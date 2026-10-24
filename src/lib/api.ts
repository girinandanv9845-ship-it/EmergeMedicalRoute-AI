/**
 * Typed HTTP client for the EmergeMedicalRoute API. All data comes from the backend over real HTTP;
 * nothing is simulated in browser state. No secrets ever live in the frontend.
 */
import type { ApiErrorBody, AppointmentRequestView, AuditEventView, CaseDetail, Paginated, QueueItem, Recommendation, Route } from '../../shared/domain';
import type { RoutingPolicy } from '../../shared/policy-types';
import type { AssistantDraft, AssistantResponse, ChatMessage } from '../../shared/assistant';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

let staffId: string | null = null;
export function setApiStaffId(id: string | null) {
  staffId = id;
}

export async function apiFetch<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (staffId) headers.set('x-demo-staff-id', staffId);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the EmergeMedicalRoute backend. Your request has NOT been processed. Check that the API server is running.');
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? (res.status >= 500 ? 'The server could not complete the request. Nothing was saved.' : `Request failed (${res.status}).`),
      err?.details ?? [],
    );
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------
export interface Health {
  status: 'ok' | 'degraded';
  backend: boolean;
  database: boolean;
  ruleEngine: boolean;
  ai: AiStatusView;
  policyVersion: string;
  policyLabel: string;
  time: string;
}

export interface AiStatusView {
  provider: string;
  name: string;
  enabled: boolean;
  /** True only when the backend has verified the provider is reachable and the model is installed. */
  verified: boolean;
  state: 'disabled' | 'available' | 'unavailable' | 'model_missing' | 'misconfigured';
  detail: string;
  model: string | null;
  checkedAt: string | null;
  lastSuccessAt: string | null;
  lastSuccessLatencyMs: number | null;
  lastFailureAt: string | null;
  lastFailureStatus: string | null;
  label: string;
}

export interface AppConfigView {
  emergencyInstruction: string;
  demoStaff: { id: string; label: string }[];
  policyVersion: string;
  policyLabel: string;
  resetConfirmation: string;
  today: string;
  demoMode: string;
}

export interface VolumePoint {
  date: string;
  total: number;
  emergency: number;
  sameDay: number;
  clarification: number;
  routine: number;
}

export interface DashboardSummary {
  totals: { total: number; awaitingReview: number; routine: number; sameDay: number; emergency: number; clarification: number; overrides: number; uncertain: number; aiFailures: number };
  routeDistribution: { route: Route; count: number }[];
  requestsOverTime: VolumePoint[];
  priorityQueue: QueueItem[];
  recentActivity: AuditEventView[];
  safetyEvents: { id: number; eventType: string; requestId: string | null; description: string; createdAt: string }[];
  overrideSummary: {
    byTransition: { from: Route; to: Route; count: number }[];
    recent: { requestId: string; from: Route; to: Route; staffId: string; createdAt: string }[];
  };
  system: Health;
}

export interface TestCaseView {
  id: string;
  title: string;
  category: string;
  kind: string;
  safetyCritical: boolean;
  description: string;
  input?: { symptomDescription: string } & Record<string, unknown>;
  rawBody?: unknown;
  aiMode?: string;
  expected: Record<string, unknown> & { route?: Route };
}

export interface TestResultView {
  testId: string;
  title: string;
  category: string;
  status: 'passed' | 'failed' | 'skipped';
  safetyCritical: boolean;
  criticalFailure: boolean;
  expected: Record<string, unknown>;
  actual: Record<string, unknown> | null;
  failureReason: string | null;
  durationMs: number;
}

export interface TestRunResponse {
  runId: string;
  createdAt: string;
  summary: { total: number; passed: number; failed: number; skipped: number; criticalFailures: number; overall: 'PASSED' | 'FAILED' | 'CRITICAL_FAILURE'; note: string };
  results: TestResultView[];
}

export interface AnalyticsSummary {
  totalRequests: number;
  byRoute: { route: Route; count: number }[];
  byStatus: { status: string; count: number }[];
  overrides: { count: number; decidedCount: number; rate: number | null; rateDefinition: string };
  uncertainty: { count: number; fallbackRouteCount: number };
  ruleActivations: { ruleId: string; count: number }[];
  aiStatusCounts: { status: string; count: number }[];
  aiFailureCount: number;
  volume: VolumePoint[];
  tests: null | {
    runId: string;
    createdAt: string;
    passed: number;
    failed: number;
    skipped: number;
    criticalFailures: number;
    routeEvaluation: {
      denominator: number;
      denominatorDefinition: string;
      correct: number;
      incorrect: number;
      emergencyExpected: number;
      emergencyFalseNegatives: number;
      emergencyFalsePositives: number;
      sameDayMismatches: number;
      routineMismatches: number;
      matrix: ({ expected: Route } & Record<Route, number>)[];
    };
    emergencyOutcomes: { testId: string; title: string; status: string; actualRoute: string | null }[];
  };
  disclaimer: string;
}

export interface CreateResponse {
  request: AppointmentRequestView;
  recommendation: Recommendation & { id: string; createdAt: string };
  duplicate: boolean;
}

export type PolicyResponse = RoutingPolicy & { availableVersions: string[]; storedVersions: { version: string; policyName: string; createdAt: string }[] };

export const api = {
  health: () => apiFetch<Health>('/health'),
  config: () => apiFetch<AppConfigView>('/config'),
  aiStatus: (refresh = false) => apiFetch<AiStatusView & { dataNotice: string | null; boundary: string[] }>(`/ai/status${refresh ? '?refresh=true' : ''}`),
  testAi: () =>
    apiFetch<{ probe: { state: string; detail: string }; outcome: null | { status: string; note: string | null; latencyMs?: number; interpretation: { plainLanguageSummary: string; suggestedRoute?: string } | null } }>(
      '/ai/test',
      { method: 'POST' },
    ),
  dashboard: () => apiFetch<DashboardSummary>('/dashboard/summary'),
  analytics: () => apiFetch<AnalyticsSummary>('/analytics/summary'),
  queue: (params: URLSearchParams) => apiFetch<Paginated<QueueItem>>(`/requests?${params.toString()}`),
  patients: () => apiFetch<{ items: { syntheticPatientId: string; requestCount: number }[] }>('/patients'),
  createRequest: (body: unknown) => apiFetch<CreateResponse>('/requests', { method: 'POST', json: body }),
  getCase: (id: string) => apiFetch<CaseDetail>(`/requests/${encodeURIComponent(id)}`),
  review: (id: string, body: unknown) => apiFetch<CaseDetail>(`/requests/${encodeURIComponent(id)}/review`, { method: 'POST', json: body }),
  override: (id: string, body: unknown) => apiFetch<CaseDetail>(`/requests/${encodeURIComponent(id)}/override`, { method: 'POST', json: body }),
  policy: () => apiFetch<PolicyResponse>('/policy'),
  audit: (params: URLSearchParams) => apiFetch<Paginated<AuditEventView> & { eventTypes: string[] }>(`/audit?${params.toString()}`),
  tests: () => apiFetch<{ cases: TestCaseView[]; latestRun: { runId: string; createdAt: string; results: TestResultView[] } | null }>('/tests'),
  runAllTests: () => apiFetch<TestRunResponse>('/tests/run', { method: 'POST' }),
  runTest: (id: string) => apiFetch<TestRunResponse>(`/tests/run/${encodeURIComponent(id)}`, { method: 'POST' }),
  assistantChat: (messages: ChatMessage[], draft: AssistantDraft) => apiFetch<AssistantResponse>('/assistant/chat', { method: 'POST', json: { messages, draft } }),
  resetDemo: (confirm: string) => apiFetch<{ deleted: number; seeded: number }>('/demo/reset', { method: 'POST', json: { confirm } }),
};
