import { describe, expect, it } from 'vitest';
import { getActivePolicy } from '../policies';
import { runAiInterpretation } from '../services/ai/interpret';
import { DisabledProvider, MockProvider, type AiProvider } from '../services/ai/providers';
import { routeRequest } from '../services/routing/route-request';
import type { EngineInput } from '../services/routing/engine';

const policy = getActivePolicy();
const req = { symptomDescription: 'Please book a flu shot', ageGroup: '40_64', requestedUrgency: 'ROUTINE' };
const input = (symptomDescription: string): EngineInput => ({ symptomDescription, ageGroup: '40_64', symptomOnset: '1_3_DAYS', requestedUrgency: 'ROUTINE' });

const fixedProvider = (output: unknown): AiProvider => ({
  name: 'fixed',
  kind: 'mock',
  isEnabled: () => true,
  interpret: async () => output,
});

describe('AI interpretation validation', () => {
  it('reports disabled with the required notice', async () => {
    const out = await runAiInterpretation(new DisabledProvider(), req, policy, 100);
    expect(out).toEqual({ status: 'disabled', interpretation: null, note: 'AI interpretation is disabled. Deterministic demonstration policy is active.' });
  });

  it('accepts valid structured output', async () => {
    const out = await runAiInterpretation(new MockProvider('ok'), req, policy, 500);
    expect(out.status).toBe('used');
    expect(out.interpretation?.extractedPhrases.length).toBeGreaterThan(0);
  });

  it('handles provider outage', async () => {
    expect((await runAiInterpretation(new MockProvider('unavailable'), req, policy, 500)).status).toBe('unavailable');
  });

  it('times out a hanging provider', async () => {
    const t = Date.now();
    const out = await runAiInterpretation(new MockProvider('timeout'), req, policy, 50);
    expect(out.status).toBe('timeout');
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it.each([
    ['invalid JSON', '{"extractedPhrases": [}'],
    ['wrong types', { extractedPhrases: 'x', relevantConceptIds: [], ambiguityNotes: [], missingInformation: [], plainLanguageSummary: '' }],
    ['extra keys (e.g. a route)', { extractedPhrases: [], relevantConceptIds: [], ambiguityNotes: [], missingInformation: [], plainLanguageSummary: 'ok', route: 'ROUTINE_APPOINTMENT' }],
    ['unknown concept IDs', { extractedPhrases: [], relevantConceptIds: ['MADE-UP-99'], ambiguityNotes: [], missingInformation: [], plainLanguageSummary: 'ok' }],
    ['diagnostic language', { extractedPhrases: [], relevantConceptIds: [], ambiguityNotes: [], missingInformation: [], plainLanguageSummary: 'The diagnosis is flu.' }],
  ])('rejects %s', async (_label, output) => {
    const out = await runAiInterpretation(fixedProvider(output), req, policy, 500);
    expect(out.status).toBe('malformed_rejected');
    expect(out.interpretation).toBeNull();
  });

  it('rejects a category outside the four administrative routes', async () => {
    const out = await runAiInterpretation(new MockProvider('invalid-category'), req, policy, 500);
    expect(out.status).toBe('malformed_rejected');
  });

  it('records latency on every outcome', async () => {
    const out = await runAiInterpretation(new MockProvider('ok'), req, policy, 500);
    expect(typeof out.latencyMs).toBe('number');
  });
});

describe('AI boundary in routing', () => {
  it('skips AI when an emergency rule matches (no delay)', async () => {
    const t = Date.now();
    const r = await routeRequest(input('I cannot breathe'), new MockProvider('timeout'), { timeoutMs: 5000 });
    expect(r.recommendation.recommendedRoute).toBe('EMERGENCY_GUIDANCE');
    expect(r.recommendation.aiStatus).toBe('skipped_emergency');
    expect(r.aiAttempted).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('AI failure keeps the deterministic route', async () => {
    for (const mode of ['unavailable', 'malformed', 'timeout'] as const) {
      const r = await routeRequest(input('My cough is getting worse'), new MockProvider(mode), { timeoutMs: 50 });
      expect(r.recommendation.recommendedRoute).toBe('SAME_DAY_HUMAN_REVIEW');
      expect(r.recommendation.aiInterpretation).toBeNull();
    }
  });

  it('AI cannot downgrade a route', async () => {
    const r = await routeRequest(input('My cough is getting worse'), new MockProvider('suggest-routine'), { timeoutMs: 500 });
    expect(r.recommendation.recommendedRoute).toBe('SAME_DAY_HUMAN_REVIEW');
    expect(r.recommendation.aiStatus).toBe('used');
  });

  it('AI can only escalate to human review, never to an emergency decision', async () => {
    const r = await routeRequest(input('Please book my flu shot'), new MockProvider('flag-emergency'), { timeoutMs: 500 });
    expect(r.recommendation.recommendedRoute).toBe('SAME_DAY_HUMAN_REVIEW');
    expect(r.recommendation.matchedRuleIds).toContain('AI-FLAG-01');
    expect(r.recommendation.emergencyGuidanceRequired).toBe(false);
  });

  it('AI ambiguity notes prevent automatic routine routing', async () => {
    const r = await routeRequest(input('Please book my flu shot, maybe next week, not sure'), new MockProvider('ok'), { timeoutMs: 500 });
    expect(r.recommendation.matchedRuleIds).toContain('AI-AMBIG-01');
    expect(r.recommendation.recommendedRoute).toBe('NEEDS_CLARIFICATION_OR_HUMAN_REVIEW');
  });
});
