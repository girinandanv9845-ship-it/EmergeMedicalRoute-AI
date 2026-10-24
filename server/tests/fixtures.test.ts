/**
 * Runs every Test Lab fixture through the same runner the UI uses, and checks that every
 * seeded synthetic record routes as documented.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../db/database';
import { SEED_RECORDS } from '../db/seed-data';
import { seedDemoData } from '../db/seed';
import { MockProvider } from '../services/ai/providers';
import { CareRouteService } from '../services/careroute-service';
import { TEST_CASES } from '../testing/fixtures';
import { runTestCase, summariseResults, type RunnerContext } from '../testing/runner';
import { makeService } from './helpers';

const ctx: RunnerContext = {
  sandbox: () => new CareRouteService(new Database(':memory:'), { aiProvider: new MockProvider('ok'), aiTimeoutMs: 300, emergencyInstruction: 'x' }),
  liveProvider: null,
  aiTimeoutMs: 300,
};

describe('Test Lab fixtures', () => {
  it('has at least 20 executable fixtures with unique IDs', () => {
    expect(TEST_CASES.filter((t) => t.kind !== 'ai-live').length).toBeGreaterThanOrEqual(20);
    expect(new Set(TEST_CASES.map((t) => t.id)).size).toBe(TEST_CASES.length);
  });

  for (const tc of TEST_CASES) {
    it(`${tc.id} — ${tc.title}`, async () => {
      const result = await runTestCase(tc, ctx);
      if (tc.kind === 'ai-live') {
        expect(result.status).toBe('skipped');
        return;
      }
      expect(result.failureReason).toBeNull();
      expect(result.status).toBe('passed');
    });
  }

  it('summary reports critical failures distinctly', () => {
    const s = summariseResults([
      { testId: 'A', title: '', category: '', status: 'passed', safetyCritical: true, criticalFailure: false, expected: {}, actual: {}, failureReason: null, durationMs: 1 },
      { testId: 'B', title: '', category: '', status: 'failed', safetyCritical: true, criticalFailure: true, expected: {}, actual: {}, failureReason: 'x', durationMs: 1 },
    ]);
    expect(s.overall).toBe('CRITICAL_FAILURE');
  });

  it('a missed emergency is marked critical even if the case was not flagged safety-critical', async () => {
    const tc = { ...TEST_CASES.find((t) => t.id === 'TC-01')!, safetyCritical: false, expected: { route: 'EMERGENCY_GUIDANCE' as const } };
    const r = await runTestCase(tc, ctx);
    expect(r.status).toBe('failed');
    expect(r.criticalFailure).toBe(true);
  });
});

describe('synthetic seed data', () => {
  it('every seeded record routes as documented and seeding is idempotent', async () => {
    const svc = makeService();
    expect(await seedDemoData(svc)).toBe(SEED_RECORDS.length);
    expect(await seedDemoData(svc)).toBe(0);
    for (const [i, s] of SEED_RECORDS.entries()) {
      const detail = svc.getCase(`SYN-${1001 + i}`);
      expect(detail.request.syntheticPatientId).toMatch(/^SYN-P-\d{4}$/);
      expect({ key: s.seedKey, route: detail.recommendation.recommendedRoute }).toEqual({ key: s.seedKey, route: s.expected });
    }
  });
});
