/**
 * AI intake assistant — shared contract between the chat UI and the server.
 *
 * The assistant only helps a requester complete the intake form. It never diagnoses, never gives
 * medical advice, never decides urgency and never routes. Every turn passes the deterministic
 * emergency rules BEFORE any AI call.
 */
import { z } from 'zod';
import { AGE_GROUPS, AI_STATUSES, ONSETS, REQUESTED_URGENCY, TIME_RANGES } from './domain';

export const MAX_CHAT_MESSAGE = 1000;
export const MAX_CHAT_MESSAGES = 40;

export const ChatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(MAX_CHAT_MESSAGE),
    /** 'text' = free text written by the requester (forms the description); 'choice' = a quick-reply tap. */
    kind: z.enum(['text', 'choice']).default('text'),
  })
  .strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const AssistantDraftSchema = z
  .object({
    ageGroup: z.enum(AGE_GROUPS).optional(),
    symptomOnset: z.enum(ONSETS).optional(),
    requestedUrgency: z.enum(REQUESTED_URGENCY).optional(),
    preferredDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    preferredTimeRange: z.enum(TIME_RANGES).optional(),
    isFollowUp: z.boolean().optional(),
  })
  .strict();
export type AssistantDraft = z.infer<typeof AssistantDraftSchema>;

export const AssistantRequestSchema = z
  .object({
    messages: z.array(ChatMessageSchema).min(1).max(MAX_CHAT_MESSAGES),
    draft: AssistantDraftSchema.default({}),
  })
  .strict();
export type AssistantRequest = z.infer<typeof AssistantRequestSchema>;

/** Fields the assistant collects, in the order it asks for them. */
export const ASSISTANT_FIELDS = ['symptomDescription', 'symptomOnset', 'requestedUrgency', 'ageGroup', 'preferredDate', 'preferredTimeRange'] as const;
export type AssistantField = (typeof ASSISTANT_FIELDS)[number];

export interface QuickReply {
  label: string;
  field: Exclude<AssistantField, 'symptomDescription'> | 'isFollowUp';
  value: string | boolean;
}

/** What the model may return. It can only suggest values for these administrative fields. */
export const AssistantModelOutputSchema = z
  .object({
    reply: z.string().min(1).max(700),
    extracted: z
      .object({
        symptomOnset: z.enum(ONSETS).optional(),
        ageGroup: z.enum(AGE_GROUPS).optional(),
        preferredTimeRange: z.enum(TIME_RANGES).optional(),
        isFollowUp: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type AssistantModelOutput = z.infer<typeof AssistantModelOutputSchema>;

export interface AssistantResponse {
  /** 'unavailable' = Ollama is not reachable / model missing; the chat never fakes AI replies. */
  type: 'reply' | 'emergency' | 'unavailable';
  reply: string;
  /** Requester's own words, joined from their free-text messages. */
  symptomDescription: string;
  draft: AssistantDraft;
  missingFields: AssistantField[];
  nextField: AssistantField | null;
  quickReplies: QuickReply[];
  ready: boolean;
  model: string | null;
  aiStatus: (typeof AI_STATUSES)[number];
  aiNote: string | null;
  latencyMs: number | null;
  precautionaryNotice: boolean;
  injectionDetected: boolean;
  /** True only when words written by the local model are part of the visible reply. */
  aiTextShown: boolean;
  emergency: null | { ruleIds: string[]; instruction: string; policyVersion: string };
}
