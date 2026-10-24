// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, recommendation, renderAt, requestView } from '../test/utils';
import { CaseDetailsPage } from './CaseDetailsPage';
import { QueuePage } from './QueuePage';
import { TestLabPage } from './TestLabPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const queueItem = (o: Record<string, unknown> = {}) => ({
  ...requestView(),
  recommendedRoute: 'ROUTINE_APPOINTMENT',
  effectiveRoute: 'ROUTINE_APPOINTMENT',
  primaryRuleId: 'ROUTINE-ADMIN-01',
  matchedRuleIds: ['ROUTINE-ADMIN-01'],
  uncertaintyPresent: false,
  emergencyGuidanceRequired: false,
  aiStatus: 'disabled',
  policyVersion: 'demo-policy-1.0',
  ...o,
});

describe('QueuePage', () => {
  it('renders rows and sends filter parameters to the API', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/requests': (url) =>
        url.includes('route=EMERGENCY_GUIDANCE')
          ? { items: [queueItem({ id: 'SYN-1009', recommendedRoute: 'EMERGENCY_GUIDANCE', emergencyGuidanceRequired: true })], total: 1, page: 1, pageSize: 15 }
          : { items: [queueItem(), queueItem({ id: 'SYN-1041', uncertaintyPresent: true, recommendedRoute: 'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW' })], total: 2, page: 1, pageSize: 15 },
    });
    renderAt(<QueuePage />, '/queue');
    const table = await screen.findByTestId('queue-table');
    expect(within(table).getByText('SYN-1040')).toBeInTheDocument();
    expect(within(table).getByText('Uncertain')).toBeInTheDocument();
    expect(api.calls[0]!.url).toContain('sort=priority');

    await user.selectOptions(screen.getByLabelText('Filter by route'), 'EMERGENCY_GUIDANCE');
    await waitFor(() => expect(screen.getByText('SYN-1009')).toBeInTheDocument());
    expect(api.calls.at(-1)!.url).toContain('route=EMERGENCY_GUIDANCE');
    expect(screen.getByLabelText('Emergency guidance')).toBeInTheDocument();
  });

  it('shows an empty state when filters match nothing', async () => {
    mockApi({ 'GET /api/requests': () => ({ items: [], total: 0, page: 1, pageSize: 15 }) });
    renderAt(<QueuePage />, '/queue?reviewStatus=OVERRIDDEN');
    expect(await screen.findByText('No requests match these filters')).toBeInTheDocument();
  });

  it('shows an error state when the backend fails', async () => {
    mockApi({ 'GET /api/requests': () => new Response(JSON.stringify({ error: { code: 'DATABASE_ERROR', message: 'A database error occurred.' } }), { status: 500 }) });
    renderAt(<QueuePage />, '/queue');
    expect(await screen.findByText('A database error occurred.')).toBeInTheDocument();
  });
});

const emergencyCase = () => ({
  request: requestView({ id: 'SYN-1009', symptomDescription: '<b>Severe</b> chest pain spreading to my arm' }),
  recommendation: recommendation({
    requestId: 'SYN-1009',
    recommendedRoute: 'EMERGENCY_GUIDANCE',
    matchedRuleIds: ['EMERG-CHEST-01'],
    explanationPoints: ['EMERG-CHEST-01 — Sudden or severe chest pain → Emergency guidance'],
    emergencyGuidanceRequired: true,
    requiresHumanReview: true,
    safetyFlags: ['EMERGENCY_CHEST'],
  }),
  reviews: [],
  audit: [{ id: 1, eventType: 'REQUEST_CREATED', requestId: 'SYN-1009', policyVersion: 'demo-policy-1.0', actorType: 'requester', actorId: null, description: 'Submitted', matchedRuleIds: [], createdAt: '2026-10-24T10:00:00Z' }],
  emergencyInstruction: 'Contact your local emergency services immediately.',
});

describe('CaseDetailsPage', () => {
  it('shows the emergency banner, rules, explanation, and renders symptom text as plain text', async () => {
    mockApi({ 'GET /api/requests/SYN-1009': () => emergencyCase() });
    renderAt(<CaseDetailsPage />, '/cases/SYN-1009', '/cases/:id');
    expect(await screen.findByTestId('emergency-banner')).toBeInTheDocument();
    expect(screen.getAllByText('EMERG-CHEST-01').length).toBeGreaterThan(0);
    expect(screen.getByTestId('explanation')).toHaveTextContent(/not a medical diagnosis/);
    expect(screen.getByTestId('symptom-text').textContent).toBe('<b>Severe</b> chest pain spreading to my arm');
    expect(screen.getByTestId('symptom-text').querySelector('b')).toBeNull();
  });

  it('requires a reason and emergency acknowledgement before submitting an override', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/requests/SYN-1009': () => emergencyCase(),
      'POST /api/requests/SYN-1009/override': () => {
        const c = emergencyCase();
        return {
          ...c,
          request: { ...c.request, reviewStatus: 'OVERRIDDEN', finalRoute: 'SAME_DAY_HUMAN_REVIEW' },
          reviews: [
            {
              id: 'REV-1', requestId: 'SYN-1009', originalRecommendationId: 'REC-1', action: 'OVERRIDE', originalRoute: 'EMERGENCY_GUIDANCE', finalRoute: 'SAME_DAY_HUMAN_REVIEW',
              overrideReason: 'Emergency services already attended.', note: null, staffActorId: 'STAFF-DEMO-A', reviewStatus: 'OVERRIDDEN', policyVersion: 'demo-policy-1.0', safetyFlags: [], createdAt: '2026-10-24T11:00:00Z',
            },
          ],
        };
      },
    });
    renderAt(<CaseDetailsPage />, '/cases/SYN-1009', '/cases/:id');
    await user.click(await screen.findByRole('button', { name: /Override route/ }));
    await user.selectOptions(screen.getByLabelText('Final administrative route'), 'SAME_DAY_HUMAN_REVIEW');
    await user.click(screen.getByRole('button', { name: 'Submit override' }));
    expect(screen.getByText(/A reason of at least 10 characters is required/)).toBeInTheDocument();
    expect(screen.getByText('Confirm that the emergency warning remains in place')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(screen.getByLabelText(/Reason for override/), 'Emergency services already attended.');
    await user.click(screen.getByRole('checkbox', { name: /mandatory emergency rule/ }));
    await user.click(screen.getByRole('button', { name: 'Submit override' }));
    expect(await screen.findByText(/Override recorded/)).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ finalRoute: 'SAME_DAY_HUMAN_REVIEW', reason: 'Emergency services already attended.', acknowledgeEmergencyWarning: true });
    expect(post.headers.get('x-demo-staff-id')).toBe('STAFF-DEMO-A');
    // Emergency banner is preserved after the override
    expect(screen.getByTestId('emergency-banner')).toHaveTextContent(/does not remove the need for emergency care/);
    expect(within(screen.getByTestId('review-history')).getByText(/Emergency services already attended/)).toBeInTheDocument();
  });

  it('shows a not-found error', async () => {
    mockApi({ 'GET /api/requests/SYN-9999': () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Request SYN-9999 was not found.' } }), { status: 404 }) });
    renderAt(<CaseDetailsPage />, '/cases/SYN-9999', '/cases/:id');
    expect(await screen.findByText('Request SYN-9999 was not found.')).toBeInTheDocument();
  });
});

describe('TestLabPage', () => {
  const cases = [
    { id: 'TC-01', title: 'Complete routine request', category: 'Routine', kind: 'engine', safetyCritical: false, description: '', input: { symptomDescription: 'Annual check-up' }, expected: { route: 'ROUTINE_APPOINTMENT' } },
    { id: 'TC-06', title: 'Severe breathing difficulty', category: 'Emergency', kind: 'engine', safetyCritical: true, description: '', input: { symptomDescription: 'I cannot breathe' }, expected: { route: 'EMERGENCY_GUIDANCE' } },
    { id: 'TC-31', title: 'Live local AI', category: 'AI', kind: 'ai-live', safetyCritical: false, description: '', input: { symptomDescription: 'flu' }, expected: { route: 'ROUTINE_APPOINTMENT' } },
  ];
  const result = (testId: string, status: string, extra: Record<string, unknown> = {}) => ({ testId, title: testId, category: '', status, safetyCritical: false, criticalFailure: false, expected: {}, actual: null, failureReason: null, durationMs: 1, ...extra });

  it('distinguishes passed, skipped and safety-critical failures', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/tests': () => ({ cases, latestRun: null }),
      'POST /api/tests/run': () => ({
        runId: 'RUN-1',
        createdAt: '2026-10-24T10:00:00Z',
        summary: { total: 3, passed: 1, failed: 1, skipped: 1, criticalFailures: 1, overall: 'CRITICAL_FAILURE', note: '' },
        results: [
          result('TC-01', 'passed', { actual: { route: 'ROUTINE_APPOINTMENT' } }),
          result('TC-06', 'failed', { safetyCritical: true, criticalFailure: true, actual: { route: 'ROUTINE_APPOINTMENT' }, failureReason: 'expected route EMERGENCY_GUIDANCE but got ROUTINE_APPOINTMENT' }),
          result('TC-31', 'skipped', { actual: { reason: 'Local AI not available' } }),
        ],
      }),
    });
    renderAt(<TestLabPage />, '/tests');
    expect(await screen.findByText('Not yet run')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Run all tests/ }));
    expect(await screen.findByText('SAFETY-CRITICAL FAILURE')).toBeInTheDocument();
    expect(within(screen.getByTestId('test-row-TC-06')).getByText('Critical failure')).toBeInTheDocument();
    expect(within(screen.getByTestId('test-row-TC-06')).getByText(/expected route EMERGENCY_GUIDANCE/)).toBeInTheDocument();
    expect(within(screen.getByTestId('test-row-TC-01')).getByText('Passed')).toBeInTheDocument();
    expect(within(screen.getByTestId('test-row-TC-31')).getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText(/NOT considered passing/)).toBeInTheDocument();
  });

  it('runs a single test', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/tests': () => ({ cases, latestRun: null }),
      'POST /api/tests/run/TC-01': () => ({ runId: 'RUN-2', createdAt: '2026-10-24T10:00:00Z', summary: {}, results: [result('TC-01', 'passed', { actual: { route: 'ROUTINE_APPOINTMENT' } })] }),
    });
    renderAt(<TestLabPage />, '/tests');
    await user.click(await screen.findByRole('button', { name: 'Run TC-01' }));
    await waitFor(() => expect(within(screen.getByTestId('test-row-TC-01')).getByText('Passed')).toBeInTheDocument());
    expect(api.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/tests/run/TC-01'))).toBe(true);
    expect(screen.getByText('All executed tests passed')).toBeInTheDocument();
  });
});
