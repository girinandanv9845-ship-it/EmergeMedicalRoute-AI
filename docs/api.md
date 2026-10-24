# REST API

Base URL: `http://localhost:3001/api` (the Vite dev server proxies `/api`). All bodies are JSON. Errors are always:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "The submitted data is invalid.", "details": [{ "path": "symptomDescription", "message": "…" }] } }
```

Codes: `VALIDATION_ERROR` 400, `MALFORMED_JSON` 400, `OVERRIDE_SAME_ROUTE` 400, `EMERGENCY_ACK_REQUIRED` 400, `CONFIRMATION_REQUIRED` 400, `STAFF_IDENTITY_REQUIRED` 401, `NOT_FOUND` 404, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429, `DATABASE_ERROR` / `INTERNAL_ERROR` 500, `DATABASE_UNAVAILABLE` 503.
Staff actions need the header `x-demo-staff-id: STAFF-DEMO-A|B|C`. This is a demo identity, **not authentication**.

## System

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{ status, backend, database, ruleEngine, ai:{provider,state,verified,model,checkedAt,lastSuccessAt,…}, policyVersion }`. 503 if the DB is down. |
| GET | `/config` | Emergency instruction, demo staff list, policy label, reset phrase, server date |
| GET | `/ai/status[?refresh=true]` | Verified AI status (`available`, `unavailable`, `model_missing`, `misconfigured`, `disabled`), telemetry, boundary rules, data notice |
| POST | `/ai/test` | Runs one fixed synthetic sentence through the local model → `{ probe, outcome:{status, latencyMs, interpretation} }` (`outcome: null` if unavailable) |

## AI intake assistant (local Ollama only)

**POST `/assistant/chat`**: one chat turn. The server is stateless; the client sends the conversation and the current draft.

```json
{ "messages": [ { "role": "assistant", "content": "Hi — …", "kind": "text" },
                { "role": "user", "content": "My lower back has ached since lifting boxes", "kind": "text" },
                { "role": "user", "content": "4–7 days ago", "kind": "choice" } ],
  "draft": { "symptomOnset": "4_7_DAYS" } }
```

`kind: "text"` = the requester's own words (these form the description); `kind: "choice"` = a quick-reply tap. Max 40 messages, 1,000 chars each; unknown keys are rejected.

Response:

```json
{ "type": "reply", "reply": "I've noted the timeframe. Would you prefer a routine appointment, or do you feel this is urgent? …",
  "symptomDescription": "My lower back has ached since lifting boxes", "draft": { "symptomOnset": "4_7_DAYS" },
  "missingFields": ["requestedUrgency", "ageGroup", "preferredDate", "preferredTimeRange"], "nextField": "requestedUrgency",
  "quickReplies": [ { "label": "Routine", "field": "requestedUrgency", "value": "ROUTINE" }, { "label": "Urgent", "field": "requestedUrgency", "value": "URGENT" } ],
  "ready": false, "model": "llama3.2:3b", "aiStatus": "used", "aiTextShown": true, "latencyMs": 6900,
  "precautionaryNotice": false, "injectionDetected": false, "emergency": null }
```

- `type: "emergency"`: a deterministic emergency rule matched. The reply is fixed emergency guidance, `emergency: { ruleIds, instruction, policyVersion }` is filled in, and the model was **not** called. Audited as `ASSISTANT_EMERGENCY_DETECTED`.
- `type: "unavailable"`: Ollama is down, timed out, the model is missing, or AI is disabled. No AI text is returned; the draft is kept.
- `aiStatus: "malformed_rejected"`: the model's output was invalid or unsafe and was replaced by the standard question.
- Every turn is audited as `ASSISTANT_CHAT_TURN` with status and latency only, never message text.

## Requests

**POST `/requests`**: create and route. The client cannot send a route (strict schema).

```json
{ "ageGroup": "40_64", "symptomDescription": "My cough is getting worse", "symptomOnset": "1_3_DAYS",
  "requestedUrgency": "ROUTINE", "preferredDate": "2026-10-27", "preferredTimeRange": "MORNING",
  "administrativeNotes": "optional", "isFollowUp": false, "syntheticPatientId": "SYN-P-2001 (optional)",
  "clientSubmissionId": "uuid (optional idempotency key)" }
```

201 (or 200 with `duplicate: true` for a repeated idempotency key):

```json
{ "request": { "id": "SYN-1033", "syntheticPatientId": "SYN-P-2032", "reviewStatus": "AWAITING_REVIEW", "…": "…" },
  "recommendation": { "id": "REC-1A2B3C4D", "recommendedRoute": "SAME_DAY_HUMAN_REVIEW", "matchedRuleIds": ["SAMEDAY-WORSEN-01"],
    "explanation": "Same-day human review recommended. …", "explanationPoints": ["SAMEDAY-WORSEN-01 — …"],
    "uncertainty": { "present": false, "reasons": [] }, "safetyFlags": ["WORSENING"], "requiresHumanReview": true,
    "emergencyGuidanceRequired": false, "precautionaryNotice": false, "policyVersion": "demo-policy-1.0",
    "aiStatus": "used", "aiLatencyMs": 4652, "aiInterpretation": { "suggestedRoute": "SAME_DAY_HUMAN_REVIEW", "…": "…" },
    "aiNote": "…", "engineErrors": [], "createdAt": "2026-10-24T10:00:00.000Z" },
  "duplicate": false }
```

Enumerations: `ageGroup` UNDER_1, 1_4, 5_12, 13_17, 18_39, 40_64, 65_PLUS, NOT_PROVIDED · `symptomOnset` TODAY, 1_3_DAYS, 4_7_DAYS, 1_4_WEEKS, OVER_1_MONTH, UNKNOWN · `requestedUrgency` ROUTINE, URGENT · `preferredTimeRange` MORNING, AFTERNOON, EVENING, ANY · `aiStatus` disabled, used, unavailable, timeout, malformed_rejected, model_missing, skipped_emergency, not_used.

| Method | Path | Description |
|---|---|---|
| GET | `/requests?search=&route=&reviewStatus=&uncertainty=yes\|no&aiStatus=&emergencyOnly=true&overriddenOnly=true&sort=priority\|date_desc\|date_asc&page=1&pageSize=20` | Paginated queue `{ items, total, page, pageSize }` |
| GET | `/requests/:id` | Case detail `{ request, recommendation, reviews, audit, emergencyInstruction }` |
| GET | `/requests/:id/history` | `{ originalRecommendation, reviews, audit }` |
| POST | `/requests/:id/review` | `{ "action": "APPROVE" \| "REQUEST_CLARIFICATION" \| "ASSIGN_TO_ME", "note": "optional" }` → updated case |
| POST | `/requests/:id/override` | `{ "finalRoute": "ROUTINE_APPOINTMENT", "reason": "≥ 10 chars", "acknowledgeEmergencyWarning": true }` (acknowledgement required for emergency cases). The original recommendation is never modified. |
| GET | `/patients` | Distinct synthetic patient IDs with request counts |

## Policy, audit, analytics, tests, demo

| Method | Path | Description |
|---|---|---|
| GET | `/policy` | Active policy (rules, precedence, label) + available/stored versions |
| GET | `/policy/:version` | Stored snapshot of a version |
| GET | `/audit?requestId=&eventType=&actorType=&page=&pageSize=` | Append-only audit events + known event types |
| GET | `/dashboard/summary` | Totals, route distribution, 14-day volume, priority queue, activity, safety events, override summary, system status |
| GET | `/analytics/summary` | Route/status counts, override rate (with denominator), rule activations, AI status counts, latest test-run evaluation |
| GET | `/tests` | Fixture definitions + latest persisted run |
| POST | `/tests/run` | Run all fixtures → `{ runId, summary:{passed,failed,skipped,criticalFailures,overall}, results }` |
| POST | `/tests/run/:testId` | Run a single fixture (e.g. `TC-06`) |
| POST | `/demo/reset` | `{ "confirm": "RESET SYNTHETIC DEMO DATA" }` → `{ deleted, seeded }` (synthetic rows only) |

Write endpoints are rate-limited (`RATE_LIMIT_PER_MINUTE`, default 120/min/IP). The request body limit is 32 KB.
