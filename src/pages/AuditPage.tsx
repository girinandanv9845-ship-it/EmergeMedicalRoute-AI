import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Lock, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState, PageHeader, RuleChip, cx } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, humanise } from '../lib/format';

const ACTOR_STYLE: Record<string, string> = {
  system: 'bg-slate-100 text-slate-700',
  staff: 'bg-sky-50 text-sky-800',
  requester: 'bg-teal-50 text-teal-800',
  ai_provider: 'bg-indigo-50 text-indigo-800',
};

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const [requestId, setRequestId] = useState(params.get('requestId') ?? '');
  const page = Number(params.get('page') ?? '1');
  const pageSize = 50;
  const apiParams = new URLSearchParams(params);
  apiParams.set('pageSize', String(pageSize));
  const q = useQuery({ queryKey: ['audit', apiParams.toString()], queryFn: () => api.audit(apiParams), placeholderData: keepPreviousData });

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next);
  };
  const totalPages = q.data ? Math.max(1, Math.ceil(q.data.total / pageSize)) : 1;

  return (
    <div className="fade-in space-y-5">
      <PageHeader icon={ScrollText} title="Audit log" description="Append-only history of important actions. Entries cannot be edited or deleted through the application (enforced by database triggers)." />

      <div className="card grid gap-3 p-4 md:grid-cols-4">
        <form
          className="md:col-span-2"
          onSubmit={(e) => {
            e.preventDefault();
            update('requestId', requestId.trim());
          }}
        >
          <label htmlFor="audit-request" className="sr-only">
            Filter by request ID
          </label>
          <input id="audit-request" className="input" placeholder="Filter by request ID (press Enter)" value={requestId} onChange={(e) => setRequestId(e.target.value)} />
        </form>
        <select aria-label="Filter by event type" className="input" value={params.get('eventType') ?? ''} onChange={(e) => update('eventType', e.target.value)}>
          <option value="">All event types</option>
          {q.data?.eventTypes.map((t) => (
            <option key={t} value={t}>
              {humanise(t)}
            </option>
          ))}
        </select>
        <select aria-label="Filter by actor" className="input" value={params.get('actorType') ?? ''} onChange={(e) => update('actorType', e.target.value)}>
          <option value="">All actors</option>
          <option value="system">System</option>
          <option value="staff">Staff</option>
          <option value="requester">Requester</option>
          <option value="ai_provider">AI provider</option>
        </select>
      </div>

      {q.isLoading ? (
        <LoadingState rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data!.items.length === 0 ? (
        <EmptyState title="No audit events match" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm" data-testid="audit-table">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-3">#</th>
                  <th scope="col" className="px-4 py-3">Timestamp</th>
                  <th scope="col" className="px-4 py-3">Event</th>
                  <th scope="col" className="px-4 py-3">Request</th>
                  <th scope="col" className="px-4 py-3">Actor</th>
                  <th scope="col" className="px-4 py-3">Description</th>
                  <th scope="col" className="px-4 py-3">Rules</th>
                  <th scope="col" className="px-4 py-3">Policy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data!.items.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400">{e.id}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-600">{formatDateTime(e.createdAt)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs font-semibold text-slate-800">{humanise(e.eventType)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">
                      {e.requestId ? (
                        <Link to={`/cases/${e.requestId}`} className="text-teal-700 hover:underline">
                          {e.requestId}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className={cx('rounded px-1.5 py-0.5 text-[11px] font-medium', ACTOR_STYLE[e.actorType])}>
                        {humanise(e.actorType)}
                        {e.actorId ? ` · ${e.actorId}` : ''}
                      </span>
                    </td>
                    <td className="min-w-64 px-4 py-2.5 text-xs text-slate-700">{e.description}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex max-w-56 flex-wrap gap-1">
                        {e.matchedRuleIds.slice(0, 4).map((r) => (
                          <RuleChip key={r} id={r} />
                        ))}
                        {e.matchedRuleIds.length > 4 && <span className="text-[11px] text-slate-500">+{e.matchedRuleIds.length - 4}</span>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-slate-500">{e.policyVersion ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
            <span>
              {q.data!.total} events · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary px-2 py-1" disabled={page <= 1} onClick={() => update('page', String(page - 1))} aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="btn-secondary px-2 py-1"
                disabled={page >= totalPages}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set('page', String(page + 1));
                  setParams(next);
                }}
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
      <p className="flex items-start gap-1.5 text-xs text-slate-500">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> Local prototype audit log: append-only within this SQLite database. It is not a tamper-evident, enterprise-grade immutable audit platform (anyone with direct file access could alter the database). Full symptom descriptions are not copied into audit messages.
      </p>
    </div>
  );
}
