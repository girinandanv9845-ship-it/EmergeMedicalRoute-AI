import { Bot, BotOff, Flag, ListChecks, ShieldAlert } from 'lucide-react';
import type { Recommendation } from '../../../shared/domain';
import { formatDateTime, humanise } from '../../lib/format';
import { ROUTE_META } from '../../lib/routes';
import { AiBadge, RouteBadge, RuleChip, cx } from '../ui';
import { NotDiagnosisNote } from './SafetyNotices';

export function RecommendationPanel({ rec, createdAt, compact = false }: { rec: Recommendation; createdAt?: string; compact?: boolean }) {
  const meta = ROUTE_META[rec.recommendedRoute];
  return (
    <div className="space-y-4" data-testid="recommendation-panel">
      <div className={cx('rounded-xl border p-4', meta.panel)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="kicker">Recommended route</span>
            <RouteBadge route={rec.recommendedRoute} />
            {rec.requiresHumanReview && <span className="rounded-md bg-white/70 px-1.5 py-0.5 text-xs font-medium text-slate-700">Human review required</span>}
          </div>
          <span className="text-xs text-slate-600">
            Policy <span className="font-mono">{rec.policyVersion}</span>
            {createdAt && <> · {formatDateTime(createdAt)}</>}
          </span>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-slate-800" data-testid="explanation">
          {rec.explanation}
        </p>
      </div>

      <div className={cx('grid gap-4', !compact && 'md:grid-cols-2')}>
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <ListChecks className="h-4 w-4 text-teal-700" aria-hidden /> Matched policy rules ({rec.matchedRuleIds.length})
          </h3>
          <ol className="space-y-2">
            {rec.explanationPoints.map((point, i) => (
              <li key={i} className="rounded-lg border border-slate-200 bg-white p-2.5 text-xs text-slate-700">
                <RuleChip id={rec.matchedRuleIds[i] ?? ''} />
                <span className="ml-2">{point.replace(/^\S+ — /, '')}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="space-y-4">
          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <ShieldAlert className="h-4 w-4 text-violet-700" aria-hidden /> Uncertainty
            </h3>
            {rec.uncertainty.present ? (
              <ul className="list-disc space-y-1 pl-5 text-xs text-slate-700" data-testid="uncertainty-reasons">
                {rec.uncertainty.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-600">No uncertainty detected by the demonstration policy. (The absence of a detected warning sign does not prove a situation is safe.)</p>
            )}
          </div>

          {rec.safetyFlags.length > 0 && (
            <div>
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                <Flag className="h-4 w-4 text-red-700" aria-hidden /> Safety flags
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {rec.safetyFlags.map((f) => (
                  <span key={f} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">
                    {humanise(f)}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50/40 p-3">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              {rec.aiStatus === 'used' ? <Bot className="h-4 w-4 text-indigo-700" aria-hidden /> : <BotOff className="h-4 w-4 text-slate-500" aria-hidden />}
              AI-assisted interpretation <AiBadge status={rec.aiStatus} />
            </h3>
            <p className="text-xs text-slate-600">{rec.aiNote ?? 'AI was not used for this evaluation.'}</p>
            {rec.aiInterpretation && (
              <div className="mt-2 space-y-1.5 text-xs text-slate-700" data-testid="ai-interpretation">
                <p>
                  <span className="font-medium">Summary (AI, may be wrong):</span> {rec.aiInterpretation.plainLanguageSummary}
                </p>
                {rec.aiInterpretation.extractedPhrases.length > 0 && (
                  <p>
                    <span className="font-medium">Extracted phrases:</span> {rec.aiInterpretation.extractedPhrases.map((p) => `“${p}”`).join(', ')}
                  </p>
                )}
                {rec.aiInterpretation.relevantConceptIds.length > 0 && <p><span className="font-medium">Suggested concepts:</span> {rec.aiInterpretation.relevantConceptIds.join(', ')}</p>}
                {rec.aiInterpretation.ambiguityNotes.length > 0 && <p><span className="font-medium">Ambiguity:</span> {rec.aiInterpretation.ambiguityNotes.join(' ')}</p>}
              </div>
            )}
            <p className="mt-2 text-[11px] text-slate-500">The deterministic policy engine is authoritative. AI output can only escalate to human review.</p>
          </div>

          {rec.engineErrors.length > 0 && (
            <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-800">
              Rule evaluation problems: {rec.engineErrors.join('; ')} — conservative fallback applied.
            </p>
          )}
        </div>
      </div>
      <NotDiagnosisNote />
    </div>
  );
}
