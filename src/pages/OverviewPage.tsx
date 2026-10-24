import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  CalendarCheck,
  CheckCircle2,
  CircleHelp,
  Clock,
  Database,
  Gauge,
  Inbox,
  LayoutDashboard,
  Server,
  ShieldAlert,
  Siren,
  UserCheck,
  Waypoints,
  XCircle,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { RouteDistributionChart, VolumeChart } from '../components/charts';
import { Card, EmptyState, ErrorState, LoadingState, PageHeader, RouteBadge, StatCard, cx } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, humanise, relativeTime } from '../lib/format';

function StatusRow({ label, ok, detail, icon: Icon }: { label: string; ok: boolean; detail: string; icon: typeof Server }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="flex items-center gap-2 text-slate-700">
        <Icon className="h-4 w-4 text-slate-500" aria-hidden /> {label}
      </span>
      <span className={cx('flex items-center gap-1.5 text-xs font-medium', ok ? 'text-emerald-700' : 'text-slate-600')}>
        {ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4 text-slate-400" aria-hidden />}
        {detail}
      </span>
    </li>
  );
}

export function OverviewPage() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: 20_000 });

  if (q.isLoading) return <LoadingState label="Loading dashboard…" rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} title="Dashboard unavailable" />;
  const d = q.data!;
  const t = d.totals;

  return (
    <div className="fade-in space-y-6">
      <PageHeader
        icon={LayoutDashboard}
        title="Operations overview"
        description="Live figures computed from persisted synthetic records. Click any metric to open the filtered queue."
        actions={
          <Link to="/intake" className="btn-primary">
            New intake
          </Link>
        }
      />

      {t.total === 0 ? (
        <EmptyState
          title="No synthetic requests yet"
          description="Submit a request through New Intake, or reload the demonstration dataset from Settings & Safety."
          action={
            <Link to="/intake" className="btn-primary">
              Create first request
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total synthetic requests" value={t.total} icon={Inbox} to="/queue?sort=date_desc" />
            <StatCard label="Awaiting staff review" value={t.awaitingReview} icon={Clock} tone="sky" to="/queue?reviewStatus=AWAITING_REVIEW" />
            <StatCard label="Emergency guidance" value={t.emergency} icon={Siren} tone="red" to="/queue?route=EMERGENCY_GUIDANCE" />
            <StatCard label="Same-day human review" value={t.sameDay} icon={Clock} tone="amber" to="/queue?route=SAME_DAY_HUMAN_REVIEW" />
            <StatCard label="Routine appointment" value={t.routine} icon={CalendarCheck} tone="teal" to="/queue?route=ROUTINE_APPOINTMENT" />
            <StatCard label="Needs clarification" value={t.clarification} icon={CircleHelp} tone="violet" to="/queue?route=NEEDS_CLARIFICATION_OR_HUMAN_REVIEW" />
            <StatCard label="Uncertain or incomplete" value={t.uncertain} hint="Any uncertainty reason recorded" icon={ShieldAlert} tone="violet" to="/queue?uncertainty=yes" />
            <StatCard label="Human overrides" value={t.overrides} icon={UserCheck} tone="indigo" to="/queue?overriddenOnly=true" />
          </div>

          <div className="grid gap-5 lg:grid-cols-5">
            <Card title="Routing distribution" className="lg:col-span-2">
              <RouteDistributionChart data={d.routeDistribution} onSelect={(r) => navigate(`/queue?route=${r}`)} />
            </Card>
            <Card title="Requests over the last 14 days (synthetic timestamps)" className="lg:col-span-3">
              <VolumeChart data={d.requestsOverTime} />
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Priority queue — awaiting review" className="lg:col-span-2" actions={<Link to="/queue?reviewStatus=AWAITING_REVIEW&sort=priority" className="text-xs font-medium text-teal-700 hover:underline">Open queue</Link>}>
              {d.priorityQueue.length === 0 ? (
                <p className="text-sm text-slate-500">Every request has been reviewed.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {d.priorityQueue.map((item) => (
                    <li key={item.id}>
                      <Link to={`/cases/${item.id}`} className="flex flex-wrap items-center gap-3 py-2.5 hover:bg-slate-50 sm:flex-nowrap">
                        <span className="w-20 font-mono text-sm font-semibold text-teal-800">{item.id}</span>
                        <RouteBadge route={item.recommendedRoute} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm text-slate-600">{item.scenarioLabel ?? item.primaryRuleId}</span>
                        <span className="text-xs text-slate-400">{relativeTime(item.createdAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="System status">
              <ul className="divide-y divide-slate-100">
                <StatusRow label="Backend API" icon={Server} ok={d.system.backend} detail="Connected" />
                <StatusRow label="Database" icon={Database} ok={d.system.database} detail={d.system.database ? 'Connected' : 'Unavailable'} />
                <StatusRow label="Rule engine" icon={Gauge} ok={d.system.ruleEngine} detail={d.system.ruleEngine ? 'Canary passed' : 'Failed'} />
                <StatusRow
                  label="AI provider"
                  icon={Bot}
                  ok={d.system.ai.verified}
                  detail={{ available: `${d.system.ai.model ?? d.system.ai.name} verified`, disabled: 'Disabled', unavailable: 'Unavailable', model_missing: 'Model missing', misconfigured: 'Misconfigured' }[d.system.ai.state]}
                />
                <li className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="flex items-center gap-2 text-slate-700">
                    <Waypoints className="h-4 w-4 text-slate-500" aria-hidden /> Active policy
                  </span>
                  <Link to="/policy" className="font-mono text-xs text-teal-700 hover:underline">
                    {d.system.policyVersion}
                  </Link>
                </li>
              </ul>
              {!d.system.ai.verified && <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">{d.system.ai.label}</p>}
              {d.totals.aiFailures > 0 && <p className="mt-2 text-xs text-slate-600">{d.totals.aiFailures} request(s) recorded an AI failure; deterministic routing continued.</p>}
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Safety events" actions={<Link to="/audit" className="text-xs font-medium text-teal-700 hover:underline">Audit log</Link>}>
              {d.safetyEvents.length === 0 ? (
                <p className="text-sm text-slate-500">No safety events recorded.</p>
              ) : (
                <ul className="space-y-2.5">
                  {d.safetyEvents.map((e) => (
                    <li key={e.id} className="text-xs">
                      <p className="flex items-center gap-1.5 font-semibold text-slate-800">
                        {e.eventType === 'EMERGENCY_RULE_MATCHED' ? <Siren className="h-3.5 w-3.5 text-red-600" aria-hidden /> : <ShieldAlert className="h-3.5 w-3.5 text-violet-600" aria-hidden />}
                        {humanise(e.eventType)}
                        {e.requestId && (
                          <Link to={`/cases/${e.requestId}`} className="font-mono font-normal text-teal-700 hover:underline">
                            {e.requestId}
                          </Link>
                        )}
                      </p>
                      <p className="text-slate-500">{relativeTime(e.createdAt)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Human override summary" actions={<Link to="/queue?overriddenOnly=true" className="text-xs font-medium text-teal-700 hover:underline">View</Link>}>
              {d.overrideSummary.byTransition.length === 0 ? (
                <p className="text-sm text-slate-500">No overrides recorded.</p>
              ) : (
                <div className="space-y-3">
                  <ul className="space-y-1.5">
                    {d.overrideSummary.byTransition.map((o) => (
                      <li key={`${o.from}-${o.to}`} className="flex flex-wrap items-center gap-1.5 text-xs">
                        <RouteBadge route={o.from} size="sm" short /> → <RouteBadge route={o.to} size="sm" short />
                        <span className="ml-auto font-semibold tabular-nums">× {o.count}</span>
                      </li>
                    ))}
                  </ul>
                  <ul className="space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
                    {d.overrideSummary.recent.map((o) => (
                      <li key={`${o.requestId}-${o.createdAt}`}>
                        <Link to={`/cases/${o.requestId}`} className="font-mono text-teal-700 hover:underline">
                          {o.requestId}
                        </Link>{' '}
                        by {o.staffId} · {relativeTime(o.createdAt)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>

            <Card title="Recent activity">
              <ul className="space-y-2.5">
                {d.recentActivity.map((a) => (
                  <li key={a.id} className="flex gap-2 text-xs">
                    <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-600" aria-hidden />
                    <div className="min-w-0">
                      <p className="font-medium text-slate-800">
                        {humanise(a.eventType)}{' '}
                        {a.requestId && (
                          <Link to={`/cases/${a.requestId}`} className="font-mono font-normal text-teal-700 hover:underline">
                            {a.requestId}
                          </Link>
                        )}
                      </p>
                      <p className="text-slate-500" title={formatDateTime(a.createdAt)}>
                        {a.actorType}
                        {a.actorId ? ` · ${a.actorId}` : ''} · {relativeTime(a.createdAt)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <p className="text-xs text-slate-500">All figures are synthetic demonstration data and are not evidence of clinical effectiveness.</p>
        </>
      )}
    </div>
  );
}
