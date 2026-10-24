/**
 * Ollama lifecycle manager — lets the project start and prepare the local AI by itself.
 *
 *   1. If the Ollama API is not answering, find the installed Ollama app / binary and launch it
 *      (Windows: "ollama app.exe" tray app; macOS: Ollama.app; otherwise `ollama serve`).
 *   2. Wait until the API answers.
 *   3. If the configured model is missing, pull it (with progress logging).
 *   4. Warm the model up (load it into memory) so the first real request is fast.
 *
 * Runs in the background at API start-up; the API serves requests the whole time and the
 * deterministic policy works regardless. Only loopback URLs are ever managed.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackUrl } from './providers';

export type ManagerPhase = 'checking' | 'starting' | 'pulling' | 'warming' | 'ready' | 'failed' | 'skipped';

export interface ManagerStatus {
  phase: ManagerPhase;
  detail: string;
  startedByApp: boolean;
  pulledByApp: boolean;
  warmLoadMs: number | null;
}

export interface ManagerDeps {
  fetchImpl: typeof fetch;
  spawnImpl: (cmd: string, args: string[], opts: SpawnOptions) => { unref(): void; on?: (ev: 'error', cb: (e: Error) => void) => unknown };
  exists: (p: string) => boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  onStatus?: (s: ManagerStatus) => void;
}

export const defaultDeps = (log: (m: string) => void, onStatus?: (s: ManagerStatus) => void): ManagerDeps => ({
  fetchImpl: fetch,
  spawnImpl: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
  exists: (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
  platform: process.platform,
  env: process.env,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log,
  onStatus,
});

/** Candidate ways to launch Ollama on this machine, most preferred first. */
export function launchCandidates(deps: Pick<ManagerDeps, 'platform' | 'env' | 'exists'>, baseUrl: string): { cmd: string; args: string[]; label: string }[] {
  const out: { cmd: string; args: string[]; label: string }[] = [];
  const port = new URL(baseUrl).port || '11434';
  const defaultPort = port === '11434';
  if (deps.platform === 'win32') {
    const roots = [deps.env.LOCALAPPDATA && path.win32.join(deps.env.LOCALAPPDATA, 'Programs', 'Ollama'), deps.env.ProgramFiles && path.win32.join(deps.env.ProgramFiles, 'Ollama')].filter(Boolean) as string[];
    for (const root of roots) {
      const tray = path.win32.join(root, 'ollama app.exe');
      const bin = path.win32.join(root, 'ollama.exe');
      // The tray app always serves on the default port; use `serve` for custom ports.
      if (defaultPort && deps.exists(tray)) out.push({ cmd: tray, args: [], label: 'Ollama app' });
      if (deps.exists(bin)) out.push({ cmd: bin, args: ['serve'], label: 'ollama serve' });
    }
  } else if (deps.platform === 'darwin') {
    if (defaultPort && deps.exists('/Applications/Ollama.app')) out.push({ cmd: 'open', args: ['-a', 'Ollama'], label: 'Ollama.app' });
  }
  out.push({ cmd: 'ollama', args: ['serve'], label: 'ollama serve (PATH)' });
  return out;
}

async function isUp(deps: ManagerDeps, baseUrl: string): Promise<string | null> {
  try {
    const res = await deps.fetchImpl(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { version?: string };
    return body.version ?? 'unknown';
  } catch {
    return null;
  }
}

async function hasModel(deps: ManagerDeps, baseUrl: string, model: string): Promise<boolean> {
  try {
    const res = await deps.fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
    const wanted = model.includes(':') ? model : `${model}:latest`;
    return (body.models ?? []).some((m) => [m.name, m.model].includes(wanted) || [m.name, m.model].includes(model));
  } catch {
    return false;
  }
}

async function pullModel(deps: ManagerDeps, baseUrl: string, model: string): Promise<void> {
  const res = await deps.fetchImpl(`${baseUrl}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
  if (!res.ok || !res.body) throw new Error(`pull failed (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastPct = -10;
  let finalStatus = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
      if (evt.error) throw new Error(evt.error);
      if (evt.status) finalStatus = evt.status;
      if (evt.total && evt.completed !== undefined) {
        const pct = Math.floor((evt.completed / evt.total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct - (pct % 10);
          deps.log(`downloading ${model}: ${pct}% of ${(evt.total / 1e9).toFixed(2)} GB`);
        }
      }
    }
  }
  if (finalStatus !== 'success') throw new Error(`pull ended with status "${finalStatus || 'unknown'}"`);
}

async function warmUp(deps: ManagerDeps, baseUrl: string, model: string): Promise<number> {
  const t = Date.now();
  // An empty prompt loads the model into memory without generating; keep it loaded for 30 min.
  const res = await deps.fetchImpl(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', keep_alive: '30m', stream: false }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`warm-up failed (HTTP ${res.status})`);
  await res.text();
  return Date.now() - t;
}

export async function ensureOllama(
  opts: {
    baseUrl: string;
    model: string;
    autoStart: boolean;
    autoPull: boolean;
    warm: boolean;
    startTimeoutMs?: number;
    /** Runs once the base model is installed (e.g. build the specialised models). Returns the model to warm up. */
    afterModelReady?: () => Promise<string | void>;
    /** Runs after loading: e.g. one tiny request per task so Ollama's prompt cache is primed. */
    prime?: () => Promise<void>;
  },
  deps: ManagerDeps,
): Promise<ManagerStatus> {
  const status: ManagerStatus = { phase: 'checking', detail: 'Checking for a running Ollama…', startedByApp: false, pulledByApp: false, warmLoadMs: null };
  const update = (phase: ManagerPhase, detail: string) => {
    status.phase = phase;
    status.detail = detail;
    deps.log(detail);
    deps.onStatus?.({ ...status });
  };
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  if (!isLoopbackUrl(baseUrl)) {
    update('skipped', 'OLLAMA_BASE_URL is not on this machine; automatic start is disabled.');
    return status;
  }
  update('checking', `Checking for Ollama at ${baseUrl}…`);
  let version = await isUp(deps, baseUrl);

  if (!version) {
    if (!opts.autoStart) {
      update('failed', 'Ollama is not running and OLLAMA_AUTO_START=false. Start the Ollama app manually.');
      return status;
    }
    const candidates = launchCandidates(deps, baseUrl);
    const port = new URL(baseUrl).port || '11434';
    for (const c of candidates) {
      update('starting', `Ollama is not running — starting ${c.label}…`);
      try {
        const child = deps.spawnImpl(c.cmd, c.args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...deps.env, OLLAMA_HOST: `127.0.0.1:${port}` },
        });
        child.on?.('error', () => undefined);
        child.unref();
      } catch {
        continue;
      }
      // The Windows tray app can take ~60 s to bring its own server up; give it 10 s, then start
      // `ollama serve` directly (the tray app then proxies to that server).
      const budget = opts.startTimeoutMs ?? 45_000;
      const deadline = Date.now() + (c.label === 'Ollama app' ? Math.min(10_000, budget) : budget);
      while (!version && Date.now() < deadline) {
        await deps.sleep(1000);
        version = await isUp(deps, baseUrl);
      }
      if (version) {
        status.startedByApp = true;
        break;
      }
    }
    if (!version) {
      update('failed', 'Could not start Ollama automatically. Install it from https://ollama.com or start the Ollama app; the app keeps working without AI meanwhile.');
      return status;
    }
  }
  deps.log(`Ollama is running (version ${version})${status.startedByApp ? ' — started automatically by the app' : ''}.`);

  if (!(await hasModel(deps, baseUrl, opts.model))) {
    if (!opts.autoPull) {
      update('failed', `Model ${opts.model} is not installed and OLLAMA_AUTO_PULL=false. Run: ollama pull ${opts.model}`);
      return status;
    }
    update('pulling', `Model ${opts.model} is not installed — downloading it (one-time, ~2 GB for llama3.2:3b)…`);
    try {
      await pullModel(deps, baseUrl, opts.model);
      status.pulledByApp = true;
    } catch (err) {
      update('failed', `Downloading ${opts.model} failed: ${err instanceof Error ? err.message : String(err)}. Retry by restarting the app or run: ollama pull ${opts.model}`);
      return status;
    }
  }

  let warmModel = opts.model;
  if (opts.afterModelReady) {
    try {
      warmModel = (await opts.afterModelReady()) || opts.model;
    } catch (err) {
      deps.log(`Preparing specialised models failed (${err instanceof Error ? err.message : String(err)}); the base model will be used.`);
    }
  }

  if (opts.warm) {
    update('warming', `Loading ${warmModel} into memory (first load can take ~25 s)…`);
    try {
      status.warmLoadMs = await warmUp(deps, baseUrl, warmModel);
      if (opts.prime) {
        const t = Date.now();
        await opts.prime();
        deps.log(`prompt cache primed for both tasks in ${((Date.now() - t) / 1000).toFixed(1)} s`);
      }
    } catch (err) {
      deps.log(`Warm-up skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  update('ready', `Local AI ready: ${warmModel}${status.warmLoadMs !== null ? ` (loaded in ${(status.warmLoadMs / 1000).toFixed(1)} s)` : ''}.`);
  return status;
}
