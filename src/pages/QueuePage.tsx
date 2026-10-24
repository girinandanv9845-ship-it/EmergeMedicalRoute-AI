import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ClipboardList, FilterX, Search, Siren } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AI_STATUSES, AI_STATUS_LABELS, REVIEW_STATUSES, REVIEW_STATUS_LABELS, ROUTES, ROUTE_LABELS } from '../../shared/domain';
import { AiBadge, EmptyState, ErrorState, LoadingState, PageHeader, RouteBadge, RuleChip, StatusBadge, UncertaintyBadge, cx } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';

const FILTER_KEYS = ['route', 'reviewStatus', 'uncertainty', 'aiStatus', 'emergencyOnly', 'overriddenOnly'] as const;

export function QueuePage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const page = Number(params.get('page') ?? '1');
  const pageSize = 15;

  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (search.trim()) next.set('search', search.trim());
      else next.delete('search');
      if ((params.get('search') ?? '') !== search.trim()) {
        next.delete('page');
        setParams(next, { replace: true });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [search, params, setParams]);

  const apiParams = new URLSearchParams(params);
  if (!apiParams.get('sort')) apiParams.set('sort', 'priority');
  apiParams.set('pageSize', String(pageSize));
  const query = useQuery({ queryKey: ['queue', apiParams.toString()], queryFn: () => api.queue(apiParams), placeholderData: keepPreviousData });

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next);
  };
  const setPage = (p: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
  };
  const activeFilters = FILTER_KEYS.filter((k) => params.get(k)).length + (params.get('search') ? 1 : 0);
  const totalPages = query.data ? Math.max(1, Math.ceil(query.data.total / pageSize)) : 1;

  return (
    <div className="fade-in">
      <PageHeader icon={ClipboardList} title="Request queue" description="All synthetic requests with their recommended route and staff review status. Emergencies are never sorted into the routine queue." />

      <div className="card mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <div className="relative md:col-span-2">
            <label htmlFor="queue-search" className="sr-only">
              Search by synthetic request ID or patient ID
            </label>
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
            <input id="queue-search" className="input pl-9" placeholder="Search SYN-1001 or SYN-P-2001" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select aria-label="Filter by route" className="input" value={params.get('route') ?? ''} onChange={(e) => update('route', e.target.value)}>
            <option value="">All routes</option>
            {ROUTES.map((r) => (
              <option key={r} value={r}>
                {ROUTE_LABELS[r]}
              </option>
            ))}
          </select>
          <select aria-label="Filter by review status" className="input" value={params.get('reviewStatus') ?? ''} onChange={(e) => update('reviewStatus', e.target.value)}>
            <option value="">All review statuses</option>
            {REVIEW_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REVIEW_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <select aria-label="Filter by uncertainty" className="input" value={params.get('uncertainty') ?? ''} onChange={(e) => update('uncertainty', e.target.value)}>
            <option value="">Any uncertainty</option>
            <option value="yes">Uncertainty present</option>
            <option value="no">No uncertainty</option>
          </select>
          <select aria-label="Filter by AI status" className="input" value={params.get('aiStatus') ?? ''} onChange={(e) => update('aiStatus', e.target.value)}>
            <option value="">Any AI status</option>
            {AI_STATUSES.map((s) => (
              <option key={s} value={s}>
                {AI_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-slate-600">Sort</span>
              <select aria-label="Sort order" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm" value={params.get('sort') ?? 'priority'} onChange={(e) => update('sort', e.target.value)}>
                <option value="priority">Priority (emergency first)</option>
                <option value="date_desc">Newest first</option>
                <option value="date_asc">Oldest first</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={params.get('emergencyOnly') === 'true'} onChange={(e) => update('emergencyOnly', e.target.checked ? 'true' : '')} />
              Emergency only
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={params.get('overriddenOnly') === 'true'} onChange={(e) => update('overriddenOnly', e.target.checked ? 'true' : '')} />
              Overridden only
            </label>
          </div>
          {activeFilters > 0 && (
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => {
                setSearch('');
                setParams(new URLSearchParams());
              }}
            >
              <FilterX className="h-3.5 w-3.5" aria-hidden /> Clear {activeFilters} filter{activeFilters > 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <LoadingState label="Loading queue…" rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} title="Could not load the queue" />
      ) : query.data && query.data.items.length === 0 ? (
        <EmptyState
          title={activeFilters ? 'No requests match these filters' : 'No requests yet'}
          description={activeFilters ? 'Try clearing a filter or searching a different ID.' : 'Submit a synthetic request or reset the demo data from Settings.'}
          action={
            <Link to="/intake" className="btn-primary">
              New intake
            </Link>
          }
        />
      ) : (
        query.data && (
          <div className="card overflow-hidden">
            <p className="sr-only" role="status">
              {query.data.total} matching requests
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm" data-testid="queue-table">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">Request</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Patient</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Submitted</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Type</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Recommended route</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Review status</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Primary rule</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Uncertainty</th>
                    <th scope="col" className="px-4 py-3 font-semibold">AI</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Assigned</th>
                  </tr>
                </thead>
                <tbody className={cx('divide-y divide-slate-100', query.isFetching && 'opacity-70')}>
                  {query.data.items.map((item) => (
                    <tr
                      key={item.id}
                      className={cx('cursor-pointer hover:bg-slate-50', item.emergencyGuidanceRequired && 'bg-red-50/50')}
                      onClick={() => navigate(`/cases/${item.id}`)}
                    >
                      <td className="whitespace-nowrap px-4 py-3">
                        <Link to={`/cases/${item.id}`} className="inline-flex items-center gap-1.5 font-mono font-semibold text-teal-800 hover:underline" onClick={(e) => e.stopPropagation()}>
                          {item.emergencyGuidanceRequired && <Siren className="h-3.5 w-3.5 text-red-600" aria-label="Emergency guidance" />}
                          {item.id}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-700">{item.syntheticPatientId}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-600">{formatDateTime(item.createdAt)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs">
                        <span className={cx('rounded px-1.5 py-0.5 font-medium', item.requestedUrgency === 'URGENT' ? 'bg-orange-50 text-orange-800' : 'bg-slate-100 text-slate-700')}>
                          {item.requestedUrgency === 'URGENT' ? 'Urgent pref.' : 'Routine pref.'}
                        </span>
                        {item.isFollowUp && <span className="ml-1 text-slate-500">· follow-up</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <RouteBadge route={item.recommendedRoute} size="sm" />
                        {item.finalRoute && item.finalRoute !== item.recommendedRoute && (
                          <div className="mt-1 text-[11px] text-slate-500">
                            Final: <RouteBadge route={item.finalRoute} size="sm" short />
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <StatusBadge status={item.reviewStatus} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        {item.primaryRuleId ? <RuleChip id={item.primaryRuleId} /> : '—'}
                        {item.matchedRuleIds.length > 1 && <span className="ml-1 text-[11px] text-slate-500">+{item.matchedRuleIds.length - 1}</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <UncertaintyBadge present={item.uncertaintyPresent} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <AiBadge status={item.aiStatus} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-slate-600">{item.assignedStaffId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
              <span>
                {query.data.total} request{query.data.total === 1 ? '' : 's'} · page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button type="button" className="btn-secondary px-2 py-1" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button type="button" className="btn-secondary px-2 py-1" disabled={page >= totalPages} onClick={() => setPage(page + 1)} aria-label="Next page">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}
