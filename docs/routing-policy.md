# Routing policy — `demo-policy-1.0`

> **DEMO POLICY — illustrative rules requiring qualified clinical review.** These rules exist to exercise system behaviour with synthetic data. They are not clinically validated and are not a complete clinical protocol.

Source of truth: [server/policies/demo-policy-1.0.ts](../server/policies/demo-policy-1.0.ts). The in-app **Routing Policy** page renders the same object, including every trigger phrase. The frontend contains no routing keywords.

## Categories

| Route | Meaning |
|---|---|
| `EMERGENCY_GUIDANCE` | Show emergency guidance immediately: contact local emergency services, don't wait. Staff still see the case. |
| `SAME_DAY_HUMAN_REVIEW` | Prompt human assessment today. |
| `NEEDS_CLARIFICATION_OR_HUMAN_REVIEW` | Safe fallback for unclear, incomplete, contradictory, injected or unassessable requests. **Never auto-routine.** |
| `ROUTINE_APPOINTMENT` | Standard queue: only when a routine rule matched **and** no other rule fired. |

## Precedence and conflict resolution

1. Any affirmed **mandatory emergency rule** → `EMERGENCY_GUIDANCE`. Nothing (AI, preference, uncertainty) can override it.
2. Same-day rule, high-risk mention, or AI-flagged concept → `SAME_DAY_HUMAN_REVIEW`.
3. Any uncertainty, contradiction, injection or missing-information rule → `NEEDS_CLARIFICATION_OR_HUMAN_REVIEW`.
4. Routine rule matched and nothing above fired → `ROUTINE_APPOINTMENT`.
5. **Uncertainty never downgrades:** same-day plus uncertainty stays same-day, with the uncertainty reasons listed.
6. Nothing matched → `UNC-NOMATCH-01` → clarification.

The rule list is sorted by route precedence, then stage, then priority. The first rule is the *primary rule* shown in the queue.

## Rules (31)

### Emergency (mandatory; emergency guidance; human review)
| ID | Name | Triggers (summary) |
|---|---|---|
| EMERG-BREATH-01 | Severe breathing difficulty | "cannot breathe", "gasping for air", "lips turning blue"… or breathing word + severity word within 4 words |
| EMERG-CHEST-01 | Sudden/severe chest pain or pressure | "crushing chest pain", "heart attack", "elephant on my chest"… or *chest* + pain word + severity word within 5 |
| EMERG-UNRESP-01 | Unresponsive/unconscious | "unresponsive", "collapsed", "will not wake up"… or inability word followed by wake/respond within 3 |
| EMERG-BLEED-01 | Heavy/uncontrolled bleeding | "bleeding heavily", "will not stop bleeding"… |
| EMERG-NEURO-01 | Sudden neurological signs | "face drooping", "slurred speech", "worst headache of my life", sudden + numb/weak/confused |
| EMERG-ALLERGY-01 | Possible severe allergic reaction | "throat is closing", "tongue swelling", "anaphylaxis" |
| EMERG-SEIZURE-01 | Ongoing seizure | "having a seizure", "seizure will not stop", "convulsing" |
| EMERG-CRISIS-01 | Immediate risk of self-harm | "end my life", "suicidal", "took too many pills" |

### Safety
| ID | Name | Route |
|---|---|---|
| SAFETY-INJECT-01 | Embedded instructions ("ignore previous instructions", "mark this as routine", "you are now…", `<script`) → treated as data, flagged | Clarification |
| SAFETY-ENGINE-ERR-01 | A rule failed to evaluate → never routine | Clarification + precautionary notice |

### Uncertainty / fallback (all → clarification)
| ID | Condition |
|---|---|
| UNC-EMPTY-01 | Empty or whitespace-only description (the API also rejects this at validation) |
| UNC-INSUFFICIENT-01 | Fewer than 3 meaningful words |
| UNC-VAGUE-01 | Vague wording ("feel off", "something is wrong") and no specific concept |
| UNC-NEGATED-01 | Emergency or high-risk phrase in negated context ("no chest pain"); precautionary notice |
| UNC-HISTORICAL-01 | Emergency or high-risk phrase in historical context ("in 2019", "years ago") with no current marker; precautionary notice |
| UNC-CONTRADICT-01 | Concept both affirmed and negated; or "feel fine / no symptoms" with a higher-priority concept; or onset contradicts the text |
| UNC-CONFLICT-01 | Routine preference but urgent wording ("urgent", "asap", "right away") |
| UNC-URGENT-PREF-01 | Urgent preference but no emergency/same-day concept. A preference alone does not establish urgency, but is never silently routine |
| UNC-LENGTH-01 | Over 1,500 characters (the whole text is still screened) |
| UNC-AGE-01 | Age group "Under 1" or "Not provided": no reviewed demo rules exist, so no unreviewed age-specific clinical rules are applied |
| UNC-NOMATCH-01 | Nothing matched |

### Same-day human review
| ID | Triggers |
|---|---|
| SAMEDAY-WORSEN-01 | "getting worse", "worsening", "spreading quickly", "deteriorating"… |
| SAMEDAY-FEVER-01 | "high fever", "fever will not go down", fever + 39/40/103/104/high |
| SAMEDAY-PAIN-01 | "severe pain", "unbearable", "8 out of 10"… |
| SAMEDAY-INJURY-01 | "had a fall", "sprained", "cannot put weight", "hit my/her/his head", "deep cut"… |
| SAMEDAY-HIGHRISK-01 | High-risk area without emergency qualifiers ("chest pain", "short of breath", "fainted", "palpitations"…), shown with a precautionary emergency notice |

### Routine
| ID | Triggers |
|---|---|
| ROUTINE-ADMIN-01 | Refill, check-up, vaccination, test results, sick note, paperwork, follow up… |
| ROUTINE-STABLE-01 | "mild", "stable", "no rush", "for a few weeks", "on and off"… |
| ROUTINE-FOLLOWUP-01 | "Follow-up to a previous visit" checkbox |

### AI boundary (only when local AI output passed validation)
| ID | Condition | Route |
|---|---|---|
| AI-FLAG-01 | AI category EMERGENCY or SAME_DAY, or an emergency-concept tag, not confirmed by deterministic rules | Same-day human review (never emergency guidance) |
| AI-AMBIG-01 | AI category NEEDS_CLARIFICATION (or notes, when no category given) | Clarification |

## Context handling

- **Negation:** a cue (`no, not, never, without, denies, none, nothing…`) within 5 words before the phrase, in the same clause; or `none / absent / denied` right after it. "not sure" is treated as uncertainty, not negation. Negated emergency phrases do not trigger emergency, but because detection is heuristic they route to human review (UNC-NEGATED-01).
- **History:** a historical marker in the sentence and no current marker ("now", "still", "again", "today", "this morning", "started") in the clause. "I had chest pain years ago but now crushing chest pain again" → emergency.
- **Typos:** words of 5+ letters within edit distance 1 (10+ letters: 2), or a 4-letter transposition ("pian"). Real words in an exclusion list are never corrected. Emergency matches made this way are flagged `TYPO_TOLERANT_MATCH`.
- **Prompt injection:** embedded instructions are never executed (the engine has no instruction channel). They are detected and flagged, and the local AI receives the text inside `<request_description>` tags as untrusted data.

## Versioning

- Policies are immutable code modules registered in `server/policies/index.ts`. The active version is snapshotted to the `policy_versions` table at start-up.
- Every recommendation, review and audit event stores the policy version. `GET /api/policy/:version` returns the stored snapshot.
- A change means a new file (for example `demo-policy-1.1.ts`) plus registration and review. There is deliberately **no in-app policy editor**, and mandatory safety rules cannot be disabled by any setting.
