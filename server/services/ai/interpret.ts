/**
 * Runs an AI provider with a timeout and strictly validates its output.
 * Any failure produces an AiOutcome describing the failure; it never throws and never
 * blocks deterministic routing.
 */
import { AiInterpretationSchema } from '../../../shared/domain';
import type { RoutingPolicy } from '../../../shared/policy-types';
import type { AiOutcome } from '../routing/engine';
import { AiProviderError, type AiProvider, type AiRequest } from './providers';

/** Output containing clinical-decision language is rejected (the AI must not diagnose or prescribe). */
// Note: "prescription" alone is NOT forbidden — refill requests legitimately mention it.
const FORBIDDEN_OUTPUT = /\b(diagnos(is|e|ed)|prescribe|should (take|use|start)|you have (a|an)?\s?\w+ (infection|disease|syndrome)|take \d+\s?mg|safe to ignore|no need to (seek|call))\b/i;

export const AI_DISABLED_NOTE = 'AI interpretation is disabled. Deterministic demonstration policy is active.';

/** In-memory telemetry per provider (reset on server restart). Never contains request text. */
export interface AiTelemetry {
  lastSuccessAt: string | null;
  lastSuccessLatencyMs: number | null;
  lastFailureAt: string | null;
  lastFailureStatus: string | null;
  lastFailureNote: string | null;
  attempts: number;
  successes: number;
}
const telemetry = new Map<string, AiTelemetry>();
export function getAiTelemetry(providerName: string): AiTelemetry {
  let t = telemetry.get(providerName);
  if (!t) {
    t = { lastSuccessAt: null, lastSuccessLatencyMs: null, lastFailureAt: null, lastFailureStatus: null, lastFailureNote: null, attempts: 0, successes: 0 };
    telemetry.set(providerName, t);
  }
  return t;
}
function record(providerName: string, outcome: AiOutcome, latencyMs: number): AiOutcome {
  const t = getAiTelemetry(providerName);
  t.attempts++;
  const now = new Date().toISOString();
  if (outcome.status === 'used') {
    t.successes++;
    t.lastSuccessAt = now;
    t.lastSuccessLatencyMs = Math.round(latencyMs);
  } else {
    t.lastFailureAt = now;
    t.lastFailureStatus = outcome.status;
    t.lastFailureNote = outcome.note;
  }
  return { ...outcome, latencyMs: Math.round(latencyMs) };
}

export async function runAiInterpretation(
  provider: AiProvider,
  req: AiRequest,
  policy: RoutingPolicy,
  timeoutMs: number,
): Promise<AiOutcome> {
  if (!provider.isEnabled()) return { status: 'disabled', interpretation: null, note: AI_DISABLED_NOTE };
  const started = performance.now();
  const outcome = await interpretAndValidate(provider, req, policy, timeoutMs);
  return record(provider.name, outcome, performance.now() - started);
}

async function interpretAndValidate(provider: AiProvider, req: AiRequest, policy: RoutingPolicy, timeoutMs: number): Promise<AiOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let raw: unknown;
  try {
    raw = await Promise.race([
      provider.interpret(req, policy, controller.signal),
      new Promise((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new AiProviderError(`AI provider timed out after ${timeoutMs} ms`, 'timeout'))),
      ),
    ]);
  } catch (err) {
    const reason = err instanceof AiProviderError ? err.reason : 'unavailable';
    const message = err instanceof AiProviderError ? err.message : 'AI provider failed';
    return {
      status: reason === 'timeout' ? 'timeout' : reason === 'model_missing' ? 'model_missing' : 'unavailable',
      interpretation: null,
      note: `${message}. Deterministic policy continued without AI.`,
    };
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'malformed_rejected', interpretation: null, note: 'AI output was not valid JSON and was rejected. Deterministic policy continued.' };
    }
  }
  const result = AiInterpretationSchema.safeParse(parsed);
  if (!result.success) {
    return { status: 'malformed_rejected', interpretation: null, note: 'AI output did not match the required schema and was rejected. Deterministic policy continued.' };
  }
  const knownIds = new Set(policy.rules.map((r) => r.id));
  const unknown = result.data.relevantConceptIds.filter((id) => !knownIds.has(id));
  if (unknown.length) {
    return { status: 'malformed_rejected', interpretation: null, note: 'AI output referenced policy concepts that do not exist and was rejected.' };
  }
  const allText = [result.data.plainLanguageSummary, ...result.data.ambiguityNotes, ...result.data.missingInformation].join(' ');
  if (FORBIDDEN_OUTPUT.test(allText)) {
    return { status: 'malformed_rejected', interpretation: null, note: 'AI output contained diagnostic or treatment language and was rejected.' };
  }
  return { status: 'used', interpretation: result.data, note: 'AI-assisted interpretation (validated). It cannot override deterministic safety rules.' };
}
