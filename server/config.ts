import fs from 'node:fs';
import path from 'node:path';

/** Minimal .env loader (no extra dependency). Existing environment variables take precedence. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1]!;
    const value = m[2]!.replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface AppConfig {
  apiPort: number;
  dbPath: string;
  aiProvider: 'disabled' | 'mock' | 'ollama';
  ollamaBaseUrl: string;
  ollamaModel: string;
  /** Start the installed Ollama app automatically if it isn't running (default true). */
  ollamaAutoStart: boolean;
  /** Download the configured model automatically if it is missing (default true). */
  ollamaAutoPull: boolean;
  /** Load the model into memory at start-up so the first request is fast (default true). */
  ollamaWarmup: boolean;
  /** Use the task-specialised models built from OLLAMA_MODEL (built automatically if missing). */
  ollamaSpecialised: boolean;
  aiTimeoutMs: number;
  emergencyInstruction: string;
  rateLimitPerMinute: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = (env.AI_PROVIDER ?? 'disabled').toLowerCase();
  return {
    apiPort: Number(env.API_PORT ?? 3001),
    dbPath: env.DB_PATH ?? './data/careroute.sqlite',
    aiProvider: provider === 'mock' || provider === 'ollama' ? provider : 'disabled',
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    ollamaModel: env.OLLAMA_MODEL ?? 'llama3.2:3b',
    ollamaAutoStart: (env.OLLAMA_AUTO_START ?? 'true').toLowerCase() !== 'false',
    ollamaAutoPull: (env.OLLAMA_AUTO_PULL ?? 'true').toLowerCase() !== 'false',
    ollamaWarmup: (env.OLLAMA_WARMUP ?? 'true').toLowerCase() !== 'false',
    ollamaSpecialised: (env.OLLAMA_SPECIALISED ?? 'true').toLowerCase() !== 'false',
    // Local CPU inference is slower than a hosted API; emergencies never wait for it (AI is skipped).
    aiTimeoutMs: Number(env.AI_TIMEOUT_MS ?? (provider === 'ollama' ? 30000 : 6000)),
    emergencyInstruction: env.EMERGENCY_INSTRUCTION ?? 'Contact your local emergency services immediately.',
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 120),
  };
}
