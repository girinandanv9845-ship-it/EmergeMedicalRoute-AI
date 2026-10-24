/**
 * Deterministic extraction of administrative intake fields from the requester's own words.
 *
 * Measured on the evaluation set, the 3B local model copied values from its worked examples
 * (e.g. giving an 81-year-old "40–64"). Exact, testable rules are more reliable for this job, so:
 *   - these rules are authoritative when they find a value;
 *   - a value suggested by the model is accepted only if the text contains supporting evidence.
 */
import type { AgeGroup, Onset, TimeRange } from '../../../shared/domain';
import type { AssistantDraft } from '../../../shared/assistant';

type Extractable = Pick<AssistantDraft, 'symptomOnset' | 'ageGroup' | 'preferredTimeRange' | 'isFollowUp'>;

const N = '(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple of|few|several|\\d+)';
const ONSET_RULES: [Onset, RegExp][] = [
  ['OVER_1_MONTH', new RegExp(`\\b(more than|over) (a|one|1) month|\\b(?:two|three|four|five|six|several|few|many|\\d+) months|\\bfor (?:months|years)\\b|\\byears ago\\b|\\b(a|one|\\d+|two|several) years?\\b(?! old)|\\bsince last year\\b`, 'i')],
  ['1_4_WEEKS', new RegExp(`\\b(?:two|three|four|couple of|few|several|[2-4]) weeks\\b|\\ba fortnight\\b|\\bsince last week\\b`, 'i')],
  ['4_7_DAYS', new RegExp(`\\b(?:four|five|six|seven|[4-7]) days\\b|\\b(?:about |almost |nearly )?a week\\b|\\blast week\\b`, 'i')],
  ['1_3_DAYS', new RegExp(`\\byesterday\\b|\\blast night\\b|\\b(?:one|two|three|couple of|few|[1-3]) days?\\b|\\bsince (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|the weekend)\\b`, 'i')],
  ['TODAY', new RegExp(`\\btoday\\b|\\bthis (?:morning|afternoon|evening)\\b|\\btonight\\b|\\b(?:an|${N}) hours? ago\\b|\\bjust now\\b`, 'i')],
];

const AGE_PATTERNS = [
  /\b(?:i am|i'm|im|i’m|aged?|is|he's|she's|he is|she is|who is|turned)\s+(\d{1,3})(?![.,]?\d)(?!\s*(?:out of|degrees|°|%|mg|am\b|pm\b|o'clock|:\d))/i,
  /\b(\d{1,3})\s*(?:years?|yrs?)(?:\s*old|-old)?\b/i,
  /\b(\d{1,3})[- ]year[- ]old\b/i,
];

export function ageGroupFor(age: number): AgeGroup | undefined {
  if (!Number.isFinite(age) || age < 0 || age > 120) return undefined;
  if (age < 1) return 'UNDER_1';
  if (age <= 4) return '1_4';
  if (age <= 12) return '5_12';
  if (age <= 17) return '13_17';
  if (age <= 39) return '18_39';
  if (age <= 64) return '40_64';
  return '65_PLUS';
}

const TIME_RULES: [TimeRange, RegExp][] = [
  ['ANY', /\b(any ?time|any time of day|whenever|no preference|flexible)\b/i],
  ['EVENING', /\b(?<!this |since |last |yesterday )evenings?\b|\bafter (?:work|[5-8]\s*(?:pm)?)\b/i],
  ['AFTERNOON', /\b(?<!this |since |yesterday )afternoons?\b|\bafter lunch\b/i],
  ['MORNING', /\b(?<!this |since |yesterday )mornings?\b|\bbefore (?:work|noon|lunch)\b/i],
];

/** Fields the requester clearly stated, by rule. */
export function extractFields(text: string): Extractable {
  const out: Extractable = {};
  const onset = ONSET_RULES.find(([, re]) => re.test(text));
  if (onset) out.symptomOnset = onset[0];
  for (const re of AGE_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const g = ageGroupFor(Number(m[1]));
      if (g) {
        out.ageGroup = g;
        break;
      }
    }
  }
  if (!out.ageGroup && /\b(newborn|my baby|infant)\b/i.test(text)) out.ageGroup = 'UNDER_1';
  const time = TIME_RULES.find(([, re]) => re.test(text));
  if (time) out.preferredTimeRange = time[0];
  if (/\bfollow[- ]?up\b|\bcheck[- ]?back\b|\breview (?:of|from) my\b/i.test(text)) out.isFollowUp = true;
  return out;
}

/** Is there anything in the text that could support a model-suggested value for this field? */
export function hasEvidence(field: keyof Extractable, value: unknown, text: string): boolean {
  switch (field) {
    case 'symptomOnset':
      return extractFields(text).symptomOnset === value;
    case 'ageGroup':
      return extractFields(text).ageGroup === value;
    case 'preferredTimeRange':
      return extractFields(text).preferredTimeRange === value;
    case 'isFollowUp':
      return value === true && extractFields(text).isFollowUp === true;
    default:
      return false;
  }
}
