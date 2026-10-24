/**
 * `npm run ollama:setup` — one command to get local AI working: starts the installed Ollama app if it
 * is not running, downloads the configured model if missing, and loads it into memory.
 * (`npm run dev` does the same automatically in the background.)
 */
import { loadDotEnv, readConfig } from '../server/config';
import { defaultDeps, ensureOllama } from '../server/services/ai/ollama-manager';

loadDotEnv();
const config = readConfig();
const status = await ensureOllama(
  { baseUrl: config.ollamaBaseUrl, model: config.ollamaModel, autoStart: true, autoPull: true, warm: true },
  defaultDeps((m) => console.log(`[ollama] ${m}`)),
);
if (status.phase !== 'ready') process.exit(1);
console.log(`\nDone. Set AI_PROVIDER=ollama in .env (it is ${config.aiProvider === 'ollama' ? 'already set' : `currently "${config.aiProvider}"`}) and run: npm run dev`);
