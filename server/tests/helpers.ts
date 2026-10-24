import { Database } from '../db/database';
import { MockProvider, DisabledProvider, type AiProvider } from '../services/ai/providers';
import { CareRouteService } from '../services/careroute-service';

export const FIXED_NOW = new Date('2026-10-24T10:00:00.000Z');

export function makeService(provider: AiProvider = new DisabledProvider()) {
  const db = new Database(':memory:');
  return new CareRouteService(db, { aiProvider: provider, aiTimeoutMs: 300, emergencyInstruction: 'Contact your local emergency services immediately.', now: () => FIXED_NOW });
}

export const validBody = (overrides: Record<string, unknown> = {}) => ({
  ageGroup: '40_64',
  symptomDescription: 'I would like to book my annual check-up.',
  symptomOnset: 'UNKNOWN',
  requestedUrgency: 'ROUTINE',
  preferredDate: '2026-10-30',
  preferredTimeRange: 'MORNING',
  ...overrides,
});

export { MockProvider };
