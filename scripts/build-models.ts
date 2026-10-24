/**
 * `npm run ai:build-models` — builds the task-specialised local models from the base model
 * (no download, no API key) and writes readable Modelfiles to ./ollama for transparency.
 */
import fs from 'node:fs';
import { loadDotEnv, readConfig } from '../server/config';
import { getActivePolicy } from '../server/policies';
import { assistantDefinition, createModel, interpreterDefinition, toModelfile } from '../server/services/ai/custom-models';

loadDotEnv();
const config = readConfig();
const defs = [interpreterDefinition(config.ollamaModel, getActivePolicy()), assistantDefinition(config.ollamaModel)];
fs.mkdirSync('ollama', { recursive: true });
for (const def of defs) {
  const file = `ollama/${def.model.replace(/[:/]/g, '-')}.Modelfile`;
  fs.writeFileSync(file, toModelfile(def));
  const t = Date.now();
  await createModel(config.ollamaBaseUrl, def);
  console.log(`built ${def.model} from ${def.from} in ${((Date.now() - t) / 1000).toFixed(1)} s  (${def.messages.length / 2} worked examples, ${file})`);
}
