import { describe, expect, it } from 'vitest';
import { ageGroupFor, extractFields, hasEvidence } from '../services/assistant/extract';
import { ASSISTANT_EVAL } from '../testing/ai-eval-set';

describe('rule-based intake extraction', () => {
  it.each(ASSISTANT_EVAL.filter((c) => Object.keys(c.expect).length).map((c) => [c.id, c.text, c.expect] as const))('%s: %s', (_id, text, expected) => {
    const out = extractFields(text);
    for (const [k, v] of Object.entries(expected)) expect(out[k as keyof typeof out]).toBe(v);
  });

  it('extracts nothing from messages that state nothing', () => {
    for (const c of ASSISTANT_EVAL.filter((x) => Object.keys(x.expect).length === 0)) {
      const out = extractFields(c.text);
      expect(out.ageGroup).toBeUndefined();
      expect(out.symptomOnset).toBeUndefined();
    }
  });

  it.each([
    ['onset', 'The pain started two days ago', { symptomOnset: '1_3_DAYS' }],
    ['onset', 'It has been going on for about a week', { symptomOnset: '4_7_DAYS' }],
    ['onset', 'I have had this for years', { symptomOnset: 'OVER_1_MONTH' }],
    ['onset', 'It began an hour ago', { symptomOnset: 'TODAY' }],
    ['age', 'She is 16', { ageGroup: '13_17' }],
    ['age', 'my 3 year old has a rash', { ageGroup: '1_4' }],
    ['age', 'I am 70 years old', { ageGroup: '65_PLUS' }],
    ['age', 'appointment for my baby', { ageGroup: 'UNDER_1' }],
    ['time', 'any time is fine', { preferredTimeRange: 'ANY' }],
    ['time', 'after work would be best', { preferredTimeRange: 'EVENING' }],
    ['follow-up', 'a follow up for my blood pressure', { isFollowUp: true }],
  ])('%s: %s', (_k, text, expected) => {
    expect(extractFields(text)).toMatchObject(expected);
  });

  it.each([
    ['temperature is not an age', 'My temperature is 39.4 today', 'ageGroup'],
    ['pain score is not an age', 'The pain is 8 out of 10', 'ageGroup'],
    ['clock time is not an age', 'Can I come at 10 am?', 'ageGroup'],
    ['"this morning" is not a time preference', 'It started this morning', 'preferredTimeRange'],
    ['"last month" in a follow-up is not an onset', 'This is a follow-up from my review last month.', 'symptomOnset'],
  ])('%s', (_label, text, field) => {
    expect(extractFields(text)[field as 'ageGroup']).toBeUndefined();
  });

  it('maps ages to the form’s age groups', () => {
    expect([0, 4, 5, 12, 13, 17, 18, 39, 40, 64, 65, 101].map(ageGroupFor)).toEqual(['UNDER_1', '1_4', '5_12', '5_12', '13_17', '13_17', '18_39', '18_39', '40_64', '40_64', '65_PLUS', '65_PLUS']);
    expect(ageGroupFor(150)).toBeUndefined();
  });

  it('accepts a model-suggested value only with supporting evidence', () => {
    expect(hasEvidence('ageGroup', '40_64', 'My mum is 81 and her knee is swollen')).toBe(false);
    expect(hasEvidence('ageGroup', '65_PLUS', 'My mum is 81 and her knee is swollen')).toBe(true);
    expect(hasEvidence('symptomOnset', '1_3_DAYS', 'Afternoons are easiest, it is about my eczema')).toBe(false);
    expect(hasEvidence('isFollowUp', true, 'I need a new prescription')).toBe(false);
  });
});
