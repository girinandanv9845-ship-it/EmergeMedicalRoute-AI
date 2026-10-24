// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { CONFIG, mockApi, renderAt } from '../test/utils';
import { AssistantPage } from './AssistantPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const AI_OK = { provider: 'ollama', name: 'ollama (llama3.2:3b)', enabled: true, verified: true, state: 'available', detail: '', model: 'llama3.2:3b', checkedAt: null, lastSuccessAt: null, lastSuccessLatencyMs: null, lastFailureAt: null, lastFailureStatus: null, label: '', dataNotice: null, boundary: [] };

const reply = (o: Record<string, unknown>) => ({
  type: 'reply',
  reply: 'When did this start?',
  symptomDescription: 'My knee has been sore after running',
  draft: {},
  missingFields: ['symptomOnset', 'requestedUrgency', 'ageGroup', 'preferredDate', 'preferredTimeRange'],
  nextField: 'symptomOnset',
  quickReplies: [{ label: '1–4 weeks ago', field: 'symptomOnset', value: '1_4_WEEKS' }],
  ready: false,
  model: 'llama3.2:3b',
  aiStatus: 'used',
  aiNote: null,
  latencyMs: 4200,
  precautionaryNotice: false,
  injectionDetected: false,
  aiTextShown: true,
  emergency: null,
  ...o,
});

function IntakeProbe() {
  const loc = useLocation();
  return <pre data-testid="intake-state">{JSON.stringify(loc.state)}</pre>;
}

function renderAssistant() {
  return renderAt(
    <Routes>
      <Route path="/assistant" element={<AssistantPage />} />
      <Route path="/intake" element={<IntakeProbe />} />
    </Routes>,
    '/assistant',
  );
}

describe('AssistantPage', () => {
  it('shows the greeting, sends a message, renders the local-AI reply and quick replies, and fills the draft', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /api/config': () => CONFIG,
      'GET /api/ai/status': () => AI_OK,
      'POST /api/assistant/chat': (_url, init) => {
        const body = JSON.parse(String(init!.body)) as { messages: { kind: string }[]; draft: Record<string, string> };
        return body.messages.at(-1)!.kind === 'choice'
          ? reply({ reply: 'Thanks. Would you prefer routine or urgent?', draft: body.draft, nextField: 'requestedUrgency', quickReplies: [{ label: 'Routine', field: 'requestedUrgency', value: 'ROUTINE' }] })
          : reply({});
      },
    });
    renderAssistant();
    expect(await screen.findByText(/I'm the clinic's AI intake assistant/)).toBeInTheDocument();
    expect(await screen.findByText('Local AI · llama3.2:3b')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Message the intake assistant'), 'My knee has been sore after running{Enter}');
    expect(await screen.findByText('When did this start?')).toBeInTheDocument();
    expect(screen.getByText(/AI · llama3.2:3b · 4.2 s/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '1–4 weeks ago' }));
    await screen.findByText('Thanks. Would you prefer routine or urgent?');
    const posts = api.calls.filter((c) => c.method === 'POST');
    expect(posts[1]!.body).toMatchObject({ draft: { symptomOnset: '1_4_WEEKS' } });
    expect((posts[1]!.body as { messages: { kind: string }[] }).messages.at(-1)!.kind).toBe('choice');
    expect(screen.getByTestId('assistant-draft')).toHaveTextContent('My knee has been sore after running');
    expect(screen.getByTestId('assistant-draft')).toHaveTextContent('1–4 weeks ago');
  });

  it('shows emergency guidance and locks the chat when the server detects an emergency', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/config': () => CONFIG,
      'GET /api/ai/status': () => AI_OK,
      'POST /api/assistant/chat': () =>
        reply({
          type: 'emergency',
          reply: 'What you describe may be an emergency. Contact your local emergency services immediately. This assistant has NOT contacted emergency services.',
          quickReplies: [],
          aiStatus: 'skipped_emergency',
          emergency: { ruleIds: ['EMERG-BREATH-01'], instruction: 'Contact your local emergency services immediately.', policyVersion: 'demo-policy-1.0' },
        }),
    });
    renderAssistant();
    await user.type(await screen.findByLabelText('Message the intake assistant'), 'he cannot breathe{Enter}');
    expect(await screen.findByTestId('emergency-banner')).toHaveTextContent('EMERG-BREATH-01');
    expect(screen.getByText('Safety rule — AI not used')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message the intake assistant')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-review')).toBeDisabled();
  });

  it('is honest when local AI is unavailable and still hands the draft to the form', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/config': () => CONFIG,
      'GET /api/ai/status': () => ({ ...AI_OK, verified: false, state: 'unavailable' }),
      'POST /api/assistant/chat': () =>
        reply({ type: 'unavailable', reply: 'The AI assistant is not available right now.', quickReplies: [], aiStatus: 'unavailable', aiNote: 'Local AI (Ollama) is not reachable.', model: 'llama3.2:3b', latencyMs: null }),
    });
    renderAssistant();
    expect(await screen.findByText('Local AI unavailable')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Message the intake assistant'), 'My knee has been sore after running{Enter}');
    expect(await screen.findByText('AI unavailable')).toBeInTheDocument();
    await user.click(screen.getByTestId('assistant-review'));
    await waitFor(() => expect(screen.getByTestId('intake-state')).toHaveTextContent('My knee has been sore after running'));
  });
});
