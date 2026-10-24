/**
 * Deterministic, safety-first routing engine.
 *
 * Pipeline (see docs/architecture.md):
 *   1. (schema validation happens at the API boundary)
 *   2. normalise text            3. emergency rules        4. safety + uncertainty checks
 *   5. same-day rules            6. routine eligibility     7. precedence resolution
 *   8. structured, schema-validated recommendation
 *
 * The engine is a pure function: identical input + identical policy version + identical AI
 * outcome always produce the identical recommendation. It never reads a client-supplied route.
 */
import {
  ROUTE_LABELS,
  ROUTE_PRECEDENCE,
  RecommendationSchema,
  type AgeGroup,
  type AiInterpretation,
  type AiStatus,
  type Onset,
  type Recommendation,
  type RequestedUrgency,
  type Route,
  type RuleEvidence,
} from '../../../shared/domain';
import { STAGE_ORDER, type PolicyRule, type RoutingPolicy } from '../../../shared/policy-types';
import { getActivePolicy } from '../../policies';
import {
  analyseText,
  findCombinationMentions,
  findPhraseMentions,
  registerKnownWords,
  tokenise,
  type AnalysedText,
  type Mention,
} from '../safety/text';

export interface EngineInput {
  symptomDescription: string;
  ageGroup: AgeGroup;
  symptomOnset: Onset;
  requestedUrgency: RequestedUrgency;
  isFollowUp?: boolean;
}

export interface AiOutcome {
  status: AiStatus;
  interpretation: AiInterpretation | null;
  note: string | null;
  latencyMs?: number;
}

export interface EngineOptions {
  policy?: RoutingPolicy;
  ai?: AiOutcome;
  /** Test-only fault injection: these rule IDs throw during evaluation. */
  failRuleIds?: string[];
}

const HIGH_RISK_STAGES = new Set(['EMERGENCY']);
const HIGH_RISK_EXTRA_RULES = new Set(['SAMEDAY-HIGHRISK-01']);

const registeredPolicies = new Set<string>();
function registerLexicon(policy: RoutingPolicy): void {
  if (registeredPolicies.has(policy.version)) return;
  const words: string[] = [];
  for (const r of policy.rules) {
    r.trigger.phrases?.forEach((p) => words.push(...tokenise(p)));
    r.trigger.combinations?.forEach((c) => c.groups.forEach((g) => words.push(...g)));
  }
  registerKnownWords(words);
  registeredPolicies.add(policy.version);
}

interface EvalState {
  analysed: AnalysedText;
  input: EngineInput;
  fired: Map<string, RuleEvidence[]>;
  negatedHighRisk: RuleEvidence[];
  historicalHighRisk: RuleEvidence[];
  affirmedByRule: Map<string, Mention[]>;
  negatedByRule: Map<string, Mention[]>;
  errors: string[];
  erroredStages: Set<string>;
}

function fire(state: EvalState, ruleId: string, evidence: RuleEvidence): void {
  const list = state.fired.get(ruleId) ?? [];
  if (!list.some((e) => e.matchedText === evidence.matchedText && e.note === evidence.note)) list.push(evidence);
  state.fired.set(ruleId, list);
}

function lexicalMentions(analysed: AnalysedText, rule: PolicyRule): Mention[] {
  const t = rule.trigger;
  const mentions: Mention[] = [];
  if (t.phrases?.length) mentions.push(...findPhraseMentions(analysed, t.phrases));
  for (const combo of t.combinations ?? []) mentions.push(...findCombinationMentions(analysed, combo));
  return mentions;
}

function evaluateLexicalRule(state: EvalState, rule: PolicyRule): void {
  const mentions = lexicalMentions(state.analysed, rule);
  if (!mentions.length) return;
  const highRisk = HIGH_RISK_STAGES.has(rule.stage) || HIGH_RISK_EXTRA_RULES.has(rule.id);
  for (const m of mentions) {
    if (!rule.trigger.contextAware || m.context === 'affirmed') {
      fire(state, rule.id, { ruleId: rule.id, matchedText: m.matchedText, context: 'affirmed', fuzzy: m.fuzzy || undefined });
      state.affirmedByRule.set(rule.id, [...(state.affirmedByRule.get(rule.id) ?? []), m]);
    } else if (m.context === 'negated') {
      state.negatedByRule.set(rule.id, [...(state.negatedByRule.get(rule.id) ?? []), m]);
      if (highRisk) state.negatedHighRisk.push({ ruleId: rule.id, matchedText: m.matchedText, context: 'negated', fuzzy: m.fuzzy || undefined });
    } else if (m.context === 'historical' && highRisk) {
      state.historicalHighRisk.push({ ruleId: rule.id, matchedText: m.matchedText, context: 'historical', fuzzy: m.fuzzy || undefined });
    }
  }
}

function affirmedInStages(state: EvalState, policy: RoutingPolicy, stages: string[]): boolean {
  return policy.rules.some((r) => stages.includes(r.stage) && state.fired.has(r.id));
}

function phraseAffirmed(state: EvalState, phrases: string[]): Mention | null {
  return findPhraseMentions(state.analysed, phrases).find((m) => m.context === 'affirmed') ?? null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function evaluateCheckRule(state: EvalState, rule: PolicyRule, policy: RoutingPolicy, ai: AiOutcome | undefined): void {
  const { input, analysed } = state;
  const t = rule.trigger;
  const description = input.symptomDescription ?? '';
  const isEmpty = description.trim().length === 0;
  const ev = (note: string, matchedText?: string): RuleEvidence => ({ ruleId: rule.id, context: 'computed', note, matchedText });

  switch (t.check) {
    case 'EMPTY_DESCRIPTION':
      if (isEmpty) fire(state, rule.id, ev('Description is empty or whitespace only'));
      return;
    case 'INSUFFICIENT_DETAIL': {
      const min = Number(t.params?.minMeaningfulWords ?? 3);
      if (!isEmpty && analysed.meaningfulWordCount < min)
        fire(state, rule.id, ev(`Only ${analysed.meaningfulWordCount} meaningful word(s); at least ${min} required`));
      return;
    }
    case 'VAGUE_DESCRIPTION': {
      const m = phraseAffirmed(state, t.phrases ?? []);
      if (m && !affirmedInStages(state, policy, ['EMERGENCY', 'SAME_DAY', 'ROUTINE']))
        fire(state, rule.id, ev('Vague wording without a specific policy concept', m.matchedText));
      return;
    }
    case 'NEGATED_HIGH_RISK_TERM':
      for (const e of state.negatedHighRisk) fire(state, rule.id, { ...e, ruleId: rule.id, note: `Negated mention related to ${e.ruleId}` });
      return;
    case 'HISTORICAL_HIGH_RISK_TERM':
      for (const e of state.historicalHighRisk) fire(state, rule.id, { ...e, ruleId: rule.id, note: `Historical mention related to ${e.ruleId}` });
      return;
    case 'CONTRADICTION': {
      for (const [ruleId, neg] of state.negatedByRule) {
        const aff = state.affirmedByRule.get(ruleId);
        if (aff?.length && neg.length)
          fire(state, rule.id, ev(`"${neg[0]!.matchedText}" is both negated and affirmed (${ruleId})`, neg[0]!.matchedText));
      }
      const fine = phraseAffirmed(state, t.phrases ?? []);
      if (fine && affirmedInStages(state, policy, ['EMERGENCY', 'SAME_DAY']))
        fire(state, rule.id, ev('A "feel fine / no symptoms" statement appears alongside a higher-priority concept', fine.matchedText));
      const longOnset = phraseAffirmed(state, asStringArray(t.params?.longOnsetPhrases));
      if (input.symptomOnset === 'TODAY' && longOnset)
        fire(state, rule.id, ev('Onset was given as "today" but the description suggests a long duration', longOnset.matchedText));
      const recent = phraseAffirmed(state, asStringArray(t.params?.recentOnsetPhrases));
      if ((input.symptomOnset === 'OVER_1_MONTH' || input.symptomOnset === '1_4_WEEKS') && recent)
        fire(state, rule.id, ev('Onset was given as weeks/months ago but the description suggests it started today', recent.matchedText));
      return;
    }
    case 'ROUTINE_PREFERENCE_URGENT_WORDING': {
      if (input.requestedUrgency !== 'ROUTINE') return;
      const m = phraseAffirmed(state, t.phrases ?? []);
      if (m) fire(state, rule.id, ev('Routine preference selected but urgent wording used', m.matchedText));
      return;
    }
    case 'URGENT_PREFERENCE_ONLY':
      if (input.requestedUrgency === 'URGENT' && !affirmedInStages(state, policy, ['EMERGENCY', 'SAME_DAY']))
        fire(state, rule.id, ev('Urgent preference selected; no emergency or same-day concept matched'));
      return;
    case 'LONG_DESCRIPTION': {
      const max = Number(t.params?.maxCharacters ?? 1500);
      if (description.length > max) fire(state, rule.id, ev(`Description is ${description.length} characters (threshold ${max})`));
      return;
    }
    case 'AGE_NOT_ASSESSABLE':
      if (asStringArray(t.params?.ageGroups).includes(input.ageGroup)) fire(state, rule.id, ev(`Age group ${input.ageGroup} is not covered by reviewed demo rules`));
      return;
    case 'PROMPT_INJECTION': {
      const lower = analysed.normalised;
      for (const src of t.patterns ?? []) {
        const match = new RegExp(src, 'i').exec(lower);
        if (match) {
          fire(state, rule.id, ev('Text resembling system instructions was ignored', match[0].slice(0, 80)));
          return;
        }
      }
      return;
    }
    case 'FOLLOW_UP_FLAG':
      if (input.isFollowUp === true) fire(state, rule.id, ev('Marked as follow-up to a previous visit'));
      return;
    case 'AI_FLAGGED_CONCEPT': {
      if (ai?.status !== 'used' || !ai.interpretation) return;
      const suggested = ai.interpretation.suggestedRoute;
      if ((suggested === 'EMERGENCY_GUIDANCE' || suggested === 'SAME_DAY_HUMAN_REVIEW') && !affirmedInStages(state, policy, ['EMERGENCY', 'SAME_DAY']))
        fire(state, rule.id, ev(`AI suggested category ${suggested}; not confirmed by deterministic rules — escalated to human review only`));
      // Concept tags: an EMERGENCY concept always escalates. When the model gives no overall category,
      // same-day concept tags escalate too. (Small local models over-tag; their categorical verdict is the
      // more reliable signal, and deterministic rules remain authoritative either way.)
      for (const id of ai.interpretation.relevantConceptIds) {
        const target = policy.rules.find((r) => r.id === id);
        const escalates = target?.stage === 'EMERGENCY' || (target?.stage === 'SAME_DAY' && suggested === undefined);
        if (target && escalates && !state.fired.has(id)) fire(state, rule.id, ev(`AI suggested ${id} (${target.name}); not confirmed by deterministic rules`));
      }
      return;
    }
    case 'AI_AMBIGUITY': {
      if (ai?.status !== 'used' || !ai.interpretation) return;
      const notes = [...ai.interpretation.ambiguityNotes, ...ai.interpretation.missingInformation];
      if (ai.interpretation.suggestedRoute === 'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW')
        fire(state, rule.id, ev(`AI suggested the request needs clarification${notes.length ? `: ${notes.slice(0, 3).join('; ')}` : ''}`));
      else if (ai.interpretation.suggestedRoute === undefined && notes.length) fire(state, rule.id, ev(`AI noted: ${notes.slice(0, 3).join('; ')}`));
      return;
    }
    case 'RULE_EVALUATION_ERROR':
    case 'NO_POLICY_MATCH':
      return; // resolved after all other rules
    default:
      throw new Error(`Unknown check ${String(t.check)}`);
  }
}

function sortRules(policy: RoutingPolicy, ids: Iterable<string>): PolicyRule[] {
  const rules = [...ids].map((id) => policy.rules.find((r) => r.id === id)).filter((r): r is PolicyRule => !!r);
  return rules.sort(
    (a, b) =>
      ROUTE_PRECEDENCE[a.route] - ROUTE_PRECEDENCE[b.route] ||
      STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
      a.priority - b.priority,
  );
}

function describeEvidence(list: RuleEvidence[]): string {
  const parts = list.slice(0, 3).map((e) => {
    if (e.matchedText && e.context !== 'computed') return `matched “${e.matchedText}”${e.fuzzy ? ' (typo-tolerant match)' : ''}${e.context !== 'affirmed' ? ` in ${e.context} context` : ''}`;
    if (e.matchedText) return `${e.note ?? 'matched'} (“${e.matchedText}”)`;
    return e.note ?? 'condition met';
  });
  return parts.join('; ');
}

const NOT_DIAGNOSIS = 'This is an administrative routing suggestion for staff review, not a medical diagnosis.';

function buildRecommendation(state: EvalState, policy: RoutingPolicy, ai: AiOutcome | undefined): Recommendation {
  const rules = sortRules(policy, state.fired.keys());
  const route: Route = rules[0]?.route ?? 'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW';
  const primary = rules[0];

  const uncertaintyRules = rules.filter((r) => r.stage === 'UNCERTAINTY' || r.stage === 'SAFETY' || r.id === 'AI-AMBIG-01');
  const uncertaintyReasons = uncertaintyRules.map((r) => {
    const detail = describeEvidence(state.fired.get(r.id) ?? []);
    return `${r.name}: ${detail || r.explanation}`;
  });

  const emergencyGuidanceRequired = rules.some((r) => r.emergencyGuidance);
  const precautionaryNotice =
    !emergencyGuidanceRequired && (rules.some((r) => r.precautionaryNotice) || state.erroredStages.has('EMERGENCY'));
  const requiresHumanReview = route !== 'ROUTINE_APPOINTMENT' || rules.some((r) => r.requiresHumanReview);

  const safetyFlags = new Set<string>();
  for (const r of rules) if (r.safetyFlag) safetyFlags.add(r.safetyFlag);
  for (const r of rules) {
    if (r.stage === 'EMERGENCY' && (state.fired.get(r.id) ?? []).some((e) => e.fuzzy)) safetyFlags.add('TYPO_TOLERANT_MATCH');
  }
  if (emergencyGuidanceRequired) safetyFlags.add('EMERGENCY_GUIDANCE_DISPLAYED');

  const explanationPoints = rules.map((r) => {
    const detail = describeEvidence(state.fired.get(r.id) ?? []);
    return `${r.id} — ${r.name} → ${ROUTE_LABELS[r.route]}${detail ? `: ${detail}` : ''}`;
  });

  let explanation: string;
  if (!primary) {
    explanation = `${ROUTE_LABELS[route]} recommended as a conservative fallback because no rule could be applied. ${NOT_DIAGNOSIS}`;
  } else {
    explanation = `${ROUTE_LABELS[route]} recommended. ${primary.explanation}`;
    const others = rules.filter((r) => r.route === route && r.id !== primary.id);
    if (others.length) explanation += ` Additional rules for this route: ${others.map((r) => r.id).join(', ')}.`;
    const lower = rules.filter((r) => ROUTE_PRECEDENCE[r.route] > ROUTE_PRECEDENCE[route]);
    if (lower.length) explanation += ` Lower-precedence rules also matched (${lower.map((r) => r.id).join(', ')}) but cannot lower the route.`;
    if (uncertaintyReasons.length && route !== 'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW')
      explanation += ' Uncertainty was also detected and is listed for staff attention.';
    if (emergencyGuidanceRequired) explanation += ' Emergency guidance is displayed immediately and is not delayed by AI processing or staff review.';
    explanation += ` ${NOT_DIAGNOSIS}`;
  }

  const rec: Recommendation = {
    recommendedRoute: route,
    matchedRuleIds: rules.map((r) => r.id),
    evidence: rules.flatMap((r) => state.fired.get(r.id) ?? []),
    explanation,
    explanationPoints,
    uncertainty: { present: uncertaintyReasons.length > 0, reasons: uncertaintyReasons },
    safetyFlags: [...safetyFlags],
    requiresHumanReview,
    emergencyGuidanceRequired,
    precautionaryNotice,
    policyVersion: policy.version,
    aiStatus: ai?.status ?? 'not_used',
    aiInterpretation: ai?.status === 'used' ? ai.interpretation : null,
    aiNote: ai?.note ?? null,
    aiLatencyMs: ai?.latencyMs ?? null,
    engineErrors: state.errors,
  };
  return RecommendationSchema.parse(rec);
}

/** Recommendation returned if the engine itself fails unexpectedly. Never routine. */
export function engineFailureFallback(policy: RoutingPolicy, message: string, ai?: AiOutcome): Recommendation {
  return RecommendationSchema.parse({
    recommendedRoute: 'NEEDS_CLARIFICATION_OR_HUMAN_REVIEW',
    matchedRuleIds: ['SAFETY-ENGINE-ERR-01'],
    evidence: [{ ruleId: 'SAFETY-ENGINE-ERR-01', context: 'computed', note: 'Routing engine failure' }],
    explanation: `Needs clarification / human review recommended as a conservative fallback: the routing engine could not complete evaluation. If the situation may be an emergency, contact local emergency services. ${NOT_DIAGNOSIS}`,
    explanationPoints: ['SAFETY-ENGINE-ERR-01 — Rule evaluation failure fallback → Needs clarification / human review'],
    uncertainty: { present: true, reasons: ['Routing engine failure — the request could not be fully evaluated'] },
    safetyFlags: ['RULE_EVALUATION_ERROR'],
    requiresHumanReview: true,
    emergencyGuidanceRequired: false,
    precautionaryNotice: true,
    policyVersion: policy.version,
    aiStatus: ai?.status ?? 'not_used',
    aiInterpretation: null,
    aiNote: ai?.note ?? null,
    engineErrors: [message],
  });
}

export function evaluateRequest(input: EngineInput, options: EngineOptions = {}): Recommendation {
  const policy = options.policy ?? getActivePolicy();
  const ai = options.ai;
  try {
    registerLexicon(policy);
    const state: EvalState = {
      analysed: analyseText(input.symptomDescription ?? ''),
      input,
      fired: new Map(),
      negatedHighRisk: [],
      historicalHighRisk: [],
      affirmedByRule: new Map(),
      negatedByRule: new Map(),
      errors: [],
      erroredStages: new Set(),
    };
    const failing = new Set(options.failRuleIds ?? []);
    const run = (rule: PolicyRule) => {
      try {
        if (failing.has(rule.id)) throw new Error(`Injected failure in ${rule.id}`);
        if (rule.trigger.check) evaluateCheckRule(state, rule, policy, ai);
        else evaluateLexicalRule(state, rule);
      } catch (err) {
        state.errors.push(`${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
        state.erroredStages.add(rule.stage);
      }
    };

    // Lexical rules first (emergency → same-day → routine) so computed checks can see what matched.
    const lexicalFirst = [...policy.rules].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.priority - b.priority);
    for (const rule of lexicalFirst) if (!rule.trigger.check) run(rule);
    for (const rule of lexicalFirst) if (rule.trigger.check) run(rule);

    if (state.errors.length) {
      fire(state, 'SAFETY-ENGINE-ERR-01', { ruleId: 'SAFETY-ENGINE-ERR-01', context: 'computed', note: `${state.errors.length} rule(s) failed to evaluate` });
    }
    if (state.fired.size === 0) {
      fire(state, 'UNC-NOMATCH-01', { ruleId: 'UNC-NOMATCH-01', context: 'computed', note: 'No emergency, same-day, uncertainty or routine rule matched' });
    }
    return buildRecommendation(state, policy, ai);
  } catch (err) {
    return engineFailureFallback(policy, err instanceof Error ? err.message : String(err), ai);
  }
}
