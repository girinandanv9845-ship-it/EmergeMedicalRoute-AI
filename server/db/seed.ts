/**
 * Idempotent seeding of synthetic demo records. Records are keyed by `seed_key` and have fixed
 * IDs (SYN-1001…), so restarting the server never duplicates them.
 */
import type { AiOutcome } from '../services/routing/engine';
import type { CareRouteService } from '../services/careroute-service';
import { SEED_RECORDS } from './seed-data';
import { seedKeyExists } from '../repositories';

const AI_SEED_OUTCOMES: Record<'unavailable' | 'malformed', AiOutcome> = {
  unavailable: { status: 'unavailable', interpretation: null, note: 'Seeded scenario: AI provider was unavailable at submission time (simulated). Deterministic policy continued.' },
  malformed: { status: 'malformed_rejected', interpretation: null, note: 'Seeded scenario: AI output failed schema validation and was rejected (simulated).' },
};
const DISABLED: AiOutcome = { status: 'disabled', interpretation: null, note: 'AI interpretation is disabled. Deterministic demonstration policy is active.' };

export async function seedDemoData(service: CareRouteService): Promise<number> {
  const now = service.now();
  let created = 0;
  for (const [index, s] of SEED_RECORDS.entries()) {
    if (seedKeyExists(service.db, s.seedKey)) continue;
    const createdAt = new Date(now);
    createdAt.setUTCDate(createdAt.getUTCDate() - s.daysAgo);
    createdAt.setUTCHours(s.hour, (index * 7) % 60, 0, 0);
    if (createdAt > now) createdAt.setTime(now.getTime() - (SEED_RECORDS.length - index) * 60_000);
    const preferred = new Date(createdAt);
    preferred.setUTCDate(preferred.getUTCDate() + 1 + (index % 6));

    const result = await service.createRequest(
      {
        syntheticPatientId: s.patient,
        ageGroup: s.ageGroup,
        symptomDescription: s.description,
        symptomOnset: s.onset,
        requestedUrgency: s.urgency,
        preferredDate: preferred.toISOString().slice(0, 10),
        preferredTimeRange: s.timeRange,
        administrativeNotes: s.notes,
        isFollowUp: s.isFollowUp,
      },
      {
        origin: 'synthetic_seed',
        seedKey: s.seedKey,
        scenarioLabel: s.scenario,
        createdAt: createdAt.toISOString(),
        seededAiOutcome: s.aiScenario ? AI_SEED_OUTCOMES[s.aiScenario] : DISABLED,
        skipDateValidation: true,
        fixedSeq: 1001 + index,
      },
    );
    created++;

    if (s.review) {
      const reviewAt = new Date(createdAt.getTime() + s.review.afterHours * 3_600_000);
      const original = service.now;
      // Seeded reviews use synthetic timestamps after the request.
      (service as { now: () => Date }).now = () => (reviewAt < now ? reviewAt : now);
      try {
        if (s.review.action === 'OVERRIDE') {
          service.override(
            result.request.id,
            { finalRoute: s.review.finalRoute, reason: s.review.reason, acknowledgeEmergencyWarning: s.review.acknowledgeEmergencyWarning },
            s.review.staff,
          );
        } else {
          service.review(result.request.id, { action: s.review.action, note: s.review.note }, s.review.staff);
        }
      } finally {
        (service as { now: () => Date }).now = original;
      }
    }
  }
  return created;
}
