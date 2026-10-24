import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { AI_STATUSES, DEMO_STAFF, REVIEW_STATUSES, RouteSchema, type ApiErrorBody } from '../shared/domain';
import { Database } from './db/database';
import { seedDemoData } from './db/seed';
import { AppError, notFound, validationError } from './errors';
import { rateLimit } from './middleware/rate-limit';
import { getActivePolicy, listPolicyVersions } from './policies';
import * as repo from './repositories';
import { MockProvider, type AiProvider } from './services/ai/providers';
import { assistantTurn } from './services/assistant/assistant';
import { CareRouteService, RESET_CONFIRMATION } from './services/careroute-service';
import { TEST_CASES } from './testing/fixtures';
import { persistTestRun, runTests, summariseResults, type RunnerContext } from './testing/runner';

export interface AppDeps {
  service: CareRouteService;
  liveAiProvider: AiProvider | null;
  rateLimitPerMinute: number;
}

const QueueQuerySchema = z.object({
  search: z.string().trim().max(40).optional(),
  route: RouteSchema.optional(),
  reviewStatus: z.enum(REVIEW_STATUSES).optional(),
  uncertainty: z.enum(['yes', 'no']).optional(),
  aiStatus: z.enum(AI_STATUSES).optional(),
  emergencyOnly: z.enum(['true', 'false']).optional(),
  overriddenOnly: z.enum(['true', 'false']).optional(),
  sort: z.enum(['date_desc', 'date_asc', 'priority']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const AuditQuerySchema = z.object({
  requestId: z.string().trim().max(40).optional(),
  eventType: z.string().trim().max(60).optional(),
  actorType: z.enum(['system', 'staff', 'requester', 'ai_provider']).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const RequestIdParam = z.string().regex(/^SYN-\d{4,6}$/, 'Request IDs look like SYN-1001');

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export function createApp(deps: AppDeps) {
  const { service } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Every endpoint is guarded when the database connection is gone, so nothing is falsely confirmed.
  app.use('/api', (req, _res, next) => {
    if (!service.db.isOpen && req.path !== '/health') return next(new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is unavailable. Nothing was saved.'));
    next();
  });
  const writeLimiter = rateLimit(deps.rateLimitPerMinute);

  const runnerContext: RunnerContext = {
    sandbox: (provider) =>
      new CareRouteService(new Database(':memory:'), {
        aiProvider: provider ?? new MockProvider('ok'),
        aiTimeoutMs: 1000,
        emergencyInstruction: service.options.emergencyInstruction,
      }),
    liveProvider: deps.liveAiProvider,
    aiTimeoutMs: service.options.aiTimeoutMs,
  };

  // ---------------------------------------------------------------- health & config
  app.get('/api/health', (_req, res) => {
    const h = service.health();
    res.status(h.database ? 200 : 503).json(h);
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      emergencyInstruction: service.options.emergencyInstruction,
      demoStaff: DEMO_STAFF,
      policyVersion: getActivePolicy().version,
      policyLabel: getActivePolicy().label,
      resetConfirmation: RESET_CONFIRMATION,
      today: service.today(),
      demoMode: 'DEMO MODE — SYNTHETIC DATA ONLY',
    });
  });

  app.get('/api/ai/status', async (req, res) => {
    if (req.query.refresh === 'true') await service.refreshAiStatus();
    const h = service.health();
    res.json({
      ...h.ai,
      dataNotice: h.ai.provider === 'ollama' ? 'AI runs locally through Ollama on this machine. Synthetic text is not sent to any external AI service.' : null,
      boundary: [
        'AI output is validated against a strict JSON schema; invalid output is rejected.',
        'AI cannot override a mandatory emergency rule and is skipped entirely when one matches.',
        'AI may only escalate a case to human review; it never downgrades or produces the authoritative route.',
        'If the AI provider fails or times out, deterministic routing continues.',
      ],
    });
  });

  app.post('/api/ai/test', writeLimiter, async (_req, res) => {
    res.json(await service.testAiProvider());
  });

  // ---------------------------------------------------------------- AI intake assistant (local Ollama only)
  app.post('/api/assistant/chat', writeLimiter, async (req, res) => {
    const turn = await assistantTurn(req.body, {
      provider: service.options.aiProvider,
      timeoutMs: service.options.aiTimeoutMs,
      emergencyInstruction: service.options.emergencyInstruction,
      today: service.today(),
    });
    repo.appendAudit(service.db, {
      eventType: turn.response.type === 'emergency' ? 'ASSISTANT_EMERGENCY_DETECTED' : 'ASSISTANT_CHAT_TURN',
      actorType: turn.response.type === 'emergency' ? 'system' : 'ai_provider',
      actorId: turn.response.model ? `ollama (${turn.response.model})` : null,
      policyVersion: getActivePolicy().version,
      matchedRuleIds: turn.emergencyRuleIds,
      description: turn.auditNote,
      createdAt: service.iso(),
    });
    res.json(turn.response);
  });

  // ---------------------------------------------------------------- dashboard & analytics
  app.get('/api/dashboard/summary', (_req, res) => res.json(service.dashboardSummary()));
  app.get('/api/analytics/summary', (_req, res) => res.json(service.analyticsSummary()));

  // ---------------------------------------------------------------- requests
  app.get('/api/requests', (req, res) => {
    const q = parse(QueueQuerySchema, req.query);
    res.json(
      service.listQueue({
        ...q,
        emergencyOnly: q.emergencyOnly === 'true',
        overriddenOnly: q.overriddenOnly === 'true',
      }),
    );
  });

  app.post('/api/requests', writeLimiter, async (req, res) => {
    const result = await service.createRequest(req.body);
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  app.get('/api/patients', (_req, res) => {
    res.json({ items: repo.listPatients(service.db), nextNewPatientHint: 'A new synthetic patient ID is generated by the server when none is selected.' });
  });

  app.get('/api/requests/:id', (req, res) => {
    res.json(service.getCase(parse(RequestIdParam, req.params.id)));
  });

  app.get('/api/requests/:id/history', (req, res) => {
    const detail = service.getCase(parse(RequestIdParam, req.params.id));
    res.json({ requestId: detail.request.id, originalRecommendation: detail.recommendation, reviews: detail.reviews, audit: detail.audit });
  });

  app.post('/api/requests/:id/review', writeLimiter, (req, res) => {
    res.json(service.review(parse(RequestIdParam, req.params.id), req.body, req.header('x-demo-staff-id')));
  });

  app.post('/api/requests/:id/override', writeLimiter, (req, res) => {
    res.json(service.override(parse(RequestIdParam, req.params.id), req.body, req.header('x-demo-staff-id')));
  });

  // ---------------------------------------------------------------- policy
  app.get('/api/policy', (_req, res) => {
    res.json({ ...getActivePolicy(), availableVersions: listPolicyVersions(), storedVersions: repo.listStoredPolicyVersions(service.db) });
  });

  app.get('/api/policy/:version', (req, res) => {
    const version = parse(z.string().max(40), req.params.version);
    const stored = repo.getStoredPolicy(service.db, version);
    if (!stored) throw notFound(`Policy version ${version}`);
    res.json(stored);
  });

  // ---------------------------------------------------------------- audit
  app.get('/api/audit', (req, res) => {
    const q = parse(AuditQuerySchema, req.query);
    const { items, total } = repo.listAudit(service.db, q);
    res.json({ items, total, page: q.page, pageSize: q.pageSize, eventTypes: repo.listAuditEventTypes(service.db) });
  });

  // ---------------------------------------------------------------- test lab
  app.get('/api/tests', (_req, res) => {
    res.json({ cases: TEST_CASES, latestRun: service.latestTestRun() });
  });

  const runAndPersist = async (ids: string[] | 'all') => {
    const results = await runTests(ids, runnerContext);
    const at = service.iso();
    const runId = persistTestRun(service.db, results, at);
    repo.appendAudit(service.db, {
      eventType: 'TEST_SUITE_RUN',
      actorType: 'staff',
      policyVersion: getActivePolicy().version,
      description: `Synthetic test run ${runId}: ${results.filter((r) => r.status === 'passed').length} passed, ${results.filter((r) => r.status === 'failed').length} failed, ${results.filter((r) => r.status === 'skipped').length} skipped, ${results.filter((r) => r.criticalFailure).length} critical.`,
      createdAt: at,
    });
    return { runId, createdAt: at, summary: summariseResults(results), results };
  };

  app.post('/api/tests/run', writeLimiter, async (_req, res) => {
    res.json(await runAndPersist('all'));
  });

  app.post('/api/tests/run/:testId', writeLimiter, async (req, res) => {
    const id = parse(z.string().regex(/^TC-\d{2}[A-Z]?$/), req.params.testId);
    if (!TEST_CASES.some((t) => t.id === id)) throw notFound(`Test case ${id}`);
    res.json(await runAndPersist([id]));
  });

  // ---------------------------------------------------------------- demo data
  app.post('/api/demo/reset', writeLimiter, async (req, res) => {
    const confirm = (req.body as { confirm?: unknown } | undefined)?.confirm;
    res.json(await service.resetDemoData(confirm, () => seedDemoData(service)));
  });

  // ---------------------------------------------------------------- errors
  app.use('/api', (_req, _res, next) => next(notFound('Endpoint')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    let status = 500;
    let body: ApiErrorBody;
    if (err instanceof AppError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, details: err.details } };
    } else if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
      status = 413;
      body = { error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' } };
    } else if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
      status = 400;
      body = { error: { code: 'MALFORMED_JSON', message: 'The request body is not valid JSON.' } };
    } else {
      // Do not leak internals (or request content) to the client.
      const isDb = err instanceof Error && /sqlite|database|constraint/i.test(`${err.name} ${err.message}`);
      body = {
        error: {
          code: isDb ? 'DATABASE_ERROR' : 'INTERNAL_ERROR',
          message: isDb ? 'A database error occurred. The action was NOT saved.' : 'An unexpected error occurred. The action was NOT completed.',
        },
      };
      console.error(`[error] ${err instanceof Error ? err.name + ': ' + err.message.slice(0, 200) : 'unknown error'}`);
    }
    res.status(status).json(body);
  });

  return app;
}
