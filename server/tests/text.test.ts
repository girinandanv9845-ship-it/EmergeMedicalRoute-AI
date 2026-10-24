import { describe, expect, it } from 'vitest';
import { analyseText, editDistance, findPhraseMentions, matchToken, normaliseText, stem } from '../services/safety/text';

describe('normaliseText', () => {
  it('lower-cases, unifies quotes and expands contractions without losing negation', () => {
    expect(normaliseText("I CAN’T breathe")).toBe('i cannot breathe');
    expect(normaliseText("he won't wake up")).toBe('he will not wake up');
    expect(normaliseText("I don't have chest pain")).toBe('i do not have chest pain');
    expect(normaliseText('She is not able to speak')).toBe('she is unable to speak');
    expect(normaliseText('cant breathe')).toBe('cannot breathe');
  });

  it('splits hyphenated words but keeps sentence punctuation', () => {
    expect(normaliseText('Follow-up visit. Thanks!')).toBe('follow up visit. thanks!');
  });
});

describe('analyseText', () => {
  it('splits sentences and clauses on punctuation and conjunctions', () => {
    const a = analyseText('No fever, but I cannot breathe. Please help');
    expect(a.sentences).toHaveLength(2);
    expect(a.clauses.map((c) => c.text)).toEqual(['no fever', 'i cannot breathe', 'please help']);
  });

  it('counts meaningful words excluding filler', () => {
    expect(analyseText('hi please help').meaningfulWordCount).toBe(1);
    expect(analyseText('   ').meaningfulWordCount).toBe(0);
  });
});

describe('fuzzy token matching', () => {
  it('computes bounded edit distance with transpositions', () => {
    expect(editDistance('pian', 'pain')).toBe(1);
    expect(editDistance('breth', 'breath')).toBe(1);
    expect(editDistance('abc', 'abcdefgh', 2)).toBe(3);
  });

  it('stems simple word endings', () => {
    expect(stem('breathing')).toBe(stem('breathe'));
    expect(stem('bleeding')).toBe('bleed');
  });

  it('matches common typos', () => {
    expect(matchToken('breth', 'breathe')).toBe('fuzzy');
    expect(matchToken('unconsious', 'unconscious')).toBe('fuzzy');
    expect(matchToken('pian', 'pain')).toBe('fuzzy');
    expect(matchToken('pain', 'pain')).toBe('exact');
  });

  it('never "corrects" real near-miss words', () => {
    expect(matchToken('cooking', 'choking')).toBeNull();
    expect(matchToken('worse', 'worst')).toBeNull();
    expect(matchToken('fewer', 'fever')).toBeNull();
    expect(matchToken('trip', 'tripped')).toBeNull();
    expect(matchToken('walking', 'waking')).toBeNull();
  });
});

describe('context detection', () => {
  const ctx = (text: string, phrase: string) => findPhraseMentions(analyseText(text), [phrase]).map((m) => m.context);

  it('detects negation before a phrase', () => {
    expect(ctx('I have no chest pain', 'chest pain')).toEqual(['negated']);
    expect(ctx('Denies chest pain today', 'chest pain')).toEqual(['negated']);
    expect(ctx('chest pain: none', 'chest pain')).toEqual(['negated']);
  });

  it('does not treat a negation inside the phrase itself as negation', () => {
    expect(ctx('my father cannot breathe', 'cannot breathe')).toEqual(['affirmed']);
    expect(ctx('he is not breathing', 'not breathing')).toEqual(['affirmed']);
  });

  it('limits negation scope to the clause', () => {
    expect(ctx('No fever but I have chest pain', 'chest pain')).toEqual(['affirmed']);
  });

  it('treats "not sure" as uncertainty, not negation', () => {
    expect(ctx('not sure if this is chest pain', 'chest pain')).toEqual(['affirmed']);
  });

  it('detects historical context unless a current marker is present', () => {
    expect(ctx('Two years ago, I had chest pain', 'chest pain')).toEqual(['historical']);
    expect(ctx('history of chest pain', 'chest pain')).toEqual(['historical']);
    expect(ctx('I had chest pain years ago and now chest pain again', 'chest pain')).toEqual(['historical', 'affirmed']);
  });
});
