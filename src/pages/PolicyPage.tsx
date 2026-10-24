import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Lock, Search, Siren, UserRoundCheck, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ROUTES, ROUTE_LABELS } from '../../shared/domain';
import type { PolicyRule, RuleStage } from '../../shared/policy-types';
import { Card, EmptyState, ErrorState, LoadingState, PageHeader, RouteBadge, cx } from '../components/ui';
import { api } from '../lib/api';
import { humanise } from '../lib/format';

const STAGES: RuleStage[] = ['EMERGENCY', 'SAFETY', 'UNCERTAINTY', 'SAME_DAY', 'ROUTINE', 'AI_BOUNDARY'];

function TriggerDetails({ rule }: { rule: PolicyRule }) {
  const t = rule.trigger;
  return (
    <div className="space-y-2 text-xs text-slate-700">
      {t.check && (
        <p>
          <span className="font-semibold">Computed check:</span> <span className="font-mono">{t.check}</span>
          {t.params && <span className="text-slate-500"> · params {JSON.stringify(t.params)}</span>}
        </p>
      )}
      {t.phrases && t.phrases.length > 0 && (
        <div>
          <p className="font-semibold">Phrases ({t.phrases.length}) — typo-tolerant{t.contextAware ? ', negation & history aware' : ''}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {t.phrases.map((p) => (
              <span key={p} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px]">
                {p}
              </span>
            ))}
          </div>
        </div>
      )}
      {t.combinations?.map((c, i) => (
        <p key={i}>
          <span className="font-semibold">Combination {i + 1}:</span> one word from each group within {c.window} words{c.ordered ? ' (in order)' : ''} —{' '}
          {c.groups.map((g) => `[${g.join(' | ')}]`).join(' + ')}
        </p>
      ))}
      {t.patterns && <p><span className="font-semibold">Patterns:</span> {t.patterns.length} instruction-like text patterns (see docs/routing-policy.md)</p>}
    </div>
  );
}

export function PolicyPage() {
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: ['policy'], queryFn: api.policy, staleTime: 60_000 });
  const [search, setSearch] = useState(params.get('rule') ?? '');
  const [stage, setStage] = useState('');
  const [route, setRoute] = useState('');
  const [open, setOpen] = useState<string | null>(params.get('rule'));

  useEffect(() => {
    const rule = params.get('rule');
    if (rule) {
      setSearch(rule);
      setOpen(rule);
    }
  }, [params]);

  const rules = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.rules ?? []).filter(
      (r) =>
        (!stage || r.stage === stage) &&
        (!route || r.route === route) &&
        (!s || [r.id, r.name, r.description, r.explanation, ...(r.trigger.phrases ?? [])].some((x) => x.toLowerCase().includes(s))),
    );
  }, [q.data, search, stage, route]);

  if (q.isLoading) return <LoadingState label="Loading policy…" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data!;

  return (
    <div className="fade-in space-y-5">
      <PageHeader icon={Waypoints} title="Routing policy" description="The single, central, versioned policy that the server uses for every routing recommendation. Read-only in this prototype." />

      <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4">
        <p className="font-bold text-amber-950">{p.label}</p>
        <p className="mt-1 text-sm text-amber-950">{p.disclaimer}</p>
        <p className="mt-2 text-xs text-amber-900">
          Version <span className="font-mono font-semibold">{p.version}</span> · effective {p.effectiveDate} · {p.rules.length} rules · status {humanise(p.status)}
          {' · '}stored versions: {p.storedVersions.map((v) => v.version).join(', ')}
        </p>
      </div>

      <Card title="Precedence & conflict resolution">
        <ol className="space-y-1.5 text-sm text-slate-700">
          {p.precedence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
          <Lock className="h-3.5 w-3.5" aria-hidden /> Mandatory safety rules cannot be disabled through settings, AI output, or staff overrides. Policy changes require a new version in code with review.
        </p>
      </Card>

      <div className="card p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="relative md:col-span-2">
            <label htmlFor="policy-search" className="sr-only">
              Search rules
            </label>
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
            <input id="policy-search" className="input pl-9" placeholder="Search rule ID, name, or phrase…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select aria-label="Filter by stage" className="input" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {humanise(s)}
              </option>
            ))}
          </select>
          <select aria-label="Filter by route" className="input" value={route} onChange={(e) => setRoute(e.target.value)}>
            <option value="">All routes</option>
            {ROUTES.map((r) => (
              <option key={r} value={r}>
                {ROUTE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {rules.length === 0 ? (
        <EmptyState title="No rules match" description="Clear the search or filters." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm" data-testid="policy-table">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-3">Rule</th>
                  <th scope="col" className="px-4 py-3">Stage</th>
                  <th scope="col" className="px-4 py-3">Route / action</th>
                  <th scope="col" className="px-4 py-3">Priority</th>
                  <th scope="col" className="px-4 py-3">Human review</th>
                  <th scope="col" className="px-4 py-3">Emergency guidance</th>
                  <th scope="col" className="px-4 py-3">Version</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Expand</span></th>
                </tr>
              </thead>
              {rules.map((r) => {
                const expanded = open === r.id;
                return (
                  <tbody key={r.id} className="border-t border-slate-100">
                    <tr className={cx('align-top', expanded && 'bg-slate-50/60')}>
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-semibold text-slate-900">{r.id}</p>
                        <p className="text-sm text-slate-800">{r.name}</p>
                        {r.mandatory && (
                          <span className="mt-1 inline-flex items-center gap-1 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
                            <Lock className="h-3 w-3" aria-hidden /> Mandatory
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">{humanise(r.stage)}</td>
                      <td className="px-4 py-3">
                        <RouteBadge route={r.route} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-xs tabular-nums">{r.priority}</td>
                      <td className="px-4 py-3 text-xs">{r.requiresHumanReview ? <span className="inline-flex items-center gap-1"><UserRoundCheck className="h-3.5 w-3.5" aria-hidden /> Required</span> : 'No'}</td>
                      <td className="px-4 py-3 text-xs">
                        {r.emergencyGuidance ? (
                          <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                            <Siren className="h-3.5 w-3.5" aria-hidden /> Displayed
                          </span>
                        ) : r.precautionaryNotice ? (
                          'Precautionary notice'
                        ) : (
                          'No'
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px]">{r.version}</td>
                      <td className="px-4 py-3">
                        <button type="button" className="btn-ghost px-2 py-1" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} details for ${r.id}`} onClick={() => setOpen(expanded ? null : r.id)}>
                          <ChevronDown className={cx('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={8} className="px-4 pb-4">
                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2 text-sm">
                              <p className="text-slate-700">{r.description}</p>
                              <p className="kicker mt-2">Triggering conditions</p>
                              <ul className="list-disc space-y-1 pl-5 text-xs text-slate-700">
                                {r.conditions.map((c) => (
                                  <li key={c}>{c}</li>
                                ))}
                              </ul>
                              <p className="kicker mt-2">Explanation shown to staff</p>
                              <p className="text-xs text-slate-700">{r.explanation}</p>
                            </div>
                            <TriggerDetails rule={r} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              })}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
