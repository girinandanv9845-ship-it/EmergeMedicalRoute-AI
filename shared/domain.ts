/**
 * Shared domain vocabulary and validation schemas for EmergeMedicalRoute AI.
 *
 * These schemas are used by BOTH the browser (for friendly form validation) and the
 * server (authoritative validation). The server never trusts a client-supplied route.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Administrative routes
// ---------------------------------------------------------------------------
export const ROUTES = [
  'EMERGENCY_GUIDANCE',
  'SAME_DAY_HUMAN_REVIEW',
  'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW',
  'ROUTINE_APPOINTMENT',
] as const;
export type Route = (typeof ROUTES)[number];
export const RouteSchema = z.enum(ROUTES);

/** Lower number = higher administrative precedence. Used to resolve conflicting rules. */
export const ROUTE_PRECEDENCE: Record<Route, number> = {
  EMERGENCY_GUIDANCE: 1,
  SAME_DAY_HUMAN_REVIEW: 2,
  NEEDS_CLARIFICATION_OR_HUMAN_REVIEW: 3,
  ROUTINE_APPOINTMENT: 4,
};

export const ROUTE_LABELS: Record<Route, string> = {
  EMERGENCY_GUIDANCE: 'Emergency guidance',
  SAME_DAY_HUMAN_REVIEW: 'Same-day human review',
  NEEDS_CLARIFICATION_OR_HUMAN_REVIEW: 'Needs clarification / human review',
  ROUTINE_APPOINTMENT: 'Routine appointment',
};

// ---------------------------------------------------------------------------
// Intake vocabulary
// ---------------------------------------------------------------------------
export const AGE_GROUPS = [
  'UNDER_1',
  '1_4',
  '5_12',
  '13_17',
  '18_39',
  '40_64',
  '65_PLUS',
  'NOT_PROVIDED',
] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];
export const AGE_GROUP_LABELS: Record<AgeGroup, string> = {
  UNDER_1: 'Under 1 year',
  '1_4': '1–4 years',
  '5_12': '5–12 years',
  '13_17': '13–17 years',
  '18_39': '18–39 years',
  '40_64': '40–64 years',
  '65_PLUS': '65 years or older',
  NOT_PROVIDED: 'Prefer not to say / unknown',
};

export const ONSETS = ['TODAY', '1_3_DAYS', '4_7_DAYS', '1_4_WEEKS', 'OVER_1_MONTH', 'UNKNOWN'] as const;
export type Onset = (typeof ONSETS)[number];
export const ONSET_LABELS: Record<Onset, string> = {
  TODAY: 'Today',
  '1_3_DAYS': '1–3 days ago',
  '4_7_DAYS': '4–7 days ago',
  '1_4_WEEKS': '1–4 weeks ago',
  OVER_1_MONTH: 'More than a month ago',
  UNKNOWN: 'Not sure / not applicable',
};

export const REQUESTED_URGENCY = ['ROUTINE', 'URGENT'] as const;
export type RequestedUrgency = (typeof REQUESTED_URGENCY)[number];

export const TIME_RANGES = ['MORNING', 'AFTERNOON', 'EVENING', 'ANY'] as const;
export type TimeRange = (typeof TIME_RANGES)[number];
export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  MORNING: 'Morning (08:00–12:00)',
  AFTERNOON: 'Afternoon (12:00–17:00)',
  EVENING: 'Evening (17:00–20:00)',
  ANY: 'Any time',
};

export const REVIEW_STATUSES = ['AWAITING_REVIEW', 'APPROVED', 'OVERRIDDEN', 'CLARIFICATION_REQUESTED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  AWAITING_REVIEW: 'Awaiting review',
  APPROVED: 'Approved by staff',
  OVERRIDDEN: 'Overridden by staff',
  CLARIFICATION_REQUESTED: 'Clarification requested',
};

export const AI_STATUSES = [
  'disabled',
  'used',
  'unavailable',
  'timeout',
  'malformed_rejected',
  'model_missing',
  'skipped_emergency',
  'not_used',
] as const;
export type AiStatus = (typeof AI_STATUSES)[number];
export const AI_STATUS_LABELS: Record<AiStatus, string> = {
  disabled: 'AI disabled',
  used: 'AI-assisted',
  unavailable: 'AI unavailable',
  timeout: 'AI timed out',
  malformed_rejected: 'AI output rejected',
  model_missing: 'AI model missing',
  skipped_emergency: 'AI skipped (emergency)',
  not_used: 'AI not used',
};

export const MAX_DESCRIPTION_LENGTH = 5000;
export const MAX_NOTES_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Intake schema
// ---------------------------------------------------------------------------
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), {
    message: 'Enter a real calendar date',
  });

/** Fields the requester (or staff on their behalf) supplies. No identifying data is collected. */
export const IntakeFieldsSchema = z
  .object({
    syntheticPatientId: z
      .string()
      .regex(/^SYN-P-\d{4}$/, 'Synthetic patient IDs look like SYN-P-2001')
      .optional(),
    ageGroup: z.enum(AGE_GROUPS, { errorMap: () => ({ message: 'Select an age group' }) }),
    symptomDescription: z
      .string({ required_error: 'Describe the concern in your own words' })
      .max(MAX_DESCRIPTION_LENGTH, `Keep the description under ${MAX_DESCRIPTION_LENGTH} characters`)
      .refine((v) => v.trim().length > 0, 'Describe the concern in your own words (it cannot be blank)'),
    symptomOnset: z.enum(ONSETS, { errorMap: () => ({ message: 'Select an approximate onset' }) }),
    requestedUrgency: z.enum(REQUESTED_URGENCY, { errorMap: () => ({ message: 'Select routine or urgent' }) }),
    preferredDate: isoDate,
    preferredTimeRange: z.enum(TIME_RANGES, { errorMap: () => ({ message: 'Select a preferred time range' }) }),
    administrativeNotes: z.string().max(MAX_NOTES_LENGTH, `Keep notes under ${MAX_NOTES_LENGTH} characters`).optional(),
    /** Optional policy context: is this a follow-up to a previous clinic visit? */
    isFollowUp: z.boolean().optional(),
  })
  .strict();
export type IntakeFields = z.infer<typeof IntakeFieldsSchema>;

/** Body of POST /api/requests. `clientSubmissionId` is an idempotency key that prevents duplicate submissions. */
export const CreateRequestBodySchema = IntakeFieldsSchema.extend({
  clientSubmissionId: z.string().uuid('clientSubmissionId must be a UUID').optional(),
}).strict();
export type CreateRequestBody = z.infer<typeof CreateRequestBodySchema>;

/** Validates the preferred date is not in the past relative to `today` (YYYY-MM-DD) and not absurdly far ahead. */
export function validatePreferredDate(preferredDate: string, today: string): string | null {
  if (preferredDate < today) return 'Preferred date cannot be in the past';
  const max = new Date(`${today}T00:00:00Z`);
  max.setUTCFullYear(max.getUTCFullYear() + 1);
  if (preferredDate > max.toISOString().slice(0, 10)) return 'Preferred date must be within the next 12 months';
  return null;
}

// ---------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------
export const DEMO_STAFF = [
  { id: 'STAFF-DEMO-A', label: 'Demo Staff A (front desk)' },
  { id: 'STAFF-DEMO-B', label: 'Demo Staff B (practice nurse)' },
  { id: 'STAFF-DEMO-C', label: 'Demo Staff C (clinic manager)' },
] as const;
export const DEMO_STAFF_IDS = DEMO_STAFF.map((s) => s.id) as [string, ...string[]];

export const ReviewBodySchema = z
  .object({
    action: z.enum(['APPROVE', 'REQUEST_CLARIFICATION', 'ASSIGN_TO_ME']),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type ReviewBody = z.infer<typeof ReviewBodySchema>;

export const MIN_OVERRIDE_REASON = 10;
export const OverrideBodySchema = z
  .object({
    finalRoute: RouteSchema,
    reason: z
      .string({ required_error: 'An override reason is required' })
      .trim()
      .min(MIN_OVERRIDE_REASON, `Override reason must be at least ${MIN_OVERRIDE_REASON} characters`)
      .max(1000),
    acknowledgeEmergencyWarning: z.boolean().optional(),
  })
  .strict();
export type OverrideBody = z.infer<typeof OverrideBodySchema>;

// ---------------------------------------------------------------------------
// Recommendation (engine output) schema — validated before it is persisted or returned
// ---------------------------------------------------------------------------
export const RuleEvidenceSchema = z.object({
  ruleId: z.string(),
  matchedText: z.string().optional(),
  context: z.enum(['affirmed', 'negated', 'historical', 'computed']),
  fuzzy: z.boolean().optional(),
  note: z.string().optional(),
});
export type RuleEvidence = z.infer<typeof RuleEvidenceSchema>;

export const AiInterpretationSchema = z
  .object({
    extractedPhrases: z.array(z.string().max(200)).max(20),
    relevantConceptIds: z.array(z.string().max(60)).max(20),
    ambiguityNotes: z.array(z.string().max(300)).max(10),
    missingInformation: z.array(z.string().max(300)).max(10),
    plainLanguageSummary: z.string().max(600),
    /** Optional administrative category suggestion. Strictly one of the four routes; can only ever escalate. */
    suggestedRoute: RouteSchema.optional(),
  })
  .strict();
export type AiInterpretation = z.infer<typeof AiInterpretationSchema>;

export const RecommendationSchema = z.object({
  recommendedRoute: RouteSchema,
  matchedRuleIds: z.array(z.string()),
  evidence: z.array(RuleEvidenceSchema),
  explanation: z.string().min(1),
  explanationPoints: z.array(z.string()),
  uncertainty: z.object({ present: z.boolean(), reasons: z.array(z.string()) }),
  safetyFlags: z.array(z.string()),
  requiresHumanReview: z.boolean(),
  emergencyGuidanceRequired: z.boolean(),
  precautionaryNotice: z.boolean(),
  policyVersion: z.string(),
  aiStatus: z.enum(AI_STATUSES),
  aiInterpretation: AiInterpretationSchema.nullable(),
  aiNote: z.string().nullable(),
  aiLatencyMs: z.number().nullable().optional(),
  engineErrors: z.array(z.string()),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

// ---------------------------------------------------------------------------
// API view models
// ---------------------------------------------------------------------------
export interface StoredRecommendation extends Recommendation {
  id: string;
  requestId: string;
  createdAt: string;
}

export interface StaffReviewRecord {
  id: string;
  requestId: string;
  originalRecommendationId: string;
  action: 'APPROVE' | 'REQUEST_CLARIFICATION' | 'ASSIGN_TO_ME' | 'OVERRIDE';
  originalRoute: Route;
  finalRoute: Route | null;
  overrideReason: string | null;
  note: string | null;
  staffActorId: string;
  reviewStatus: ReviewStatus;
  policyVersion: string;
  safetyFlags: string[];
  createdAt: string;
}

export interface AppointmentRequestView {
  id: string;
  syntheticPatientId: string;
  ageGroup: AgeGroup;
  symptomDescription: string;
  symptomOnset: Onset;
  requestedUrgency: RequestedUrgency;
  preferredDate: string;
  preferredTimeRange: TimeRange;
  administrativeNotes: string | null;
  isFollowUp: boolean;
  dataOrigin: 'synthetic_seed' | 'synthetic_intake';
  scenarioLabel: string | null;
  reviewStatus: ReviewStatus;
  assignedStaffId: string | null;
  finalRoute: Route | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueItem extends AppointmentRequestView {
  recommendedRoute: Route;
  effectiveRoute: Route;
  primaryRuleId: string | null;
  matchedRuleIds: string[];
  uncertaintyPresent: boolean;
  emergencyGuidanceRequired: boolean;
  aiStatus: AiStatus;
  policyVersion: string;
}

export interface CaseDetail {
  request: AppointmentRequestView;
  recommendation: StoredRecommendation;
  reviews: StaffReviewRecord[];
  audit: AuditEventView[];
  emergencyInstruction: string;
}

export interface AuditEventView {
  id: number;
  eventType: string;
  requestId: string | null;
  policyVersion: string | null;
  actorType: 'system' | 'staff' | 'requester' | 'ai_provider';
  actorId: string | null;
  description: string;
  matchedRuleIds: string[];
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}
