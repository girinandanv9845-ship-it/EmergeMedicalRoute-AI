import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, FlaskConical } from 'lucide-react';
import { Link } from 'react-router-dom';
import { REVIEW_STATUS_LABELS, ROUTES, type ReviewStatus } from '../../shared/domain';
import { RouteDistributionChart, SimpleBarChart, VolumeChart } from '../components/charts';
import { Card, EmptyState, ErrorState, LoadingState, PageHeader, RouteBadge, cx } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, humanise, pct } from '../lib/format';
import { ROUTE_META } from '../lib/routes';

function Metric({ label, value, hint, alert }: { label: string; value: React.ReactNode; hint?: string; alert?: boolean }) {
  return (
    <div className={cx('rounded-lg border p-3', alert ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white')}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cx('mt-0.5 text-xl font-semibold tabular-nums', alert ? 'text-red-800' : 'text-slate-900')}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

export function AnalyticsPage() {
  const q = useQuery({ queryKey: ['analytics'], queryFn: api.analytics });
  if (q.isLoading) return <LoadingState label="Loading analytics…" rows={5} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data!;
  const t = a.tests;

  return (
    <div className="fade-in space-y-5">
      <PageHeader icon={BarChart3} title="Analytics & evaluation" description="Computed from persisted synthetic records and the most recent Test Lab run." />
      <div role="note" className="flex items-start gap-2 rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-sm font-medium text-amber-950">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {a.disclaimer}
      </div>

      {a.totalRequests === 0 ? (
        <EmptyState title="No requests to analyse" description="Create requests or reset the demo data to populate analytics." />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="Total requests" value={a.totalRequests} />
            <Metric label="Human overrides" value={a.overrides.count} />
            <Metric label="Override rate" value={pct(a.overrides.rate)} hint={`${a.overrides.count} ÷ ${a.overrides.decidedCount} decided. ${a.overrides.rateDefinition}`} />
            <Metric label="Uncertainty present" value={a.uncertainty.count} hint={`${a.uncertainty.fallbackRouteCount} routed to clarification fallback`} />
            <Metric label="AI failures recorded" value={a.aiFailureCount} hint="Unavailable, timed out or rejected output" />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Requests by administrative route">
              <RouteDistributionChart data={a.byRoute} />
            </Card>
            <Card title="Requests by review status">
              <SimpleBarChart data={a.byStatus.map((s) => ({ name: REVIEW_STATUS_LABELS[s.status as ReviewStatus], value: s.count }))} label="Requests" height={200} color="#475569" />
            </Card>
          </div>

          <Card title="Request volume over time (synthetic timestamps)">
            <VolumeChart data={a.volume} />
          </Card>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Rule activation counts" className="lg:col-span-2">
              <SimpleBarChart data={a.ruleActivations.map((r) => ({ name: r.ruleId, value: r.count }))} label="Activations" height={Math.max(220, a.ruleActivations.length * 24)} />
            </Card>
            <Card title="AI status across requests">
              <ul className="space-y-2 text-sm">
                {a.aiStatusCounts.map((s) => (
                  <li key={s.status} className="flex items-center justify-between">
                    <span className="text-slate-700">{humanise(s.status)}</span>
                    <span className="font-semibold tabular-nums">{s.count}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}

      <Card title="Synthetic test evaluation" actions={<Link to="/tests" className="text-xs font-medium text-teal-700 hover:underline">Open Test Lab</Link>}>
        {!t ? (
          <EmptyState icon={FlaskConical} title="No test run recorded yet" description="Run the synthetic suite in the Test Lab to populate these metrics." action={<Link to="/tests" className="btn-primary">Go to Test Lab</Link>} />
        ) : (
          <div className="space-y-5">
            <p className="text-xs text-slate-500">
              Run <span className="font-mono">{t.runId}</span> · {formatDateTime(t.createdAt)} · {t.passed} passed, {t.failed} failed, {t.skipped} skipped, {t.criticalFailures} critical
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Correctly routed" value={`${t.routeEvaluation.correct} / ${t.routeEvaluation.denominator}`} hint={t.routeEvaluation.denominatorDefinition} />
              <Metric label="Incorrect routes" value={t.routeEvaluation.incorrect} alert={t.routeEvaluation.incorrect > 0} />
              <Metric label="Emergency false negatives" value={t.routeEvaluation.emergencyFalseNegatives} hint={`of ${t.routeEvaluation.emergencyExpected} expected emergency cases`} alert={t.routeEvaluation.emergencyFalseNegatives > 0} />
              <Metric label="Emergency false positives" value={t.routeEvaluation.emergencyFalsePositives} alert={t.routeEvaluation.emergencyFalsePositives > 0} />
              <Metric label="Same-day mismatches" value={t.routeEvaluation.sameDayMismatches} alert={t.routeEvaluation.sameDayMismatches > 0} />
              <Metric label="Routine mismatches" value={t.routeEvaluation.routineMismatches} alert={t.routeEvaluation.routineMismatches > 0} />
              <Metric label="Tests passed" value={t.passed} />
              <Metric label="Critical failures" value={t.criticalFailures} alert={t.criticalFailures > 0} />
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Expected vs actual route (route-bearing test cases)</h3>
              <div className="overflow-x-auto">
                <table className="min-w-full text-center text-xs" data-testid="confusion-matrix">
                  <thead>
                    <tr className="text-slate-500">
                      <th scope="col" className="px-2 py-2 text-left">Expected ↓ / Actual →</th>
                      {ROUTES.map((r) => (
                        <th key={r} scope="col" className="px-2 py-2">
                          {ROUTE_META[r].short}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.routeEvaluation.matrix.map((row) => (
                      <tr key={row.expected} className="border-t border-slate-100">
                        <th scope="row" className="px-2 py-2 text-left">
                          <RouteBadge route={row.expected} size="sm" short />
                        </th>
                        {ROUTES.map((col) => {
                          const n = row[col];
                          const diag = col === row.expected;
                          return (
                            <td key={col} className={cx('px-2 py-2 tabular-nums', n > 0 && (diag ? 'bg-emerald-50 font-semibold text-emerald-900' : 'bg-red-100 font-semibold text-red-900'))}>
                              {n}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">Emergency test outcomes</h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {t.emergencyOutcomes.map((e) => (
                  <li key={e.testId} className={cx('flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs', e.status === 'passed' ? 'border-slate-200' : 'border-red-300 bg-red-50')}>
                    <span>
                      <span className="font-mono font-semibold">{e.testId}</span> {e.title}
                    </span>
                    <span className="font-semibold">{e.status === 'passed' ? '✓ emergency' : `✗ ${e.actualRoute ?? e.status}`}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
