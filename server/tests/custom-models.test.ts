import { describe, expect, it, vi } from 'vitest';
import { getActivePolicy } from '../policies';
import { ASSISTANT_MODEL, INTERPRETER_MODEL, assistantDefinition, createModel, interpreterDefinition, toModelfile } from '../services/ai/custom-models';
import { runAiInterpretation } from '../services/ai/interpret';
import { OllamaProvider } from '../services/ai/providers';
import { assistantTurn } from '../services/assistant/assistant';
import { ASSISTANT_EVAL, INTERPRETER_EVAL } from '../testing/ai-eval-set';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const policy = getActivePolicy();
const SPECIAL = { interpreterModel: INTERPRETER_MODEL, assistantModel: ASSISTANT_MODEL };

function fake(installed: string[], opts: { missingOnChat?: string } = {}) {
  const chats: { model: string; messages: { role: string; content: string }[] }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) return json({ models: installed.map((name) => ({ name })) });
    const body = JSON.parse(String(init!.body));
    chats.push(body);
    if (body.model === opts.missingOnChat) return json({ error: `model "${body.model}" not found` }, 404);
    const content = u.endsWith('/api/chat') && body.messages.some((m: { content: string }) => m.content.includes('client_message'))
      ? { reply: 'Thanks, noted.', extracted: {} }
      : { extractedPhrases: ['x'], relevantConceptIds: [], ambiguityNotes: [], missingInformation: [], plainLanguageSummary: 'Requester asks for a check-up.', suggestedRoute: 'ROUTINE_APPOINTMENT' };
    return json({ message: { content: JSON.stringify(content) }, prompt_eval_count: 42, eval_count: 17, total_duration: 2e9, eval_duration: 1e9, prompt_eval_duration: 5e8, load_duration: 0 });
  });
  return { provider: new OllamaProvider('http://localhost:11434', 'llama3.2:3b', impl as unknown as typeof fetch, SPECIAL), chats };
}

describe('specialised model definitions', () => {
  it('build from the base model with built-in instructions, worked examples and shared context size', () => {
    const i = interpreterDefinition('llama3.2:3b', policy);
    const a = assistantDefinition('llama3.2:3b');
    expect(i.model).toBe(INTERPRETER_MODEL);
    expect(i.from).toBe('llama3.2:3b');
    expect(i.system).toMatch(/Allowed concept IDs:[\s\S]*EMERG-BREATH-01/);
    expect(i.system).toMatch(/Never diagnose/);
    expect(a.system).toMatch(/UNTRUSTED/);
    expect(i.parameters.num_ctx).toBe(a.parameters.num_ctx);
    expect(i.messages.length % 2).toBe(0);
    expect(a.messages.filter((m) => m.role === 'user').length).toBeGreaterThanOrEqual(5);
  });

  it('worked examples are valid against the production schemas and never diagnose', () => {
    for (const m of interpreterDefinition('llama3.2:3b', policy).messages.filter((x) => x.role === 'assistant')) {
      const o = JSON.parse(m.content);
      expect(Object.keys(o).sort()).toEqual(['ambiguityNotes', 'extractedPhrases', 'missingInformation', 'plainLanguageSummary', 'relevantConceptIds', 'suggestedRoute']);
      expect(o.plainLanguageSummary).not.toMatch(/diagnos|prescri/i);
    }
    for (const m of assistantDefinition('llama3.2:3b').messages.filter((x) => x.role === 'assistant')) {
      const o = JSON.parse(m.content);
      expect(o.reply).not.toMatch(/\?/);
    }
  });

  it('evaluation sentences are not copied from the worked examples (no testing on the examples)', () => {
    const examples = [...interpreterDefinition('llama3.2:3b', policy).messages, ...assistantDefinition('llama3.2:3b').messages].map((m) => m.content.toLowerCase()).join('\n');
    for (const c of [...INTERPRETER_EVAL, ...ASSISTANT_EVAL]) expect(examples).not.toContain(c.text.toLowerCase());
  });

  it('renders a readable Modelfile and refuses non-local hosts', async () => {
    const mf = toModelfile(assistantDefinition('llama3.2:3b'));
    expect(mf).toMatch(/^# careroute-assistant/);
    expect(mf).toMatch(/\nFROM llama3\.2:3b\n/);
    expect(mf).toMatch(/PARAMETER num_ctx 2048/);
    expect(mf).toMatch(/MESSAGE user """/);
    await expect(createModel('http://10.1.2.3:11434', assistantDefinition('llama3.2:3b'))).rejects.toThrow(/non-local/);
  });
});

describe('OllamaProvider with specialised models', () => {
  it('uses the specialised models only when installed, sending only per-request text', async () => {
    const { provider, chats } = fake(['llama3.2:3b', INTERPRETER_MODEL, ASSISTANT_MODEL]);
    await provider.checkStatus();
    expect(provider.specialisedReady).toBe(true);
    const out = await runAiInterpretation(provider, { symptomDescription: 'Annual check-up please', ageGroup: '40_64', requestedUrgency: 'ROUTINE' }, policy, 1000);
    expect(out.status).toBe('used');
    expect(chats[0]!.model).toBe(INTERPRETER_MODEL);
    expect(chats[0]!.messages).toHaveLength(1);
    expect(chats[0]!.messages[0]!.content).not.toMatch(/Allowed concept IDs/);
    expect(provider.lastMetrics).toMatchObject({ model: INTERPRETER_MODEL, promptTokens: 42, outputTokens: 17, totalMs: 2000 });

    await assistantTurn({ messages: [{ role: 'user', content: 'My back aches after lifting boxes', kind: 'text' }], draft: {} }, { provider, timeoutMs: 1000, emergencyInstruction: 'x', today: '2026-10-24' });
    expect(chats[1]!.model).toBe(ASSISTANT_MODEL);
    expect(chats[1]!.messages[0]!.role).not.toBe('system');
  });

  it('falls back to the base model with full prompts when the specialised models are missing', async () => {
    const { provider, chats } = fake(['llama3.2:3b']);
    const st = await provider.checkStatus();
    expect(st.state).toBe('available');
    expect(provider.specialisedReady).toBe(false);
    await runAiInterpretation(provider, { symptomDescription: 'Annual check-up please', ageGroup: '40_64', requestedUrgency: 'ROUTINE' }, policy, 1000);
    expect(chats[0]!.model).toBe('llama3.2:3b');
    expect(chats[0]!.messages[0]!.role).toBe('system');
  });

  it('switches back to the base model if a specialised model disappears', async () => {
    const { provider, chats } = fake(['llama3.2:3b', INTERPRETER_MODEL, ASSISTANT_MODEL], { missingOnChat: INTERPRETER_MODEL });
    await provider.checkStatus();
    const first = await runAiInterpretation(provider, { symptomDescription: 'Annual check-up', ageGroup: '40_64', requestedUrgency: 'ROUTINE' }, policy, 1000);
    expect(first.status).toBe('model_missing');
    expect(provider.specialisedReady).toBe(false);
    await runAiInterpretation(provider, { symptomDescription: 'Annual check-up', ageGroup: '40_64', requestedUrgency: 'ROUTINE' }, policy, 1000);
    expect(chats[1]!.model).toBe('llama3.2:3b');
  });
});
