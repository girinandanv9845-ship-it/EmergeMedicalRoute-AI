/**
 * Application service: the single place where intake, routing, persistence, staff review,
 * audit logging and analytics are coordinated. HTTP routes are thin wrappers around this.
 */
import { randomUUID } from 'node:crypto';
import {
  CreateRequestBodySchema,
  DEMO_STAFF_IDS,
  OverrideBodySchema,
  ROUTES,
  ROUTE_LABELS,
  ReviewBodySchema,
  validatePreferredDate,
  type AppointmentRequestView,
  type CaseDetail,
  type IntakeFields,
  type Paginated,
  type QueueItem,
  type Recommendation,
  type ReviewStatus,
  type Route,
  type StaffReviewRecord,
} from '../../shared/domain';
import type { Database } from '../db/database';
import { AppError, notFound, validationError } from '../errors';
import { getActivePolicy } from '../policies';
import * as repo from '../repositories';
import { getAiTelemetry, runAiInterpretation } from './ai/interpret';
import type { ManagerStatus } from './ai/ollama-manager';
import type { AiProvider, ProviderStatus } from './ai/providers';
import { evaluateRequest, type AiOutcome } from './routing/engine';
import { routeRequest } from './routing/route-request';

export interface ServiceOptions {
  aiProvider: AiProvider;
  aiTimeoutMs: number;
  emergencyInstruction: string;
  now?: () => Date;
}

export interface CreateOptions {
  origin?: 'synthetic_intake' | 'synthetic_seed';
  seedKey?: string;
  scenarioLabel?: string;
  createdAt?: string;
  /** Seed-only: record a fixed AI outcome (e.g. a simulated outage) instead of calling a provider. */
  seededAiOutcome?: AiOutcome;
  skipDateValidation?: boolean;
  fixedSeq?: number;
}

export interface CreateResult {
  request: AppointmentRequestView;
  recommendation: Recommendation & { id: string; createdAt: string };
  duplicate: boolean;
}

export const RESET_CONFIRMATION = 'RESET SYNTHETIC DEMO DATA';

export interface AiProbe extends ProviderStatus {
  checkedAt: string | null;
}

export class CareRouteService {
  readonly now: () => Date;
  aiProbe: AiProbe = { state: 'unavailable', detail: 'Not checked yet.', checkedAt: null };
  /** Progress of the automatic Ollama start / model download / warm-up (null when not managed). */
  aiStartup: ManagerStatus | null = null;

  constructor(
    readonly db: Database,
    readonly options: ServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    repo.ensurePolicyStored(db, getActivePolicy(), this.iso());
    if (options.aiProvider.kind === 'disabled')
      this.aiProbe = { state: 'disabled', detail: 'AI interpretation is disabled. Deterministic demonstration policy is active.', checkedAt: null };
  }

  /** Live connectivity probe (no inference, no request text). */
  async refreshAiStatus(): Promise<AiProbe> {
    const p = this.options.aiProvider;
    let status: ProviderStatus;
    try {
      status = p.checkStatus ? await p.checkStatus() : { state: p.isEnabled() ? 'available' : 'disabled', detail: p.name };
    } catch {
      status = { state: 'unavailable', detail: 'AI status check failed.' };
    }
    this.aiProbe = { ...status, checkedAt: this.iso() };
    return this.aiProbe;
  }

  /** Runs one fixed, non-sensitive synthetic sentence through the provider and reports the validated outcome. */
  async testAiProvider() {
    const probe = await this.refreshAiStatus();
    if (probe.state !== 'available') return { probe, outcome: null };
    const sample = { symptomDescription: 'I would like to book a flu vaccination next week, nothing urgent.', ageGroup: '40_64', requestedUrgency: 'ROUTINE' };
    const outcome = await runAiInterpretation(this.options.aiProvider, sample, getActivePolicy(), this.options.aiTimeoutMs);
    repo.appendAudit(this.db, {
      eventType: 'AI_PROVIDER_TESTED',
      actorType: 'staff',
      description: `Local AI test with a fixed synthetic sentence: ${outcome.status}${outcome.latencyMs !== undefined ? ` in ${outcome.latencyMs} ms` : ''}.`,
      createdAt: this.iso(),
    });
    return { probe, outcome };
  }

  iso(): string {
    return this.now().toISOString();
  }

  today(): string {
    return this.iso().slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // Intake
  // -------------------------------------------------------------------------
  async createRequest(body: unknown, opts: CreateOptions = {}): Promise<CreateResult> {
    const parsed = CreateRequestBodySchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    const { clientSubmissionId, ...fields } = parsed.data;
    if (!opts.skipDateValidation) {
      const dateError = validatePreferredDate(fields.preferredDate, this.today());
      if (dateError) throw new AppError(400, 'VALIDATION_ERROR', dateError, [{ path: 'preferredDate', message: dateError }]);
    }

    if (clientSubmissionId) {
      const existing = repo.findRequestBySubmissionId(this.db, clientSubmissionId);
      if (existing) return this.duplicateResult(existing);
    }

    const policy = getActivePolicy();
    const engineInput = {
      symptomDescription: fields.symptomDescription,
      ageGroup: fields.ageGroup,
      symptomOnset: fields.symptomOnset,
      requestedUrgency: fields.requestedUrgency,
      isFollowUp: fields.isFollowUp,
    };

    let recommendation: Recommendation;
    let aiAttempted = false;
    let aiOutcome: AiOutcome;
    if (opts.seededAiOutcome) {
      aiOutcome = opts.seededAiOutcome;
      recommendation = evaluateRequest(engineInput, { policy, ai: aiOutcome });
    } else {
      const routed = await routeRequest(engineInput, this.options.aiProvider, { timeoutMs: this.options.aiTimeoutMs, policy });
      recommendation = routed.recommendation;
      aiAttempted = routed.aiAttempted;
      aiOutcome = routed.aiOutcome;
    }

    const createdAt = opts.createdAt ?? this.iso();
    const recId = `REC-${randomUUID().slice(0, 8).toUpperCase()}`;
    let requestId = '';
    try {
      this.db.transaction(() => {
        const seq = opts.fixedSeq ?? repo.nextRequestSeq(this.db);
        requestId = `SYN-${seq}`;
        const patientId = fields.syntheticPatientId ?? repo.nextPatientId(this.db);
        repo.insertRequest(this.db, {
          id: requestId,
          seq,
          syntheticPatientId: patientId,
          fields,
          dataOrigin: opts.origin ?? 'synthetic_intake',
          seedKey: opts.seedKey,
          scenarioLabel: opts.scenarioLabel,
          clientSubmissionId,
          createdAt,
        });
        repo.insertRecommendation(this.db, recId, requestId, recommendation, createdAt);
        repo.setCurrentRecommendation(this.db, requestId, recId);
        this.auditRouting(requestId, recommendation, aiAttempted, aiOutcome, createdAt, opts.origin === 'synthetic_seed');
      });
    } catch (err) {
      // A concurrent duplicate with the same idempotency key: return the stored record instead.
      if (clientSubmissionId && /UNIQUE/i.test(String(err))) {
        const existing = repo.findRequestBySubmissionId(this.db, clientSubmissionId);
        if (existing) return this.duplicateResult(existing);
      }
      throw err;
    }
    const request = repo.getRequest(this.db, requestId)!;
    return { request, recommendation: { ...recommendation, id: recId, createdAt }, duplicate: false };
  }

  private duplicateResult(existing: AppointmentRequestView): CreateResult {
    const detail = this.getCase(existing.id);
    repo.appendAudit(this.db, {
      eventType: 'DUPLICATE_SUBMISSION_BLOCKED',
      requestId: existing.id,
      policyVersion: detail.recommendation.policyVersion,
      actorType: 'system',
      description: 'A repeated submission with the same idempotency key was detected; no new request was created.',
      createdAt: this.iso(),
    });
    return { request: existing, recommendation: detail.recommendation, duplicate: true };
  }

  private auditRouting(requestId: string, rec: Recommendation, aiAttempted: boolean, ai: AiOutcome, at: string, seeded: boolean): void {
    const base = { requestId, policyVersion: rec.policyVersion, createdAt: at };
    repo.appendAudit(this.db, {
      ...base,
      eventType: 'REQUEST_CREATED',
      actorType: seeded ? 'system' : 'requester',
      description: seeded ? 'Synthetic demo request seeded.' : 'Synthetic appointment request submitted through the intake form.',
    });
    if (ai.status === 'skipped_emergency') {
      repo.appendAudit(this.db, { ...base, eventType: 'AI_SKIPPED_EMERGENCY', actorType: 'system', description: 'AI interpretation skipped because an emergency rule matched.' });
    } else if (aiAttempted || ['unavailable', 'timeout', 'malformed_rejected', 'model_missing'].includes(ai.status)) {
      repo.appendAudit(this.db, { ...base, eventType: 'AI_INTERPRETATION_ATTEMPTED', actorType: 'ai_provider', actorId: this.options.aiProvider.name, description: `AI interpretation attempted (${ai.status}).` });
      if (ai.status === 'unavailable' || ai.status === 'timeout' || ai.status === 'model_missing')
        repo.appendAudit(this.db, { ...base, eventType: 'AI_PROVIDER_UNAVAILABLE', actorType: 'system', description: ai.note ?? 'AI provider unavailable; deterministic policy continued.' });
      if (ai.status === 'malformed_rejected')
        repo.appendAudit(this.db, { ...base, eventType: 'AI_OUTPUT_REJECTED', actorType: 'system', description: ai.note ?? 'AI output rejected by schema validation.' });
    }
    repo.appendAudit(this.db, {
      ...base,
      eventType: 'ROUTING_EVALUATED',
      actorType: 'system',
      matchedRuleIds: rec.matchedRuleIds,
      description: `Recommended route: ${ROUTE_LABELS[rec.recommendedRoute]} (policy ${rec.policyVersion}).`,
    });
    if (rec.emergencyGuidanceRequired) {
      repo.appendAudit(this.db, {
        ...base,
        eventType: 'EMERGENCY_RULE_MATCHED',
        actorType: 'system',
        matchedRuleIds: rec.matchedRuleIds.filter((id) => id.startsWith('EMERG-')),
        description: 'Mandatory emergency rule matched; emergency guidance displayed immediately. The prototype did NOT contact emergency services.',
      });
    }
    if (rec.recommendedRoute === 'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW') {
      repo.appendAudit(this.db, {
        ...base,
        eventType: 'SAFE_FALLBACK_APPLIED',
        actorType: 'system',
        matchedRuleIds: rec.matchedRuleIds.filter((id) => id.startsWith('UNC-') || id.startsWith('SAFETY-') || id.startsWith('AI-')),
        description: `Conservative fallback applied: ${rec.uncertainty.reasons.length} uncertainty reason(s).`,
      });
    }
    if (rec.matchedRuleIds.includes('SAFETY-INJECT-01')) {
      repo.appendAudit(this.db, { ...base, eventType: 'PROMPT_INJECTION_FLAGGED', actorType: 'system', matchedRuleIds: ['SAFETY-INJECT-01'], description: 'Embedded instructions were detected and ignored.' });
    }
    if (rec.engineErrors.length) {
      repo.appendAudit(this.db, { ...base, eventType: 'RULE_EVALUATION_ERROR', actorType: 'system', matchedRuleIds: ['SAFETY-ENGINE-ERR-01'], description: `${rec.engineErrors.length} rule(s) failed; safe fallback used.` });
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------
  getCase(id: string): CaseDetail {
    const request = repo.getRequest(this.db, id);
    if (!request) throw notFound(`Request ${id}`);
    const row = this.db.get<{ current_recommendation_id: string }>('SELECT current_recommendation_id FROM appointment_requests WHERE id = ?', id);
    const recommendation = row?.current_recommendation_id ? repo.getRecommendation(this.db, row.current_recommendation_id) : undefined;
    if (!recommendation) throw new AppError(500, 'INTEGRITY_ERROR', `Request ${id} has no stored recommendation.`);
    return {
      request,
      recommendation,
      reviews: repo.listReviews(this.db, id),
      audit: repo.listAuditForRequest(this.db, id),
      emergencyInstruction: this.options.emergencyInstruction,
    };
  }

  listQueue(filters: repo.QueueFilters): Paginated<QueueItem> {
    const { items, total } = repo.listQueue(this.db, filters);
    return { items, total, page: filters.page, pageSize: filters.pageSize };
  }

  // -------------------------------------------------------------------------
  // Staff actions
  // -------------------------------------------------------------------------
  private requireStaff(staffId: string | undefined): string {
    if (!staffId || !DEMO_STAFF_IDS.includes(staffId))
      throw new AppError(401, 'STAFF_IDENTITY_REQUIRED', 'Select a demo staff identity before reviewing cases (demo environment — not real authentication).');
    return staffId;
  }

  review(id: string, body: unknown, staffIdHeader: string | undefined): CaseDetail {
    const staffId = this.requireStaff(staffIdHeader);
    const parsed = ReviewBodySchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    const detail = this.getCase(id);
    const rec = detail.recommendation;
    const at = this.iso();
    const { action, note } = parsed.data;
    let reviewStatus: ReviewStatus = detail.request.reviewStatus;
    let finalRoute: Route | null | undefined;
    if (action === 'APPROVE') {
      reviewStatus = 'APPROVED';
      finalRoute = rec.recommendedRoute;
    } else if (action === 'REQUEST_CLARIFICATION') {
      reviewStatus = 'CLARIFICATION_REQUESTED';
    }
    const record: StaffReviewRecord = {
      id: `REV-${randomUUID().slice(0, 8).toUpperCase()}`,
      requestId: id,
      originalRecommendationId: rec.id,
      action,
      originalRoute: rec.recommendedRoute,
      finalRoute: finalRoute ?? null,
      overrideReason: null,
      note: note || null,
      staffActorId: staffId,
      reviewStatus,
      policyVersion: rec.policyVersion,
      safetyFlags: rec.safetyFlags,
      createdAt: at,
    };
    this.db.transaction(() => {
      repo.insertReview(this.db, record);
      repo.updateRequestReview(this.db, id, {
        reviewStatus,
        finalRoute,
        assignedStaffId: action === 'ASSIGN_TO_ME' ? staffId : detail.request.assignedStaffId ?? staffId,
        updatedAt: at,
      });
      const descriptions = {
        APPROVE: `Staff approved the recommended route (${ROUTE_LABELS[rec.recommendedRoute]}). Administrative review only — not clinical approval.`,
        REQUEST_CLARIFICATION: 'Staff requested clarification from the requester.',
        ASSIGN_TO_ME: `Case assigned to ${staffId}.`,
      } as const;
      repo.appendAudit(this.db, {
        eventType: action === 'ASSIGN_TO_ME' ? 'STAFF_CASE_ASSIGNED' : 'STAFF_CASE_REVIEWED',
        requestId: id,
        policyVersion: rec.policyVersion,
        actorType: 'staff',
        actorId: staffId,
        matchedRuleIds: rec.matchedRuleIds,
        description: descriptions[action],
        createdAt: at,
      });
    });
    return this.getCase(id);
  }

  override(id: string, body: unknown, staffIdHeader: string | undefined): CaseDetail {
    const staffId = this.requireStaff(staffIdHeader);
    const parsed = OverrideBodySchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error, 'The override could not be saved.');
    const detail = this.getCase(id);
    const rec = detail.recommendation;
    const { finalRoute, reason, acknowledgeEmergencyWarning } = parsed.data;
    if (finalRoute === rec.recommendedRoute)
      throw new AppError(400, 'OVERRIDE_SAME_ROUTE', 'The selected route matches the recommendation. Use "Approve recommendation" instead.');
    if (rec.emergencyGuidanceRequired && !acknowledgeEmergencyWarning)
      throw new AppError(
        400,
        'EMERGENCY_ACK_REQUIRED',
        'This case matched a mandatory emergency rule. Confirm that the emergency warning remains in place and that an administrative override does not remove the need for emergency care.',
      );
    const at = this.iso();
    const record: StaffReviewRecord = {
      id: `REV-${randomUUID().slice(0, 8).toUpperCase()}`,
      requestId: id,
      originalRecommendationId: rec.id,
      action: 'OVERRIDE',
      originalRoute: rec.recommendedRoute,
      finalRoute,
      overrideReason: reason,
      note: null,
      staffActorId: staffId,
      reviewStatus: 'OVERRIDDEN',
      policyVersion: rec.policyVersion,
      safetyFlags: rec.safetyFlags,
      createdAt: at,
    };
    this.db.transaction(() => {
      repo.insertReview(this.db, record);
      repo.updateRequestReview(this.db, id, { reviewStatus: 'OVERRIDDEN', finalRoute, assignedStaffId: detail.request.assignedStaffId ?? staffId, updatedAt: at });
      repo.appendAudit(this.db, {
        eventType: 'STAFF_OVERRIDE_SUBMITTED',
        requestId: id,
        policyVersion: rec.policyVersion,
        actorType: 'staff',
        actorId: staffId,
        matchedRuleIds: rec.matchedRuleIds,
        description: `Override: ${ROUTE_LABELS[rec.recommendedRoute]} → ${ROUTE_LABELS[finalRoute]}. Reason stored in staff review ${record.id}. Original recommendation preserved${
          rec.emergencyGuidanceRequired ? '; emergency warning preserved and acknowledged' : ''
        }.`,
        createdAt: at,
      });
    });
    return this.getCase(id);
  }

  // -------------------------------------------------------------------------
  // Demo data
  // -------------------------------------------------------------------------
  resetDemoData(confirm: unknown, reseed: () => Promise<number>): Promise<{ deleted: number; seeded: number }> {
    if (confirm !== RESET_CONFIRMATION)
      throw new AppError(400, 'CONFIRMATION_REQUIRED', `Type "${RESET_CONFIRMATION}" to confirm. Only synthetic demo records are affected.`);
    const deleted = this.db.transaction(() => {
      const r = this.db.run(
        "DELETE FROM appointment_requests WHERE data_origin IN ('synthetic_seed', 'synthetic_intake') AND id LIKE 'SYN-%' AND synthetic_patient_id LIKE 'SYN-P-%'",
      );
      repo.appendAudit(this.db, {
        eventType: 'DEMO_DATA_RESET',
        actorType: 'staff',
        description: `Demo data reset: ${r.changes} synthetic request(s) removed (with their recommendations and reviews). Audit history is retained.`,
        policyVersion: getActivePolicy().version,
        createdAt: this.iso(),
      });
      return r.changes;
    });
    return reseed().then((seeded) => ({ deleted, seeded }));
  }

  // -------------------------------------------------------------------------
  // Health, dashboard & analytics
  // -------------------------------------------------------------------------
  health() {
    const database = this.db.isOpen && this.db.ping();
    let ruleEngine = false;
    try {
      // Canary: the engine must route a known emergency description to emergency guidance.
      ruleEngine =
        evaluateRequest({ symptomDescription: 'I cannot breathe', ageGroup: '40_64', symptomOnset: 'TODAY', requestedUrgency: 'URGENT' })
          .recommendedRoute === 'EMERGENCY_GUIDANCE';
    } catch {
      ruleEngine = false;
    }
    const p = this.options.aiProvider;
    const probe = this.aiProbe;
    const t = getAiTelemetry(p.name);
    const startup = this.aiStartup;
    const preparing = probe.state !== 'available' && startup !== null && ['checking', 'starting', 'pulling', 'warming'].includes(startup.phase);
    const label =
      probe.state === 'available'
        ? `Local AI available: ${p.name}`
        : probe.state === 'disabled'
          ? 'AI interpretation is disabled. Deterministic demonstration policy is active.'
          : preparing
            ? `${startup.detail} Deterministic demonstration policy is active meanwhile.`
            : `${probe.detail} Deterministic demonstration policy is active.`;
    return {
      status: database && ruleEngine ? 'ok' : 'degraded',
      backend: true,
      database,
      ruleEngine,
      ai: {
        provider: p.kind,
        name: p.name,
        enabled: p.isEnabled(),
        verified: probe.state === 'available',
        state: probe.state,
        detail: probe.detail,
        model: probe.model ?? null,
        checkedAt: probe.checkedAt,
        lastSuccessAt: t.lastSuccessAt,
        lastSuccessLatencyMs: t.lastSuccessLatencyMs,
        lastFailureAt: t.lastFailureAt,
        lastFailureStatus: t.lastFailureStatus,
        startup: startup ? { phase: startup.phase, detail: startup.detail, startedByApp: startup.startedByApp, pulledByApp: startup.pulledByApp, warmLoadMs: startup.warmLoadMs } : null,
        label,
      },
      policyVersion: getActivePolicy().version,
      policyLabel: getActivePolicy().label,
      time: this.iso(),
    };
  }

  dashboardSummary() {
    const all = repo.listAllQueue(this.db);
    const byRoute = Object.fromEntries(ROUTES.map((r) => [r, 0])) as Record<Route, number>;
    for (const q of all) byRoute[q.recommendedRoute]++;
    const awaiting = all.filter((q) => q.reviewStatus === 'AWAITING_REVIEW');
    const priorityRank: Record<Route, number> = { EMERGENCY_GUIDANCE: 1, SAME_DAY_HUMAN_REVIEW: 2, NEEDS_CLARIFICATION_OR_HUMAN_REVIEW: 3, ROUTINE_APPOINTMENT: 4 };
    const priorityQueue = [...awaiting]
      .sort((a, b) => priorityRank[a.recommendedRoute] - priorityRank[b.recommendedRoute] || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8);
    const overrides = this.db.all<{ original_route: Route; final_route: Route; c: number }>(
      "SELECT original_route, final_route, COUNT(*) AS c FROM staff_reviews WHERE action = 'OVERRIDE' GROUP BY original_route, final_route ORDER BY c DESC",
    );
    const recentOverrides = this.db.all<{ request_id: string; original_route: Route; final_route: Route; staff_actor_id: string; created_at: string }>(
      "SELECT request_id, original_route, final_route, staff_actor_id, created_at FROM staff_reviews WHERE action = 'OVERRIDE' ORDER BY created_at DESC LIMIT 5",
    );
    const safetyTypes = ['EMERGENCY_RULE_MATCHED', 'SAFE_FALLBACK_APPLIED', 'PROMPT_INJECTION_FLAGGED', 'AI_PROVIDER_UNAVAILABLE', 'AI_OUTPUT_REJECTED', 'RULE_EVALUATION_ERROR'];
    const safetyEvents = this.db
      .all<{ id: number; event_type: string; request_id: string | null; description: string; created_at: string }>(
        `SELECT id, event_type, request_id, description, created_at FROM audit_events WHERE event_type IN (${safetyTypes.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC LIMIT 8`,
        ...safetyTypes,
      )
      .map((r) => ({ id: r.id, eventType: r.event_type, requestId: r.request_id, description: r.description, createdAt: r.created_at }));
    const recentActivity = repo.listAudit(this.db, { page: 1, pageSize: 10 }).items;

    return {
      totals: {
        total: all.length,
        awaitingReview: awaiting.length,
        routine: byRoute.ROUTINE_APPOINTMENT,
        sameDay: byRoute.SAME_DAY_HUMAN_REVIEW,
        emergency: byRoute.EMERGENCY_GUIDANCE,
        clarification: byRoute.NEEDS_CLARIFICATION_OR_HUMAN_REVIEW,
        overrides: all.filter((q) => q.reviewStatus === 'OVERRIDDEN').length,
        uncertain: all.filter((q) => q.uncertaintyPresent).length,
        aiFailures: all.filter((q) => ['unavailable', 'timeout', 'malformed_rejected', 'model_missing'].includes(q.aiStatus)).length,
      },
      routeDistribution: ROUTES.map((r) => ({ route: r, count: byRoute[r] })),
      requestsOverTime: this.volumeByDay(all, 14),
      priorityQueue,
      recentActivity,
      safetyEvents,
      overrideSummary: {
        byTransition: overrides.map((o) => ({ from: o.original_route, to: o.final_route, count: o.c })),
        recent: recentOverrides.map((o) => ({ requestId: o.request_id, from: o.original_route, to: o.final_route, staffId: o.staff_actor_id, createdAt: o.created_at })),
      },
      system: this.health(),
    };
  }

  private volumeByDay(items: QueueItem[], days: number) {
    const today = new Date(`${this.today()}T00:00:00Z`);
    const buckets: { date: string; total: number; emergency: number; sameDay: number; clarification: number; routine: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      buckets.push({ date: d.toISOString().slice(0, 10), total: 0, emergency: 0, sameDay: 0, clarification: 0, routine: 0 });
    }
    const index = new Map(buckets.map((b) => [b.date, b]));
    for (const q of items) {
      const b = index.get(q.createdAt.slice(0, 10));
      if (!b) continue;
      b.total++;
      if (q.recommendedRoute === 'EMERGENCY_GUIDANCE') b.emergency++;
      else if (q.recommendedRoute === 'SAME_DAY_HUMAN_REVIEW') b.sameDay++;
      else if (q.recommendedRoute === 'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW') b.clarification++;
      else b.routine++;
    }
    return buckets;
  }

  analyticsSummary() {
    const all = repo.listAllQueue(this.db);
    const byRoute = ROUTES.map((r) => ({ route: r, count: all.filter((q) => q.recommendedRoute === r).length }));
    const statuses: ReviewStatus[] = ['AWAITING_REVIEW', 'APPROVED', 'OVERRIDDEN', 'CLARIFICATION_REQUESTED'];
    const byStatus = statuses.map((s) => ({ status: s, count: all.filter((q) => q.reviewStatus === s).length }));
    const overrides = all.filter((q) => q.reviewStatus === 'OVERRIDDEN').length;
    const decided = all.filter((q) => q.reviewStatus === 'OVERRIDDEN' || q.reviewStatus === 'APPROVED').length;
    const ruleCounts = new Map<string, number>();
    for (const q of all) for (const id of q.matchedRuleIds) ruleCounts.set(id, (ruleCounts.get(id) ?? 0) + 1);
    const aiCounts = new Map<string, number>();
    for (const q of all) aiCounts.set(q.aiStatus, (aiCounts.get(q.aiStatus) ?? 0) + 1);

    return {
      totalRequests: all.length,
      byRoute,
      byStatus,
      overrides: {
        count: overrides,
        decidedCount: decided,
        rate: decided ? overrides / decided : null,
        rateDefinition: 'Overrides ÷ requests with a final staff decision (approved + overridden).',
      },
      uncertainty: { count: all.filter((q) => q.uncertaintyPresent).length, fallbackRouteCount: all.filter((q) => q.recommendedRoute === 'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW').length },
      ruleActivations: [...ruleCounts.entries()].map(([ruleId, count]) => ({ ruleId, count })).sort((a, b) => b.count - a.count),
      aiStatusCounts: [...aiCounts.entries()].map(([status, count]) => ({ status, count })),
      aiFailureCount: all.filter((q) => ['unavailable', 'timeout', 'malformed_rejected', 'model_missing'].includes(q.aiStatus)).length,
      volume: this.volumeByDay(all, 14),
      tests: this.testEvaluation(),
      disclaimer: 'Metrics reflect synthetic demonstration scenarios and are not evidence of clinical effectiveness.',
    };
  }

  latestTestRun() {
    const latest = this.db.get<{ run_id: string; created_at: string }>('SELECT run_id, MAX(created_at) AS created_at FROM test_runs GROUP BY run_id ORDER BY MAX(id) DESC LIMIT 1');
    if (!latest) return null;
    const rows = this.db.all<{
      test_id: string;
      title: string;
      category: string;
      status: 'passed' | 'failed' | 'skipped';
      safety_critical: number;
      critical_failure: number;
      expected_result: string;
      actual_result: string | null;
      failure_reason: string | null;
      duration_ms: number;
      created_at: string;
    }>('SELECT * FROM test_runs WHERE run_id = ? ORDER BY id', latest.run_id);
    return {
      runId: latest.run_id,
      createdAt: latest.created_at,
      results: rows.map((r) => ({
        testId: r.test_id,
        title: r.title,
        category: r.category,
        status: r.status,
        safetyCritical: r.safety_critical === 1,
        criticalFailure: r.critical_failure === 1,
        expected: JSON.parse(r.expected_result) as Record<string, unknown>,
        actual: r.actual_result ? (JSON.parse(r.actual_result) as Record<string, unknown>) : null,
        failureReason: r.failure_reason,
        durationMs: r.duration_ms,
      })),
    };
  }

  private testEvaluation() {
    const run = this.latestTestRun();
    if (!run) return null;
    const executed = run.results.filter((r) => r.status !== 'skipped');
    const routed = executed.filter((r) => typeof r.expected.route === 'string' && r.actual && typeof r.actual.route === 'string');
    const exp = (r: (typeof routed)[number]) => r.expected.route as Route;
    const act = (r: (typeof routed)[number]) => r.actual!.route as Route;
    const matrix = ROUTES.map((e) => ({ expected: e, ...Object.fromEntries(ROUTES.map((a) => [a, routed.filter((r) => exp(r) === e && act(r) === a).length])) }));
    return {
      runId: run.runId,
      createdAt: run.createdAt,
      passed: run.results.filter((r) => r.status === 'passed').length,
      failed: run.results.filter((r) => r.status === 'failed').length,
      skipped: run.results.filter((r) => r.status === 'skipped').length,
      criticalFailures: run.results.filter((r) => r.criticalFailure).length,
      routeEvaluation: {
        denominator: routed.length,
        denominatorDefinition: 'Executed (non-skipped) Test Lab cases that specify an expected route.',
        correct: routed.filter((r) => exp(r) === act(r)).length,
        incorrect: routed.filter((r) => exp(r) !== act(r)).length,
        emergencyExpected: routed.filter((r) => exp(r) === 'EMERGENCY_GUIDANCE').length,
        emergencyFalseNegatives: routed.filter((r) => exp(r) === 'EMERGENCY_GUIDANCE' && act(r) !== 'EMERGENCY_GUIDANCE').length,
        emergencyFalsePositives: routed.filter((r) => exp(r) !== 'EMERGENCY_GUIDANCE' && act(r) === 'EMERGENCY_GUIDANCE').length,
        sameDayMismatches: routed.filter((r) => (exp(r) === 'SAME_DAY_HUMAN_REVIEW') !== (act(r) === 'SAME_DAY_HUMAN_REVIEW')).length,
        routineMismatches: routed.filter((r) => (exp(r) === 'ROUTINE_APPOINTMENT') !== (act(r) === 'ROUTINE_APPOINTMENT')).length,
        matrix,
      },
      emergencyOutcomes: run.results
        .filter((r) => r.expected.route === 'EMERGENCY_GUIDANCE')
        .map((r) => ({ testId: r.testId, title: r.title, status: r.status, actualRoute: (r.actual?.route as string | undefined) ?? null })),
    };
  }
}

export type { IntakeFields };
