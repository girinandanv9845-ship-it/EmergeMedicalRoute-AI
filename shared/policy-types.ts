import type { Route } from './domain';

/** Pipeline stage a rule belongs to. Stages are evaluated in this order; precedence is resolved by route. */
export type RuleStage = 'EMERGENCY' | 'SAFETY' | 'UNCERTAINTY' | 'SAME_DAY' | 'ROUTINE' | 'AI_BOUNDARY';

export const STAGE_ORDER: RuleStage[] = ['EMERGENCY', 'SAFETY', 'UNCERTAINTY', 'SAME_DAY', 'ROUTINE', 'AI_BOUNDARY'];

/**
 * A combination trigger fires when one token from EVERY group occurs within `window`
 * tokens of each other inside a single clause. `ordered` requires groups in sequence.
 */
export interface CombinationTrigger {
  groups: string[][];
  window: number;
  ordered?: boolean;
}

export type CheckId =
  | 'EMPTY_DESCRIPTION'
  | 'INSUFFICIENT_DETAIL'
  | 'VAGUE_DESCRIPTION'
  | 'NEGATED_HIGH_RISK_TERM'
  | 'HISTORICAL_HIGH_RISK_TERM'
  | 'CONTRADICTION'
  | 'ROUTINE_PREFERENCE_URGENT_WORDING'
  | 'URGENT_PREFERENCE_ONLY'
  | 'LONG_DESCRIPTION'
  | 'AGE_NOT_ASSESSABLE'
  | 'PROMPT_INJECTION'
  | 'NO_POLICY_MATCH'
  | 'FOLLOW_UP_FLAG'
  | 'AI_FLAGGED_CONCEPT'
  | 'AI_AMBIGUITY'
  | 'RULE_EVALUATION_ERROR';

export interface RuleTrigger {
  /** Normalised phrases (lower-case, contractions expanded: "cannot", "will not", "unable"). Typo-tolerant. */
  phrases?: string[];
  combinations?: CombinationTrigger[];
  /** Regular-expression sources evaluated against lower-cased text (used for injection detection). */
  patterns?: string[];
  /** Named computed check implemented by the engine. */
  check?: CheckId;
  params?: Record<string, number | string | string[]>;
  /** When true, negated and historical mentions do NOT fire this rule (they are surfaced separately). */
  contextAware?: boolean;
}

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  stage: RuleStage;
  route: Route;
  /** 1 = highest priority. Used for ordering within a route and choosing the primary rule. */
  priority: number;
  /** Human-readable triggering conditions (what staff see in the policy explorer). */
  conditions: string[];
  trigger: RuleTrigger;
  explanation: string;
  requiresHumanReview: boolean;
  emergencyGuidance: boolean;
  precautionaryNotice?: boolean;
  /** Mandatory safety rules cannot be suppressed by AI output, settings, or overrides. */
  mandatory: boolean;
  /** Short safety flag recorded with the recommendation when this rule fires. */
  safetyFlag?: string;
  version: string;
}

export interface RoutingPolicy {
  version: string;
  name: string;
  label: string;
  status: 'DEMONSTRATION_ONLY';
  effectiveDate: string;
  disclaimer: string;
  precedence: string[];
  defaultEmergencyInstruction: string;
  rules: PolicyRule[];
}
