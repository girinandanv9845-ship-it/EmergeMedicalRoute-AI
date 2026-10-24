import { createApp } from './app';
import { loadDotEnv, readConfig, type AppConfig } from './config';
import { Database } from './db/database';
import { seedDemoData } from './db/seed';
import { ASSISTANT_MODEL, INTERPRETER_MODEL, assistantDefinition, createModel, interpreterDefinition } from './services/ai/custom-models';
import { defaultDeps, ensureOllama } from './services/ai/ollama-manager';
import { getActivePolicy } from './policies';
import { runAiInterpretation } from './services/ai/interpret';
import { assistantTurn } from './services/assistant/assistant';
import { DisabledProvider, MockProvider, OllamaProvider, type AiProvider } from './services/ai/providers';
import { CareRouteService } from './services/careroute-service';

export function buildProvider(config: AppConfig): AiProvider {
  if (config.aiProvider === 'mock') return new MockProvider('ok');
  if (config.aiProvider === 'ollama')
    return new OllamaProvider(config.ollamaBaseUrl, config.ollamaModel, fetch, config.ollamaSpecialised ? { interpreterModel: INTERPRETER_MODEL, assistantModel: ASSISTANT_MODEL } : null);
  return new DisabledProvider();
}

async function main() {
  loadDotEnv();
  const config = readConfig();
  const db = new Database(config.dbPath);
  const provider = buildProvider(config);
  const service = new CareRouteService(db, {
    aiProvider: provider,
    aiTimeoutMs: config.aiTimeoutMs,
    emergencyInstruction: config.emergencyInstruction,
  });
  const seeded = await seedDemoData(service);
  const app = createApp({ service, liveAiProvider: provider.kind === 'ollama' ? provider : null, rateLimitPerMinute: config.rateLimitPerMinute });
  // Verify the AI provider now and every 30 s, so the UI only reports what was actually verified.
  await service.refreshAiStatus();
  setInterval(() => void service.refreshAiStatus(), 30_000).unref();

  app.listen(config.apiPort, () => {
    console.log(`EmergeMedicalRoute AI API listening on http://localhost:${config.apiPort}`);
    console.log(`  database: ${config.dbPath} (${seeded} synthetic seed record(s) added this start)`);
    const probe = service.aiProbe;
    console.log(`  AI provider: ${provider.name} — ${probe.state}: ${probe.detail}`);
    console.log('  DEMO MODE — SYNTHETIC DATA ONLY');
  });

  // Start / prepare the local AI in the background. The API is already serving; the deterministic
  // policy works the whole time, and the AI status flips to "available" once verified.
  if (provider instanceof OllamaProvider && provider.isEnabled()) {
    const log = (m: string) => console.log(`[ollama] ${m}`);
    void ensureOllama(
      {
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
        autoStart: config.ollamaAutoStart,
        autoPull: config.ollamaAutoPull,
        warm: config.ollamaWarmup,
        // Build the task-specialised models (seconds; shares the base weights) if they are missing.
        afterModelReady: config.ollamaSpecialised
          ? async () => {
              const status = await provider.checkStatus();
              if (!provider.specialisedReady) {
                log(`building task-specialised models ${INTERPRETER_MODEL} and ${ASSISTANT_MODEL}…`);
                for (const def of [interpreterDefinition(config.ollamaModel, getActivePolicy()), assistantDefinition(config.ollamaModel)]) await createModel(config.ollamaBaseUrl, def);
                await provider.checkStatus();
              } else log(`task-specialised models present (${status.detail})`);
              return provider.specialisedReady ? INTERPRETER_MODEL : undefined;
            }
          : undefined,
        // One tiny synthetic request per task so the first real client gets a cached (fast) prompt.
        prime: async () => {
          await runAiInterpretation(provider, { symptomDescription: 'Warm-up: book a check-up.', ageGroup: '40_64', requestedUrgency: 'ROUTINE' }, getActivePolicy(), 180_000);
          await assistantTurn(
            { messages: [{ role: 'user', content: 'Warm-up: I need a check-up.', kind: 'text' }], draft: {} },
            { provider, timeoutMs: 180_000, emergencyInstruction: config.emergencyInstruction, today: service.today() },
          );
        },
      },
      defaultDeps(log, (s) => {
        service.aiStartup = s;
        if (s.phase === 'ready' || s.phase === 'failed' || s.phase === 'warming') void service.refreshAiStatus();
      }),
    ).catch((err) => log(`automatic start failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

main().catch((err) => {
  console.error('Failed to start EmergeMedicalRoute AI API:', err instanceof Error ? err.message : err);
  process.exit(1);
});
