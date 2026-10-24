# EmergeMedicalRoute AI

**Explainable Medical Appointment Intake and Safe Routing** · AI Hackathon, Question 4: Medical Appointment Triage and Routing

> **DEMO MODE — SYNTHETIC DATA ONLY.** Educational prototype. It does **not** diagnose, treat or prescribe, its routing rules are illustrative and **not clinically validated**, and it does **not** contact emergency services. See [docs/safety-note.md](docs/safety-note.md).

## Problem

A community clinic receives appointment requests describing symptoms, preferred times, and whether the request is routine or urgent. Staff need a tool that organises requests for **human review** without making an automated diagnosis.

## Solution overview

EmergeMedicalRoute AI is a clinic-operations dashboard. Each synthetic request goes through this flow:

```
Intake form → schema validation → deterministic safety & policy engine ──► recommendation + explanation
                                        │  (emergency? → guidance shown immediately, AI skipped)
                                        └─► optional LOCAL AI (Ollama) interpretation → can only ESCALATE
→ staff review / override (reason required) → append-only audit log → analytics & Test Lab
```

- **Four administrative routes:** `EMERGENCY_GUIDANCE`, `SAME_DAY_HUMAN_REVIEW`, `NEEDS_CLARIFICATION_OR_HUMAN_REVIEW` (the safe fallback), and `ROUTINE_APPOINTMENT`.
- **One central, versioned policy** ([server/policies/demo-policy-1.0.ts](server/policies/demo-policy-1.0.ts)) with 31 rules. Every recommendation stores the IDs of the rules that matched and the policy version.
- **Every suggestion is explained**: matched rules, the text that triggered them, uncertainty reasons, safety flags, and a "not a diagnosis" note.
- **Safety-first behaviour:**
  - Emergencies show guidance instantly.
  - Negated phrases ("no chest pain"), historical ones ("in 2019"), contradictory, vague, empty or injected text always goes to human review and is never auto-routine.
  - Typos ("cant breth") and paraphrases ("elephant sitting on my chest") are recognised.
- **Human-in-the-loop:**
  - Staff can approve, request clarification, assign, or override.
  - An override requires a reason, plus an explicit acknowledgement on emergency cases.
  - The original recommendation is immutable and is shown next to the final decision.
- **Optional local AI** through **Ollama (`llama3.2:3b`)**:
  - Runs on this machine, called from the backend only, with no external AI API.
  - Output is strictly schema-validated, can only escalate, and never decides the route.
- **AI intake assistant (chatbot)**: clients chat with a local Ollama model to put together their request. Every message is checked by the emergency rules first, the model only acknowledges (the app asks the questions), medical advice and booking promises are blocked, and the client reviews the prefilled form and submits it.
- **Test Lab**: 49 synthetic test cases run against the real engine, with safety-critical failures highlighted.
- **Analytics, Policy explorer, Audit log**: all built from real persisted data.

## Features

| Page | What it does |
|---|---|
| Overview | Live metrics (each opens the filtered queue), routing distribution, 14-day volume, priority queue, safety events, override summary, system status (backend / DB / rule-engine canary / verified AI / policy) |
| AI Assistant | Client-facing chat (local Ollama only): emergency gate before any AI, quick-reply chips, live "your request so far" panel in the client's own words, honest "AI unavailable" state, then Review & submit into the normal form |
| New Intake | Accessible, validated form (age group only, no identifiers), idempotent submission, persistent emergency notice, one-click synthetic examples |
| Request Queue | Search by request or patient ID; filter by route, review status, uncertainty, AI status; emergency-only / overridden-only; priority or date sort; pagination |
| Case Details | Emergency banner (never hidden), original info, recommendation and explanation, uncertainty, AI interpretation, final decision, staff actions and override workflow, review history, audit trail |
| Routing Policy | Read-only, searchable explorer: every rule's trigger phrases, combinations, precedence, review and emergency flags |
| Test Lab | Run all or individual tests; passed / failed / skipped / **critical** failures shown separately |
| Analytics | Routes, statuses, override rate (denominator stated), uncertainty, rule activations, AI failures, test evaluation (confusion matrix, emergency false negatives and false positives) |
| Audit Log | Append-only events (enforced by SQLite triggers), filterable |
| Settings & Safety | Safety note, verified local-AI status + "Test local AI", demo staff identity, confirmed demo-data reset |

## Architecture & stack

React 19 + TypeScript + Vite + Tailwind v4 + Recharts + TanStack Query · Node.js + Express 5 + Zod · SQLite via Node's built-in `node:sqlite` (no native build) · Vitest + Testing Library + Supertest + Playwright · Ollama (local LLM, optional).
Details: [docs/architecture.md](docs/architecture.md) · API: [docs/api.md](docs/api.md) · Policy: [docs/routing-policy.md](docs/routing-policy.md).

```
shared/          Zod schemas, route vocabulary, policy types (used by client AND server)
server/
  policies/      demo-policy-1.0.ts — THE routing policy (single source of truth)
  services/
    safety/      text normalisation, typo-tolerant matching, negation/history detection
    routing/     engine.ts (deterministic) + route-request.ts (AI orchestration)
    ai/          providers.ts (Disabled / Mock / Ollama) + interpret.ts (timeout + strict validation)
    careroute-service.ts  intake, review, override, audit, dashboard, analytics
  repositories/  parameterised SQL     db/  migrations, seed data, seeding
  testing/       fixtures.ts (synthetic test cases) + runner.ts
  tests/         unit + integration tests
src/             React app (pages/, components/, lib/)
tests/e2e/       Playwright end-to-end tests
docs/            architecture, routing policy, safety note, test report, demo script, API
```

## Prerequisites

- **Node.js 22.13 or newer** (developed on Node 24.18). On Windows on ARM, the native ARM64 Node build is faster than the x64 build.
- npm 10 or newer.
- *Optional:* **[Ollama](https://ollama.com)** for local AI interpretation. Without it the app runs in deterministic mode.

## Installation

```powershell
cd "EmergeMedicalRoute AI"
npm install
copy .env.example .env        # macOS/Linux: cp .env.example .env
```

### Local AI with Ollama (no API key: runs entirely on this laptop)

Install Ollama once from https://ollama.com. **That's all.** `npm run dev` then:
1. starts the Ollama app / `ollama serve` automatically if it is not running,
2. downloads `llama3.2:3b` automatically if it is missing (one time, ~2 GB),
3. loads the model into memory so the first chat reply is fast.

The website is usable immediately; the AI status switches to "Local AI available" once verified (~25 s from a cold start on the Snapdragon X laptop). To do the same without starting the app: `npm run ollama:setup`.

> Note: `ollama launch claude` is **not** needed. It launches the *Claude Code* coding tool on top of Ollama. This app only needs the Ollama server (`ollama serve`), which it starts itself.

Manual commands, if you prefer:

```powershell
# Ollama installs to %LOCALAPPDATA%\Programs\Ollama; if `ollama` is not on PATH, use the full path:
& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" pull llama3.2:3b     # ~2.0 GB download, ~3-4 GB RAM when loaded
Invoke-RestMethod http://localhost:11434/api/tags                      # should list llama3.2:3b
npm run ai:check                                                       # live smoke test: latency, JSON validity, routes
npm run ai:chat-check                                                  # live browser conversation with the AI assistant (needs npm run dev)
```

`.env` (server-side only; the browser never sees these values):

```env
AI_PROVIDER=ollama                 # or: disabled (default in code) | mock
OLLAMA_BASE_URL=http://localhost:11434   # must be localhost/127.0.0.1 — remote hosts are refused
OLLAMA_MODEL=llama3.2:3b
AI_TIMEOUT_MS=30000                # only non-emergency requests ever wait for the model
```

**Switching models later:** `ollama pull <model>` (for example `llama3.2:1b` for faster but weaker results, or `qwen2.5:3b`), set `OLLAMA_MODEL=<model>`, restart the API, then run `npm run ai:check` and the Test Lab. If the model isn't installed, the app reports **"Model missing"** and keeps working deterministically.

### Task-specialised local models (how the local AI was "trained")

Real weight training (fine-tuning) is not practical on this laptop (CPU-only, Windows ARM64): it would need a GPU-oriented Python stack, take many hours, and risk unsafe behaviour with only synthetic data. Instead the app **specialises** the local model the standard Ollama way. Each specialised model is the same `llama3.2:3b` weights (no extra download) plus built-in instructions, synthetic worked examples and tuned parameters:

| Model | Job | Built-in |
|---|---|---|
| `careroute-interpreter:v1` | interpret intake requests for staff | instructions + policy concept list + 5 worked examples, `temperature 0`, `num_ctx 2048` |
| `careroute-assistant:v1` | the client chatbot's one-line acknowledgements | instructions + 5 worked examples, `temperature 0.2`, `num_ctx 2048` |

They are built automatically at start-up (in seconds) and their prompt cache is primed so the first client gets the fast path. Definitions: [server/services/ai/custom-models.ts](server/services/ai/custom-models.ts); readable Modelfiles: [ollama/](ollama/). Turn off with `OLLAMA_SPECIALISED=false`.

**Measured on this laptop** (`npm run ai:eval`, synthetic set of 18 interpreter cases and 14 assistant turns that are not in the worked examples; full report: [docs/ai-evaluation.md](docs/ai-evaluation.md)):

| Metric | Base model | Specialised |
|---|---|---|
| Interpreter: acceptable category | 56% | **94%** |
| Interpreter: under-triage (less urgent than acceptable) | 44% | **6%** |
| Interpreter: resisted embedded "classify as routine" instructions | 0/2 | **2/2** |
| Assistant: model extracts the stated fields correctly | 0% | **91%** |
| Assistant: booking promises in raw replies | 29% | **0%** |
| Assistant: replies with usable model text | 57% | **93%** |
| Wrong values reaching the form (final, after rules) | 0 | 0 |
| Medical questions declined | 100% | 100% |

Other efficiency work found during this evaluation:
- **Prompt-cache fix:** the per-turn chat state used to be sent as a *system* message. Llama's template merges system messages into the top of the prompt, so it broke Ollama's prompt cache every turn. Moving it after the client's text cut assistant replies from **~12 s to ~2.5–3 s** (`npm run ai:latency`).
- **Rule-based field extraction:** age group, onset, preferred time and follow-up are read by exact, tested rules (`server/services/assistant/extract.ts`). A model value is only accepted with supporting evidence in the client's words, so invented values cannot reach the form.
- **False-positive fix:** the "never prescribe" output filter wrongly rejected refill requests that mention "prescription for"; fixed.

Latency note: interpreter and assistant speeds are similar for both setups once cached (assistant ~3 s, interpreter ~6 s per request on this CPU). Cold, uncached prompts are much slower (~30–55 tokens/s to read), which is why the app primes the cache at start-up (about 1 minute of background work the first time).

Commands: `npm run ai:build-models` (rebuild), `npm run ai:eval` (quality comparison), `npm run ai:latency` (realistic timing).

## Database & synthetic data

- SQLite file at `./data/careroute.sqlite`, created and migrated automatically on start.
- **Seeding is automatic and idempotent:** 32 synthetic requests (SYN-1001 to SYN-1032) are keyed by `seed_key`, so restarts never duplicate them. To seed manually, run `npm run seed`.
- **Reset:** Settings & Safety → *Reset demo data…* → type the confirmation phrase. This deletes only rows marked as synthetic demo data, then reseeds. Audit history is kept.

## Running

```powershell
npm run dev          # API http://localhost:3001  +  web http://localhost:5173  (open the web URL)
```

**Local AI starts by itself:** with `AI_PROVIDER=ollama` (already set in `.env`), `npm run dev` launches Ollama if needed, pulls the model if missing, and warms it up. The log shows `[ollama] Local AI ready: llama3.2:3b`. No API key is used; the API's only AI connection is to `127.0.0.1:11434`. The UI only shows "Local AI available" after a successful check, and if Ollama can't start, the app keeps working with the deterministic policy and says so. Ollama keeps running in the background after you stop the app (like the normal Ollama app); quit it from the system tray if you want.

Production-style: `npm run start` (builds, then serves API on 3001 and the built app on http://localhost:4173).

## Tests

```powershell
npm test               # Vitest: unit + integration + frontend (Ollama is mocked)
npm run test:e2e       # Playwright end-to-end (first time: npx playwright install chromium)
npm run lint           # ESLint
npm run typecheck      # strict TypeScript, client + server
npm run build          # typecheck + production build
npm run ai:check       # live local-model smoke test (needs Ollama running)
npm run report:tests   # regenerate docs/test-report.md from actual runs
```

**Latest recorded results (2026-10-24, Snapdragon X / Windows 11 ARM64 / 16 GB):**

| Check | Result |
|---|---|
| Vitest (13 files) | **254 / 254 passed** |
| Test Lab fixtures | **49 / 49 passed**, 0 skipped, 0 critical (including the live Ollama case and 3 AI-assistant safety cases) |
| Playwright E2E | **9 / 9 passed** (6 workflows + 2 AI-assistant flows + 1 mobile responsive) |
| Lint | 0 errors, 3 warnings (React Fast Refresh hints only) |
| Typecheck + build | passed |
| Live local AI (`llama3.2:3b`) | valid JSON on every sample; ~25 s cold model load, then **~4.5–5.5 s** per request; emergency requests answered in ~12 ms with AI skipped |
| Live AI assistant chat | full conversation → handoff to the form; **~3–9 s per turn**; medical question declined; no off-script questions or booking promises |

Full report: [docs/test-report.md](docs/test-report.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| UI says "Cannot reach the EmergeMedicalRoute backend" | Run `npm run dev` and check that the `[api]` line shows port 3001 |
| Port 5173/3001 in use | Stop the other process, or set `WEB_PORT` / `API_PORT` |
| "Ollama unavailable" | Restart `npm run dev` (it auto-starts Ollama), or run `npm run ollama:setup`. If Ollama isn't installed, install it from ollama.com |
| "Model missing" | Restart `npm run dev` (auto-download), or `& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" pull llama3.2:3b` |
| `ollama pull` stalls ("part N stalled; retrying") | Usually a slow network. Quit Ollama from the tray, reopen it, and pull again |
| AI requests time out | The first request after start loads the model (~25 s). Raise `AI_TIMEOUT_MS` or use `llama3.2:1b` |
| E2E fails to start | `npx playwright install chromium`; free ports 3101/5174 |
| npm warns about blocked install scripts | Harmless here: esbuild ships prebuilt binaries |

## Safety limitations

- Illustrative demo policy with no clinical validation. Phrase matching can miss unusual wording; unmatched text falls back to human review, never routine.
- Local LLM output can be wrong or inconsistent. It is validated, can only escalate, and is skipped for emergencies.
- Demo staff identities are **not** authentication. The audit log is append-only inside SQLite but is not a tamper-proof enterprise audit system.
- No healthcare-privacy regulation compliance has been assessed. Never enter real patient data.
