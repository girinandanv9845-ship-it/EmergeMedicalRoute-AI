/**
 * Data-access layer. Every query is parameterised. Rows are mapped to shared view models.
 */
import type {
  AppointmentRequestView,
  AuditEventView,
  IntakeFields,
  QueueItem,
  Recommendation,
  ReviewStatus,
  Route,
  StaffReviewRecord,
  StoredRecommendation,
} from '../../shared/domain';
import type { RoutingPolicy } from '../../shared/policy-types';
import type { Database, SqlParam } from '../db/database';

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
export function ensurePolicyStored(db: Database, policy: RoutingPolicy, now: string): void {
  db.run(
    'INSERT OR IGNORE INTO policy_versions (version, policy_name, policy_definition, created_at) VALUES (?, ?, ?, ?)',
    policy.version,
    policy.label,
    JSON.stringify(policy),
    now,
  );
}

export function getStoredPolicy(db: Database, version: string): RoutingPolicy | undefined {
  const row = db.get<{ policy_definition: string }>('SELECT policy_definition FROM policy_versions WHERE version = ?', version);
  return row ? json<RoutingPolicy | undefined>(row.policy_definition, undefined) : undefined;
}

export function listStoredPolicyVersions(db: Database): { version: string; policyName: string; createdAt: string }[] {
  return db
    .all<{ version: string; policy_name: string; created_at: string }>('SELECT version, policy_name, created_at FROM policy_versions ORDER BY id')
    .map((r) => ({ version: r.version, policyName: r.policy_name, createdAt: r.created_at }));
}

// ---------------------------------------------------------------------------
// Appointment requests
// ---------------------------------------------------------------------------
interface RequestRow {
  id: string;
  seq: number;
  synthetic_patient_id: string;
  age_group: string;
  symptom_description: string;
  symptom_onset: string;
  requested_urgency: string;
  preferred_date: string;
  preferred_time_range: string;
  administrative_notes: string | null;
  is_follow_up: number;
  data_origin: string;
  scenario_label: string | null;
  client_submission_id: string | null;
  review_status: string;
  assigned_staff_id: string | null;
  final_route: string | null;
  current_recommendation_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapRequest(r: RequestRow): AppointmentRequestView {
  return {
    id: r.id,
    syntheticPatientId: r.synthetic_patient_id,
    ageGroup: r.age_group as AppointmentRequestView['ageGroup'],
    symptomDescription: r.symptom_description,
    symptomOnset: r.symptom_onset as AppointmentRequestView['symptomOnset'],
    requestedUrgency: r.requested_urgency as AppointmentRequestView['requestedUrgency'],
    preferredDate: r.preferred_date,
    preferredTimeRange: r.preferred_time_range as AppointmentRequestView['preferredTimeRange'],
    administrativeNotes: r.administrative_notes,
    isFollowUp: r.is_follow_up === 1,
    dataOrigin: r.data_origin as AppointmentRequestView['dataOrigin'],
    scenarioLabel: r.scenario_label,
    reviewStatus: r.review_status as ReviewStatus,
    assignedStaffId: r.assigned_staff_id,
    finalRoute: (r.final_route as Route | null) ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function nextRequestSeq(db: Database): number {
  const row = db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM appointment_requests');
  return Math.max(1000, row?.m ?? 1000) + 1;
}

export function nextPatientId(db: Database): string {
  const row = db.get<{ m: number | null }>(
    "SELECT MAX(CAST(substr(synthetic_patient_id, 7) AS INTEGER)) AS m FROM appointment_requests WHERE synthetic_patient_id LIKE 'SYN-P-%'",
  );
  return `SYN-P-${Math.max(2000, row?.m ?? 2000) + 1}`;
}

export interface InsertRequest {
  id: string;
  seq: number;
  syntheticPatientId: string;
  fields: IntakeFields;
  dataOrigin: 'synthetic_seed' | 'synthetic_intake';
  seedKey?: string;
  scenarioLabel?: string;
  clientSubmissionId?: string;
  createdAt: string;
}

export function insertRequest(db: Database, r: InsertRequest): void {
  db.run(
    `INSERT INTO appointment_requests (id, seq, synthetic_patient_id, age_group, symptom_description, symptom_onset, requested_urgency,
      preferred_date, preferred_time_range, administrative_notes, is_follow_up, data_origin, seed_key, scenario_label, client_submission_id,
      review_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AWAITING_REVIEW', ?, ?)`,
    r.id,
    r.seq,
    r.syntheticPatientId,
    r.fields.ageGroup,
    r.fields.symptomDescription,
    r.fields.symptomOnset,
    r.fields.requestedUrgency,
    r.fields.preferredDate,
    r.fields.preferredTimeRange,
    r.fields.administrativeNotes?.trim() || null,
    r.fields.isFollowUp ? 1 : 0,
    r.dataOrigin,
    r.seedKey ?? null,
    r.scenarioLabel ?? null,
    r.clientSubmissionId ?? null,
    r.createdAt,
    r.createdAt,
  );
}

export function getRequest(db: Database, id: string): AppointmentRequestView | undefined {
  const row = db.get<RequestRow>('SELECT * FROM appointment_requests WHERE id = ?', id);
  return row ? mapRequest(row) : undefined;
}

export function findRequestBySubmissionId(db: Database, clientSubmissionId: string): AppointmentRequestView | undefined {
  const row = db.get<RequestRow>('SELECT * FROM appointment_requests WHERE client_submission_id = ?', clientSubmissionId);
  return row ? mapRequest(row) : undefined;
}

export function seedKeyExists(db: Database, seedKey: string): boolean {
  return !!db.get('SELECT 1 AS x FROM appointment_requests WHERE seed_key = ?', seedKey);
}

export function updateRequestReview(
  db: Database,
  id: string,
  patch: { reviewStatus?: ReviewStatus; finalRoute?: Route | null; assignedStaffId?: string; updatedAt: string },
): void {
  const sets: string[] = ['updated_at = ?'];
  const params: SqlParam[] = [patch.updatedAt];
  if (patch.reviewStatus) {
    sets.push('review_status = ?');
    params.push(patch.reviewStatus);
  }
  if (patch.finalRoute !== undefined) {
    sets.push('final_route = ?');
    params.push(patch.finalRoute);
  }
  if (patch.assignedStaffId) {
    sets.push('assigned_staff_id = ?');
    params.push(patch.assignedStaffId);
  }
  params.push(id);
  db.run(`UPDATE appointment_requests SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

export function setCurrentRecommendation(db: Database, requestId: string, recId: string): void {
  db.run('UPDATE appointment_requests SET current_recommendation_id = ? WHERE id = ?', recId, requestId);
}

export interface QueueFilters {
  search?: string;
  route?: Route;
  reviewStatus?: ReviewStatus;
  uncertainty?: 'yes' | 'no';
  aiStatus?: string;
  emergencyOnly?: boolean;
  overriddenOnly?: boolean;
  sort?: 'date_desc' | 'date_asc' | 'priority';
  page: number;
  pageSize: number;
}

const QUEUE_SELECT = `
  SELECT r.*, rec.recommended_route, rec.matched_rule_ids, rec.primary_rule_id, rec.uncertainty_present,
         rec.emergency_guidance_required, rec.ai_status, rec.policy_version,
         COALESCE(r.final_route, rec.recommended_route) AS effective_route
  FROM appointment_requests r
  JOIN routing_recommendations rec ON rec.id = r.current_recommendation_id`;

type QueueRow = RequestRow & {
  recommended_route: string;
  matched_rule_ids: string;
  primary_rule_id: string | null;
  uncertainty_present: number;
  emergency_guidance_required: number;
  ai_status: string;
  policy_version: string;
  effective_route: string;
};

function mapQueue(r: QueueRow): QueueItem {
  return {
    ...mapRequest(r),
    recommendedRoute: r.recommended_route as Route,
    effectiveRoute: r.effective_route as Route,
    primaryRuleId: r.primary_rule_id,
    matchedRuleIds: json<string[]>(r.matched_rule_ids, []),
    uncertaintyPresent: r.uncertainty_present === 1,
    emergencyGuidanceRequired: r.emergency_guidance_required === 1,
    aiStatus: r.ai_status as QueueItem['aiStatus'],
    policyVersion: r.policy_version,
  };
}

const PRIORITY_ORDER = `CASE rec.recommended_route
  WHEN 'EMERGENCY_GUIDANCE' THEN 1 WHEN 'SAME_DAY_HUMAN_REVIEW' THEN 2
  WHEN 'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW' THEN 3 ELSE 4 END`;

export function listQueue(db: Database, f: QueueFilters): { items: QueueItem[]; total: number } {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (f.search) {
    where.push('(r.id LIKE ? OR r.synthetic_patient_id LIKE ?)');
    const like = `%${f.search.replace(/[%_]/g, '')}%`;
    params.push(like, like);
  }
  if (f.route) {
    where.push('rec.recommended_route = ?');
    params.push(f.route);
  }
  if (f.reviewStatus) {
    where.push('r.review_status = ?');
    params.push(f.reviewStatus);
  }
  if (f.uncertainty) {
    where.push('rec.uncertainty_present = ?');
    params.push(f.uncertainty === 'yes' ? 1 : 0);
  }
  if (f.aiStatus) {
    where.push('rec.ai_status = ?');
    params.push(f.aiStatus);
  }
  if (f.emergencyOnly) where.push('rec.emergency_guidance_required = 1');
  if (f.overriddenOnly) where.push("r.review_status = 'OVERRIDDEN'");
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order =
    f.sort === 'date_asc'
      ? 'r.created_at ASC'
      : f.sort === 'priority'
        ? `${PRIORITY_ORDER} ASC, CASE r.review_status WHEN 'AWAITING_REVIEW' THEN 0 ELSE 1 END, r.created_at DESC`
        : 'r.created_at DESC';
  const total = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM (${QUEUE_SELECT} ${whereSql})`, ...params)?.c ?? 0;
  const rows = db.all<QueueRow>(`${QUEUE_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, f.pageSize, (f.page - 1) * f.pageSize);
  return { items: rows.map(mapQueue), total };
}

export function listAllQueue(db: Database): QueueItem[] {
  return db.all<QueueRow>(`${QUEUE_SELECT} ORDER BY r.created_at ASC`).map(mapQueue);
}

export function listPatients(db: Database): { syntheticPatientId: string; requestCount: number; lastRequestAt: string }[] {
  return db
    .all<{ synthetic_patient_id: string; c: number; last: string }>(
      'SELECT synthetic_patient_id, COUNT(*) AS c, MAX(created_at) AS last FROM appointment_requests GROUP BY synthetic_patient_id ORDER BY synthetic_patient_id',
    )
    .map((r) => ({ syntheticPatientId: r.synthetic_patient_id, requestCount: r.c, lastRequestAt: r.last }));
}

// ---------------------------------------------------------------------------
// Recommendations (immutable)
// ---------------------------------------------------------------------------
export function insertRecommendation(db: Database, id: string, requestId: string, rec: Recommendation, createdAt: string): void {
  db.run(
    `INSERT INTO routing_recommendations (id, request_id, recommended_route, matched_rule_ids, primary_rule_id, explanation, payload,
      uncertainty_present, requires_human_review, emergency_guidance_required, policy_version, ai_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    requestId,
    rec.recommendedRoute,
    JSON.stringify(rec.matchedRuleIds),
    rec.matchedRuleIds[0] ?? null,
    rec.explanation,
    JSON.stringify(rec),
    rec.uncertainty.present ? 1 : 0,
    rec.requiresHumanReview ? 1 : 0,
    rec.emergencyGuidanceRequired ? 1 : 0,
    rec.policyVersion,
    rec.aiStatus,
    createdAt,
  );
}

export function getRecommendation(db: Database, id: string): StoredRecommendation | undefined {
  const row = db.get<{ id: string; request_id: string; payload: string; created_at: string }>(
    'SELECT id, request_id, payload, created_at FROM routing_recommendations WHERE id = ?',
    id,
  );
  if (!row) return undefined;
  return { ...json<Recommendation>(row.payload, {} as Recommendation), id: row.id, requestId: row.request_id, createdAt: row.created_at };
}

// ---------------------------------------------------------------------------
// Staff reviews (immutable)
// ---------------------------------------------------------------------------
interface ReviewRow {
  id: string;
  request_id: string;
  original_recommendation_id: string;
  action: StaffReviewRecord['action'];
  original_route: string;
  final_route: string | null;
  override_reason: string | null;
  note: string | null;
  staff_actor_id: string;
  review_status: string;
  policy_version: string;
  safety_flags: string;
  created_at: string;
}

export function insertReview(db: Database, r: StaffReviewRecord): void {
  db.run(
    `INSERT INTO staff_reviews (id, request_id, original_recommendation_id, action, original_route, final_route, override_reason, note,
      staff_actor_id, review_status, policy_version, safety_flags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.id,
    r.requestId,
    r.originalRecommendationId,
    r.action,
    r.originalRoute,
    r.finalRoute,
    r.overrideReason,
    r.note,
    r.staffActorId,
    r.reviewStatus,
    r.policyVersion,
    JSON.stringify(r.safetyFlags),
    r.createdAt,
  );
}

export function listReviews(db: Database, requestId: string): StaffReviewRecord[] {
  return db.all<ReviewRow>('SELECT * FROM staff_reviews WHERE request_id = ? ORDER BY created_at ASC, rowid ASC', requestId).map((r) => ({
    id: r.id,
    requestId: r.request_id,
    originalRecommendationId: r.original_recommendation_id,
    action: r.action,
    originalRoute: r.original_route as Route,
    finalRoute: r.final_route as Route | null,
    overrideReason: r.override_reason,
    note: r.note,
    staffActorId: r.staff_actor_id,
    reviewStatus: r.review_status as ReviewStatus,
    policyVersion: r.policy_version,
    safetyFlags: json<string[]>(r.safety_flags, []),
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Audit events (append-only — enforced by database triggers)
// ---------------------------------------------------------------------------
export interface NewAuditEvent {
  eventType: string;
  requestId?: string | null;
  policyVersion?: string | null;
  actorType: AuditEventView['actorType'];
  actorId?: string | null;
  description: string;
  matchedRuleIds?: string[];
  createdAt: string;
}

export function appendAudit(db: Database, e: NewAuditEvent): void {
  db.run(
    'INSERT INTO audit_events (event_type, request_id, policy_version, actor_type, actor_id, description, matched_rule_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    e.eventType,
    e.requestId ?? null,
    e.policyVersion ?? null,
    e.actorType,
    e.actorId ?? null,
    e.description.slice(0, 500),
    JSON.stringify(e.matchedRuleIds ?? []),
    e.createdAt,
  );
}

interface AuditRow {
  id: number;
  event_type: string;
  request_id: string | null;
  policy_version: string | null;
  actor_type: AuditEventView['actorType'];
  actor_id: string | null;
  description: string;
  matched_rule_ids: string;
  created_at: string;
}
const mapAudit = (r: AuditRow): AuditEventView => ({
  id: r.id,
  eventType: r.event_type,
  requestId: r.request_id,
  policyVersion: r.policy_version,
  actorType: r.actor_type,
  actorId: r.actor_id,
  description: r.description,
  matchedRuleIds: json<string[]>(r.matched_rule_ids, []),
  createdAt: r.created_at,
});

export function listAudit(
  db: Database,
  f: { requestId?: string; eventType?: string; actorType?: string; page: number; pageSize: number },
): { items: AuditEventView[]; total: number } {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (f.requestId) {
    where.push('request_id LIKE ?');
    params.push(`%${f.requestId.replace(/[%_]/g, '')}%`);
  }
  if (f.eventType) {
    where.push('event_type = ?');
    params.push(f.eventType);
  }
  if (f.actorType) {
    where.push('actor_type = ?');
    params.push(f.actorType);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit_events ${w}`, ...params)?.c ?? 0;
  const items = db
    .all<AuditRow>(`SELECT * FROM audit_events ${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...params, f.pageSize, (f.page - 1) * f.pageSize)
    .map(mapAudit);
  return { items, total };
}

export function listAuditForRequest(db: Database, requestId: string): AuditEventView[] {
  return db.all<AuditRow>('SELECT * FROM audit_events WHERE request_id = ? ORDER BY created_at ASC, id ASC', requestId).map(mapAudit);
}

export function listAuditEventTypes(db: Database): string[] {
  return db.all<{ event_type: string }>('SELECT DISTINCT event_type FROM audit_events ORDER BY event_type').map((r) => r.event_type);
}
