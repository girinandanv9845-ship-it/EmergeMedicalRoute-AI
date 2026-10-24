import { CalendarCheck, CircleHelp, Clock, Siren, type LucideIcon } from 'lucide-react';
import { ROUTE_LABELS, type Route } from '../../shared/domain';

export interface RouteMeta {
  label: string;
  short: string;
  icon: LucideIcon;
  /** Chart fill (validated palette — see docs/architecture.md). */
  color: string;
  badge: string;
  panel: string;
  description: string;
}

export const ROUTE_META: Record<Route, RouteMeta> = {
  EMERGENCY_GUIDANCE: {
    label: ROUTE_LABELS.EMERGENCY_GUIDANCE,
    short: 'Emergency',
    icon: Siren,
    color: '#dc2626',
    badge: 'bg-red-50 text-red-800 ring-red-600/30',
    panel: 'border-red-300 bg-red-50',
    description: 'Direct to local emergency services immediately.',
  },
  SAME_DAY_HUMAN_REVIEW: {
    label: ROUTE_LABELS.SAME_DAY_HUMAN_REVIEW,
    short: 'Same-day',
    icon: Clock,
    color: '#ca8a04',
    badge: 'bg-amber-50 text-amber-900 ring-amber-600/30',
    panel: 'border-amber-300 bg-amber-50',
    description: 'Prompt human assessment today.',
  },
  NEEDS_CLARIFICATION_OR_HUMAN_REVIEW: {
    label: ROUTE_LABELS.NEEDS_CLARIFICATION_OR_HUMAN_REVIEW,
    short: 'Clarify',
    icon: CircleHelp,
    color: '#7c3aed',
    badge: 'bg-violet-50 text-violet-900 ring-violet-600/30',
    panel: 'border-violet-300 bg-violet-50',
    description: 'Unclear or incomplete — staff must review; never auto-routine.',
  },
  ROUTINE_APPOINTMENT: {
    label: ROUTE_LABELS.ROUTINE_APPOINTMENT,
    short: 'Routine',
    icon: CalendarCheck,
    color: '#0d9488',
    badge: 'bg-teal-50 text-teal-900 ring-teal-600/30',
    panel: 'border-teal-300 bg-teal-50',
    description: 'Standard administrative queue.',
  },
};
