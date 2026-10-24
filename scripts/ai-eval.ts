/**
 * `npm run ai:eval` — measures the local model on the synthetic evaluation set, comparing:
 *   A) base model + full prompts per request  (llama3.2:3b)
 *   B) task-specialised models (built-in instructions + worked examples + tuned parameters)
 * Writes docs/ai-evaluation.md. All numbers come from actual runs on this machine.
 */
import fs from 'node:fs';
import os from 'node:os';
import { ROUTE_PRECEDENCE, type Route } from '../shared/domain';
import { AssistantModelOutputSchema } from '../shared/assistant';
import { loadDotEnv, readConfig } from '../server/config';
import { getActivePolicy } from '../server/policies';
import { runAiInterpretation } from '../server/services/ai/interpret';
import { ASSISTANT_MODEL, INTERPRETER_MODEL } from '../server/services/ai/custom-models';
import { OllamaProvider } from '../server/services/ai/providers';
import { BOOKING_PROMISE, UNSAFE_REPLY, assistantTurn } from '../server/services/assistant/assistant';
import { ASSISTANT_EVAL, INTERPRETER_EVAL } from '../server/testing/ai-eval-set';

loadDotEnv();
const config = readConfig();
const policy = getActivePolicy();

interface ConfigResult {
  label: string;
  interp: { id: string; valid: boolean; suggested: Route | null; correct: boolean; under: boolean; over: boolean; wallMs: number; promptTokens: number; outputTokens: number; promptMs: number; genMs: number }[];
  assist: {
    id: string;
    validJson: boolean;
    rawQuestion: boolean;
    rawAdvice: boolean;
    rawPromise: boolean;
    rawDigits: boolean;
    expected: number;
    correct: number;
    wrong: number;
    finalCorrect: number;
    finalWrong: number;
    declinedMedical: boolean | null;
    shownAiText: boolean;
    wallMs: number;
    promptTokens: number;
    outputTokens: number;
  }[];
}

async function evaluate(label: string, provider: OllamaProvider): Promise<ConfigResult> {
  await provider.checkStatus();
  const result: ConfigResult = { label, interp: [], assist: [] };
  // Warm-up both tasks so load time is excluded from latency figures.
  await runAiInterpretation(provider, { symptomDescription: 'Warm-up: book a check-up.', ageGroup: '40_64', requestedUrgency: 'ROUTINE' }, policy, 180_000);
  await assistantTurn({ messages: [{ role: 'user', content: 'Warm-up: I need a check-up.', kind: 'text' }], draft: {} }, { provider, timeoutMs: 180_000, emergencyInstruction: 'x', today: '2026-10-24' });

  for (const c of INTERPRETER_EVAL) {
    const t = performance.now();
    const out = await runAiInterpretation(provider, { symptomDescription: c.text, ageGroup: c.ageGroup, requestedUrgency: c.urgency }, policy, 120_000);
    const wallMs = performance.now() - t;
    const suggested = out.interpretation?.suggestedRoute ?? null;
    const correct = !!suggested && c.accept.includes(suggested);
    const leastUrgentAccepted = Math.max(...c.accept.map((r) => ROUTE_PRECEDENCE[r]));
    const mostUrgentAccepted = Math.min(...c.accept.map((r) => ROUTE_PRECEDENCE[r]));
    const m = provider.lastMetrics;
    result.interp.push({
      id: c.id,
      valid: out.status === 'used',
      suggested,
      correct,
      under: !!suggested && !correct && ROUTE_PRECEDENCE[suggested] > leastUrgentAccepted,
      over: !!suggested && !correct && ROUTE_PRECEDENCE[suggested] < mostUrgentAccepted,
      wallMs,
      promptTokens: m?.promptTokens ?? 0,
      outputTokens: m?.outputTokens ?? 0,
      promptMs: m?.promptMs ?? 0,
      genMs: m?.generateMs ?? 0,
    });
    process.stdout.write(`  [${label}] ${c.id} ${suggested ?? out.status}${correct ? '' : ' ✗'} ${(wallMs / 1000).toFixed(1)}s\n`);
  }

  for (const c of ASSISTANT_EVAL) {
    const t = performance.now();
    const turn = await assistantTurn({ messages: [{ role: 'user', content: c.text, kind: 'text' }], draft: {} }, { provider, timeoutMs: 120_000, emergencyInstruction: 'x', today: '2026-10-24' });
    const wallMs = performance.now() - t;
    let parsed: ReturnType<typeof AssistantModelOutputSchema.safeParse> | null = null;
    try {
      parsed = turn.rawModelReply ? AssistantModelOutputSchema.safeParse(JSON.parse(turn.rawModelReply)) : null;
    } catch {
      parsed = null;
    }
    const raw = parsed?.success ? parsed.data : null;
    const extracted = (raw?.extracted ?? {}) as Record<string, unknown>;
    const expectedKeys = Object.keys(c.expect);
    const correct = expectedKeys.filter((k) => extracted[k] === (c.expect as Record<string, unknown>)[k]).length;
    const wrong = Object.keys(extracted).filter((k) => extracted[k] !== undefined && extracted[k] !== (c.expect as Record<string, unknown>)[k]).length;
    const finalDraft = turn.response.draft as Record<string, unknown>;
    const finalCorrect = expectedKeys.filter((k) => finalDraft[k] === (c.expect as Record<string, unknown>)[k]).length;
    const finalWrong = Object.keys(finalDraft).filter((k) => finalDraft[k] !== undefined && finalDraft[k] !== (c.expect as Record<string, unknown>)[k]).length;
    const reply = raw?.reply ?? '';
    const m = provider.lastMetrics;
    result.assist.push({
      id: c.id,
      validJson: !!raw,
      rawQuestion: reply.includes('?'),
      rawAdvice: UNSAFE_REPLY.test(reply),
      rawPromise: BOOKING_PROMISE.test(reply),
      rawDigits: /\d/.test(reply),
      expected: expectedKeys.length,
      correct,
      wrong,
      finalCorrect,
      finalWrong,
      declinedMedical: c.medicalQuestion ? /medical advice/i.test(turn.response.reply) && !UNSAFE_REPLY.test(turn.response.reply) : null,
      shownAiText: turn.response.aiTextShown,
      wallMs,
      promptTokens: m?.promptTokens ?? 0,
      outputTokens: m?.outputTokens ?? 0,
    });
    process.stdout.write(`  [${label}] ${c.id} extracted ${correct}/${expectedKeys.length}${wrong ? `, ${wrong} wrong` : ''} ${(wallMs / 1000).toFixed(1)}s\n`);
  }
  return result;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n: number, d: number) => `${n}/${d} (${d ? Math.round((n / d) * 100) : 0}%)`;
const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function summary(r: ConfigResult) {
  const i = r.interp;
  const a = r.assist;
  const expectedFields = a.reduce((n, x) => n + x.expected, 0);
  const med = a.filter((x) => x.declinedMedical !== null);
  return {
    'Interpreter: valid structured output': pct(i.filter((x) => x.valid).length, i.length),
    'Interpreter: acceptable category': pct(i.filter((x) => x.correct).length, i.length),
    'Interpreter: under-triage (less urgent than acceptable)': pct(i.filter((x) => x.under).length, i.length),
    'Interpreter: over-triage': pct(i.filter((x) => x.over).length, i.length),
    'Interpreter: mean latency': s(avg(i.map((x) => x.wallMs))),
    'Interpreter: mean prompt tokens processed': Math.round(avg(i.map((x) => x.promptTokens))),
    'Interpreter: mean output tokens': Math.round(avg(i.map((x) => x.outputTokens))),
    'Assistant: valid structured output': pct(a.filter((x) => x.validJson).length, a.length),
    'Assistant (raw model): fields extracted correctly': pct(a.reduce((n, x) => n + x.correct, 0), expectedFields),
    'Assistant (raw model): wrong / invented field values': a.reduce((n, x) => n + x.wrong, 0),
    'Assistant (final, rules + evidence-checked model): fields correct': pct(a.reduce((n, x) => n + x.finalCorrect, 0), expectedFields),
    'Assistant (final): wrong field values reaching the form': a.reduce((n, x) => n + x.finalWrong, 0),
    'Assistant: raw replies asking a question (filtered)': pct(a.filter((x) => x.rawQuestion).length, a.length),
    'Assistant: raw replies with advice/diagnosis (blocked)': pct(a.filter((x) => x.rawAdvice).length, a.length),
    'Assistant: raw replies with booking promises (filtered)': pct(a.filter((x) => x.rawPromise).length, a.length),
    'Assistant: medical questions declined in final reply': pct(med.filter((x) => x.declinedMedical).length, med.length),
    'Assistant: replies where model text was usable': pct(a.filter((x) => x.shownAiText).length, a.length),
    'Assistant: mean latency': s(avg(a.map((x) => x.wallMs))),
    'Assistant: mean prompt tokens processed': Math.round(avg(a.map((x) => x.promptTokens))),
  };
}

const base = new OllamaProvider(config.ollamaBaseUrl, config.ollamaModel, fetch, null);
const special = new OllamaProvider(config.ollamaBaseUrl, config.ollamaModel, fetch, { interpreterModel: INTERPRETER_MODEL, assistantModel: ASSISTANT_MODEL });
const st = await special.checkStatus();
if (!special.specialisedReady) {
  console.error(`Specialised models are not installed (${st.detail}). Run: npm run ai:build-models`);
  process.exit(1);
}

console.log(`Evaluating on ${os.cpus()[0]?.model ?? 'unknown CPU'} — ${INTERPRETER_EVAL.length} interpreter cases, ${ASSISTANT_EVAL.length} assistant cases per configuration`);
const A = await evaluate('base', base);
const B = await evaluate('specialised', special);
const sa = summary(A);
const sb = summary(B);

const lines: string[] = [
  '# Local AI evaluation — base vs task-specialised models',
  '',
  `> Generated by \`npm run ai:eval\` on ${new Date().toISOString()} · ${os.cpus()[0]?.model ?? ''} · ${Math.round(os.totalmem() / 1e9)} GB RAM · Ollama, CPU only.`,
  `> Synthetic evaluation set: ${INTERPRETER_EVAL.length} interpreter cases and ${ASSISTANT_EVAL.length} assistant turns (\`server/testing/ai-eval-set.ts\`), none of which appear in the models' built-in examples.`,
  '> **This measures administrative interpretation quality on synthetic text, not clinical accuracy.** Emergencies are excluded because they never reach the model.',
  '',
  '| Metric | A) Base `' + config.ollamaModel + '` + full prompts | B) Specialised `' + INTERPRETER_MODEL + '` / `' + ASSISTANT_MODEL + '` |',
  '|---|---|---|',
  ...Object.keys(sa).map((k) => `| ${k} | ${(sa as Record<string, unknown>)[k]} | ${(sb as Record<string, unknown>)[k]} |`),
  '',
  '## What "specialised" means here',
  '',
  'Not weight training. Each specialised model is the same base weights plus a built-in system prompt, a few synthetic worked examples (few-shot) and tuned parameters (`num_ctx 2048`, task-specific `temperature` / `num_predict`). Definitions: `server/services/ai/custom-models.ts`; readable Modelfiles: `ollama/`.',
  '',
  '## Per-case interpreter results',
  '',
  '| Case | Acceptable | A) Base | B) Specialised |',
  '|---|---|---|---|',
  ...INTERPRETER_EVAL.map((c, idx) => {
    const fmt = (x: ConfigResult['interp'][number]) => `${x.suggested ?? 'invalid'}${x.correct ? ' ✅' : x.under ? ' ⚠️ under' : ' ❌'}`;
    return `| ${c.id} | ${c.accept.join(' / ')} | ${fmt(A.interp[idx]!)} | ${fmt(B.interp[idx]!)} |`;
  }),
  '',
  'Safety reminder: in the running app, model output can only **escalate** a request to human review; the deterministic policy is authoritative, so an under-triaged model suggestion never lowers a route.',
];
fs.writeFileSync('docs/ai-evaluation.md', lines.join('\n') + '\n');
console.log('\n' + Object.keys(sa).map((k) => `${k.padEnd(58)} A: ${String((sa as Record<string, unknown>)[k]).padEnd(14)} B: ${(sb as Record<string, unknown>)[k]}`).join('\n'));
console.log('\nWrote docs/ai-evaluation.md');
