import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Copy, MessagesSquare, RotateCcw, Send, SquarePen, Wand2 } from 'lucide-react';
import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  AGE_GROUPS,
  AGE_GROUP_LABELS,
  IntakeFieldsSchema,
  MAX_DESCRIPTION_LENGTH,
  MAX_NOTES_LENGTH,
  ONSETS,
  ONSET_LABELS,
  TIME_RANGES,
  TIME_RANGE_LABELS,
  validatePreferredDate,
} from '../../shared/domain';
import { RecommendationPanel } from '../components/routing/RecommendationPanel';
import { EmergencyBanner, IntakeEmergencyNotice, PrecautionNotice } from '../components/routing/SafetyNotices';
import { Card, InlineMessage, PageHeader, cx } from '../components/ui';
import { ApiError, api, type CreateResponse } from '../lib/api';

interface FormState {
  patientMode: 'new' | 'existing';
  syntheticPatientId: string;
  ageGroup: string;
  symptomDescription: string;
  symptomOnset: string;
  requestedUrgency: string;
  preferredDate: string;
  preferredTimeRange: string;
  administrativeNotes: string;
  isFollowUp: boolean;
}

const EMPTY: FormState = {
  patientMode: 'new',
  syntheticPatientId: '',
  ageGroup: '',
  symptomDescription: '',
  symptomOnset: '',
  requestedUrgency: '',
  preferredDate: '',
  preferredTimeRange: '',
  administrativeNotes: '',
  isFollowUp: false,
};

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** One-click synthetic examples for demonstrations. */
const EXAMPLES: { label: string; values: Partial<FormState> }[] = [
  { label: 'Routine', values: { ageGroup: '40_64', symptomDescription: 'I would like to book my annual check-up and a flu shot, no rush.', symptomOnset: 'UNKNOWN', requestedUrgency: 'ROUTINE', preferredTimeRange: 'MORNING' } },
  { label: 'Same-day', values: { ageGroup: '18_39', symptomDescription: 'My cough has been getting worse for three days and now I have a high temperature.', symptomOnset: '1_3_DAYS', requestedUrgency: 'URGENT', preferredTimeRange: 'ANY' } },
  { label: 'Emergency', values: { ageGroup: '65_PLUS', symptomDescription: 'My father suddenly has crushing chest pain spreading to his arm.', symptomOnset: 'TODAY', requestedUrgency: 'URGENT', preferredTimeRange: 'ANY' } },
  { label: 'Unclear', values: { ageGroup: '18_39', symptomDescription: 'I just feel off and something is not right.', symptomOnset: 'UNKNOWN', requestedUrgency: 'ROUTINE', preferredTimeRange: 'AFTERNOON' } },
];

type Errors = Partial<Record<keyof FormState | 'form', string>>;

function Field({ id, label, error, hint, required, children }: { id: string; label: string; error?: string; hint?: ReactNode; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label} {required && <span className="text-red-700" aria-hidden>*</span>}
        {required && <span className="sr-only">(required)</span>}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function IntakePage() {
  const uid = useId();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: api.config });
  const patients = useQuery({ queryKey: ['patients'], queryFn: api.patients });
  const location = useLocation();
  const assistantDraft = (location.state as { assistantDraft?: Partial<Record<keyof FormState, unknown>> } | null)?.assistantDraft;
  const [form, setForm] = useState<FormState>(() =>
    assistantDraft
      ? {
          ...EMPTY,
          ageGroup: String(assistantDraft.ageGroup ?? ''),
          symptomDescription: String(assistantDraft.symptomDescription ?? ''),
          symptomOnset: String(assistantDraft.symptomOnset ?? ''),
          requestedUrgency: String(assistantDraft.requestedUrgency ?? ''),
          preferredDate: String(assistantDraft.preferredDate ?? ''),
          preferredTimeRange: String(assistantDraft.preferredTimeRange ?? ''),
          isFollowUp: assistantDraft.isFollowUp === true,
        }
      : EMPTY,
  );
  const [errors, setErrors] = useState<Errors>({});
  const [result, setResult] = useState<CreateResponse | null>(null);
  const submissionId = useRef<string>(crypto.randomUUID());
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const today = config.data?.today ?? localToday();
  const instruction = config.data?.emergencyInstruction ?? 'Contact your local emergency services immediately.';

  const mutation = useMutation({
    mutationFn: api.createRequest,
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries();
      window.scrollTo({ top: 0, behavior: 'auto' });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.details.length) {
        const next: Errors = {};
        for (const d of err.details) next[(d.path as keyof FormState) || 'form'] = d.message;
        next.form = err.message;
        setErrors(next);
      } else setErrors({ form: err instanceof Error ? err.message : 'Submission failed' });
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
    },
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const descLength = form.symptomDescription.length;

  const validate = (): Errors => {
    const payload = {
      syntheticPatientId: form.patientMode === 'existing' && form.syntheticPatientId ? form.syntheticPatientId : undefined,
      ageGroup: form.ageGroup || undefined,
      symptomDescription: form.symptomDescription,
      symptomOnset: form.symptomOnset || undefined,
      requestedUrgency: form.requestedUrgency || undefined,
      preferredDate: form.preferredDate,
      preferredTimeRange: form.preferredTimeRange || undefined,
      administrativeNotes: form.administrativeNotes || undefined,
      isFollowUp: form.isFollowUp,
    };
    const parsed = IntakeFieldsSchema.safeParse(payload);
    const next: Errors = {};
    if (!parsed.success) for (const issue of parsed.error.issues) next[(issue.path[0] as keyof FormState) ?? 'form'] ??= issue.message;
    if (!next.preferredDate && form.preferredDate) {
      const dateErr = validatePreferredDate(form.preferredDate, today);
      if (dateErr) next.preferredDate = dateErr;
    }
    if (form.patientMode === 'existing' && !form.syntheticPatientId) next.syntheticPatientId = 'Select a synthetic patient or choose "new synthetic patient"';
    return next;
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (mutation.isPending) return; // prevent double submission
    const next = validate();
    if (Object.keys(next).length) {
      setErrors({ ...next, form: 'Please fix the highlighted fields.' });
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
      return;
    }
    setErrors({});
    mutation.mutate({
      ...(form.patientMode === 'existing' ? { syntheticPatientId: form.syntheticPatientId } : {}),
      ageGroup: form.ageGroup,
      symptomDescription: form.symptomDescription,
      symptomOnset: form.symptomOnset,
      requestedUrgency: form.requestedUrgency,
      preferredDate: form.preferredDate,
      preferredTimeRange: form.preferredTimeRange,
      administrativeNotes: form.administrativeNotes.trim() || undefined,
      isFollowUp: form.isFollowUp,
      clientSubmissionId: submissionId.current,
    });
  };

  const reset = () => {
    setForm(EMPTY);
    setErrors({});
    setResult(null);
    mutation.reset();
    submissionId.current = crypto.randomUUID();
  };

  const fieldErrorList = useMemo(() => Object.entries(errors).filter(([k, v]) => k !== 'form' && v), [errors]);
  const aria = (key: keyof FormState, hint = false) => ({
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `${uid}-${key}-error` : hint ? `${uid}-${key}-hint` : undefined,
  });

  if (result) {
    const rec = result.recommendation;
    return (
      <div className="fade-in space-y-5">
        {rec.emergencyGuidanceRequired && <EmergencyBanner instruction={instruction} ruleIds={rec.matchedRuleIds.filter((r) => r.startsWith('EMERG-'))} policyVersion={rec.policyVersion} />}
        {rec.precautionaryNotice && <PrecautionNotice instruction={instruction} />}
        <PageHeader
          icon={CheckCircle2}
          title={result.duplicate ? 'Request already received' : 'Request submitted and routed'}
          description={
            result.duplicate
              ? 'This exact submission was already received, so no duplicate was created. The original request is shown below.'
              : 'The synthetic request was saved and evaluated on the server against the active demonstration policy.'
          }
          actions={
            <>
              <Link to={`/cases/${result.request.id}`} className="btn-primary">
                Open case {result.request.id} <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <button type="button" className="btn-secondary" onClick={reset}>
                <SquarePen className="h-4 w-4" aria-hidden /> New request
              </button>
            </>
          }
        />
        <InlineMessage tone="success">
          Saved as <strong className="font-mono">{result.request.id}</strong> for synthetic patient <strong className="font-mono">{result.request.syntheticPatientId}</strong>. A staff member reviews every
          recommendation.
        </InlineMessage>
        <Card>
          <RecommendationPanel rec={rec} createdAt={rec.createdAt} />
        </Card>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <PageHeader
        icon={SquarePen}
        title="New appointment request"
        description="Enter a synthetic request. Do not enter real names, contact details, addresses, insurance or record numbers — only synthetic demonstration data."
        actions={
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Fill with a synthetic example">
            <span className="flex items-center gap-1 text-xs text-slate-500">
              <Wand2 className="h-3.5 w-3.5" aria-hidden /> Examples:
            </span>
            {EXAMPLES.map((ex) => (
              <button key={ex.label} type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setForm({ ...EMPTY, ...ex.values, preferredDate: plusDays(today, 2) })}>
                {ex.label}
              </button>
            ))}
          </div>
        }
      />

      {assistantDraft ? (
        <div className="mb-5">
          <InlineMessage tone="info">
            Prefilled from your conversation with the AI intake assistant. Please check every field before submitting — the AI can make mistakes. The concern is in your own words.
          </InlineMessage>
        </div>
      ) : (
        <Link to="/assistant" className="card mb-5 flex items-center gap-3 p-4 transition hover:border-indigo-300 hover:shadow-md">
          <span className="rounded-lg bg-indigo-100 p-2 text-indigo-700">
            <MessagesSquare className="h-5 w-5" aria-hidden />
          </span>
          <span className="flex-1 text-sm">
            <span className="font-semibold text-slate-900">Prefer to chat?</span> <span className="text-slate-600">The AI intake assistant (local model) can help you fill this in step by step.</span>
          </span>
          <ArrowRight className="h-4 w-4 text-slate-400" aria-hidden />
        </Link>
      )}

      <form noValidate onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-3" aria-describedby={errors.form ? `${uid}-summary` : undefined}>
        <div className="space-y-6 lg:col-span-2">
          {errors.form && (
            <div ref={errorSummaryRef} tabIndex={-1} id={`${uid}-summary`} role="alert" className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 outline-none">
              <p className="font-semibold">{errors.form}</p>
              {fieldErrorList.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {fieldErrorList.map(([k, v]) => (
                    <li key={k}>
                      <a className="underline" href={`#${uid}-${k}`}>
                        {v}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <Card title="Requester (synthetic)">
            <div className="grid gap-4 sm:grid-cols-2">
              <fieldset className="sm:col-span-2">
                <legend className="label">Synthetic patient identifier</legend>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="patientMode" checked={form.patientMode === 'new'} onChange={() => set('patientMode', 'new')} />
                    New synthetic patient (ID generated by the server)
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="patientMode" checked={form.patientMode === 'existing'} onChange={() => set('patientMode', 'existing')} />
                    Existing demo patient
                  </label>
                </div>
                {form.patientMode === 'existing' && (
                  <div className="mt-2 max-w-xs">
                    <select id={`${uid}-syntheticPatientId`} className="input" value={form.syntheticPatientId} onChange={(e) => set('syntheticPatientId', e.target.value)} {...aria('syntheticPatientId')} aria-label="Existing synthetic patient">
                      <option value="">Select a demo patient…</option>
                      {patients.data?.items.map((p) => (
                        <option key={p.syntheticPatientId} value={p.syntheticPatientId}>
                          {p.syntheticPatientId} ({p.requestCount} request{p.requestCount === 1 ? '' : 's'})
                        </option>
                      ))}
                    </select>
                    {errors.syntheticPatientId && <p id={`${uid}-syntheticPatientId-error`} className="mt-1 text-xs font-medium text-red-700">{errors.syntheticPatientId}</p>}
                  </div>
                )}
              </fieldset>
              <Field id={`${uid}-ageGroup`} label="Age group" required error={errors.ageGroup} hint="An age group only — never a date of birth.">
                <select id={`${uid}-ageGroup`} className="input" value={form.ageGroup} onChange={(e) => set('ageGroup', e.target.value)} {...aria('ageGroup', true)}>
                  <option value="">Select…</option>
                  {AGE_GROUPS.map((a) => (
                    <option key={a} value={a}>
                      {AGE_GROUP_LABELS[a]}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="flex items-end">
                <label className="flex items-center gap-2 pb-2 text-sm text-slate-800">
                  <input type="checkbox" checked={form.isFollowUp} onChange={(e) => set('isFollowUp', e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                  Follow-up to a previous clinic visit
                </label>
              </div>
            </div>
          </Card>

          <Card title="Concern">
            <div className="space-y-4">
              <Field
                id={`${uid}-symptomDescription`}
                label="Describe the concern in your own words"
                required
                error={errors.symptomDescription}
                hint={
                  <span className={cx(descLength > MAX_DESCRIPTION_LENGTH && 'font-semibold text-red-700')}>
                    {descLength.toLocaleString()} / {MAX_DESCRIPTION_LENGTH.toLocaleString()} characters
                  </span>
                }
              >
                <textarea
                  id={`${uid}-symptomDescription`}
                  rows={5}
                  className="input resize-y"
                  value={form.symptomDescription}
                  onChange={(e) => set('symptomDescription', e.target.value)}
                  placeholder="e.g. I would like to book a routine check-up…"
                  {...aria('symptomDescription', true)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={`${uid}-symptomOnset`} label="Approximate onset" required error={errors.symptomOnset}>
                  <select id={`${uid}-symptomOnset`} className="input" value={form.symptomOnset} onChange={(e) => set('symptomOnset', e.target.value)} {...aria('symptomOnset')}>
                    <option value="">Select…</option>
                    {ONSETS.map((o) => (
                      <option key={o} value={o}>
                        {ONSET_LABELS[o]}
                      </option>
                    ))}
                  </select>
                </Field>
                <fieldset aria-describedby={`${uid}-urg-hint`}>
                  <legend className="label">
                    Request type <span className="text-red-700" aria-hidden>*</span>
                  </legend>
                  <div className="flex gap-2" id={`${uid}-requestedUrgency`}>
                    {(['ROUTINE', 'URGENT'] as const).map((u) => (
                      <label
                        key={u}
                        className={cx(
                          'flex flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                          form.requestedUrgency === u ? 'border-teal-600 bg-teal-50 text-teal-900' : 'border-slate-300 bg-white',
                        )}
                      >
                        <input type="radio" name="requestedUrgency" value={u} checked={form.requestedUrgency === u} onChange={() => set('requestedUrgency', u)} />
                        {u === 'ROUTINE' ? 'Routine' : 'Urgent'}
                      </label>
                    ))}
                  </div>
                  {errors.requestedUrgency ? (
                    <p className="mt-1 text-xs font-medium text-red-700">{errors.requestedUrgency}</p>
                  ) : (
                    <p id={`${uid}-urg-hint`} className="mt-1 text-xs text-slate-500">
                      Your preference is recorded, but on its own it does not decide clinical urgency.
                    </p>
                  )}
                </fieldset>
              </div>
            </div>
          </Card>

          <Card title="Appointment preference">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${uid}-preferredDate`} label="Preferred date" required error={errors.preferredDate}>
                <input id={`${uid}-preferredDate`} type="date" className="input" min={today} value={form.preferredDate} onChange={(e) => set('preferredDate', e.target.value)} {...aria('preferredDate')} />
              </Field>
              <Field id={`${uid}-preferredTimeRange`} label="Preferred time" required error={errors.preferredTimeRange}>
                <select id={`${uid}-preferredTimeRange`} className="input" value={form.preferredTimeRange} onChange={(e) => set('preferredTimeRange', e.target.value)} {...aria('preferredTimeRange')}>
                  <option value="">Select…</option>
                  {TIME_RANGES.map((t) => (
                    <option key={t} value={t}>
                      {TIME_RANGE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="sm:col-span-2">
                <Field id={`${uid}-administrativeNotes`} label="Administrative notes (optional)" error={errors.administrativeNotes} hint={`${form.administrativeNotes.length} / ${MAX_NOTES_LENGTH}`}>
                  <textarea
                    id={`${uid}-administrativeNotes`}
                    rows={2}
                    className="input"
                    value={form.administrativeNotes}
                    onChange={(e) => set('administrativeNotes', e.target.value)}
                    placeholder="e.g. prefers the ground-floor room (no identifying details)"
                    {...aria('administrativeNotes', true)}
                  />
                </Field>
              </div>
            </div>
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-28 lg:self-start">
          <IntakeEmergencyNotice instruction={instruction} />
          <div className="card space-y-3 p-5">
            <p className="text-sm text-slate-700">The request is evaluated on the server by the deterministic demonstration policy. Emergency guidance is shown immediately — it never waits for AI.</p>
            {mutation.isPending && (
              <p role="status" className="text-xs text-slate-500">
                If local AI is enabled, a non-emergency request can take several seconds while the on-device model interprets it.
              </p>
            )}
            <button type="submit" className="btn-primary w-full" disabled={mutation.isPending} aria-busy={mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> Evaluating…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" aria-hidden /> Submit request
                </>
              )}
            </button>
            <button type="button" className="btn-secondary w-full" onClick={reset} disabled={mutation.isPending}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Reset form
            </button>
            <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <Copy className="h-3 w-3" aria-hidden /> Repeat clicks are safe: an idempotency key prevents duplicate submissions.
            </p>
          </div>
        </aside>
      </form>
    </div>
  );
}
