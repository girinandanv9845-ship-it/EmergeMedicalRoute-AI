import { AlertTriangle, Bot, BotOff, CheckCircle2, CircleDashed, Inbox, Loader2, RefreshCw, ShieldAlert, UserCheck, XCircle, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AI_STATUS_LABELS, REVIEW_STATUS_LABELS, type AiStatus, type ReviewStatus, type Route } from '../../../shared/domain';
import { ApiError } from '../../lib/api';
import { ROUTE_META } from '../../lib/routes';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Badges (always icon + text — never colour alone)
// ---------------------------------------------------------------------------
export function RouteBadge({ route, size = 'md', short = false }: { route: Route; size?: 'sm' | 'md'; short?: boolean }) {
  const m = ROUTE_META[route];
  const Icon = m.icon;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset',
        m.badge,
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs',
      )}
      data-route={route}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {short ? m.short : m.label}
    </span>
  );
}

const STATUS_STYLE: Record<ReviewStatus, { icon: LucideIcon; cls: string }> = {
  AWAITING_REVIEW: { icon: CircleDashed, cls: 'bg-slate-100 text-slate-700 ring-slate-400/30' },
  APPROVED: { icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-800 ring-emerald-600/30' },
  OVERRIDDEN: { icon: UserCheck, cls: 'bg-sky-50 text-sky-800 ring-sky-600/30' },
  CLARIFICATION_REQUESTED: { icon: AlertTriangle, cls: 'bg-orange-50 text-orange-800 ring-orange-600/30' },
};

export function StatusBadge({ status }: { status: ReviewStatus }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', s.cls)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {REVIEW_STATUS_LABELS[status]}
    </span>
  );
}

export function AiBadge({ status }: { status: AiStatus }) {
  const off = status === 'disabled' || status === 'not_used';
  const bad = status === 'unavailable' || status === 'timeout' || status === 'malformed_rejected';
  const Icon = off ? BotOff : bad ? XCircle : Bot;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium',
        off ? 'bg-slate-100 text-slate-600' : bad ? 'bg-orange-50 text-orange-800' : 'bg-indigo-50 text-indigo-800',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {AI_STATUS_LABELS[status]}
    </span>
  );
}

export function UncertaintyBadge({ present }: { present: boolean }) {
  if (!present) return <span className="text-xs text-slate-500">None</span>;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-800">
      <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
      Uncertain
    </span>
  );
}

export function RuleChip({ id }: { id: string }) {
  return (
    <Link to={`/policy?rule=${encodeURIComponent(id)}`} className="inline-block rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 hover:bg-slate-200">
      {id}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------
export function PageHeader({ title, description, actions, icon: Icon }: { title: string; description?: ReactNode; actions?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-900">
          {Icon && <Icon className="h-6 w-6 text-teal-700" aria-hidden />}
          {title}
        </h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, bodyClassName, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  return (
    <section className={cx('card', className)} aria-labelledby={title && id ? `${id}-title` : undefined}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          {title && (
            <h2 id={id ? `${id}-title` : undefined} className="text-sm font-semibold text-slate-900">
              {title}
            </h2>
          )}
          {actions}
        </header>
      )}
      <div className={cx('p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'slate',
  to,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: LucideIcon;
  tone?: 'slate' | 'red' | 'amber' | 'violet' | 'teal' | 'sky' | 'indigo';
  to?: string;
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-800',
    violet: 'bg-violet-100 text-violet-700',
    teal: 'bg-teal-100 text-teal-800',
    sky: 'bg-sky-100 text-sky-700',
    indigo: 'bg-indigo-100 text-indigo-700',
  };
  const body = (
    <div className="flex items-start gap-3">
      <span className={cx('rounded-lg p-2', tones[tone])}>
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      </div>
    </div>
  );
  return to ? (
    <Link to={to} className="card block p-4 transition hover:border-teal-300 hover:shadow-md">
      {body}
    </Link>
  ) : (
    <div className="card p-4">{body}</div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-slate-600">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function LoadingState({ label = 'Loading…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true">
      <Spinner label={label} />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-200/70" />
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action, icon: Icon = Inbox }: { title: string; description?: ReactNode; action?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <Icon className="h-8 w-8 text-slate-400" aria-hidden />
      <p className="mt-3 text-sm font-semibold text-slate-800">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-slate-600">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Something went wrong' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Unknown error';
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
      <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden />
      <div className="flex-1">
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5">{message}</p>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-secondary">
          <RefreshCw className="h-4 w-4" aria-hidden /> Retry
        </button>
      )}
    </div>
  );
}

export function InlineMessage({ tone, children }: { tone: 'success' | 'error' | 'info'; children: ReactNode }) {
  const map = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    error: 'border-red-200 bg-red-50 text-red-900',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
  };
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? XCircle : AlertTriangle;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', map[tone])}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accessible modal dialog (used for destructive confirmations)
// ---------------------------------------------------------------------------
export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, button, textarea, select');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="card fade-in w-full max-w-lg p-6">
        <h2 id={titleId} className="text-lg font-semibold text-slate-900">
          {title}
        </h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
