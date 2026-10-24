import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, FileSearch, Gavel, History, MessageCircleQuestion, ScrollText, Search, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AGE_GROUP_LABELS,
  MIN_OVERRIDE_REASON,
  ONSET_LABELS,
  ROUTES,
  ROUTE_LABELS,
  TIME_RANGE_LABELS,
  type CaseDetail,
  type Route,
} from '../../shared/domain';
import { RecommendationPanel } from '../components/routing/RecommendationPanel';
import { EmergencyBanner, PrecautionNotice } from '../components/routing/SafetyNotices';
import { Card, EmptyState, ErrorState, InlineMessage, LoadingState, PageHeader, RouteBadge, StatusBadge, cx } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatDate, formatDateTime, humanise } from '../lib/format';
import { useStaff } from '../lib/staff';

export function CaseLookupPage() {
  const navigate = useNavigate();
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recent = useQuery({ queryKey: ['queue', 'recent-for-lookup'], queryFn: () => api.queue(new URLSearchParams({ sort: 'priority', pageSize: '8', reviewStatus: 'AWAITING_REVIEW' })) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = id.trim().toUpperCase();
    if (!/^SYN-\d{4,6}$/.test(v)) {
      setError('Enter a synthetic request ID such as SYN-1001.');
      return;
    }
    navigate(`/cases/${v}`);
  };
  return (
    <div className="fade-in">
      <PageHeader icon={FileSearch} title="Case details" description="Open a synthetic request to see its recommendation, explanation, review history and audit trail." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Open a case by ID">
          <form onSubmit={submit} className="flex gap-2" noValidate>
            <label htmlFor="case-id" className="sr-only">
              Synthetic request ID
            </label>
            <input id="case-id" className="input" placeholder="SYN-1001" value={id} onChange={(e) => setId(e.target.value)} aria-invalid={!!error} aria-describedby={error ? 'case-id-error' : undefined} />
            <button type="submit" className="btn-primary">
              <Search className="h-4 w-4" aria-hidden /> Open
            </button>
          </form>
          {error && (
            <p id="case-id-error" className="mt-2 text-xs font-medium text-red-700">
              {error}
            </p>
          )}
        </Card>
        <Card title="Highest-priority cases awaiting review">
          {recent.isLoading ? (
            <LoadingState rows={3} />
          ) : recent.isError ? (
            <ErrorState error={recent.error} />
          ) : recent.data?.items.length ? (
            <ul className="divide-y divide-slate-100">
              {recent.data.items.map((q) => (
                <li key={q.id}>
                  <Link to={`/cases/${q.id}`} className="flex items-center justify-between gap-3 py-2 text-sm hover:text-teal-800">
                    <span className="font-mono font-semibold">{q.id}</span>
                    <RouteBadge route={q.recommendedRoute} size="sm" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Nothing awaiting review" />
          )}
        </Card>
      </div>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 text-slate-900">{children}</dd>
    </div>
  );
}

function StaffActions({ detail }: { detail: CaseDetail }) {
  const qc = useQueryClient();
  const { staffId } = useStaff();
  const rec = detail.recommendation;
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [finalRoute, setFinalRoute] = useState<Route | ''>('');
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const onDone = (data: CaseDetail, text: string) => {
    qc.setQueryData(['case', data.request.id], data);
    qc.invalidateQueries({ queryKey: ['queue'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['audit'] });
    setMessage({ tone: 'success', text });
  };
  const onFail = (err: unknown) => {
    const e = err instanceof ApiError ? err : null;
    const fe: Record<string, string> = {};
    e?.details.forEach((d) => (fe[d.path] = d.message));
    setFieldErrors(fe);
    setMessage({ tone: 'error', text: e?.message ?? 'The action failed and was not saved.' });
  };

  const review = useMutation({
    mutationFn: (action: 'APPROVE' | 'REQUEST_CLARIFICATION' | 'ASSIGN_TO_ME') => api.review(detail.request.id, { action }),
    onSuccess: (data, action) =>
      onDone(data, action === 'APPROVE' ? 'Recommendation approved (administrative review).' : action === 'ASSIGN_TO_ME' ? `Assigned to ${staffId}.` : 'Clarification requested.'),
    onError: onFail,
  });
  const override = useMutation({
    mutationFn: () => api.override(detail.request.id, { finalRoute, reason, ...(rec.emergencyGuidanceRequired ? { acknowledgeEmergencyWarning: ack } : {}) }),
    onSuccess: (data) => {
      onDone(data, 'Override recorded. The original recommendation is preserved.');
      setShowOverride(false);
      setReason('');
      setFinalRoute('');
      setAck(false);
    },
    onError: onFail,
  });

  const submitOverride = (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!finalRoute) fe.finalRoute = 'Select the final administrative route';
    if (reason.trim().length < MIN_OVERRIDE_REASON) fe.reason = `A reason of at least ${MIN_OVERRIDE_REASON} characters is required when the route differs from the recommendation`;
    if (rec.emergencyGuidanceRequired && !ack) fe.ack = 'Confirm that the emergency warning remains in place';
    setFieldErrors(fe);
    if (Object.keys(fe).length) return;
    override.mutate();
  };
  const busy = review.isPending || override.isPending;

  return (
    <Card title="Staff review" id="staff-review">
      <div className="space-y-3">
        <p className="text-xs text-slate-600">
          Acting as <span className="font-mono font-semibold">{staffId}</span> (demo identity — not real authentication). Staff review is an <strong>administrative</strong> decision, not clinical approval.
        </p>
        {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => review.mutate('APPROVE')}>
            <CheckCircle2 className="h-4 w-4" aria-hidden /> Approve recommendation
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => review.mutate('REQUEST_CLARIFICATION')}>
            <MessageCircleQuestion className="h-4 w-4" aria-hidden /> Request clarification
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => review.mutate('ASSIGN_TO_ME')}>
            <UserPlus className="h-4 w-4" aria-hidden /> Assign to me
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setShowOverride((s) => !s)} aria-expanded={showOverride} aria-controls="override-form">
            <Gavel className="h-4 w-4" aria-hidden /> Override route
          </button>
        </div>

        {showOverride && (
          <form id="override-form" onSubmit={submitOverride} noValidate className="fade-in space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-700">
              Original recommendation: <RouteBadge route={rec.recommendedRoute} size="sm" /> — it will be preserved alongside your decision.
            </p>
            <div>
              <label htmlFor="override-route" className="label">
                Final administrative route
              </label>
              <select id="override-route" className="input" value={finalRoute} onChange={(e) => setFinalRoute(e.target.value as Route)} aria-invalid={!!fieldErrors.finalRoute}>
                <option value="">Select…</option>
                {ROUTES.filter((r) => r !== rec.recommendedRoute).map((r) => (
                  <option key={r} value={r}>
                    {ROUTE_LABELS[r]}
                  </option>
                ))}
              </select>
              {fieldErrors.finalRoute && <p className="mt-1 text-xs font-medium text-red-700">{fieldErrors.finalRoute}</p>}
            </div>
            <div>
              <label htmlFor="override-reason" className="label">
                Reason for override <span className="text-red-700">*</span>
              </label>
              <textarea
                id="override-reason"
                rows={3}
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-invalid={!!fieldErrors.reason}
                aria-describedby="override-reason-msg"
                placeholder="e.g. Spoke with requester; administrative appointment only."
              />
              <p id="override-reason-msg" className={cx('mt-1 text-xs', fieldErrors.reason ? 'font-medium text-red-700' : 'text-slate-500')}>
                {fieldErrors.reason ?? `Required. ${reason.trim().length}/${MIN_OVERRIDE_REASON} minimum characters.`}
              </p>
            </div>
            {rec.emergencyGuidanceRequired && (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3">
                <label className="flex items-start gap-2 text-sm text-red-950">
                  <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-invalid={!!fieldErrors.ack} />
                  I understand this case matched a mandatory emergency rule. The emergency warning stays in place, and an administrative override does not remove the need for emergency care.
                </label>
                {fieldErrors.ack && <p className="mt-1 text-xs font-medium text-red-700">{fieldErrors.ack}</p>}
              </div>
            )}
            <div className="flex gap-2">
              <button type="submit" className="btn-primary" disabled={busy}>
                {override.isPending ? 'Saving…' : 'Submit override'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setShowOverride(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

export function CaseDetailsPage() {
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: ['case', id], queryFn: () => api.getCase(id), retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 1 });

  if (query.isLoading) return <LoadingState label={`Loading ${id}…`} rows={5} />;
  if (query.isError)
    return (
      <div className="space-y-4">
        <Link to="/queue" className="btn-ghost">
          <ArrowLeft className="h-4 w-4" /> Back to queue
        </Link>
        <ErrorState error={query.error} onRetry={() => query.refetch()} title={`Could not load ${id}`} />
      </div>
    );
  const detail = query.data!;
  const { request: r, recommendation: rec, reviews, audit } = detail;
  const overridden = r.reviewStatus === 'OVERRIDDEN';

  return (
    <div className="fade-in space-y-5">
      {/* Emergency guidance is always first and never hidden, even after an override. */}
      {rec.emergencyGuidanceRequired && (
        <EmergencyBanner instruction={detail.emergencyInstruction} ruleIds={rec.matchedRuleIds.filter((x) => x.startsWith('EMERG-'))} policyVersion={rec.policyVersion} overridden={overridden} />
      )}
      {rec.precautionaryNotice && <PrecautionNotice instruction={detail.emergencyInstruction} />}

      <PageHeader
        icon={FileSearch}
        title={`Case ${r.id}`}
        description={
          <>
            Synthetic patient <span className="font-mono">{r.syntheticPatientId}</span> · submitted {formatDateTime(r.createdAt)}
            {r.scenarioLabel && <> · demo scenario: {r.scenarioLabel}</>}
          </>
        }
        actions={
          <Link to="/queue" className="btn-secondary">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Queue
          </Link>
        }
      />

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card title="Routing recommendation (original — never overwritten)">
            <RecommendationPanel rec={rec} createdAt={rec.createdAt} />
          </Card>

          <Card title="Original submitted information">
            <dl className="divide-y divide-slate-100">
              <InfoRow label="Description">
                <p className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-sm" data-testid="symptom-text">
                  {r.symptomDescription || <em className="text-slate-500">(empty)</em>}
                </p>
              </InfoRow>
              <InfoRow label="Age group">{AGE_GROUP_LABELS[r.ageGroup]}</InfoRow>
              <InfoRow label="Onset">{ONSET_LABELS[r.symptomOnset]}</InfoRow>
              <InfoRow label="Requested type">{r.requestedUrgency === 'URGENT' ? 'Urgent (preference only)' : 'Routine'}</InfoRow>
              <InfoRow label="Follow-up">{r.isFollowUp ? 'Yes — follow-up to a previous visit' : 'No'}</InfoRow>
              <InfoRow label="Preferred slot">
                {formatDate(r.preferredDate)} · {TIME_RANGE_LABELS[r.preferredTimeRange]}
              </InfoRow>
              <InfoRow label="Admin notes">{r.administrativeNotes ?? <span className="text-slate-500">None</span>}</InfoRow>
              <InfoRow label="Data origin">{r.dataOrigin === 'synthetic_seed' ? 'Synthetic seed record' : 'Synthetic intake submission'}</InfoRow>
            </dl>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Final administrative decision">
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Status</span>
                <StatusBadge status={r.reviewStatus} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Recommended</span>
                <RouteBadge route={rec.recommendedRoute} size="sm" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Final route</span>
                {r.finalRoute ? <RouteBadge route={r.finalRoute} size="sm" /> : <span className="text-xs text-slate-500">Pending staff decision</span>}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Assigned</span>
                <span className="font-mono text-xs">{r.assignedStaffId ?? '—'}</span>
              </div>
              {overridden && rec.emergencyGuidanceRequired && (
                <p className="rounded-lg bg-red-50 p-2 text-xs text-red-900">Emergency warning preserved. The administrative override does not remove the need for emergency care.</p>
              )}
            </div>
          </Card>

          <StaffActions detail={detail} />

          <Card title={`Staff review history (${reviews.length})`}>
            {reviews.length === 0 ? (
              <p className="text-sm text-slate-500">No staff actions yet.</p>
            ) : (
              <ol className="space-y-3" data-testid="review-history">
                {reviews.map((rv) => (
                  <li key={rv.id} className="rounded-lg border border-slate-200 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 font-semibold text-slate-900">
                        <History className="h-3.5 w-3.5" aria-hidden /> {humanise(rv.action)}
                      </span>
                      <span className="text-slate-500">{formatDateTime(rv.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-slate-600">
                      by <span className="font-mono">{rv.staffActorId}</span> · policy {rv.policyVersion}
                    </p>
                    {rv.action === 'OVERRIDE' && rv.finalRoute && (
                      <div className="mt-2 space-y-1">
                        <p className="flex flex-wrap items-center gap-1">
                          <RouteBadge route={rv.originalRoute} size="sm" short /> → <RouteBadge route={rv.finalRoute} size="sm" short />
                        </p>
                        <p className="text-slate-800">
                          <span className="font-medium">Reason:</span> {rv.overrideReason}
                        </p>
                      </div>
                    )}
                    {rv.note && <p className="mt-1 text-slate-800">Note: {rv.note}</p>}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title="Audit trail" actions={<Link to={`/audit?requestId=${r.id}`} className="text-xs font-medium text-teal-700 hover:underline">Full log</Link>}>
            <ol className="relative space-y-3 border-l border-slate-200 pl-4">
              {audit.map((a) => (
                <li key={a.id} className="text-xs">
                  <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border-2 border-white bg-teal-600" aria-hidden />
                  <p className="flex items-center gap-1 font-semibold text-slate-800">
                    <ScrollText className="h-3 w-3" aria-hidden /> {humanise(a.eventType)}
                  </p>
                  <p className="text-slate-600">{a.description}</p>
                  <p className="text-slate-400">
                    {formatDateTime(a.createdAt)} · {a.actorType}
                    {a.actorId ? ` (${a.actorId})` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
