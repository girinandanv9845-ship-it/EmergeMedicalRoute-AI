import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { ROUTES, type Route } from '../../shared/domain';
import type { VolumePoint } from '../lib/api';
import { ROUTE_META } from '../lib/routes';

const AXIS = { fontSize: 11, fill: '#64748b' };
const GRID = '#e2e8f0';

function TooltipBox({ title, rows }: { title: string; rows: { label: string; value: ReactNode; color?: string }[] }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-slate-900">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="flex items-center gap-2 text-slate-700">
          {r.color && <span className="h-2.5 w-2.5 rounded-sm" style={{ background: r.color }} aria-hidden />}
          <span className="flex-1">{r.label}</span>
          <span className="font-semibold tabular-nums text-slate-900">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

export function TableToggle({ children, label = 'View as table' }: { children: ReactNode; label?: string }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-slate-500 hover:text-slate-800">{label}</summary>
      <div className="mt-2 overflow-x-auto">{children}</div>
    </details>
  );
}

export function RouteLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Legend">
      {ROUTES.map((r) => {
        const Icon = ROUTE_META[r].icon;
        return (
          <li key={r} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ROUTE_META[r].color }} aria-hidden />
            <Icon className="h-3 w-3" aria-hidden />
            {ROUTE_META[r].short}
          </li>
        );
      })}
    </ul>
  );
}

/** Horizontal bars: count of requests per route. Single series → bars labelled by route on the axis. */
export function RouteDistributionChart({ data, onSelect }: { data: { route: Route; count: number }[]; onSelect?: (route: Route) => void }) {
  const rows = data.map((d) => ({ ...d, name: ROUTE_META[d.route].short }));
  return (
    <div>
      <div className="h-52" role="img" aria-label={`Routing distribution: ${rows.map((r) => `${r.name} ${r.count}`).join(', ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }} barCategoryGap={10}>
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis type="number" allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" width={78} tick={{ ...AXIS, fill: '#334155' }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: 'rgba(15,23,42,0.04)' }}
              content={({ active, payload }: TooltipProps<number, string>) =>
                active && payload?.[0] ? (
                  <TooltipBox title={ROUTE_META[(payload[0].payload as { route: Route }).route].label} rows={[{ label: 'Requests', value: payload[0].value }]} />
                ) : null
              }
            />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={26} onClick={(d: { route?: Route }) => d.route && onSelect?.(d.route)} className={onSelect ? 'cursor-pointer' : undefined} label={{ position: 'right', fontSize: 11, fill: '#334155' }}>
              {rows.map((r) => (
                <Cell key={r.route} fill={ROUTE_META[r.route].color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <TableToggle>
        <table className="w-full">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1">Route</th>
              <th className="py-1 text-right">Requests</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.route} className="border-t border-slate-100">
                <td className="py-1">{ROUTE_META[r.route].label}</td>
                <td className="py-1 text-right tabular-nums">{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableToggle>
    </div>
  );
}

const STACK: { key: keyof VolumePoint; route: Route }[] = [
  { key: 'emergency', route: 'EMERGENCY_GUIDANCE' },
  { key: 'sameDay', route: 'SAME_DAY_HUMAN_REVIEW' },
  { key: 'clarification', route: 'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW' },
  { key: 'routine', route: 'ROUTINE_APPOINTMENT' },
];

/** Stacked daily bars by route (synthetic timestamps). */
export function VolumeChart({ data }: { data: VolumePoint[] }) {
  const rows = data.map((d) => ({ ...d, label: new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }));
  return (
    <div>
      <RouteLegend />
      <div className="mt-2 h-56" role="img" aria-label={`Requests per day over the last ${rows.length} days, total ${rows.reduce((n, r) => n + r.total, 0)}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ left: -16, right: 8, top: 8, bottom: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
            <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: 'rgba(15,23,42,0.05)' }}
              content={({ active, payload, label }: TooltipProps<number, string>) =>
                active && payload?.length ? (
                  <TooltipBox
                    title={String(label)}
                    rows={[
                      ...STACK.map((s) => ({ label: ROUTE_META[s.route].short, value: (payload[0]!.payload as VolumePoint)[s.key], color: ROUTE_META[s.route].color })),
                      { label: 'Total', value: (payload[0]!.payload as VolumePoint).total },
                    ]}
                  />
                ) : null
              }
            />
            {STACK.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} stackId="v" fill={ROUTE_META[s.route].color} stroke="#ffffff" strokeWidth={2} radius={i === STACK.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={28} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <TableToggle>
        <table className="w-full">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1">Date</th>
              {STACK.map((s) => (
                <th key={s.key} className="py-1 text-right">
                  {ROUTE_META[s.route].short}
                </th>
              ))}
              <th className="py-1 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.date} className="border-t border-slate-100">
                <td className="py-1">{r.date}</td>
                {STACK.map((s) => (
                  <td key={s.key} className="py-1 text-right tabular-nums">
                    {r[s.key]}
                  </td>
                ))}
                <td className="py-1 text-right font-semibold tabular-nums">{r.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableToggle>
    </div>
  );
}

/** Single-series horizontal bar chart in one neutral hue (magnitude, not identity). */
export function SimpleBarChart({ data, label, height = 260, color = '#0f766e' }: { data: { name: string; value: number }[]; label: string; height?: number; color?: string }) {
  return (
    <div>
      <div style={{ height }} role="img" aria-label={`${label}: ${data.map((d) => `${d.name} ${d.value}`).join(', ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 28, top: 0, bottom: 0 }} barCategoryGap={6}>
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis type="number" allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" width={150} tick={{ ...AXIS, fill: '#334155', fontFamily: 'ui-monospace, monospace' }} axisLine={false} tickLine={false} interval={0} />
            <Tooltip
              cursor={{ fill: 'rgba(15,23,42,0.04)' }}
              content={({ active, payload }: TooltipProps<number, string>) =>
                active && payload?.[0] ? <TooltipBox title={String((payload[0].payload as { name: string }).name)} rows={[{ label, value: payload[0].value }]} /> : null
              }
            />
            <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} maxBarSize={18} label={{ position: 'right', fontSize: 11, fill: '#334155' }} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <TableToggle>
        <table className="w-full">
          <tbody>
            {data.map((d) => (
              <tr key={d.name} className="border-t border-slate-100">
                <td className="py-1 font-mono">{d.name}</td>
                <td className="py-1 text-right tabular-nums">{d.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableToggle>
    </div>
  );
}
