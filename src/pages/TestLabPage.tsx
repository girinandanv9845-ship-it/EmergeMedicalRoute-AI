import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, CheckCircle2, ChevronDown, CircleSlash, FlaskConical, Play, PlayCircle, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Route } from '../../shared/domain';
import { Card, ErrorState, InlineMessage, LoadingState, PageHeader, RouteBadge, cx } from '../components/ui';
import { api, type TestCaseView, type TestResultView } from '../lib/api';
import { formatDateTime } from '../lib/format';

function StatusPill({ result }: { result?: TestResultView }) {
  if (!result) return <span className="text-xs text-slate-400">Not run</span>;
  if (result.criticalFailure)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
        <AlertOctagon className="h-3.5 w-3.5" aria-hidden /> Critical failure
      </span>
    );
  if (result.status === 'failed')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-800 ring-1 ring-red-600/30">
        <XCircle className="h-3.5 w-3.5" aria-hidden /> Failed
      </span>
    );
  if (result.status === 'skipped')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-400/30">
        <CircleSlash className="h-3.5 w-3.5" aria-hidden /> Skipped
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-600/30">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Passed
    </span>
  );
}

function describeInput(tc: TestCaseView): string {
  if (tc.input) {
    const text = tc.input.symptomDescription;
    return text.trim() === '' ? `(${text.length === 0 ? 'empty' : 'whitespace only'})` : text.length > 160 ? `${text.slice(0, 160)}… (${text.length} chars)` : text;
  }
  if (tc.rawBody) {
    const s = JSON.stringify(tc.rawBody);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  }
  return '—';
}

function Expected({ e }: { e: TestCaseView['expected'] }) {
  return (
    <div className="space-y-1 text-xs text-slate-700">
      {e.route && (
        <div className="flex items-center gap-1">
          Route: <RouteBadge route={e.route} size="sm" short />
        </div>
      )}
      {typeof e.notRoute === 'string' && <p>Must not be: {String(e.notRoute)}</p>}
      {Array.isArray(e.mustIncludeRules) && <p>Rules: {(e.mustIncludeRules as string[]).join(', ')}</p>}
      {Array.isArray(e.mustExcludeRules) && <p>Not rules: {(e.mustExcludeRules as string[]).join(', ')}</p>}
      {typeof e.emergencyGuidance === 'boolean' && <p>Emergency guidance: {e.emergencyGuidance ? 'yes' : 'no'}</p>}
      {typeof e.requiresHumanReview === 'boolean' && <p>Human review mandatory: {e.requiresHumanReview ? 'yes' : 'no'}</p>}
      {Array.isArray(e.safetyFlags) && <p>Flags: {(e.safetyFlags as string[]).join(', ')}</p>}
      {typeof e.aiStatus === 'string' && <p>AI status: {e.aiStatus}</p>}
      {typeof e.outcome === 'string' && <p>Outcome: {e.outcome}{e.errorCode ? ` (${String(e.errorCode)})` : ''}</p>}
      {typeof e.assistantType === 'string' && <p>Assistant response: {e.assistantType}</p>}
      {e.modelMustNotBeCalled === true && <p>Local model must not be called</p>}
      {typeof e.replyMustNotMatch === 'string' && <p>Reply must not contain: {e.replyMustNotMatch}</p>}
    </div>
  );
}

export function TestLabPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tests'], queryFn: api.tests });
  const [results, setResults] = useState<Record<string, TestResultView>>({});
  const [lastRun, setLastRun] = useState<{ runId: string; createdAt: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'failed' | 'critical' | 'safety'>('all');
  const [open, setOpen] = useState<string | null>(null);

  const merged = useMemo(() => {
    const base: Record<string, TestResultView> = {};
    q.data?.latestRun?.results.forEach((r) => (base[r.testId] = r));
    return { ...base, ...results };
  }, [q.data, results]);

  const after = (data: Awaited<ReturnType<typeof api.runAllTests>>) => {
    setResults((prev) => ({ ...prev, ...Object.fromEntries(data.results.map((r) => [r.testId, r])) }));
    setLastRun({ runId: data.runId, createdAt: data.createdAt });
    qc.invalidateQueries({ queryKey: ['analytics'] });
    qc.invalidateQueries({ queryKey: ['audit'] });
  };
  const runAll = useMutation({ mutationFn: api.runAllTests, onSuccess: after });
  const runOne = useMutation({ mutationFn: api.runTest, onSuccess: after });

  if (q.isLoading) return <LoadingState label="Loading test cases…" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const cases = q.data!.cases;
  const all = cases.map((c) => merged[c.id]).filter((r): r is TestResultView => !!r);
  const counts = {
    passed: all.filter((r) => r.status === 'passed').length,
    failed: all.filter((r) => r.status === 'failed').length,
    skipped: all.filter((r) => r.status === 'skipped').length,
    critical: all.filter((r) => r.criticalFailure).length,
  };
  const overall = all.length === 0 ? null : counts.critical > 0 ? 'CRITICAL' : counts.failed > 0 ? 'FAILED' : 'PASSED';
  const visible = cases.filter((c) => {
    const r = merged[c.id];
    if (filter === 'failed') return r?.status === 'failed';
    if (filter === 'critical') return r?.criticalFailure;
    if (filter === 'safety') return c.safetyCritical;
    return true;
  });
  const runInfo = lastRun ?? (q.data!.latestRun ? { runId: q.data!.latestRun.runId, createdAt: q.data!.latestRun.createdAt } : null);

  return (
    <div className="fade-in space-y-5">
      <PageHeader
        icon={FlaskConical}
        title="Test Lab"
        description="Executes the synthetic test suite against the real backend routing engine, AI boundary, validation and workflow services. Results are computed, never hard-coded."
        actions={
          <button type="button" className="btn-primary" onClick={() => runAll.mutate()} disabled={runAll.isPending}>
            <PlayCircle className="h-4 w-4" aria-hidden /> {runAll.isPending ? 'Running…' : 'Run all tests'}
          </button>
        }
      />

      {(runAll.isError || runOne.isError) && <ErrorState error={runAll.error ?? runOne.error} title="Test run failed to execute" />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6" aria-live="polite">
        <div
          className={cx(
            'card p-4 lg:col-span-2',
            overall === 'CRITICAL' && 'border-2 border-red-600 bg-red-50',
            overall === 'FAILED' && 'border-red-300 bg-red-50',
            overall === 'PASSED' && 'border-emerald-300 bg-emerald-50',
          )}
          data-testid="test-overall"
        >
          <p className="kicker">Suite status</p>
          <p className="mt-1 text-xl font-bold">
            {overall === null ? 'Not yet run' : overall === 'CRITICAL' ? 'SAFETY-CRITICAL FAILURE' : overall === 'FAILED' ? 'Failures present' : 'All executed tests passed'}
          </p>
          <p className="mt-1 text-xs text-slate-600">{runInfo ? `Run ${runInfo.runId} · ${formatDateTime(runInfo.createdAt)}` : 'Press "Run all tests".'}</p>
          <p className="mt-1 text-xs text-slate-600">Passing synthetic tests does not establish clinical safety.</p>
        </div>
        {[
          ['Passed', counts.passed, 'text-emerald-700'],
          ['Failed', counts.failed, 'text-red-700'],
          ['Critical failures', counts.critical, 'text-red-700'],
          ['Skipped (optional deps)', counts.skipped, 'text-slate-600'],
        ].map(([label, value, cls]) => (
          <div key={label as string} className="card p-4">
            <p className="kicker">{label}</p>
            <p className={cx('mt-1 text-2xl font-semibold tabular-nums', cls as string)}>{value}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        {cases.length} test cases · {cases.filter((c) => c.safetyCritical).length} safety-critical · {counts.skipped} skipped because an optional dependency (the local Ollama model) is not available.
      </p>

      {overall === 'CRITICAL' && <InlineMessage tone="error">A safety-critical test failed. The suite is NOT considered passing. Investigate the highlighted rows before any demonstration.</InlineMessage>}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter tests">
        {(['all', 'safety', 'failed', 'critical'] as const).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cx('rounded-full px-3 py-1 text-xs font-medium ring-1', filter === f ? 'bg-teal-700 text-white ring-teal-700' : 'bg-white text-slate-700 ring-slate-300')}>
            {{ all: 'All', safety: 'Safety-critical', failed: 'Failed', critical: 'Critical failures' }[f]}
          </button>
        ))}
      </div>

      <Card bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm" data-testid="test-table">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3">Test</th>
                <th scope="col" className="px-4 py-3">Synthetic input</th>
                <th scope="col" className="px-4 py-3">Expected</th>
                <th scope="col" className="px-4 py-3">Actual</th>
                <th scope="col" className="px-4 py-3">Status</th>
                <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map((tc) => {
                const r = merged[tc.id];
                const actualRoute = r?.actual?.route as Route | undefined;
                const expanded = open === tc.id;
                return (
                  <tr key={tc.id} className={cx('align-top', r?.criticalFailure && 'bg-red-50', r?.status === 'failed' && !r.criticalFailure && 'bg-red-50/40')} data-testid={`test-row-${tc.id}`}>
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs font-semibold">{tc.id}</p>
                      <p className="text-sm text-slate-800">{tc.title}</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {tc.category} · {tc.kind}
                        {tc.safetyCritical && <span className="ml-1 rounded bg-red-100 px-1 font-semibold text-red-800">safety-critical</span>}
                      </p>
                    </td>
                    <td className="max-w-xs px-4 py-3 text-xs text-slate-700">
                      <p className="break-words">{describeInput(tc)}</p>
                      {tc.aiMode && <p className="mt-1 text-[11px] text-indigo-700">Mock AI mode: {tc.aiMode}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <Expected e={tc.expected} />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">
                      {!r ? (
                        '—'
                      ) : (
                        <div className="space-y-1">
                          {actualRoute && <RouteBadge route={actualRoute} size="sm" short />}
                          {typeof r.actual?.outcome === 'string' && <p>Outcome: {String(r.actual.outcome)}{r.actual.errorCode ? ` (${String(r.actual.errorCode)})` : ''}</p>}
                          {typeof r.actual?.assistantType === 'string' && <p>Assistant: {String(r.actual.assistantType)}{r.actual.modelCalled === false ? ' · model not called' : ''}</p>}
                          {typeof r.actual?.aiStatus === 'string' && <p>AI: {String(r.actual.aiStatus)}</p>}
                          {r.status === 'skipped' && typeof r.actual?.reason === 'string' && <p className="text-slate-500">{r.actual.reason}</p>}
                          {r.failureReason && <p className="font-medium text-red-800">✗ {r.failureReason}</p>}
                          <button type="button" className="inline-flex items-center gap-0.5 text-[11px] text-slate-500 hover:text-slate-800" onClick={() => setOpen(expanded ? null : tc.id)} aria-expanded={expanded}>
                            Raw <ChevronDown className={cx('h-3 w-3', expanded && 'rotate-180')} aria-hidden />
                          </button>
                          {expanded && <pre className="max-w-xs overflow-x-auto rounded bg-slate-900 p-2 text-[10px] text-slate-100">{JSON.stringify(r.actual, null, 2)}</pre>}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <StatusPill result={r} />
                      {r && <p className="mt-1 text-[10px] text-slate-400">{r.durationMs} ms</p>}
                    </td>
                    <td className="px-4 py-3">
                      <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => runOne.mutate(tc.id)} disabled={runOne.isPending || runAll.isPending} aria-label={`Run ${tc.id}`}>
                        <Play className="h-3.5 w-3.5" aria-hidden /> Run
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
