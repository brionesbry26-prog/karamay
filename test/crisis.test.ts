import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessRisk, crisisResources, guessLanguage, safetyReply } from '../src/safety/crisis.js';

/**
 * The deterministic layer is a safety net, not a classifier. These cases pin
 * its current behaviour; known misses are listed explicitly so they stay visible.
 */
describe('crisis detection — urgent', () => {
  it.each([
    "I'm going to kill myself tonight",
    'i will end my life',
    'Papatayin ko na ang sarili ko',
    'magpapakamatay na ako',
    'tatalon na ako sa tulay',
    'gusto ko nang mamatay ngayon',
    'I want to die, I have the pills ready',
    'I want to dieeee right now',
  ])('%s -> urgent', (text) => {
    expect(assessRisk(text).level).toBe('urgent');
  });
});

describe('crisis detection — concern', () => {
  it.each([
    'I want to die',
    'sometimes I think about suicide',
    'I keep cutting myself',
    "I don't want to live anymore",
    'everyone would be better off without me',
    'Ayoko nang mabuhay',
    'gusto ko na lang mamatay',
    'wala nang saysay ang buhay ko',
    'naglalaslas ako minsan',
    'sinasaktan ko ang sarili ko',
    'mas mabuti pa kung wala na ako',
    'parang gusto ko nang mawala na lang talaga',
    'Grabe, gusto ko nang mamatayyy',
    'Nagpapakamatay yung isip ko, ewan',
  ])('%s -> concern or urgent (self-harm)', (text) => {
    const r = assessRisk(text);
    expect(r.level).not.toBe('none');
    expect(r.categories).toContain('self_harm');
  });

  it.each(['sinasaktan niya ako', 'binubugbog ako ng tatay ko', 'my boyfriend hits me', 'I was raped', 'papatayin niya ako'])(
    '%s -> harm from others',
    (text) => {
      const r = assessRisk(text);
      expect(r.level).not.toBe('none');
      expect(r.categories).toContain('harm_from_others');
    },
  );
});

describe('crisis detection — common idioms do not trigger', () => {
  it.each([
    'patay na patay ako sa kanya',
    'nakakamatay sa sarap ng adobo',
    'I could kill for a coffee',
    'this traffic is killing me',
    'namatay yung phone ko',
    'I almost died laughing',
    'I want to die laughing at this meme',
    'patayin mo na yung ilaw',
    'the plants died while I was away',
    'deadline is killing me pero kaya pa',
  ])('%s -> none', (text) => {
    expect(assessRisk(text).level).toBe('none');
  });
});

describe('known limitations (documented false negatives)', () => {
  it.each(['pagod na pagod na ako sa lahat, gusto ko nang magpahinga habambuhay', 'sana hindi na lang ako ipinanganak', "I won't be a burden much longer"])(
    '%s is NOT detected by the keyword layer',
    (text) => {
      // Indirect phrasing relies on the model-side safety instructions; see docs/AI_SAFETY.md.
      expect(assessRisk(text).level).toBe('none');
    },
  );
});

describe('safe responses and resources', () => {
  it('detects Filipino/Taglish vs English for template language', () => {
    expect(guessLanguage('Ayoko na talaga, pagod na ako')).toBe('fil');
    expect(guessLanguage('I feel really tired today')).toBe('en');
  });

  it('templates point to verified numbers only and never claim to have contacted anyone', () => {
    const verified = crisisResources().resources.flatMap((r) => r.phones.map((p) => p.number.replace(/\D/g, '')));
    for (const lang of ['fil', 'en'] as const) {
      for (const level of ['concern', 'urgent'] as const) {
        for (const cats of [['self_harm'], ['harm_from_others']] as const) {
          const text = safetyReply(level, [...cats], lang);
          const numbers = text.match(/\b\d{3,}\b/g) ?? [];
          for (const n of numbers) expect(verified).toContain(n);
          expect(text).not.toMatch(/I (have )?(called|contacted|alerted|notified)|tinawagan ko na|nakontak ko na/i);
        }
      }
    }
  });

  it('the resource file carries a source and verification date for every entry', () => {
    const file = crisisResources();
    expect(file.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const r of file.resources) {
      expect(r.source).toBeTruthy();
      expect(r.phones.length).toBeGreaterThan(0);
    }
  });

  it('the offline fallback in index.html matches the verified resource file', () => {
    const html = readFileSync('web/index.html', 'utf8');
    for (const r of crisisResources().resources) {
      for (const p of r.phones) expect(html).toContain(`tel:${p.tel}`);
    }
  });
});
