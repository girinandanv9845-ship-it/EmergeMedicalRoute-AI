import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { Providers } from '../Providers';

export type Handler = (url: string, init?: RequestInit) => unknown | Promise<unknown>;

/** Mocks global fetch. Handlers are matched by "METHOD /path" prefix; return value is JSON, or a Response. */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: { method: string; url: string; body: unknown; headers: Headers }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
    const key = Object.keys(handlers)
      .filter((k) => {
        const [m, p] = k.split(' ');
        return m === method && url.startsWith(p!);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response(JSON.stringify({ error: { code: 'NOT_MOCKED', message: `No mock for ${method} ${url}` } }), { status: 404 });
    const result = await handlers[key]!(url, init);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export function renderAt(ui: ReactElement, path: string, routePath = '*') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={ui} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

export const CONFIG = {
  emergencyInstruction: 'Contact your local emergency services immediately.',
  demoStaff: [{ id: 'STAFF-DEMO-A', label: 'Demo Staff A' }],
  policyVersion: 'demo-policy-1.0',
  policyLabel: 'DEMO POLICY — illustrative rules requiring qualified clinical review',
  resetConfirmation: 'RESET SYNTHETIC DEMO DATA',
  today: '2026-10-24',
  demoMode: 'DEMO MODE — SYNTHETIC DATA ONLY',
};

export function recommendation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'REC-1',
    requestId: 'SYN-1040',
    createdAt: '2026-10-24T10:00:00.000Z',
    recommendedRoute: 'ROUTINE_APPOINTMENT',
    matchedRuleIds: ['ROUTINE-ADMIN-01'],
    evidence: [],
    explanation: 'Routine appointment recommended. This is an administrative routing suggestion for staff review, not a medical diagnosis.',
    explanationPoints: ['ROUTINE-ADMIN-01 — Administrative / preventive request → Routine appointment'],
    uncertainty: { present: false, reasons: [] },
    safetyFlags: [],
    requiresHumanReview: false,
    emergencyGuidanceRequired: false,
    precautionaryNotice: false,
    policyVersion: 'demo-policy-1.0',
    aiStatus: 'disabled',
    aiInterpretation: null,
    aiNote: 'AI interpretation is disabled. Deterministic demonstration policy is active.',
    aiLatencyMs: null,
    engineErrors: [],
    ...overrides,
  };
}

export function requestView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'SYN-1040',
    syntheticPatientId: 'SYN-P-2040',
    ageGroup: '40_64',
    symptomDescription: 'Annual check-up please',
    symptomOnset: 'UNKNOWN',
    requestedUrgency: 'ROUTINE',
    preferredDate: '2026-10-30',
    preferredTimeRange: 'MORNING',
    administrativeNotes: null,
    isFollowUp: false,
    dataOrigin: 'synthetic_intake',
    scenarioLabel: null,
    reviewStatus: 'AWAITING_REVIEW',
    assignedStaffId: null,
    finalRoute: null,
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    ...overrides,
  };
}
