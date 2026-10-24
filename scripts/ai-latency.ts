/**
 * `npm run ai:latency` — realistic latency check: primes both specialised models, then alternates
 * interpreter and assistant calls the way real usage does, and reports Ollama's own timings.
 */
import { loadDotEnv, readConfig } from '../server/config';
import { getActivePolicy } from '../server/policies';
import { runAiInterpretation } from '../server/services/ai/interpret';
import { ASSISTANT_MODEL, INTERPRETER_MODEL } from '../server/services/ai/custom-models';
import { OllamaProvider } from '../server/services/ai/providers';
import { assistantTurn } from '../server/services/assistant/assistant';

loadDotEnv();
const config = readConfig();
const p = new OllamaProvider(config.ollamaBaseUrl, config.ollamaModel, fetch, { interpreterModel: INTERPRETER_MODEL, assistantModel: ASSISTANT_MODEL });
await p.checkStatus();
const policy = getActivePolicy();
const chat = (text: string) => assistantTurn({ messages: [{ role: 'user', content: text, kind: 'text' }], draft: {} }, { provider: p, timeoutMs: 120000, emergencyInstruction: 'x', today: '2026-10-24' });
const interp = (text: string) => runAiInterpretation(p, { symptomDescription: text, ageGroup: '40_64', requestedUrgency: 'ROUTINE' }, policy, 120000);

const steps: [string, () => Promise<unknown>][] = [
  ['prime interpreter', () => interp('Warm-up: check-up please.')],
  ['prime assistant', () => chat('Warm-up: I need a check-up.')],
  ['assistant', () => chat('My wrist has hurt since I fell off my bike yesterday.')],
  ['assistant', () => chat('Evenings after 6 please.')],
  ['interpreter', () => interp('My cough has got much worse over the last two days.')],
  ['assistant', () => chat('The headaches started about three weeks ago.')],
  ['interpreter', () => interp('I need to renew my repeat prescription.')],
  ['interpreter', () => interp('Something is not right with me but I cannot explain it.')],
  ['assistant', () => chat('Hello, I would like an appointment about my back.')],
];
const warm: number[] = [];
for (const [label, fn] of steps) {
  const t = performance.now();
  await fn();
  const wall = performance.now() - t;
  const m = p.lastMetrics!;
  if (!label.startsWith('prime')) warm.push(wall);
  console.log(`${label.padEnd(18)} ${(wall / 1000).toFixed(1).padStart(5)} s | prompt ${m.promptTokens} tok in ${m.promptMs} ms | output ${m.outputTokens} tok in ${m.generateMs} ms | load ${m.loadMs} ms`);
}
console.log(`\nmean after priming: ${(warm.reduce((a, b) => a + b, 0) / warm.length / 1000).toFixed(1)} s over ${warm.length} calls`);
