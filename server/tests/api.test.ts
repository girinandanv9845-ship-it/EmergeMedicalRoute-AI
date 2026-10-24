import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedDemoData } from '../db/seed';
import { MockProvider } from '../services/ai/providers';
import type { CareRouteService } from '../services/careroute-service';
import { makeService, validBody } from './helpers';

let service: CareRouteService;
let app: ReturnType<typeof createApp>;
const STAFF = { 'x-demo-staff-id': 'STAFF-DEMO-B' };

function build(provider = undefined as MockProvider | undefined) {
  service = makeService(provider);
  app = createApp({ service, liveAiProvider: null, rateLimitPerMinute: 10_000 });
}

beforeEach(() => build());

describe('health, config and policy', () => {
  it('reports system status', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', database: true, ruleEngine: true, policyVersion: 'demo-policy-1.0' });
    expect(res.body.ai.label).toBe('AI interpretation is disabled. Deterministic demonstration policy is active.');
  });

  it('serves the active policy and stored versions', async () => {
    const res = await request(app).get('/api/policy').expect(200);
    expect(res.body.label).toMatch(/^DEMO POLICY/);
    expect(res.body.rules.length).toBeGreaterThan(20);
    await request(app).get('/api/policy/demo-policy-1.0').expect(200);
    await request(app).get('/api/policy/nope').expect(404);
  });

  it('does not expose secrets in config', async () => {
    const res = await request(app).get('/api/config').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/api[_-]?key/i);
  });
});

describe('POST /api/requests', () => {
  it('creates, routes and persists a request with the correct structure', async () => {
    const res = await request(app).post('/api/requests').send(validBody({ symptomDescription: 'My cough is getting worse' })).expect(201);
    expect(res.body.request.id).toMatch(/^SYN-\d+$/);
    expect(res.body.request.syntheticPatientId).toMatch(/^SYN-P-\d{4}$/);
    expect(res.body.recommendation).toMatchObject({
      recommendedRoute: 'SAME_DAY_HUMAN_REVIEW',
      matchedRuleIds: ['SAMEDAY-WORSEN-01'],
      policyVersion: 'demo-policy-1.0',
      aiStatus: 'disabled',
      requiresHumanReview: true,
    });
    const detail = await request(app).get(`/api/requests/${res.body.request.id}`).expect(200);
    expect(detail.body.recommendation.id).toBe(res.body.recommendation.id);
    expect(detail.body.audit.map((a: { eventType: string }) => a.eventType)).toEqual(['REQUEST_CREATED', 'ROUTING_EVALUATED']);
  });

  it('returns emergency guidance immediately and audits the matched rule', async () => {
    const res = await request(app).post('/api/requests').send(validBody({ symptomDescription: 'I cannot breathe', requestedUrgency: 'URGENT' })).expect(201);
    expect(res.body.recommendation.emergencyGuidanceRequired).toBe(true);
    const audit = await request(app).get(`/api/audit?eventType=EMERGENCY_RULE_MATCHED`).expect(200);
    expect(audit.body.items[0]).toMatchObject({ requestId: res.body.request.id, matchedRuleIds: ['EMERG-BREATH-01'] });
    expect(audit.body.items[0].description).toMatch(/did NOT contact emergency services/);
  });

  it('never trusts a client-supplied route', async () => {
    const res = await request(app).post('/api/requests').send({ ...validBody(), recommendedRoute: 'ROUTINE_APPOINTMENT' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['empty description', { symptomDescription: '' }],
    ['whitespace description', { symptomDescription: '   ' }],
    ['overlong description', { symptomDescription: 'x'.repeat(5001) }],
    ['invalid age group', { ageGroup: 'TEEN' }],
    ['impossible date', { preferredDate: '2026-02-30' }],
    ['past date', { preferredDate: '2020-01-01' }],
    ['date too far ahead', { preferredDate: '2099-01-01' }],
  ])('rejects %s', async (_label, patch) => {
    const res = await request(app).post('/api/requests').send(validBody(patch)).expect(400);
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    await request(app).post('/api/requests').set('content-type', 'application/json').send('{"oops"').expect(400);
    await request(app).post('/api/requests').send({ symptomDescription: 'x'.repeat(40_000) }).expect(413);
  });

  it('prevents duplicate submissions with the same idempotency key', async () => {
    const body = validBody({ clientSubmissionId: '2b4f9a3e-7c1d-4f6a-9e2b-1a2b3c4d5e6f' });
    const first = await request(app).post('/api/requests').send(body).expect(201);
    const second = await request(app).post('/api/requests').send(body).expect(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.request.id).toBe(first.body.request.id);
    const list = await request(app).get('/api/requests').expect(200);
    expect(list.body.total).toBe(1);
  });

  it('stores symptom text as data (no HTML interpretation server-side)', async () => {
    const res = await request(app).post('/api/requests').send(validBody({ symptomDescription: '<img src=x onerror=alert(1)> flu shot please' })).expect(201);
    expect(res.body.request.symptomDescription).toBe('<img src=x onerror=alert(1)> flu shot please');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('AI provider behaviour through the API', () => {
  it('continues deterministically when the provider is unavailable and audits it', async () => {
    build(new MockProvider('unavailable'));
    const res = await request(app).post('/api/requests').send(validBody({ symptomDescription: 'My cough is getting worse' })).expect(201);
    expect(res.body.recommendation).toMatchObject({ recommendedRoute: 'SAME_DAY_HUMAN_REVIEW', aiStatus: 'unavailable' });
    const audit = await request(app).get('/api/audit?eventType=AI_PROVIDER_UNAVAILABLE').expect(200);
    expect(audit.body.total).toBe(1);
  });

  it('rejects malformed AI output and keeps the deterministic route', async () => {
    build(new MockProvider('malformed'));
    const res = await request(app).post('/api/requests').send(validBody()).expect(201);
    expect(res.body.recommendation).toMatchObject({ recommendedRoute: 'ROUTINE_APPOINTMENT', aiStatus: 'malformed_rejected', aiInterpretation: null });
  });
});

describe('queue', () => {
  beforeEach(async () => {
    await seedDemoData(service);
  });

  it('filters by route, status, uncertainty and AI status, and searches IDs', async () => {
    const em = await request(app).get('/api/requests?route=EMERGENCY_GUIDANCE&pageSize=100').expect(200);
    expect(em.body.total).toBeGreaterThan(0);
    expect(em.body.items.every((i: { recommendedRoute: string }) => i.recommendedRoute === 'EMERGENCY_GUIDANCE')).toBe(true);
    const ov = await request(app).get('/api/requests?reviewStatus=OVERRIDDEN').expect(200);
    expect(ov.body.items.every((i: { reviewStatus: string }) => i.reviewStatus === 'OVERRIDDEN')).toBe(true);
    const unc = await request(app).get('/api/requests?uncertainty=yes&pageSize=100').expect(200);
    expect(unc.body.items.every((i: { uncertaintyPresent: boolean }) => i.uncertaintyPresent)).toBe(true);
    const ai = await request(app).get('/api/requests?aiStatus=unavailable').expect(200);
    expect(ai.body.total).toBe(1);
    const s = await request(app).get('/api/requests?search=SYN-P-2003').expect(200);
    expect(s.body.total).toBe(2);
    const byId = await request(app).get('/api/requests?search=SYN-1005').expect(200);
    expect(byId.body.items[0].id).toBe('SYN-1005');
  });

  it('sorts by priority with emergencies first and paginates', async () => {
    const res = await request(app).get('/api/requests?sort=priority&pageSize=5&page=1').expect(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.items[0].recommendedRoute).toBe('EMERGENCY_GUIDANCE');
    await request(app).get('/api/requests?route=NOPE').expect(400);
  });

  it('dashboard and analytics are computed from persisted records', async () => {
    const d = await request(app).get('/api/dashboard/summary').expect(200);
    expect(d.body.totals.total).toBe(32);
    expect(d.body.routeDistribution.reduce((n: number, r: { count: number }) => n + r.count, 0)).toBe(32);
    const a = await request(app).get('/api/analytics/summary').expect(200);
    expect(a.body.overrides.count).toBe(3);
    expect(a.body.disclaimer).toMatch(/not evidence of clinical effectiveness/);
  });
});

describe('staff review and overrides', () => {
  let id: string;
  beforeEach(async () => {
    const res = await request(app).post('/api/requests').send(validBody({ symptomDescription: 'My cough is getting worse' }));
    id = res.body.request.id;
  });

  it('requires a demo staff identity', async () => {
    const res = await request(app).post(`/api/requests/${id}/review`).send({ action: 'APPROVE' }).expect(401);
    expect(res.body.error.code).toBe('STAFF_IDENTITY_REQUIRED');
  });

  it('approves a recommendation', async () => {
    const res = await request(app).post(`/api/requests/${id}/review`).set(STAFF).send({ action: 'APPROVE' }).expect(200);
    expect(res.body.request).toMatchObject({ reviewStatus: 'APPROVED', finalRoute: 'SAME_DAY_HUMAN_REVIEW', assignedStaffId: 'STAFF-DEMO-B' });
  });

  it('rejects an override with a missing or short reason', async () => {
    await request(app).post(`/api/requests/${id}/override`).set(STAFF).send({ finalRoute: 'ROUTINE_APPOINTMENT' }).expect(400);
    const res = await request(app).post(`/api/requests/${id}/override`).set(STAFF).send({ finalRoute: 'ROUTINE_APPOINTMENT', reason: 'short' }).expect(400);
    expect(res.body.error.details[0].path).toBe('reason');
    const detail = await request(app).get(`/api/requests/${id}`);
    expect(detail.body.reviews).toHaveLength(0);
  });

  it('rejects an override to the same route', async () => {
    const res = await request(app).post(`/api/requests/${id}/override`).set(STAFF).send({ finalRoute: 'SAME_DAY_HUMAN_REVIEW', reason: 'This reason is long enough.' }).expect(400);
    expect(res.body.error.code).toBe('OVERRIDE_SAME_ROUTE');
  });

  it('records a valid override and preserves the original recommendation', async () => {
    const res = await request(app)
      .post(`/api/requests/${id}/override`)
      .set(STAFF)
      .send({ finalRoute: 'ROUTINE_APPOINTMENT', reason: 'Phoned requester; symptoms improving, routine slot agreed.' })
      .expect(200);
    expect(res.body.request).toMatchObject({ reviewStatus: 'OVERRIDDEN', finalRoute: 'ROUTINE_APPOINTMENT' });
    expect(res.body.recommendation.recommendedRoute).toBe('SAME_DAY_HUMAN_REVIEW');
    expect(res.body.reviews[0]).toMatchObject({ action: 'OVERRIDE', originalRoute: 'SAME_DAY_HUMAN_REVIEW', finalRoute: 'ROUTINE_APPOINTMENT', staffActorId: 'STAFF-DEMO-B', policyVersion: 'demo-policy-1.0' });
    const history = await request(app).get(`/api/requests/${id}/history`).expect(200);
    expect(history.body.audit.map((a: { eventType: string }) => a.eventType)).toContain('STAFF_OVERRIDE_SUBMITTED');
  });

  it('emergency overrides require acknowledgement and keep the warning', async () => {
    const em = await request(app).post('/api/requests').send(validBody({ symptomDescription: 'He is unconscious' }));
    const eid = em.body.request.id;
    const body = { finalRoute: 'SAME_DAY_HUMAN_REVIEW', reason: 'Emergency services already attended per caller.' };
    const rej = await request(app).post(`/api/requests/${eid}/override`).set(STAFF).send(body).expect(400);
    expect(rej.body.error.code).toBe('EMERGENCY_ACK_REQUIRED');
    const ok = await request(app).post(`/api/requests/${eid}/override`).set(STAFF).send({ ...body, acknowledgeEmergencyWarning: true }).expect(200);
    expect(ok.body.recommendation.emergencyGuidanceRequired).toBe(true);
    expect(ok.body.request.finalRoute).toBe('SAME_DAY_HUMAN_REVIEW');
  });
});

describe('audit log integrity', () => {
  it('audit events cannot be updated or deleted', async () => {
    await request(app).post('/api/requests').send(validBody());
    expect(() => service.db.run("UPDATE audit_events SET description = 'tampered'")).toThrow(/append-only/);
    expect(() => service.db.run('DELETE FROM audit_events')).toThrow(/append-only/);
    expect(() => service.db.run("UPDATE routing_recommendations SET recommended_route = 'ROUTINE_APPOINTMENT'")).toThrow(/immutable/);
  });

  it('audit messages do not copy full symptom descriptions', async () => {
    const text = 'Unique synthetic marker phrase zebra-umbrella getting worse';
    await request(app).post('/api/requests').send(validBody({ symptomDescription: text }));
    const audit = await request(app).get('/api/audit?pageSize=200').expect(200);
    expect(JSON.stringify(audit.body)).not.toContain('zebra-umbrella');
  });
});

describe('demo reset', () => {
  it('requires the exact confirmation phrase', async () => {
    await seedDemoData(service);
    await request(app).post('/api/demo/reset').send({ confirm: 'yes' }).expect(400);
    const list = await request(app).get('/api/requests').expect(200);
    expect(list.body.total).toBe(32);
  });

  it('removes only synthetic data, reseeds, and keeps the audit history', async () => {
    await seedDemoData(service);
    await request(app).post('/api/requests').send(validBody());
    const before = (await request(app).get('/api/audit')).body.total;
    const res = await request(app).post('/api/demo/reset').send({ confirm: 'RESET SYNTHETIC DEMO DATA' }).expect(200);
    expect(res.body).toEqual({ deleted: 33, seeded: 32 });
    const after = await request(app).get('/api/audit?eventType=DEMO_DATA_RESET').expect(200);
    expect(after.body.total).toBe(1);
    expect((await request(app).get('/api/audit')).body.total).toBeGreaterThan(before);
    // Policy versions and test runs are not synthetic request data and are kept.
    expect(service.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM policy_versions')?.c).toBe(1);
  });
});

describe('test lab API', () => {
  it('runs all tests against the real engine and persists results', async () => {
    const res = await request(app).post('/api/tests/run').expect(200);
    expect(res.body.summary.criticalFailures).toBe(0);
    expect(res.body.summary.failed).toBe(0);
    expect(res.body.summary.skipped).toBe(1);
    const latest = await request(app).get('/api/tests').expect(200);
    expect(latest.body.latestRun.results.length).toBe(res.body.results.length);
    const analytics = await request(app).get('/api/analytics/summary').expect(200);
    expect(analytics.body.tests.routeEvaluation.emergencyFalseNegatives).toBe(0);
  });

  it('runs a single test', async () => {
    const res = await request(app).post('/api/tests/run/TC-06').expect(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ testId: 'TC-06', status: 'passed', safetyCritical: true });
    await request(app).post('/api/tests/run/TC-99').expect(404);
  });
});

describe('failure handling', () => {
  it('a database failure never produces a fabricated success', async () => {
    service.db.close();
    const res = await request(app).post('/api/requests').send(validBody());
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/Nothing was saved/);
    const h = await request(app).get('/api/health');
    expect(h.status).toBe(503);
    expect(h.body.database).toBe(false);
  });

  it('unknown endpoints return 404 JSON', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rate limits excessive writes', async () => {
    service = makeService();
    app = createApp({ service, liveAiProvider: null, rateLimitPerMinute: 2 });
    await request(app).post('/api/requests').send(validBody());
    await request(app).post('/api/requests').send(validBody());
    await request(app).post('/api/requests').send(validBody()).expect(429);
  });
});
