import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contrastRatio, validateAccentColor } from '@saas-instant/shared';
import {
  DEFAULT_ACCENT,
  applyAccent,
  applyRememberedAccent,
  buildAccentCss,
  darkAccentTokens,
  formatRatio,
  lightAccentTokens,
  readRememberedAccent,
  rememberAccent,
} from './accent';

const SAMPLES = ['#b45309', '#15803d', '#7c3aed', '#be123c', '#0f766e', '#4338ca', '#1e293b'];

beforeEach(() => {
  document.getElementById('accent-theme')?.remove();
  try {
    window.localStorage.clear();
  } catch {
    // ohne Speicher
  }
});
afterEach(() => document.getElementById('accent-theme')?.remove());

describe('abgeleitete Akzent-Token', () => {
  it.each(SAMPLES)('Hell %s: Text auf allen Flächen mindestens 4,5:1', (hex) => {
    const k = lightAccentTokens(hex);
    expect(k['--farbe-primaer']).toBe(hex);
    expect(contrastRatio(k['--farbe-primaer-text']!, k['--farbe-primaer']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(k['--farbe-primaer-text']!, k['--farbe-primaer-hover']!)).toBeGreaterThanOrEqual(4.5);
    for (const bg of [k['--farbe-primaer-soft']!, k['--farbe-primaer-softer']!, '#ffffff']) {
      expect(contrastRatio(k['--farbe-primaer-softtext']!, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(k['--farbe-primaer-softtext-hover']!, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(SAMPLES)('Dunkel %s: Akzent und Text auf den dunklen Flächen mindestens 4,5:1', (hex) => {
    const onDark = validateAccentColor(hex).accentOnDark!;
    const k = darkAccentTokens(onDark);
    for (const bg of ['#1e293b', '#0f172a', '#172033']) {
      expect(contrastRatio(k['--farbe-primaer']!, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(k['--farbe-primaer-softtext']!, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(k['--farbe-primaer-text']!, k['--farbe-primaer']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(k['--farbe-primaer-text']!, k['--farbe-primaer-hover']!)).toBeGreaterThanOrEqual(4.5);
    for (const bg of [k['--farbe-primaer-soft']!, k['--farbe-primaer-softer']!]) {
      expect(contrastRatio(k['--farbe-primaer-softtext']!, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(k['--farbe-primaer-softtext-hover']!, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('Akzent anwenden', () => {
  it('der Standard und ungültige Werte lassen tokens.css gelten', () => {
    expect(buildAccentCss(DEFAULT_ACCENT)).toBeNull();
    expect(buildAccentCss('#0369A1')).toBeNull();
    expect(buildAccentCss('rot')).toBeNull();
    expect(buildAccentCss('#ffff00')).toBeNull(); // Kontrast zu gering
    expect(applyAccent('#ffff00')).toBe(false);
    expect(document.getElementById('accent-theme')).toBeNull();
  });

  it('setzt Hell, Dunkel per Medienabfrage und per data-theme', () => {
    expect(applyAccent('#b45309', '#f59e0b')).toBe(true);
    const css = document.getElementById('accent-theme')!.textContent!;
    expect(css).toContain('html:root { --farbe-primaer: #b45309;');
    expect(css).toContain('--farbe-primaer-hover:');
    expect(css).toContain('--farbe-fokus: #b45309;');
    expect(css).toContain('@media (prefers-color-scheme: dark) { html:root:not([data-theme="light"])');
    expect(css).toContain('html:root[data-theme="dark"]');
  });

  it('ersetzt das Stylesheet statt es zu vervielfachen und entfernt es beim Standard', () => {
    applyAccent('#b45309');
    applyAccent('#15803d');
    expect(document.querySelectorAll('#accent-theme')).toHaveLength(1);
    expect(document.getElementById('accent-theme')!.textContent).toContain('#15803d');
    applyAccent(DEFAULT_ACCENT);
    expect(document.getElementById('accent-theme')).toBeNull();
  });

  it('merkt sich den Akzent und setzt ihn vor dem Rendern wieder', () => {
    rememberAccent('#15803d', '#4ade80');
    expect(readRememberedAccent()).toEqual({ accentColor: '#15803d', accentOnDark: '#4ade80' });
    applyRememberedAccent();
    expect(document.getElementById('accent-theme')!.textContent).toContain('#15803d');
    rememberAccent(DEFAULT_ACCENT, null);
    expect(readRememberedAccent().accentColor).toBe(DEFAULT_ACCENT);
  });

  it('formatiert den Kontrast mit Komma und rundet nie auf', () => {
    expect(formatRatio(5.934)).toBe('5,93');
    expect(formatRatio(4.4999)).toBe('4,49');
  });
});
