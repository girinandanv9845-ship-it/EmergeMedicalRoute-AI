/**
 * Orchestrates deterministic routing with optional AI assistance.
 *
 *  1. Deterministic evaluation runs first, synchronously.
 *  2. If an emergency rule matched, AI is skipped entirely so emergency guidance is never delayed.
 *  3. Otherwise AI (if enabled) runs with a timeout; its validated output is fed back into the
 *     deterministic engine, which may only ESCALATE via AI boundary rules — never downgrade.
 */
import type { Recommendation } from '../../../shared/domain';
import type { RoutingPolicy } from '../../../shared/policy-types';
import { getActivePolicy } from '../../policies';
import { AI_DISABLED_NOTE, runAiInterpretation } from '../ai/interpret';
import type { AiProvider } from '../ai/providers';
import { evaluateRequest, type AiOutcome, type EngineInput } from './engine';

export interface RouteResult {
  recommendation: Recommendation;
  aiAttempted: boolean;
  aiOutcome: AiOutcome;
}

export async function routeRequest(
  input: EngineInput,
  provider: AiProvider,
  opts: { timeoutMs: number; policy?: RoutingPolicy },
): Promise<RouteResult> {
  const policy = opts.policy ?? getActivePolicy();

  if (!provider.isEnabled()) {
    const ai: AiOutcome = { status: 'disabled', interpretation: null, note: AI_DISABLED_NOTE };
    return { recommendation: evaluateRequest(input, { policy, ai }), aiAttempted: false, aiOutcome: ai };
  }

  const deterministic = evaluateRequest(input, { policy });
  if (deterministic.emergencyGuidanceRequired) {
    const ai: AiOutcome = {
      status: 'skipped_emergency',
      interpretation: null,
      note: 'AI was skipped because a mandatory emergency rule matched. Emergency guidance is shown without waiting for AI.',
    };
    return { recommendation: evaluateRequest(input, { policy, ai }), aiAttempted: false, aiOutcome: ai };
  }

  const ai = await runAiInterpretation(
    provider,
    { symptomDescription: input.symptomDescription, ageGroup: input.ageGroup, requestedUrgency: input.requestedUrgency },
    policy,
    opts.timeoutMs,
  );
  const recommendation = evaluateRequest(input, { policy, ai });

  // Defence in depth: AI-informed evaluation must never be lower precedence than deterministic-only.
  const rank = { EMERGENCY_GUIDANCE: 1, SAME_DAY_HUMAN_REVIEW: 2, NEEDS_CLARIFICATION_OR_HUMAN_REVIEW: 3, ROUTINE_APPOINTMENT: 4 } as const;
  if (rank[recommendation.recommendedRoute] > rank[deterministic.recommendedRoute]) {
    return { recommendation: { ...deterministic, aiStatus: ai.status, aiNote: ai.note, aiInterpretation: null }, aiAttempted: true, aiOutcome: ai };
  }
  return { recommendation, aiAttempted: true, aiOutcome: ai };
}
