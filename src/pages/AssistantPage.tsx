import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Bot, CheckCircle2, CircleDashed, MessagesSquare, RotateCcw, Send, ShieldAlert, User } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AGE_GROUP_LABELS, ONSET_LABELS, TIME_RANGE_LABELS } from '../../shared/domain';
import { MAX_CHAT_MESSAGE, type AssistantDraft, type AssistantResponse, type ChatMessage, type QuickReply } from '../../shared/assistant';
import { EmergencyBanner, IntakeEmergencyNotice, PrecautionNotice } from '../components/routing/SafetyNotices';
import { Card, ErrorState, PageHeader, cx } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/format';

const GREETING =
  "Hi — I'm the clinic's AI intake assistant. I can help you put together an appointment request, which clinic staff will then review. I can't give medical advice. In your own words, what would you like an appointment for?";

interface DisplayMessage extends ChatMessage {
  meta?: Pick<AssistantResponse, 'type' | 'aiStatus' | 'latencyMs' | 'model' | 'aiNote' | 'aiTextShown'>;
}

const FIELD_ROWS: { key: keyof AssistantDraft | 'symptomDescription'; label: string }[] = [
  { key: 'symptomDescription', label: 'Concern (your words)' },
  { key: 'symptomOnset', label: 'Started' },
  { key: 'requestedUrgency', label: 'Request type' },
  { key: 'ageGroup', label: 'Age group' },
  { key: 'preferredDate', label: 'Preferred day' },
  { key: 'preferredTimeRange', label: 'Preferred time' },
];

function displayValue(key: string, draft: AssistantDraft, description: string): string | null {
  switch (key) {
    case 'symptomDescription':
      return description || null;
    case 'symptomOnset':
      return draft.symptomOnset ? ONSET_LABELS[draft.symptomOnset] : null;
    case 'requestedUrgency':
      return draft.requestedUrgency ? (draft.requestedUrgency === 'URGENT' ? 'Urgent (preference)' : 'Routine') : null;
    case 'ageGroup':
      return draft.ageGroup ? AGE_GROUP_LABELS[draft.ageGroup] : null;
    case 'preferredDate':
      return draft.preferredDate ? formatDate(draft.preferredDate) : null;
    case 'preferredTimeRange':
      return draft.preferredTimeRange ? TIME_RANGE_LABELS[draft.preferredTimeRange] : null;
    default:
      return null;
  }
}

function AssistantBadge({ meta }: { meta: NonNullable<DisplayMessage['meta']> }) {
  if (meta.type === 'emergency') return <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800">Safety rule — AI not used</span>;
  if (meta.type === 'unavailable') return <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-800">AI unavailable</span>;
  if (meta.aiStatus === 'malformed_rejected')
    return (
      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700" title={meta.aiNote ?? ''}>
        Standard reply (AI output blocked)
      </span>
    );
  if (!meta.aiTextShown)
    return (
      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700" title="The local model was consulted; the visible text is the app's standard question.">
        Standard question · local AI consulted
        {meta.latencyMs !== null ? ` · ${(meta.latencyMs / 1000).toFixed(1)} s` : ''}
      </span>
    );
  return (
    <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-800" title={meta.aiNote ?? ''}>
      AI · {meta.model ?? 'local model'}
      {meta.latencyMs !== null ? ` · ${(meta.latencyMs / 1000).toFixed(1)} s` : ''}
    </span>
  );
}

export function AssistantPage() {
  const navigate = useNavigate();
  const config = useQuery({ queryKey: ['config'], queryFn: api.config });
  const ai = useQuery({ queryKey: ['ai-status'], queryFn: () => api.aiStatus(true), refetchInterval: 30_000 });
  const [messages, setMessages] = useState<DisplayMessage[]>([{ role: 'assistant', content: GREETING, kind: 'text' }]);
  const [draft, setDraft] = useState<AssistantDraft>({});
  const [description, setDescription] = useState('');
  const [last, setLast] = useState<AssistantResponse | null>(null);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const instruction = config.data?.emergencyInstruction ?? 'Contact your local emergency services immediately.';
  const emergency = last?.type === 'emergency' ? last : null;

  const chat = useMutation({
    mutationFn: (vars: { messages: DisplayMessage[]; draft: AssistantDraft }) =>
      api.assistantChat(
        vars.messages.map(({ role, content, kind }) => ({ role, content, kind })),
        vars.draft,
      ),
    onSuccess: (res) => {
      setLast(res);
      setDraft(res.draft);
      setDescription(res.symptomDescription);
      setMessages((m) => [...m, { role: 'assistant', content: res.reply, kind: 'text', meta: { type: res.type, aiStatus: res.aiStatus, latencyMs: res.latencyMs, model: res.model, aiNote: res.aiNote, aiTextShown: res.aiTextShown } }]);
    },
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, chat.isPending]);

  const send = (msg: DisplayMessage, nextDraft = draft) => {
    if (chat.isPending || emergency) return;
    const next = [...messages, msg];
    setMessages(next);
    chat.mutate({ messages: next, draft: nextDraft });
  };

  const onSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    send({ role: 'user', content: text.slice(0, MAX_CHAT_MESSAGE), kind: 'text' });
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  const choose = (q: QuickReply) => {
    const nextDraft = { ...draft, [q.field]: q.value } as AssistantDraft;
    setDraft(nextDraft);
    send({ role: 'user', content: q.label, kind: 'choice' }, nextDraft);
  };

  const restart = () => {
    setMessages([{ role: 'assistant', content: GREETING, kind: 'text' }]);
    setDraft({});
    setDescription('');
    setLast(null);
    setInput('');
    chat.reset();
  };

  const review = () => navigate('/intake', { state: { assistantDraft: { ...draft, symptomDescription: description } } });
  const lastIsAssistant = messages[messages.length - 1]?.role === 'assistant';
  const quickReplies = !chat.isPending && lastIsAssistant && last?.type === 'reply' ? last.quickReplies : [];
  const aiOk = ai.data?.verified === true;

  return (
    <div className="fade-in space-y-5">
      {emergency?.emergency && <EmergencyBanner instruction={emergency.emergency.instruction} ruleIds={emergency.emergency.ruleIds} policyVersion={emergency.emergency.policyVersion} />}
      <PageHeader
        icon={MessagesSquare}
        title="AI intake assistant"
        description="Chat to put together an appointment request. The assistant runs on a local Ollama model, asks only intake questions, and never gives medical advice. You review and submit the request yourself."
        actions={
          <Link to="/intake" className="btn-secondary">
            Use the form instead
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="card flex h-[70vh] min-h-[480px] flex-col lg:col-span-2" aria-label="Conversation with the AI intake assistant">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-white">
                <Bot className="h-4.5 w-4.5" aria-hidden />
              </span>
              <div className="leading-tight">
                <p className="text-sm font-semibold text-slate-900">Intake assistant</p>
                <p className="text-[11px] text-slate-500">AI can make mistakes · not medical advice · not for emergencies</p>
              </div>
            </div>
            <span
              data-testid="assistant-ai-status"
              className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset', aiOk ? 'bg-emerald-50 text-emerald-800 ring-emerald-600/30' : 'bg-orange-50 text-orange-800 ring-orange-600/30')}
            >
              <span className={cx('h-1.5 w-1.5 rounded-full', aiOk ? 'bg-emerald-500' : 'bg-orange-500')} aria-hidden />
              {ai.isLoading ? 'Checking local AI…' : aiOk ? `Local AI · ${ai.data?.model}` : 'Local AI unavailable'}
            </span>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4" role="log" aria-live="polite" data-testid="chat-log">
            {messages.map((m, i) =>
              m.role === 'assistant' ? (
                <div key={i} className="flex items-start gap-2">
                  <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full', m.meta?.type === 'emergency' ? 'bg-red-600 text-white' : 'bg-indigo-100 text-indigo-700')}>
                    {m.meta?.type === 'emergency' ? <ShieldAlert className="h-4 w-4" aria-hidden /> : <Bot className="h-4 w-4" aria-hidden />}
                  </span>
                  <div className="max-w-[85%]">
                    <div
                      className={cx(
                        'whitespace-pre-wrap rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-sm',
                        m.meta?.type === 'emergency' ? 'border-2 border-red-600 bg-red-50 font-semibold text-red-950' : m.meta?.type === 'unavailable' ? 'border border-orange-200 bg-orange-50 text-orange-950' : 'bg-slate-100 text-slate-900',
                      )}
                      data-testid="assistant-message"
                    >
                      {m.content}
                    </div>
                    {m.meta && (
                      <div className="mt-1">
                        <AssistantBadge meta={m.meta} />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex items-start justify-end gap-2">
                  <div className={cx('max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-sm text-white', m.kind === 'choice' ? 'bg-teal-600' : 'bg-teal-700')} data-testid="user-message">
                    {m.content}
                  </div>
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-800">
                    <User className="h-4 w-4" aria-hidden />
                  </span>
                </div>
              ),
            )}
            {chat.isPending && (
              <div className="flex items-center gap-2 text-xs text-slate-500" role="status">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
                  <Bot className="h-4 w-4" aria-hidden />
                </span>
                <span className="inline-flex gap-1" aria-hidden>
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.2s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.1s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
                </span>
                Assistant is thinking (local model, a few seconds)…
              </div>
            )}
            {chat.isError && (
              <ErrorState
                error={chat.error}
                title={chat.error instanceof ApiError && chat.error.status === 0 ? 'Cannot reach the clinic server' : 'Message not processed'}
              />
            )}
            {last?.precautionaryNotice && !emergency && <PrecautionNotice instruction={instruction} />}
          </div>

          {quickReplies.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-slate-100 px-4 py-2.5" role="group" aria-label="Quick replies">
              {quickReplies.map((q) => (
                <button key={`${q.field}-${String(q.value)}`} type="button" onClick={() => choose(q)} className="rounded-full border border-teal-600 bg-white px-3 py-1 text-xs font-medium text-teal-800 hover:bg-teal-50">
                  {q.label}
                </button>
              ))}
            </div>
          )}

          {emergency ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950">
              <span>This assistant can't help with emergencies. {instruction}</span>
              <button type="button" className="btn-secondary" onClick={restart}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Start a new conversation
              </button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-slate-100 p-3">
              <label htmlFor="chat-input" className="sr-only">
                Message the intake assistant
              </label>
              <textarea
                id="chat-input"
                ref={inputRef}
                rows={2}
                maxLength={MAX_CHAT_MESSAGE}
                className="input resize-none"
                placeholder="Type your message… (Enter to send, Shift+Enter for a new line)"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <button type="submit" className="btn-primary h-10" disabled={chat.isPending || !input.trim()} aria-label="Send message">
                <Send className="h-4 w-4" aria-hidden />
              </button>
            </form>
          )}
        </section>

        <aside className="space-y-4">
          <IntakeEmergencyNotice instruction={instruction} />
          <Card title="Your request so far">
            <dl className="space-y-2.5" data-testid="assistant-draft">
              {FIELD_ROWS.map((row) => {
                const value = displayValue(row.key, draft, description);
                return (
                  <div key={row.key} className="flex items-start gap-2 text-sm">
                    {value ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden /> : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" aria-hidden />}
                    <div className="min-w-0">
                      <dt className="text-xs text-slate-500">{row.label}</dt>
                      <dd className={cx('break-words', value ? 'whitespace-pre-wrap text-slate-900' : 'text-slate-400')}>{value ?? 'Not yet'}</dd>
                    </div>
                  </div>
                );
              })}
            </dl>
            <button type="button" className="btn-primary mt-4 w-full" onClick={review} disabled={!description || !!emergency} data-testid="assistant-review">
              Review & submit <ArrowRight className="h-4 w-4" aria-hidden />
            </button>
            <p className="mt-2 text-xs text-slate-500">
              {last?.ready ? 'All details collected. ' : ''}You'll check every field on the request form before anything is submitted. The concern is kept in your own words.
            </p>
            {last?.type === 'unavailable' && (
              <p className="mt-2 rounded-lg bg-orange-50 p-2 text-xs text-orange-900">
                {last.aiNote} Your details are kept — use <strong>Review & submit</strong> to finish with the form.
              </p>
            )}
            {last?.injectionDetected && <p className="mt-2 rounded-lg bg-violet-50 p-2 text-xs text-violet-900">Some text looked like instructions to the system. It was ignored and will be flagged for staff.</p>}
          </Card>
          <button type="button" className="btn-ghost w-full text-xs" onClick={restart}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Start over
          </button>
        </aside>
      </div>
    </div>
  );
}
