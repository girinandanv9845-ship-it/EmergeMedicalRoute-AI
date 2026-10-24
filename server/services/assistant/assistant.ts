/**
 * AI intake assistant (local Ollama only).
 *
 * Turn pipeline:
 *   1. Validate the conversation and current draft (strict Zod).
 *   2. Build the description from the requester's OWN free-text messages (never AI paraphrase).
 *   3. DETERMINISTIC emergency gate: run the routing engine on that text. Emergency → stop, return
 *      fixed emergency guidance, never call the model.
 *   4. Work out the next missing intake field deterministically (with quick-reply options).
 *   5. Ask the local Ollama model for a short, friendly reply + optional extraction of administrative
 *      fields, with structured JSON output and a timeout.
 *   6. Validate the model output; reject diagnosis / advice / reassurance language.
 *   7. If Ollama is unreachable, the model is missing, or it times out → return 'unavailable'.
 *      No scripted replies are ever presented as AI.
 *
 * The assistant never routes a request and never submits anything: the requester reviews the
 * prefilled form and submits it through the normal, fully audited intake pipeline.
 */
import {
  AGE_GROUPS,
  AGE_GROUP_LABELS,
  ONSETS,
  ONSET_LABELS,
  TIME_RANGES,
  TIME_RANGE_LABELS,
  type AiStatus,
} from '../../../shared/domain';
import {
  ASSISTANT_FIELDS,
  AssistantModelOutputSchema,
  AssistantRequestSchema,
  type AssistantDraft,
  type AssistantField,
  type AssistantResponse,
  type ChatMessage,
  type QuickReply,
} from '../../../shared/assistant';
import { validationError } from '../../errors';
import { getActivePolicy } from '../../policies';
import { analyseText } from '../safety/text';
import { AiProviderError, OllamaProvider, type AiProvider } from '../ai/providers';
import { evaluateRequest } from '../routing/engine';
import { extractFields, hasEvidence } from './extract';

/** Replies that diagnose, advise, prescribe or reassure are never shown. */
export const UNSAFE_REPLY =
  /\b(diagnos\w*|you (probably|likely|may|might) have|sounds like (a|an|you have)|it('| i)s (probably|likely|just|nothing)|nothing to worry|not (anything )?serious|no need to (worry|see|come|call|seek)|don'?t need to (see|worry)|you should take|take (some|an?|two|\d)|ibuprofen|paracetamol|acetaminophen|aspirin|antibiotic\w*|prescri\w*|\d+\s?mg\b|dosage|you('| a)re fine|you will be fine)\b/i;

import { ASSISTANT_SYSTEM_PROMPT } from './prompts';
export { ASSISTANT_SYSTEM_PROMPT };

const QUESTIONS: Record<AssistantField, string> = {
  symptomDescription: 'In your own words, what would you like an appointment for?',
  symptomOnset: 'When did this start?',
  requestedUrgency: 'Would you prefer a routine appointment, or do you feel this is urgent? (Your preference is noted; clinic staff decide the timing.)',
  ageGroup: 'Which age group is the appointment for?',
  preferredDate: 'Which day would suit you best?',
  preferredTimeRange: 'What time of day would suit you?',
};

const READY_TEXT = 'Thank you — I have everything needed. Please review the request and submit it; clinic staff will look at it.';

function addDays(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function quickRepliesFor(field: AssistantField | null, today: string): QuickReply[] {
  switch (field) {
    case 'symptomOnset':
      return ONSETS.map((o) => ({ label: ONSET_LABELS[o], field: 'symptomOnset', value: o }));
    case 'requestedUrgency':
      return [
        { label: 'Routine', field: 'requestedUrgency', value: 'ROUTINE' },
        { label: 'Urgent', field: 'requestedUrgency', value: 'URGENT' },
      ];
    case 'ageGroup':
      return AGE_GROUPS.map((a) => ({ label: AGE_GROUP_LABELS[a], field: 'ageGroup', value: a }));
    case 'preferredDate':
      return [
        { label: 'Tomorrow', field: 'preferredDate', value: addDays(today, 1) },
        { label: 'In 2 days', field: 'preferredDate', value: addDays(today, 2) },
        { label: 'In 3 days', field: 'preferredDate', value: addDays(today, 3) },
        { label: 'Next week', field: 'preferredDate', value: addDays(today, 7) },
      ];
    case 'preferredTimeRange':
      return TIME_RANGES.map((t) => ({ label: TIME_RANGE_LABELS[t], field: 'preferredTimeRange', value: t }));
    default:
      return [];
  }
}

export function descriptionFrom(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'user' && m.kind === 'text')
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 5000);
}

export function missingFields(description: string, draft: AssistantDraft): AssistantField[] {
  return ASSISTANT_FIELDS.filter((f) => {
    if (f === 'symptomDescription') return analyseText(description).meaningfulWordCount < 2;
    return draft[f] === undefined;
  });
}

/**
 * Keeps only safe statement sentences from the model's acknowledgement: no questions (the server asks
 * every question, so the model can never ask for anything off-script such as a date of birth), nothing
 * repeated from earlier assistant messages, at most ~200 characters.
 */
/** Sentences implying a booking, availability or confirmation — only clinic staff can do that. */
/** A request for medical advice, even without a question mark ("tell me my diagnosis"). */
export const MEDICAL_REQUEST =
  /\b(diagnos\w*|what (medicine|medication|tablets?|pills?|treatment)|which (medicine|medication|tablets?|pills?|treatment)|should i (take|use|try)|is (it|this) (serious|cancer|broken|infected|normal)|could (it|this) be|what('?s| is) wrong with me|antibiotics?|painkillers?|dosage|dose)\b/i;

export const BOOKING_PROMISE =
  /\b(slots?|availab\w*|confirm\w*|booked|book you|scheduled|reserved|we have|see you|appointment (is|has been)|will be seen|received|submitted|forward\w*|sent (to|it)|passed (on|to)|be in touch|get back to you|contact you|call you|reach out|we will review)\b/i;

export function sanitiseAcknowledgement(text: string, history: ChatMessage[]): string {
  const previous = history.filter((m) => m.role === 'assistant').map((m) => m.content.toLowerCase());
  const latest = [...history].reverse().find((m) => m.role === 'user');
  const latestIsChoice = latest?.kind === 'choice';
  const latestAsks = latest?.kind === 'text' && (latest.content.includes('?') || MEDICAL_REQUEST.test(latest.content));
  const latestMentionsBooking = latest?.kind === 'text' && /\b(book|schedule|appointment (for|on|at))\b/i.test(latest.content);
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s &&
        !s.includes('?') &&
        !BOOKING_PROMISE.test(s) &&
        // A disclaimer only fits when the requester actually asked something (the server adds it then).
        !((latestIsChoice || !latestAsks) && /medical (advice|explanation|information)/i.test(s)) &&
        // "I can't book…" only fits when the requester asked to book.
        !(!latestMentionsBooking && /\bbook/i.test(s)) &&
        // Instructions ("Please select…") would conflict with the server's question.
        !/^please\b/i.test(s) &&
        // Small models get dates, times and numbers wrong; the server shows the real values.
        !/\d/.test(s) &&
        !previous.some((p) => p.includes(s.toLowerCase())),
    );
  // The prompt asks for ONE sentence; keep the first clean one (≤ 200 chars).
  const first = sentences[0] ?? '';
  return first.length <= 200 ? first : '';
}

function assistantFormat() {
  return {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      extracted: {
        type: 'object',
        properties: {
          symptomOnset: { type: 'string', enum: [...ONSETS] },
          ageGroup: { type: 'string', enum: [...AGE_GROUPS] },
          preferredTimeRange: { type: 'string', enum: [...TIME_RANGES] },
          isFollowUp: { type: 'boolean' },
        },
      },
    },
    required: ['reply', 'extracted'],
  };
}

export interface AssistantContext {
  provider: AiProvider;
  timeoutMs: number;
  emergencyInstruction: string;
  today: string;
}

export interface AssistantTurnResult {
  response: AssistantResponse;
  /** For the audit log — never contains message text. */
  auditNote: string;
  /** Raw model output before validation/sanitising — for offline evaluation only, never returned to clients. */
  rawModelReply?: string | null;
  emergencyRuleIds: string[];
}

export async function assistantTurn(body: unknown, ctx: AssistantContext): Promise<AssistantTurnResult> {
  const parsed = AssistantRequestSchema.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error, 'The chat message could not be processed.');
  const { messages } = parsed.data;
  let draft: AssistantDraft = { ...parsed.data.draft };
  const policy = getActivePolicy();
  const description = descriptionFrom(messages);
  const ollama = ctx.provider instanceof OllamaProvider ? ctx.provider : null;

  // --- 3. Deterministic emergency gate (always, before any AI) --------------------------------
  const rec = evaluateRequest({
    symptomDescription: description,
    ageGroup: draft.ageGroup ?? '18_39',
    symptomOnset: draft.symptomOnset ?? 'UNKNOWN',
    requestedUrgency: draft.requestedUrgency ?? 'ROUTINE',
    isFollowUp: draft.isFollowUp,
  });
  const base = {
    symptomDescription: description,
    model: ollama?.model ?? null,
    latencyMs: null as number | null,
    precautionaryNotice: rec.precautionaryNotice,
    injectionDetected: rec.matchedRuleIds.includes('SAFETY-INJECT-01'),
    aiTextShown: false,
    emergency: null,
  };

  if (rec.emergencyGuidanceRequired) {
    const ruleIds = rec.matchedRuleIds.filter((id) => id.startsWith('EMERG-'));
    return {
      emergencyRuleIds: ruleIds,
      auditNote: 'Assistant chat: emergency rule matched; chat stopped and emergency guidance shown (AI not called).',
      response: {
        ...base,
        type: 'emergency',
        reply: `What you describe may be an emergency. ${ctx.emergencyInstruction} Please do not wait for an appointment or a clinic callback. This assistant has NOT contacted emergency services.`,
        draft,
        missingFields: [],
        nextField: null,
        quickReplies: [],
        ready: false,
        aiStatus: 'skipped_emergency',
        aiNote: 'AI was not called because a mandatory emergency rule matched.',
        emergency: { ruleIds, instruction: ctx.emergencyInstruction, policyVersion: policy.version },
      },
    };
  }

  // --- 7 (early). Ollama only -----------------------------------------------------------------
  const unavailable = (aiStatus: AiStatus, note: string): AssistantTurnResult => {
    const missing = missingFields(description, draft);
    return {
      emergencyRuleIds: [],
      auditNote: `Assistant chat: AI unavailable (${aiStatus}).`,
      response: {
        ...base,
        type: 'unavailable',
        reply: 'The AI assistant is not available right now. Your details so far are kept — you can finish your request using the form.',
        draft,
        missingFields: missing,
        nextField: missing[0] ?? null,
        quickReplies: [],
        ready: missing.length === 0,
        aiStatus,
        aiNote: note,
      },
    };
  };
  if (!ollama || !ollama.isEnabled()) {
    return unavailable('disabled', 'The intake assistant uses the local Ollama model only. Set AI_PROVIDER=ollama and start Ollama to enable it.');
  }

  // --- 3b. Rule-based extraction from the requester's latest words (authoritative) -------------
  const latestUser = [...messages].reverse().find((m) => m.role === 'user');
  const latestText = latestUser?.kind === 'text' ? latestUser.content : '';
  for (const [k, v] of Object.entries(extractFields(latestText)) as [keyof AssistantDraft, never][]) {
    if (draft[k] === undefined) draft = { ...draft, [k]: v };
  }

  // --- 4. Deterministic next question ---------------------------------------------------------
  const missingBefore = missingFields(description, draft);
  const nextBefore = missingBefore[0] ?? null;
  const known = Object.entries(draft)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');
  const nextQuestion = nextBefore
    ? nextBefore === 'symptomDescription' && description
      ? 'Could you tell me a little more about what you need the appointment for?'
      : QUESTIONS[nextBefore]
    : READY_TEXT;

  // --- 5. Local model call --------------------------------------------------------------------
  const chat: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }];
  for (const m of messages.slice(-6)) {
    chat.push(m.role === 'user' ? { role: 'user', content: `<client_message>${m.content.replace(/<\/?client_message>/gi, '')}</client_message>` } : { role: 'assistant', content: JSON.stringify({ reply: m.content, extracted: {} }) });
  }
  // The per-turn state goes AFTER the requester's text in the last user message — not in a system
  // message. Llama's chat template merges all system messages into the top of the prompt, so a
  // changing system note would invalidate Ollama's prompt cache on every turn (measured: ~10 s vs ~1 s).
  const lastUser = [...chat].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    lastUser.content += `\n\n[App note, not from the person: already known — ${known || 'nothing yet'}. Write the one-sentence acknowledgement of the latest message. JSON only.]`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  const started = performance.now();
  let raw: string | null;
  try {
    raw = await Promise.race([
      ollama.chatJson(chat, assistantFormat(), controller.signal, 120),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new AiProviderError('timed out', 'timeout')))),
    ]);
  } catch (err) {
    const reason = err instanceof AiProviderError ? err.reason : 'unavailable';
    const status: AiStatus = reason === 'timeout' ? 'timeout' : reason === 'model_missing' ? 'model_missing' : 'unavailable';
    return unavailable(status, err instanceof AiProviderError ? `${err.message}.` : 'Local AI request failed.');
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Math.round(performance.now() - started);

  // --- 6. Validate model output ---------------------------------------------------------------
  let output: ReturnType<typeof AssistantModelOutputSchema.parse> | null = null;
  try {
    const result = AssistantModelOutputSchema.safeParse(raw ? JSON.parse(raw) : null);
    if (result.success) output = result.data;
  } catch {
    output = null;
  }
  let aiStatus: AiStatus = 'used';
  let aiNote: string | null = `Reply written by local model ${ollama.model} and validated.`;
  let ack = '';
  let modelAck = '';
  if (!output) {
    aiStatus = 'malformed_rejected';
    aiNote = 'The local model returned invalid output, so a standard question is shown instead.';
  } else if (UNSAFE_REPLY.test(output.reply)) {
    aiStatus = 'malformed_rejected';
    aiNote = 'The local model reply contained medical advice or reassurance and was blocked.';
    ack = "I can't give medical advice — clinic staff will review your request.";
  } else {
    ack = sanitiseAcknowledgement(output.reply, messages);
    modelAck = ack;
    // Model may only FILL missing administrative fields the person clearly stated.
    // A model-suggested value is accepted only with supporting evidence in the requester's words.
    for (const [k, v] of Object.entries(output.extracted) as [keyof typeof output.extracted, never][]) {
      if (draft[k] === undefined && v !== undefined && hasEvidence(k, v, latestText)) draft = { ...draft, [k]: v };
    }
  }

  const missing = missingFields(description, draft);
  const next = missing[0] ?? null;
  // If the requester's latest free-text message asks something, guarantee the "no medical advice" line.
  const latest = [...messages].reverse().find((m) => m.role === 'user');
  if (latest?.kind === 'text' && (latest.content.includes('?') || MEDICAL_REQUEST.test(latest.content)) && !/medical advice/i.test(ack)) {
    const rest = /clinic staff will review/i.test(ack) ? '' : ack;
    ack = `I can't give medical advice — clinic staff will review your request.${rest ? ` ${rest}` : ''}`;
  }
  // The NEXT QUESTION always comes from the server, never from the model.
  const question = next ? (next === 'symptomDescription' && description ? nextQuestion : QUESTIONS[next]) : READY_TEXT;
  const reply = [ack, question].filter(Boolean).join(' ');

  return {
    emergencyRuleIds: [],
    auditNote: `Assistant chat turn: ${aiStatus} (${latencyMs} ms), ${missing.length} field(s) still missing.`,
    rawModelReply: raw,
    response: {
      ...base,
      type: 'reply',
      reply,
      draft,
      missingFields: missing,
      nextField: next,
      quickReplies: quickRepliesFor(next, ctx.today),
      ready: missing.length === 0,
      aiStatus,
      aiNote,
      latencyMs,
      aiTextShown: modelAck !== '' && reply.includes(modelAck),
    },
  };
}
