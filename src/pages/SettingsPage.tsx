import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BotOff, CheckCircle2, Database, FlaskConical, RotateCcw, ShieldCheck, UserCog, XCircle } from 'lucide-react';
import { useState } from 'react';
import { DEMO_STAFF } from '../../shared/domain';
import { Card, Dialog, ErrorState, InlineMessage, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, humanise } from '../lib/format';
import { useStaff } from '../lib/staff';

const SAFETY_PRINCIPLES = [
  'EmergeMedicalRoute AI is an educational hackathon prototype.',
  'It uses synthetic demonstration data only.',
  'It does not diagnose, treat, or prescribe.',
  'Its routing rules are illustrative and have not been clinically validated.',
  'Human review is required for appropriate administrative routing.',
  'Unclear or high-risk descriptions must not be automatically treated as routine.',
  'Emergency guidance must direct people to local emergency services immediately.',
  'The application does not contact emergency services.',
  'AI-generated interpretations can be wrong.',
  'The absence of a detected warning sign does not prove that a situation is safe.',
  'Passing synthetic tests does not establish clinical safety.',
  'Clinical use would require qualified healthcare review, formal validation, security assessment, and appropriate regulatory evaluation.',
];

function ResetDemo({ phrase }: { phrase: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const reset = useMutation({
    mutationFn: () => api.resetDemo(typed),
    onSuccess: () => {
      qc.invalidateQueries();
      setOpen(false);
      setTyped('');
    },
  });
  return (
    <Card title="Demo data">
      <p className="text-sm text-slate-700">
        Removes every synthetic request (seeded and submitted), with its recommendations and reviews, then reloads the 32 synthetic seed records. Only records explicitly marked as synthetic demo data are touched. Audit history,
        policy versions and test runs are kept.
      </p>
      {reset.isSuccess && (
        <div className="mt-3">
          <InlineMessage tone="success">
            Reset complete: {reset.data.deleted} synthetic request(s) removed, {reset.data.seeded} seed record(s) loaded.
          </InlineMessage>
        </div>
      )}
      <button type="button" className="btn-danger mt-4" onClick={() => setOpen(true)}>
        <RotateCcw className="h-4 w-4" aria-hidden /> Reset demo data…
      </button>
      <Dialog open={open} title="Reset synthetic demo data?" onClose={() => !reset.isPending && setOpen(false)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (typed === phrase) reset.mutate();
          }}
          className="space-y-3"
        >
          <p className="text-sm text-slate-700">This cannot be undone. Type the phrase below to confirm.</p>
          <p className="rounded bg-slate-100 px-2 py-1 font-mono text-xs">{phrase}</p>
          <label htmlFor="reset-confirm" className="label">
            Confirmation phrase
          </label>
          <input id="reset-confirm" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          {reset.isError && <ErrorState error={reset.error} title="Reset failed" />}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={reset.isPending}>
              Cancel
            </button>
            <button type="submit" className="btn-danger" disabled={typed !== phrase || reset.isPending}>
              {reset.isPending ? 'Resetting…' : 'Reset demo data'}
            </button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

const AI_STATE_UI = {
  available: { label: 'Local AI available', icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-800 ring-emerald-600/30' },
  unavailable: { label: 'Ollama unavailable', icon: XCircle, cls: 'bg-orange-50 text-orange-800 ring-orange-600/30' },
  model_missing: { label: 'Model missing', icon: AlertTriangle, cls: 'bg-orange-50 text-orange-800 ring-orange-600/30' },
  misconfigured: { label: 'Misconfigured', icon: AlertTriangle, cls: 'bg-red-50 text-red-800 ring-red-600/30' },
  disabled: { label: 'AI disabled', icon: BotOff, cls: 'bg-slate-100 text-slate-700 ring-slate-400/30' },
} as const;

function AiCard() {
  const qc = useQueryClient();
  const ai = useQuery({ queryKey: ['ai-status'], queryFn: () => api.aiStatus(true), refetchInterval: 30_000 });
  const test = useMutation({
    mutationFn: api.testAi,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-status'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  if (ai.isError) return <Card title="AI-assisted interpretation"><ErrorState error={ai.error} onRetry={() => ai.refetch()} /></Card>;
  const d = ai.data;
  const ui = d ? AI_STATE_UI[d.state] : null;
  return (
    <Card title="AI-assisted interpretation (local)">
      {!d || !ui ? (
        <p className="text-sm text-slate-500">Checking AI provider…</p>
      ) : (
        <div className="space-y-3 text-sm" data-testid="ai-status-card">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${ui.cls}`}>
              <ui.icon className="h-3.5 w-3.5" aria-hidden /> {ui.label}
            </span>
            <span className="font-mono text-xs text-slate-600">{d.name}</span>
          </div>
          <p className="text-slate-700">{d.detail}</p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-slate-500">Last verified</dt>
            <dd>{d.checkedAt ? formatDateTime(d.checkedAt) : '—'}</dd>
            <dt className="text-slate-500">Last successful inference</dt>
            <dd>{d.lastSuccessAt ? `${formatDateTime(d.lastSuccessAt)} (${d.lastSuccessLatencyMs} ms)` : 'None since server start'}</dd>
            <dt className="text-slate-500">Last failed request</dt>
            <dd>{d.lastFailureAt ? `${formatDateTime(d.lastFailureAt)} — ${humanise(d.lastFailureStatus ?? '')}` : 'None'}</dd>
          </dl>
          {d.provider !== 'disabled' && (
            <button type="button" className="btn-secondary" onClick={() => test.mutate()} disabled={test.isPending}>
              <FlaskConical className="h-4 w-4" aria-hidden /> {test.isPending ? 'Running local inference…' : 'Test local AI'}
            </button>
          )}
          {test.isError && <ErrorState error={test.error} title="AI test failed" />}
          {test.data && (
            <InlineMessage tone={test.data.outcome?.status === 'used' ? 'success' : 'error'}>
              {test.data.outcome
                ? `Test result: ${humanise(test.data.outcome.status)}${test.data.outcome.latencyMs !== undefined ? ` in ${(test.data.outcome.latencyMs / 1000).toFixed(1)} s` : ''}. ${test.data.outcome.interpretation?.plainLanguageSummary ?? test.data.outcome.note ?? ''}`
                : `Not tested: ${test.data.probe.detail}`}
            </InlineMessage>
          )}
          {d.dataNotice && <InlineMessage tone="info">{d.dataNotice}</InlineMessage>}
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate-700">
            {d.boundary.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">
            Configured on the server only: <code>AI_PROVIDER=ollama</code>, <code>OLLAMA_BASE_URL</code> (must be localhost), <code>OLLAMA_MODEL</code>, <code>AI_TIMEOUT_MS</code>. The browser never talks to Ollama. Keyword and
            rule matching is not a trained AI model.
          </p>
        </div>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: api.config });
  const { staffId, setStaffId } = useStaff();

  return (
    <div className="fade-in space-y-5">
      <PageHeader icon={ShieldCheck} title="Settings & safety" description="Safety note, AI configuration status, demo identity and demo data management." />

      <section aria-labelledby="safety-note" className="rounded-xl border-2 border-teal-700 bg-white p-6">
        <h2 id="safety-note" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <ShieldCheck className="h-5 w-5 text-teal-700" aria-hidden /> Safety note
        </h2>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-slate-800" data-testid="safety-principles">
          {SAFETY_PRINCIPLES.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-slate-500">
          Configured emergency instruction: “{config.data?.emergencyInstruction ?? '…'}” — location-neutral by design; the prototype does not assume a local emergency telephone number. No healthcare-privacy regulation compliance
          has been assessed. Demo staff identities are not authentication and provide no real access control.
        </p>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <AiCard />


        <Card title="Demo staff identity">
          <div className="space-y-2">
            {DEMO_STAFF.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input type="radio" name="staff" checked={staffId === s.id} onChange={() => setStaffId(s.id)} />
                <UserCog className="h-4 w-4 text-slate-500" aria-hidden />
                {s.label} <span className="font-mono text-xs text-slate-500">{s.id}</span>
              </label>
            ))}
            <p className="pt-1 text-xs text-slate-500">Recorded on reviews and overrides. Demo environment — not production-grade access control.</p>
          </div>
        </Card>
      </div>

      {config.data && <ResetDemo phrase={config.data.resetConfirmation} />}

      <Card title="Data handling">
        <p className="flex items-start gap-2 text-sm text-slate-700">
          <Database className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
          Data is stored in a local SQLite file on the server machine. Symptom text is rendered as plain text (never as HTML). The intake form never asks for names, contact details, addresses, insurance identifiers or record numbers.
        </p>
      </Card>
    </div>
  );
}
