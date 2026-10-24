import { describe, expect, it } from 'vitest';
import { ensureOllama, launchCandidates, type ManagerDeps, type ManagerStatus } from '../services/ai/ollama-manager';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function harness(o: { upAfterSpawn?: boolean; initiallyUp?: boolean; models?: string[]; pullLines?: object[]; platform?: NodeJS.Platform; files?: string[] } = {}) {
  let up = o.initiallyUp ?? false;
  let models = o.models ?? ['llama3.2:3b'];
  const spawned: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const calls: string[] = [];
  const logs: string[] = [];
  const phases: ManagerStatus['phase'][] = [];
  const deps: ManagerDeps = {
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u.replace('http://localhost:11434', '')}`);
      if (!up) throw new TypeError('ECONNREFUSED');
      if (u.endsWith('/api/version')) return json({ version: '0.40.10' });
      if (u.endsWith('/api/tags')) return json({ models: models.map((name) => ({ name })) });
      if (u.endsWith('/api/pull')) {
        models = [...models, 'llama3.2:3b'];
        const body = (o.pullLines ?? [{ status: 'pulling manifest' }, { status: 'pulling x', total: 100, completed: 50 }, { status: 'pulling x', total: 100, completed: 100 }, { status: 'success' }]).map((l) => JSON.stringify(l)).join('\n') + '\n';
        return new Response(body, { status: 200 });
      }
      if (u.endsWith('/api/generate')) return json({ done: true });
      return json({}, 404);
    }) as unknown as typeof fetch,
    spawnImpl: (cmd, args, opts) => {
      spawned.push({ cmd, args, env: opts.env });
      if (o.upAfterSpawn !== false) up = true;
      return { unref() {} };
    },
    exists: (p) => (o.files ?? ['C:\\Users\\demo\\AppData\\Local\\Programs\\Ollama\\ollama app.exe', 'C:\\Users\\demo\\AppData\\Local\\Programs\\Ollama\\ollama.exe']).includes(p),
    platform: o.platform ?? 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
    sleep: async () => {},
    log: (m) => logs.push(m),
    onStatus: (s) => phases.push(s.phase),
  };
  return { deps, spawned, calls, logs, phases };
}

const OPTS = { baseUrl: 'http://localhost:11434', model: 'llama3.2:3b', autoStart: true, autoPull: true, warm: true, startTimeoutMs: 50 };

describe('Ollama manager', () => {
  it('prefers the Windows Ollama tray app, then the binary, then PATH', () => {
    const { deps } = harness();
    expect(launchCandidates(deps, OPTS.baseUrl).map((c) => c.label)).toEqual(['Ollama app', 'ollama serve', 'ollama serve (PATH)']);
    expect(launchCandidates(deps, 'http://localhost:12345').map((c) => c.label)).toEqual(['ollama serve', 'ollama serve (PATH)']);
  });

  it('starts Ollama automatically when it is not running, then warms the model', async () => {
    const h = harness();
    const s = await ensureOllama(OPTS, h.deps);
    expect(s).toMatchObject({ phase: 'ready', startedByApp: true, pulledByApp: false });
    expect(h.spawned[0]!.cmd).toMatch(/ollama app\.exe$/);
    expect(h.spawned[0]!.env?.OLLAMA_HOST).toBe('127.0.0.1:11434');
    expect(h.calls).toContain('POST /api/generate');
    expect(h.phases).toEqual(['checking', 'starting', 'warming', 'ready']);
  });

  it('does not start anything when Ollama is already running', async () => {
    const h = harness({ initiallyUp: true });
    const s = await ensureOllama(OPTS, h.deps);
    expect(s).toMatchObject({ phase: 'ready', startedByApp: false });
    expect(h.spawned).toHaveLength(0);
  });

  it('downloads a missing model automatically with progress', async () => {
    const h = harness({ initiallyUp: true, models: [] });
    const s = await ensureOllama(OPTS, h.deps);
    expect(s).toMatchObject({ phase: 'ready', pulledByApp: true });
    expect(h.logs.some((l) => /downloading llama3\.2:3b: 50%/.test(l))).toBe(true);
  });

  it('reports a failed download honestly', async () => {
    const h = harness({ initiallyUp: true, models: [], pullLines: [{ status: 'pulling manifest' }, { error: 'network unreachable' }] });
    const s = await ensureOllama(OPTS, h.deps);
    expect(s.phase).toBe('failed');
    expect(s.detail).toMatch(/network unreachable/);
  });

  it('tries the next launcher if the first does not bring the API up, then fails clearly', async () => {
    const h = harness({ upAfterSpawn: false });
    const s = await ensureOllama(OPTS, h.deps);
    expect(h.spawned.map((x) => x.args.join(' '))).toEqual(['', 'serve', 'serve']);
    expect(s.phase).toBe('failed');
    expect(s.detail).toMatch(/Could not start Ollama automatically/);
  });

  it('respects OLLAMA_AUTO_START=false and OLLAMA_AUTO_PULL=false', async () => {
    const off = harness();
    expect((await ensureOllama({ ...OPTS, autoStart: false }, off.deps)).phase).toBe('failed');
    expect(off.spawned).toHaveLength(0);
    const noPull = harness({ initiallyUp: true, models: [] });
    const s = await ensureOllama({ ...OPTS, autoPull: false }, noPull.deps);
    expect(s.detail).toMatch(/ollama pull llama3\.2:3b/);
    expect(noPull.calls).not.toContain('POST /api/pull');
  });

  it('never manages a non-local Ollama host', async () => {
    const h = harness();
    const s = await ensureOllama({ ...OPTS, baseUrl: 'http://10.0.0.5:11434' }, h.deps);
    expect(s.phase).toBe('skipped');
    expect(h.spawned).toHaveLength(0);
  });
});
