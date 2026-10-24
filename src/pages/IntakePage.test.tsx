// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, mockApi, recommendation, renderAt, requestView } from '../test/utils';
import { IntakePage } from './IntakePage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const baseMocks = { 'GET /api/config': () => CONFIG, 'GET /api/patients': () => ({ items: [] }) };

async function fillValid(user: ReturnType<typeof userEvent.setup>, description: string) {
  await user.selectOptions(screen.getByLabelText(/Age group/), '40_64');
  await user.type(screen.getByLabelText(/Describe the concern/), description);
  await user.selectOptions(screen.getByLabelText(/Approximate onset/), 'TODAY');
  await user.click(screen.getByLabelText('Urgent'));
  await user.type(screen.getByLabelText(/Preferred date/), '2026-10-28');
  await user.selectOptions(screen.getByLabelText(/Preferred time/), 'ANY');
}

describe('IntakePage', () => {
  it('shows the persistent emergency notice next to the submit button', async () => {
    mockApi(baseMocks);
    renderAt(<IntakePage />, '/intake');
    expect(await screen.findByText(/This form is not an emergency service/)).toBeInTheDocument();
  });

  it('validates required fields and blank descriptions without calling the API', async () => {
    const user = userEvent.setup();
    const api = mockApi(baseMocks);
    renderAt(<IntakePage />, '/intake');
    await user.type(screen.getByLabelText(/Describe the concern/), '    ');
    await user.click(screen.getByRole('button', { name: /Submit request/ }));
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('Please fix the highlighted fields.');
    expect(screen.getAllByText(/cannot be blank/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Select an age group').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Describe the concern/)).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects a past preferred date', async () => {
    const user = userEvent.setup();
    mockApi(baseMocks);
    renderAt(<IntakePage />, '/intake');
    await fillValid(user, 'Flu shot please');
    const date = screen.getByLabelText(/Preferred date/);
    await user.clear(date);
    await user.type(date, '2020-01-01');
    await user.click(screen.getByRole('button', { name: /Submit request/ }));
    expect((await screen.findAllByText('Preferred date cannot be in the past')).length).toBeGreaterThan(0);
  });

  it('submits once with an idempotency key and shows the emergency banner immediately', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...baseMocks,
      'POST /api/requests': () => ({
        request: requestView({ symptomDescription: 'I cannot breathe' }),
        recommendation: recommendation({ recommendedRoute: 'EMERGENCY_GUIDANCE', matchedRuleIds: ['EMERG-BREATH-01'], emergencyGuidanceRequired: true, requiresHumanReview: true, explanationPoints: ['EMERG-BREATH-01 — x'] }),
        duplicate: false,
      }),
    });
    renderAt(<IntakePage />, '/intake');
    await fillValid(user, 'I cannot breathe');
    await user.dblClick(screen.getByRole('button', { name: /Submit request/ }));
    const banner = await screen.findByTestId('emergency-banner');
    expect(banner).toHaveTextContent(/Contact your local emergency services immediately/);
    expect(banner).toHaveTextContent(/has NOT contacted emergency services/);
    const posts = api.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { clientSubmissionId: string }).clientSubmissionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByRole('link', { name: /Open case SYN-1040/ })).toHaveAttribute('href', '/cases/SYN-1040');
  });

  it('shows server validation errors and does not claim success', async () => {
    const user = userEvent.setup();
    mockApi({
      ...baseMocks,
      'POST /api/requests': () =>
        new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'The submitted data is invalid.', details: [{ path: 'symptomDescription', message: 'Too long' }] } }), { status: 400 }),
    });
    renderAt(<IntakePage />, '/intake');
    await fillValid(user, 'Flu shot please');
    await user.click(screen.getByRole('button', { name: /Submit request/ }));
    expect(await screen.findByText('The submitted data is invalid.')).toBeInTheDocument();
    expect(screen.queryByText(/Request submitted and routed/)).not.toBeInTheDocument();
  });

  it('reports a backend connection failure honestly', async () => {
    const user = userEvent.setup();
    mockApi(baseMocks);
    renderAt(<IntakePage />, '/intake');
    await fillValid(user, 'Flu shot please');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await user.click(screen.getByRole('button', { name: /Submit request/ }));
    expect(await screen.findByText(/has NOT been processed/)).toBeInTheDocument();
  });

  it('reset clears the form', async () => {
    const user = userEvent.setup();
    mockApi(baseMocks);
    renderAt(<IntakePage />, '/intake');
    await user.type(screen.getByLabelText(/Describe the concern/), 'Something');
    await user.click(screen.getByRole('button', { name: /Reset form/ }));
    await waitFor(() => expect(screen.getByLabelText(/Describe the concern/)).toHaveValue(''));
  });
});
