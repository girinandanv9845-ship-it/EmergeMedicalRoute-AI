import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  ClipboardList,
  FileSearch,
  FlaskConical,
  LayoutDashboard,
  Menu,
  MessagesSquare,
  ScrollText,
  ShieldCheck,
  SquarePen,
  Waypoints,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { DEMO_STAFF } from '../../../shared/domain';
import { api } from '../../lib/api';
import { useStaff } from '../../lib/staff';
import { cx } from '../ui';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/intake', label: 'New Intake', icon: SquarePen },
  { to: '/assistant', label: 'AI Assistant', icon: MessagesSquare },
  { to: '/queue', label: 'Request Queue', icon: ClipboardList },
  { to: '/cases', label: 'Case Details', icon: FileSearch },
  { to: '/policy', label: 'Routing Policy', icon: Waypoints },
  { to: '/tests', label: 'Test Lab', icon: FlaskConical },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/audit', label: 'Audit Log', icon: ScrollText },
  { to: '/settings', label: 'Settings & Safety', icon: ShieldCheck },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-700 text-white">
        <Activity className="h-5 w-5" aria-hidden />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-white">EmergeMedicalRoute AI</p>
        <p className="text-[11px] text-slate-400">Explainable intake & safe routing</p>
      </div>
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main navigation" className="mt-6 space-y-0.5">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white',
            )
          }
        >
          <Icon className="h-4.5 w-4.5 shrink-0" aria-hidden />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function SystemDot() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000, retry: 0 });
  const ok = health.data?.status === 'ok';
  const label = health.isLoading ? 'Checking backend…' : health.isError ? 'Backend unreachable' : ok ? 'All systems operational' : 'Degraded';
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span className={cx('h-2 w-2 rounded-full', health.isLoading ? 'bg-slate-500' : ok ? 'bg-emerald-400' : 'bg-red-400')} aria-hidden />
      <span>{label}</span>
    </div>
  );
}

function StaffSelector() {
  const { staffId, setStaffId } = useStaff();
  return (
    <label className="flex items-center gap-2 text-xs text-slate-600">
      <span className="hidden whitespace-nowrap sm:inline">Demo staff identity</span>
      <select
        aria-label="Demo staff identity (not real authentication)"
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800"
        value={staffId}
        onChange={(e) => setStaffId(e.target.value)}
      >
        {DEMO_STAFF.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen lg:pl-64">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col bg-slate-900 px-4 py-5 lg:flex">
        <Brand />
        <NavList />
        <div className="mt-auto space-y-3 border-t border-white/10 pt-4">
          <SystemDot />
          <p className="text-[11px] leading-relaxed text-slate-500">Educational hackathon prototype. Not a medical device. Does not diagnose.</p>
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} aria-hidden />
          <aside className="relative flex h-full w-72 flex-col bg-slate-900 px-4 py-5">
            <div className="flex items-center justify-between">
              <Brand />
              <button type="button" className="rounded p-1 text-slate-300 hover:bg-white/10" onClick={() => setOpen(false)} aria-label="Close navigation">
                <X className="h-5 w-5" />
              </button>
            </div>
            <NavList onNavigate={() => setOpen(false)} />
            <div className="mt-auto">
              <SystemDot />
            </div>
          </aside>
        </div>
      )}

      <div className="sticky top-0 z-30">
        <div role="status" className="bg-amber-400 px-4 py-1.5 text-center text-xs font-bold tracking-wide text-amber-950" data-testid="demo-banner">
          DEMO MODE — SYNTHETIC DATA ONLY
        </div>
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-4 py-2.5 backdrop-blur sm:px-6">
          <button type="button" className="rounded-md p-1.5 text-slate-700 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open}>
            <Menu className="h-5 w-5" />
          </button>
          <p className="hidden text-xs text-slate-500 md:block">Administrative decision support only — staff make every final decision.</p>
          <StaffSelector />
        </header>
      </div>

      <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
