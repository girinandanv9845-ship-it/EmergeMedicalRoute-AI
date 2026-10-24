/**
 * Executes Test Lab fixtures against the REAL routing engine, AI boundary, schemas and services.
 * Nothing is hard-coded as passed: each result is computed from actual output.
 */
import { randomUUID } from 'node:crypto';
import { CreateRequestBodySchema, type Recommendation } from '../../shared/domain';
import type { Database } from '../db/database';
import { AppError } from '../errors';
import { getActivePolicy } from '../policies';
import { MockProvider, OllamaProvider, type AiProvider } from '../services/ai/providers';
import { assistantTurn } from '../services/assistant/assistant';
import type { CareRouteService } from '../services/careroute-service';
import { evaluateRequest } from '../services/routing/engine';
import { routeRequest } from '../services/routing/route-request';
import { BASE_INPUT, TEST_CASES, type ExpectedResult, type RoutingTestCase } from './fixtures';

export interface TestResult {
  testId: string;
  title: string;
  category: string;
  status: 'passed' | 'failed' | 'skipped';
  safetyCritical: boolean;
  criticalFailure: boolean;
  expected: ExpectedResult;
  actual: Record<string, unknown> | null;
  failureReason: string | null;
  durationMs: number;
}

export interface RunnerContext {
  /** Creates an isolated in-memory service (used for duplicate and override workflow tests). */
  sandbox: (provider?: AiProvider) => CareRouteService;
  liveProvider: AiProvider | null;
  aiTimeoutMs: number;
}

function compareRecommendation(expected: ExpectedResult, rec: Recommendation): string[] {
  const problems: string[] = [];
  if (expected.route && rec.recommendedRoute !== expected.route) problems.push(`expected route ${expected.route} but got ${rec.recommendedRoute}`);
  if (expected.notRoute && rec.recommendedRoute === expected.notRoute) problems.push(`route must not be ${expected.notRoute}`);
  for (const id of expected.mustIncludeRules ?? []) if (!rec.matchedRuleIds.includes(id)) problems.push(`expected rule ${id} to match`);
  for (const id of expected.mustExcludeRules ?? []) if (rec.matchedRuleIds.includes(id)) problems.push(`rule ${id} must not match`);
  if (expected.emergencyGuidance !== undefined && rec.emergencyGuidanceRequired !== expected.emergencyGuidance)
    problems.push(`expected emergencyGuidance=${expected.emergencyGuidance}`);
  if (expected.requiresHumanReview !== undefined && rec.requiresHumanReview !== expected.requiresHumanReview)
    problems.push(`expected requiresHumanReview=${expected.requiresHumanReview}`);
  if (expected.uncertaintyPresent !== undefined && rec.uncertainty.present !== expected.uncertaintyPresent)
    problems.push(`expected uncertainty.present=${expected.uncertaintyPresent}`);
  for (const f of expected.safetyFlags ?? []) if (!rec.safetyFlags.includes(f)) problems.push(`expected safety flag ${f}`);
  if (expected.aiStatus && rec.aiStatus !== expected.aiStatus) problems.push(`expected aiStatus ${expected.aiStatus} but got ${rec.aiStatus}`);
  return problems;
}

const summarise = (rec: Recommendation) => ({
  route: rec.recommendedRoute,
  matchedRuleIds: rec.matchedRuleIds,
  emergencyGuidance: rec.emergencyGuidanceRequired,
  requiresHumanReview: rec.requiresHumanReview,
  uncertaintyPresent: rec.uncertainty.present,
  safetyFlags: rec.safetyFlags,
  aiStatus: rec.aiStatus,
});

function engineInput(tc: RoutingTestCase) {
  const i = { ...BASE_INPUT, ...tc.input! };
  return { symptomDescription: i.symptomDescription, ageGroup: i.ageGroup, symptomOnset: i.symptomOnset, requestedUrgency: i.requestedUrgency, isFollowUp: i.isFollowUp };
}

async function execute(tc: RoutingTestCase, ctx: RunnerContext): Promise<{ status: TestResult['status']; actual: Record<string, unknown> | null; problems: string[] }> {
  const policy = getActivePolicy();
  switch (tc.kind) {
    case 'engine':
    case 'fault': {
      const rec = evaluateRequest(engineInput(tc), { policy, failRuleIds: tc.failRuleIds });
      return { status: 'passed', actual: summarise(rec), problems: compareRecommendation(tc.expected, rec) };
    }
    case 'ai': {
      const started = Date.now();
      const { recommendation } = await routeRequest(engineInput(tc), new MockProvider(tc.aiMode ?? 'ok'), { timeoutMs: Math.min(ctx.aiTimeoutMs, 1500), policy });
      const actual = { ...summarise(recommendation), elapsedMs: Date.now() - started };
      const problems = compareRecommendation(tc.expected, recommendation);
      if (tc.expected.emergencyGuidance && actual.elapsedMs > 500) problems.push('emergency result was delayed by AI processing');
      return { status: 'passed', actual, problems };
    }
    case 'ai-live': {
      if (!ctx.liveProvider || !ctx.liveProvider.isEnabled()) return { status: 'skipped', actual: { reason: 'No local AI provider configured (set AI_PROVIDER=ollama).' }, problems: [] };
      const probe = ctx.liveProvider.checkStatus ? await ctx.liveProvider.checkStatus() : null;
      if (probe && probe.state !== 'available') return { status: 'skipped', actual: { reason: `Local AI not available: ${probe.detail}` }, problems: [] };
      const { recommendation } = await routeRequest(engineInput(tc), ctx.liveProvider, { timeoutMs: ctx.aiTimeoutMs, policy });
      const problems = compareRecommendation(tc.expected, recommendation);
      if (recommendation.aiStatus !== 'used') problems.push(`live provider did not return usable output (aiStatus=${recommendation.aiStatus})`);
      return { status: 'passed', actual: summarise(recommendation), problems };
    }
    case 'assistant': {
      let chatCalled = false;
      const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/api/chat')) chatCalled = true;
        if (tc.ollamaReply === 'DOWN') throw new TypeError('fetch failed');
        if (tc.ollamaReply === 'HANG')
          return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
        const content = typeof tc.ollamaReply === 'string' ? tc.ollamaReply : JSON.stringify(tc.ollamaReply);
        return new Response(JSON.stringify({ message: { role: 'assistant', content } }), { status: 200 });
      }) as unknown as typeof fetch;
      const provider = new OllamaProvider('http://localhost:11434', 'llama3.2:3b (mocked)', fakeFetch);
      const turn = await assistantTurn({ messages: tc.chat, draft: {} }, { provider, timeoutMs: 1500, emergencyInstruction: 'Contact your local emergency services immediately.', today: '2026-10-24' });
      const r = turn.response;
      const actual = { assistantType: r.type, aiStatus: r.aiStatus, emergencyRuleIds: turn.emergencyRuleIds, modelCalled: chatCalled, reply: r.reply };
      const problems: string[] = [];
      const e = tc.expected;
      if (e.assistantType && r.type !== e.assistantType) problems.push(`expected assistant response type ${e.assistantType} but got ${r.type}`);
      if (e.aiStatus && r.aiStatus !== e.aiStatus) problems.push(`expected aiStatus ${e.aiStatus} but got ${r.aiStatus}`);
      for (const id of e.mustIncludeRules ?? []) if (!turn.emergencyRuleIds.includes(id)) problems.push(`expected rule ${id}`);
      if (e.modelMustNotBeCalled && chatCalled) problems.push('the local model was called during an emergency');
      if (e.replyMustNotMatch && new RegExp(e.replyMustNotMatch, 'i').test(r.reply)) problems.push('unsafe model text reached the requester');
      return { status: 'passed', actual, problems };
    }
    case 'schema': {
      const parsed = CreateRequestBodySchema.safeParse(tc.rawBody);
      const outcome = parsed.success ? 'accepted' : 'rejected';
      const actual = { outcome, errorCode: parsed.success ? null : 'VALIDATION_ERROR', issues: parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`) };
      const problems = outcome !== tc.expected.outcome ? [`expected ${tc.expected.outcome} but was ${outcome}`] : [];
      return { status: 'passed', actual, problems };
    }
    case 'duplicate': {
      const svc = ctx.sandbox();
      try {
        const body = { ...BASE_INPUT, ...tc.input, clientSubmissionId: randomUUID() };
        const first = await svc.createRequest(body, { skipDateValidation: true });
        const second = await svc.createRequest(body, { skipDateValidation: true });
        const count = svc.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM appointment_requests')?.c ?? 0;
        const actual = { outcome: 'accepted', firstId: first.request.id, secondId: second.request.id, secondFlaggedDuplicate: second.duplicate, storedRequests: count };
        const problems: string[] = [];
        if (!second.duplicate) problems.push('second submission was not flagged as a duplicate');
        if (first.request.id !== second.request.id) problems.push('duplicate created a second request ID');
        if (count !== 1) problems.push(`expected 1 stored request but found ${count}`);
        return { status: 'passed', actual, problems };
      } finally {
        svc.db.close();
      }
    }
    case 'override': {
      const svc = ctx.sandbox();
      try {
        const created = await svc.createRequest({ ...BASE_INPUT, ...tc.input }, { skipDateValidation: true });
        let outcome: 'accepted' | 'rejected' = 'accepted';
        let errorCode: string | null = null;
        try {
          svc.override(created.request.id, tc.overrideBody, 'STAFF-DEMO-B');
        } catch (err) {
          outcome = 'rejected';
          errorCode = err instanceof AppError ? err.code : 'UNEXPECTED_ERROR';
        }
        const detail = svc.getCase(created.request.id);
        const actual = {
          outcome,
          errorCode,
          route: detail.recommendation.recommendedRoute,
          finalRoute: detail.request.finalRoute,
          reviewStatus: detail.request.reviewStatus,
          emergencyGuidance: detail.recommendation.emergencyGuidanceRequired,
          reviewsRecorded: detail.reviews.length,
        };
        const problems: string[] = [];
        if (outcome !== tc.expected.outcome) problems.push(`expected override to be ${tc.expected.outcome} but it was ${outcome}`);
        if (tc.expected.errorCode && errorCode !== tc.expected.errorCode) problems.push(`expected error ${tc.expected.errorCode} but got ${errorCode ?? 'none'}`);
        if (tc.expected.route && detail.recommendation.recommendedRoute !== tc.expected.route) problems.push('original recommendation was not preserved');
        if (tc.expected.emergencyGuidance && !detail.recommendation.emergencyGuidanceRequired) problems.push('emergency warning was not preserved');
        if (outcome === 'accepted' && detail.request.reviewStatus !== 'OVERRIDDEN') problems.push('review status not set to OVERRIDDEN');
        if (outcome === 'rejected' && detail.reviews.length !== 0) problems.push('a rejected override was persisted');
        return { status: 'passed', actual, problems };
      } finally {
        svc.db.close();
      }
    }
  }
}

export async function runTestCase(tc: RoutingTestCase, ctx: RunnerContext): Promise<TestResult> {
  const t0 = performance.now();
  let status: TestResult['status'];
  let actual: Record<string, unknown> | null = null;
  let problems: string[];
  try {
    const r = await execute(tc, ctx);
    actual = r.actual;
    problems = r.problems;
    status = r.status === 'skipped' ? 'skipped' : problems.length ? 'failed' : 'passed';
  } catch (err) {
    status = 'failed';
    problems = [`test threw: ${err instanceof Error ? err.message : String(err)}`];
  }
  const emergencyMiss = tc.expected.route === 'EMERGENCY_GUIDANCE' && actual?.route !== 'EMERGENCY_GUIDANCE' && status === 'failed';
  return {
    testId: tc.id,
    title: tc.title,
    category: tc.category,
    status,
    safetyCritical: tc.safetyCritical,
    criticalFailure: status === 'failed' && (tc.safetyCritical || emergencyMiss),
    expected: tc.expected,
    actual,
    failureReason: status === 'failed' ? problems.join('; ') : null,
    durationMs: Math.round((performance.now() - t0) * 100) / 100,
  };
}

export async function runTests(ids: string[] | 'all', ctx: RunnerContext): Promise<TestResult[]> {
  const cases = ids === 'all' ? TEST_CASES : TEST_CASES.filter((t) => ids.includes(t.id));
  const results: TestResult[] = [];
  for (const tc of cases) results.push(await runTestCase(tc, ctx));
  return results;
}

export function persistTestRun(db: Database, results: TestResult[], at: string): string {
  const runId = `RUN-${at.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 4)}`;
  const version = getActivePolicy().version;
  db.transaction(() => {
    for (const r of results) {
      db.run(
        `INSERT INTO test_runs (run_id, test_id, title, category, status, safety_critical, critical_failure, expected_result, actual_result, failure_reason, policy_version, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        runId, r.testId, r.title, r.category, r.status, r.safetyCritical ? 1 : 0, r.criticalFailure ? 1 : 0,
        JSON.stringify(r.expected), r.actual ? JSON.stringify(r.actual) : null, r.failureReason, version, r.durationMs, at,
      );
    }
  });
  return runId;
}

export function summariseResults(results: TestResult[]) {
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const criticalFailures = results.filter((r) => r.criticalFailure).length;
  return {
    total: results.length,
    passed,
    failed,
    skipped,
    criticalFailures,
    overall: criticalFailures > 0 ? 'CRITICAL_FAILURE' : failed > 0 ? 'FAILED' : 'PASSED',
    note: 'Passing synthetic tests does not establish clinical safety.',
  };
}
