# Architecture

## Components

```
┌──────────── Browser (React SPA, :5173) ─────────────┐        ┌────────────── Node API (Express 5, :3001) ───────────────┐
│ pages/ Overview · Intake · Queue · Case · Policy ·  │  HTTP  │ app.ts            routes, validation, rate limit, errors │
│        Test Lab · Analytics · Audit · Settings      │ /api/* │ careroute-service intake · review · override · audit ·  │
│ lib/api.ts  typed fetch client (no secrets)         │◄──────►│                   dashboard · analytics · AI probe       │
│ shared/domain.ts  same Zod schemas as the server    │        │ services/routing  engine.ts (deterministic, pure)        │
└─────────────────────────────────────────────────────┘        │                   route-request.ts (AI orchestration)    │
                                                               │ services/safety   text.ts (normalise, match, context)    │
                                                               │ services/ai       providers.ts · interpret.ts            │
                                                               │ policies/         demo-policy-1.0.ts (single source)     │
                                                               │ repositories/ db/ node:sqlite, migrations, triggers      │
                                                               └───────┬───────────────────────────────┬──────────────────┘
                                                                       │ SQLite file                   │ loopback only
                                                               ./data/careroute.sqlite        Ollama :11434 (llama3.2:3b)
```

Responsibilities are separated: input validation (`shared/domain.ts` Zod), safety and text analysis (`services/safety`), policy evaluation (`services/routing/engine.ts`), optional AI interpretation (`services/ai`), recommendation persistence and human override (`careroute-service.ts`), audit logging (`repositories` plus DB triggers), analytics, and automated testing (`server/testing`).

## Request flow (POST /api/requests)

1. **Validate** the body with `CreateRequestBodySchema` (strict, so unknown keys such as a client-supplied `recommendedRoute` are rejected) and check that the preferred date is today or later, within 12 months.
2. **Idempotency:** if the `clientSubmissionId` was already used, return the stored request (`duplicate: true`) and audit `DUPLICATE_SUBMISSION_BLOCKED`.
3. **Deterministic evaluation** (`evaluateRequest`): normalise the text, then run lexical rules (emergency → same-day → routine), then computed checks (safety, uncertainty, AI boundary), then resolve precedence, and validate the result against `RecommendationSchema`.
4. **AI orchestration** (`routeRequest`):
   - If AI is disabled → done.
   - If an **emergency rule matched → AI is skipped** (`skipped_emergency`) and the response returns in milliseconds.
   - Otherwise call the provider with a timeout, validate its output, and re-run the deterministic engine with the validated output. AI-boundary rules can only escalate. A final guard re-checks that the AI-informed route never ranks below the deterministic one.
5. **Persist** in one transaction: request row, immutable recommendation row, and audit events (`REQUEST_CREATED`, `AI_*`, `ROUTING_EVALUATED`, `EMERGENCY_RULE_MATCHED`, `SAFE_FALLBACK_APPLIED`, `PROMPT_INJECTION_FLAGGED`, `RULE_EVALUATION_ERROR`).
6. Return the request plus recommendation. The UI renders emergency guidance first.

## Routing engine

- **Pure and deterministic:** the same input, policy version and AI outcome always give the same output (unit-tested). No timestamps or randomness.
- **Text analysis** (`text.ts`):
  - Contractions are expanded (`can't → cannot`, `not able to → unable to`).
  - Text is split into sentences and clauses (on punctuation and `but / and / however …`).
  - Matching uses light stemming, plus bounded edit distance for typos (≥5-letter words, never "correcting" real words like *cooking → choking* or *trip → tripped*).
  - **Negation** is detected within 5 words before a phrase in the same clause; **history** from sentence markers ("years ago", "in 2019", "history of") unless the clause has a current-time marker ("now", "still", "today").
- **Precedence:** `EMERGENCY_GUIDANCE > SAME_DAY_HUMAN_REVIEW > NEEDS_CLARIFICATION_OR_HUMAN_REVIEW > ROUTINE_APPOINTMENT`. Uncertainty never downgrades a route. Nothing matched → `UNC-NOMATCH-01` (clarification, never routine).
- **Failure handling:** each rule runs in its own try/catch. A failing rule adds `SAFETY-ENGINE-ERR-01` (human review plus precautionary notice), and an engine-level failure returns `engineFailureFallback`. Neither path can ever produce routine.

## AI boundary (local Ollama)

| Concern | Implementation |
|---|---|
| Where it runs | `OllamaProvider` calls `POST {OLLAMA_BASE_URL}/api/chat` from the **backend only**. Base URL must be loopback; anything else is refused (`misconfigured`). |
| Model | `llama3.2:3b` (Q4_K_M, 2.0 GB). Verified on Snapdragon X (ARM64, CPU-only, 16 GB): ~25 s cold load, ~4.5–5.5 s per request warm. |
| Prompt | System prompt: administrative helper, never diagnose or treat, description is **untrusted data** in `<request_description>` tags, ignore embedded instructions, one worked example. `temperature: 0`, `keep_alive: 30m`. |
| Structured output | Ollama `format` = JSON Schema with enums for concept IDs (policy rule IDs) and `suggestedRoute` (the 4 routes). |
| Validation | `interpret.ts`: timeout (`AI_TIMEOUT_MS`), JSON parse, strict Zod schema (`AiInterpretationSchema`, unknown keys rejected), concept IDs must exist, diagnostic or treatment language rejected. Failure → `unavailable` / `timeout` / `model_missing` / `malformed_rejected`; deterministic route stands. |
| Influence on routing | `AI-FLAG-01`: AI category EMERGENCY or SAME_DAY, or an emergency-concept tag not confirmed by rules → **same-day human review** (never emergency guidance itself). `AI-AMBIG-01`: AI category NEEDS_CLARIFICATION → clarification. A "routine" suggestion has no effect. |
| Status | `CareRouteService.refreshAiStatus()` probes `/api/tags` at start-up and every 30 s → `available` / `unavailable` / `model_missing` / `misconfigured`. The UI shows "Local AI available" only when verified. Telemetry (last success and latency, last failure) is kept in memory, never request text. |
| Testing | `server/tests/ollama.test.ts` injects a fake `fetch` (no model needed). `npm run ai:check` and Test Lab case TC-31 exercise the real model. |

Why this calibration: the 3B model over-tags concepts and invents ambiguity notes, so escalation is keyed to its overall categorical verdict. Notes and tags are still shown to staff, and any emergency-concept tag still escalates.

## AI intake assistant (client chat, local Ollama only)

`POST /api/assistant/chat` → `services/assistant/assistant.ts` (`assistantTurn`). The server is stateless; the client sends the conversation and draft.

1. **Validate** with a strict Zod schema (≤40 messages, ≤1,000 chars each, draft fields are enums).
2. **Description** = the requester's own free-text messages joined together (quick-reply taps excluded). The model never paraphrases it.
3. **Deterministic emergency gate:** `evaluateRequest` runs on the description. If emergency, return fixed guidance (`type: emergency`) **without calling the model**, and audit `ASSISTANT_EMERGENCY_DETECTED`.
4. **Next field** is chosen deterministically (description → onset → urgency preference → age group → day → time), with server-generated quick replies (dates computed server-side).
5. **Ollama call** (`OllamaProvider.chatJson`): system prompt plus the last 6 messages (client text wrapped in `<client_message>` tags), JSON-schema `format`, `num_predict: 120`, timeout. The model writes **one acknowledgement sentence** and may extract onset, age group, time range or follow-up only if the person clearly stated them. It can never overwrite a field the person chose, and it never sets the urgency preference.
6. **Output safety:** strict schema, an unsafe-language filter (diagnosis, medication, dosage, reassurance), and sentence filtering that drops questions (so the model can't ask for a date of birth), booking or "received" claims, "Please…" instructions and text repeated from earlier turns. A medical question from the client always gets "I can't give medical advice — clinic staff will review your request."
7. **Reply** = sanitised acknowledgement + the **server's** next question. `aiTextShown` says truthfully whether any model text is visible, and the UI badge shows "AI · model" or "Standard question · local AI consulted".
8. **Ollama only:** if Ollama is unreachable, times out, the model is missing or AI is disabled → `type: unavailable`. No scripted text is ever passed off as AI, and the draft is kept for the form.
9. **Handoff:** "Review & submit" opens the normal intake form prefilled (router state). The client submits, and the standard routing, explanation, staff review and audit pipeline applies.

Measured on the Snapdragon X laptop: ~3–9 s per turn, about 5 s typical.

## Task-specialised local models

`server/services/ai/custom-models.ts` defines `careroute-interpreter:v1` and `careroute-assistant:v1`, created through Ollama's `/api/create` (`FROM llama3.2:3b` + `SYSTEM` + `MESSAGE` worked examples + `PARAMETER`s). This is not weight training: the weights stay the same, so it adds no storage (verified: one 1.88 GB weight file on disk).

- `OllamaProvider.checkStatus()` sets `specialisedReady` only when both models are installed. Requests then go to the specialised models with only the per-request text; otherwise the base model gets the full prompts. A 404 for a specialised model switches back to the base model automatically.
- Both models use the same `num_ctx` (2048), so Ollama serves them from one loaded copy of the weights.
- At start-up the manager builds missing specialised models, loads the interpreter, and **primes the prompt cache** with one tiny request per task.
- **Prompt-cache rule:** never put per-request content in a `system` message (Llama's template hoists it to the top of the prompt and breaks the cache). The assistant's per-turn state is appended to the last user message instead.
- Field extraction for the assistant is rule-based (`server/services/assistant/extract.ts`); model-suggested values need textual evidence.
- Evaluation: `scripts/ai-eval.ts` (quality, writes `docs/ai-evaluation.md`), `scripts/ai-latency.ts` (alternating realistic timing). The evaluation set (`server/testing/ai-eval-set.ts`) is checked by a unit test to share no sentences with the worked examples.

## Database

| Table | Notes |
|---|---|
| `appointment_requests` | `id` CHECK `LIKE 'SYN-%'`, `synthetic_patient_id` CHECK `LIKE 'SYN-P-%'`, `data_origin` ∈ {synthetic_seed, synthetic_intake}, unique `seed_key` (idempotent seeding), unique `client_submission_id` (duplicate prevention), review status, final route, current recommendation |
| `routing_recommendations` | Full recommendation JSON + indexed columns. **UPDATE blocked by trigger** (immutable). |
| `staff_reviews` | Approve / clarify / assign / override records; CHECK requires a ≥10-char reason and final route for overrides; UPDATE blocked |
| `audit_events` | **UPDATE and DELETE blocked by triggers** (append-only). No full symptom text. |
| `policy_versions` | JSON snapshot of each policy version used |
| `test_runs` | Every Test Lab result (expected, actual, status, critical flag) |

Migrations run at start-up (`schema_migrations`). All SQL is parameterised. Demo reset deletes only synthetic rows (by origin and ID pattern), with cascades to recommendations and reviews; audit, policy and test history are kept.

## Failure handling

| Failure | Behaviour |
|---|---|
| Ollama stopped / model missing / slow / malformed output | Status shown truthfully; deterministic route used; audit `AI_PROVIDER_UNAVAILABLE` or `AI_OUTPUT_REJECTED`; emergencies unaffected (AI skipped) |
| Database unavailable | Every endpoint returns 503 "Nothing was saved"; health reports `database: false`; the UI shows an error, never a fake success |
| Backend unreachable | UI: "Cannot reach the EmergeMedicalRoute backend. Your request has NOT been processed." |
| Rule evaluation error | `SAFETY-ENGINE-ERR-01` → human review plus precautionary notice |
| Oversized or malformed body | 413 / 400 JSON errors (32 KB body limit; 5,000-char description limit) |
| Excessive writes | 429 with `Retry-After` (per-IP fixed window, `RATE_LIMIT_PER_MINUTE`) |

## Security notes

Helmet headers, no secrets in the client bundle (verified by grep), the browser never contacts Ollama, Zod validation on every input, strict schemas reject unknown fields, symptom text rendered as text (React escaping; covered by a test), parameterised SQL, demo staff header validated against an allow-list (explicitly **not** authentication).
