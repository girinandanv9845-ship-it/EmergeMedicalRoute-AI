/**
 * Text normalisation and phrase matching for the deterministic routing engine.
 *
 * Design goals:
 *  - Preserve meaning: contractions are expanded rather than stripped, so "can't breathe"
 *    and "cannot breathe" match the same rule and negation words remain visible.
 *  - Tolerate small typos ("breth", "unconsious", "chest pian") with a bounded edit distance.
 *  - Detect negated ("no chest pain") and historical ("two years ago") mentions so they are
 *    surfaced for human review instead of being silently treated as confirmed emergencies.
 */
import type { CombinationTrigger } from '../../../shared/policy-types';

export type MentionContext = 'affirmed' | 'negated' | 'historical';

export interface Clause {
  tokens: string[];
  text: string;
  sentenceIndex: number;
}

export interface AnalysedText {
  original: string;
  normalised: string;
  sentences: string[];
  clauses: Clause[];
  meaningfulWordCount: number;
}

export interface Mention {
  matchedText: string;
  context: MentionContext;
  fuzzy: boolean;
}

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan\s*'?\s*t\b/g, 'cannot'],
  [/\bcan not\b/g, 'cannot'],
  [/\bwon\s*'?\s*t\b/g, 'will not'],
  [/\b(do|does|did|is|are|was|were|has|have|had|should|would|could|must)n\s*'?\s*t\b/g, '$1 not'],
  [/\bi\s*'?\s*m\b/g, 'i am'],
  [/\b(it|that|he|she|there|what)\s*'s\b/g, '$1 is'],
  [/\b(i|you|we|they)\s*'ve\b/g, '$1 have'],
  [/\b(i|you|we|they|he|she)\s*'ll\b/g, '$1 will'],
  [/\b(i|you|we|they|he|she)\s*'d\b/g, '$1 would'],
  [/\b(is |are |am |was |were )?not able to\b/g, '$1unable to'],
  [/\bisnt\b/g, 'is not'],
  [/\bdoesnt\b/g, 'does not'],
  [/\bdont\b/g, 'do not'],
  [/\bdidnt\b/g, 'did not'],
  [/\bcant\b/g, 'cannot'],
];

const CLAUSE_BREAK_WORDS = new Set(['but', 'however', 'although', 'though', 'and', 'except', 'whereas', 'yet']);

const STOPWORDS = new Set(
  'a an the i me my we our you your he him his she her it its they them their is am are was were be been being have has had do does did of to in on at for with from by and or but so if then than that this these those just very really please hi hello thanks thank need want would like can could some any about also get got im'.split(
    ' ',
  ),
);

export const NEGATION_CUES = new Set(['no', 'not', 'never', 'nothing', 'without', 'denies', 'denied', 'deny', 'none', 'nor', 'negative']);
/** Words after "not" that mean the speaker is uncertain rather than negating. */
const NEGATION_EXCEPTIONS = new Set(['sure', 'certain', 'only', 'just', 'quite']);
const POST_NEGATION_CUES = new Set(['none', 'absent', 'denied', 'negative']);

const HISTORICAL_PATTERNS: RegExp[] = [
  /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|several|few|many|couple of)\s+(years?|months?)\s+ago\b/,
  /\b(\d+|a|one|two|three|four|five|six|several|few|couple of)\s+weeks?\s+ago\b/,
  /\b(years|months) ago\b/,
  /\blast (year|month|summer|winter|spring|autumn|fall)\b/,
  /\bin (19|20)\d{2}\b/,
  /\bback in\b/,
  /\bhistory of\b/,
  /\bin the past\b/,
  /\bpreviously\b/,
  /\bused to\b/,
  /\bas a (child|kid|teenager|baby)\b/,
  /\bwhen i was (young|younger|a child|a kid|a teenager)\b/,
  /\byears back\b/,
  /\b(fully )?resolved\b/,
  /\ba long time ago\b/,
];

const CURRENT_PATTERNS: RegExp[] = [
  /\b(now|still|again|currently|ongoing|tonight|today)\b/,
  /\bright now\b/,
  /\bthis (morning|afternoon|evening)\b/,
  /\b(minutes?|an hour|hours?) ago\b/,
  /\bjust (now|started)\b/,
  /\bat the moment\b/,
  /\bstarted\b/,
];

/** Lower-case, unify quotes and dashes, expand contractions. Keeps clause punctuation. */
export function normaliseText(input: string): string {
  let t = input.normalize('NFKC').toLowerCase();
  t = t.replace(/[‘’‛′`´]/g, "'").replace(/[“”]/g, '"');
  t = t.replace(/(\p{L})[-‐-―](\p{L})/gu, '$1 $2');
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  t = t.replace(/[ \t]+/g, ' ');
  return t.trim();
}

export function tokenise(text: string): string[] {
  return text
    .replace(/'/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function analyseText(input: string): AnalysedText {
  const normalised = normaliseText(input ?? '');
  const sentences = normalised.split(/[.!?;\n]+/).map((s) => s.trim()).filter(Boolean);
  const clauses: Clause[] = [];
  sentences.forEach((sentence, sentenceIndex) => {
    for (const part of sentence.split(/[,()]+/)) {
      let current: string[] = [];
      for (const tok of tokenise(part)) {
        if (CLAUSE_BREAK_WORDS.has(tok)) {
          if (current.length) clauses.push({ tokens: current, text: current.join(' '), sentenceIndex });
          current = [];
        } else current.push(tok);
      }
      if (current.length) clauses.push({ tokens: current, text: current.join(' '), sentenceIndex });
    }
  });
  const meaningfulWordCount = tokenise(normalised).filter((t) => !STOPWORDS.has(t) && t.length > 1).length;
  return { original: input ?? '', normalised, sentences, clauses, meaningfulWordCount };
}

// ---------------------------------------------------------------------------
// Fuzzy token matching
// ---------------------------------------------------------------------------

/** Very light stemmer so "breathing" ~ "breathe" ~ "breath", "bleeding" ~ "bleed". */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Optimal string alignment distance (Levenshtein + adjacent transpositions), bounded. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) val = Math.min(val, d[i - 2]![j - 2]! + 1);
      d[i]![j] = val;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Real words that must never be "corrected" into a lexicon word (e.g. "worse" must not become
 * "worst", "fewer" must not become "fever"). Lexicon words are added at runtime.
 */
const KNOWN_WORDS = new Set(
  'worse worst fewer chess cheat bread breed breach paint rain main lain seize bleed blend breathe breath breeze chase cheap chest fever never lever paid pain pin pan wake woke make bake take lake fake rake mild wild mile mind kind blood flood floor fall fell feel fill full fine find wine line air hair fair pair heart hearth hurt hurts head heat heal bead dead read lips lisp tips hips throat threat cooking smoking poking joking looking booking sizing spending breaking breeding blending breadth dropping staple hunting acting grasping smuggling smelling spelling selling sporting women walking route rose crashing overdue overdo vacation conclusion bleak brake broke cheese chess'.split(
    ' ',
  ),
);

export function registerKnownWords(words: Iterable<string>): void {
  for (const w of words) KNOWN_WORDS.add(w);
}

export type TokenMatch = 'exact' | 'fuzzy' | null;

export function matchToken(token: string, target: string): TokenMatch {
  if (token === target) return 'exact';
  const ts = stem(token);
  const gs = stem(target);
  if (ts === gs) return 'exact';
  // Never fuzzy-correct a genuine word, digits, or short words.
  if (KNOWN_WORDS.has(token) || /\d/.test(token) || /\d/.test(target)) return null;
  if (token[0] !== target[0]) return null;
  // Short typed words are never fuzzy-matched except for a 4-letter transposition ("pian" -> "pain").
  if (token.length < 5 && !(token.length === 4 && target.length === 4)) return null;
  if (target.length >= 10) return editDistance(token, target, 2) <= 2 || editDistance(ts, gs, 2) <= 2 ? 'fuzzy' : null;
  if (target.length >= 5) return editDistance(token, target, 1) <= 1 || editDistance(ts, gs, 1) <= 1 ? 'fuzzy' : null;
  if (target.length === 4 && token.length === 4) {
    // Allow only a single adjacent transposition for 4-letter words ("pian" -> "pain").
    return editDistance(token, target, 1) === 1 && [...token].sort().join('') === [...target].sort().join('') ? 'fuzzy' : null;
  }
  return null;
}

function matchInGroup(token: string, group: string[]): TokenMatch {
  let best: TokenMatch = null;
  for (const g of group) {
    const m = matchToken(token, g);
    if (m === 'exact') return 'exact';
    if (m === 'fuzzy') best = 'fuzzy';
  }
  return best;
}

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------
function isNegated(clause: Clause, start: number, end: number): boolean {
  for (let i = Math.max(0, start - 5); i < start; i++) {
    const tok = clause.tokens[i]!;
    if (NEGATION_CUES.has(tok)) {
      const next = clause.tokens[i + 1];
      if (tok === 'not' && next && NEGATION_EXCEPTIONS.has(next)) continue;
      return true;
    }
  }
  for (let i = end + 1; i <= Math.min(clause.tokens.length - 1, end + 2); i++) {
    if (POST_NEGATION_CUES.has(clause.tokens[i]!)) return true;
  }
  return false;
}

function isHistorical(analysed: AnalysedText, clause: Clause): boolean {
  const sentence = analysed.sentences[clause.sentenceIndex] ?? '';
  if (!HISTORICAL_PATTERNS.some((re) => re.test(sentence))) return false;
  // A current-time marker in the same clause means it is happening now (conservative).
  return !CURRENT_PATTERNS.some((re) => re.test(clause.text));
}

function contextOf(analysed: AnalysedText, clause: Clause, start: number, end: number): MentionContext {
  if (isNegated(clause, start, end)) return 'negated';
  if (isHistorical(analysed, clause)) return 'historical';
  return 'affirmed';
}

// ---------------------------------------------------------------------------
// Phrase & combination search
// ---------------------------------------------------------------------------
export function findPhraseMentions(analysed: AnalysedText, phrases: string[]): Mention[] {
  const mentions: Mention[] = [];
  for (const phrase of phrases) {
    const pTokens = tokenise(phrase);
    if (!pTokens.length) continue;
    for (const clause of analysed.clauses) {
      const toks = clause.tokens;
      for (let i = 0; i + pTokens.length <= toks.length; i++) {
        let fuzzy = false;
        let ok = true;
        for (let k = 0; k < pTokens.length; k++) {
          const m = matchToken(toks[i + k]!, pTokens[k]!);
          if (!m) {
            ok = false;
            break;
          }
          if (m === 'fuzzy') fuzzy = true;
        }
        if (ok) {
          const end = i + pTokens.length - 1;
          mentions.push({ matchedText: toks.slice(i, end + 1).join(' '), context: contextOf(analysed, clause, i, end), fuzzy });
        }
      }
    }
  }
  return mentions;
}

export function findCombinationMentions(analysed: AnalysedText, combo: CombinationTrigger): Mention[] {
  const mentions: Mention[] = [];
  for (const clause of analysed.clauses) {
    const toks = clause.tokens;
    // positions[g] = list of [index, fuzzy] where group g matched
    const positions = combo.groups.map((group) => {
      const hits: [number, boolean][] = [];
      toks.forEach((t, idx) => {
        const m = matchInGroup(t, group);
        if (m) hits.push([idx, m === 'fuzzy']);
      });
      return hits;
    });
    if (positions.some((p) => p.length === 0)) continue;
    // Anchor on the first group and look for the other groups inside the window.
    for (const [anchorIdx, anchorFuzzy] of positions[0]!) {
      const chosen: [number, boolean][] = [[anchorIdx, anchorFuzzy]];
      let ok = true;
      for (let g = 1; g < positions.length; g++) {
        const prev = chosen[chosen.length - 1]![0];
        const candidate = positions[g]!.find(([idx]) => {
          if (chosen.some(([c]) => c === idx)) return false;
          if (combo.ordered) return idx > prev && idx - prev <= combo.window;
          return Math.abs(idx - anchorIdx) <= combo.window;
        });
        if (!candidate) {
          ok = false;
          break;
        }
        chosen.push(candidate);
      }
      if (!ok) continue;
      const idxs = chosen.map(([i]) => i);
      const start = Math.min(...idxs);
      const end = Math.max(...idxs);
      mentions.push({
        matchedText: toks.slice(start, end + 1).join(' '),
        context: contextOf(analysed, clause, start, end),
        fuzzy: chosen.some(([, f]) => f),
      });
      break; // one mention per clause per combination is enough
    }
  }
  return mentions;
}

export function textContainsAny(normalised: string, phrases: string[]): string | null {
  const tokText = ` ${tokenise(normalised).join(' ')} `;
  for (const p of phrases) {
    if (tokText.includes(` ${tokenise(p).join(' ')} `)) return p;
  }
  return null;
}
