import { contrastRatio, validateAccentColor } from '@saas-instant/shared';

/**
 * Akzentfarbe der Oberfläche.
 *
 * Die Verwaltung kennt EINEN Akzent (`--farbe-primaer`) samt abgeleiteten
 * Varianten (Hover, Fokus, weiche Flächen). Die Standardwerte stehen in
 * `packages/ui/src/tokens.css`. Eine konfigurierte Farbe überschreibt sie
 * über ein Stylesheet im `<head>`, das dieselben Selektoren mit etwas mehr
 * Gewicht benutzt — so bleiben Hell, Dunkel und der manuelle Wechsel
 * (`data-theme`) unverändert in Kraft.
 *
 * Abgeleitet wird so, dass die Paare weiter die Prüfung von
 * `scripts/contrast-check.mjs` bestehen (Text >= 4,5:1).
 */

/** Standardakzent; solange er gilt, wird nichts überschrieben. */
export const DEFAULT_ACCENT = '#0369a1';

/** Feste Vorschauflächen für Logo und Akzent (unabhängig vom aktuellen Modus). */
export const PREVIEW_LIGHT_BACKGROUND = '#ffffff';
export const PREVIEW_DARK_BACKGROUND = '#0f1318';

const STYLE_ID = 'accent-theme';
const STORAGE_KEY = 'saas-instant.accent';
const WHITE = '#ffffff';
const BLACK = '#000000';
/** Dunkle Oberflächen aus tokens.css, auf denen Text in Akzentfarbe stehen muss. */
const DARK_SURFACES = ['#1e293b', '#0f172a', '#172033'];
const DARK_TEXT_ON_ACCENT = '#0f172a';

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** Mischt `a` mit `b`; `amount` ist der Anteil von `b` (0 bis 1). */
export function mixColors(a: string, b: string, amount: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return (
    '#' +
    ca
      .map((c, i) =>
        Math.round(c + (cb[i]! - c) * amount)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** Mischt `color` Schritt für Schritt mit `toward`, bis alle Hintergründe `min` erreichen. */
function until(color: string, toward: string, backgrounds: string[], min = 4.5): string {
  let result = color;
  for (let i = 0; i <= 20; i++) {
    result = mixColors(color, toward, i * 0.05);
    if (backgrounds.every((bg) => contrastRatio(result, bg) >= min)) return result;
  }
  return result;
}

export type AccentTokens = Record<string, string>;

/** Abgeleitete Token-Werte für den Hellmodus; `accent` muss >= 4,5:1 auf Weiß haben. */
export function lightAccentTokens(accent: string): AccentTokens {
  const soft = mixColors(accent, WHITE, 0.88);
  const softer = mixColors(accent, WHITE, 0.94);
  const softText = until(accent, BLACK, [soft, softer, WHITE]);
  return {
    '--farbe-primaer': accent,
    '--farbe-primaer-hover': mixColors(accent, BLACK, 0.2),
    '--farbe-primaer-text': WHITE,
    '--farbe-primaer-soft': soft,
    '--farbe-primaer-softtext': softText,
    '--farbe-primaer-softer': softer,
    '--farbe-primaer-softrahmen': mixColors(accent, WHITE, 0.7),
    '--farbe-primaer-softtext-hover': mixColors(softText, BLACK, 0.25),
    '--farbe-fokus': accent,
  };
}

/** Abgeleitete Token-Werte für den Dunkelmodus aus der aufgehellten Akzentfarbe. */
export function darkAccentTokens(accentOnDark: string): AccentTokens {
  const accent = until(accentOnDark, WHITE, DARK_SURFACES);
  const base = DARK_SURFACES[1]!;
  const soft = mixColors(accent, base, 0.72);
  const softer = mixColors(accent, base, 0.82);
  const softText = until(mixColors(accent, WHITE, 0.4), WHITE, [soft, softer, ...DARK_SURFACES]);
  return {
    '--farbe-primaer': accent,
    '--farbe-primaer-hover': mixColors(accent, WHITE, 0.25),
    '--farbe-primaer-text': DARK_TEXT_ON_ACCENT,
    '--farbe-primaer-soft': soft,
    '--farbe-primaer-softtext': softText,
    '--farbe-primaer-softer': softer,
    '--farbe-primaer-softrahmen': mixColors(accent, base, 0.6),
    '--farbe-primaer-softtext-hover': mixColors(softText, WHITE, 0.4),
    '--farbe-fokus': accent,
  };
}

function declarations(tokens: AccentTokens): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
}

/**
 * Das Stylesheet für eine Akzentfarbe, oder `null` bei Standard bzw. ungültiger
 * Eingabe (dann gelten die Werte aus tokens.css). Ohne `accentOnDark` wird der
 * Dunkelwert aus der Farbe berechnet.
 */
export function buildAccentCss(accent: unknown, accentOnDark?: unknown): string | null {
  if (!isHexColor(accent)) return null;
  const color = accent.toLowerCase();
  if (color === DEFAULT_ACCENT) return null;
  const check = validateAccentColor(color);
  if (!check.valid) return null;
  const onDark = isHexColor(accentOnDark)
    ? accentOnDark.toLowerCase()
    : (check.accentOnDark ?? color);
  const light = declarations(lightAccentTokens(color));
  const dark = declarations(darkAccentTokens(onDark));
  return [
    `html:root { ${light} }`,
    `@media (prefers-color-scheme: dark) { html:root:not([data-theme="light"]) { ${dark} } }`,
    `html:root[data-theme="dark"] { ${dark} }`,
  ].join('\n');
}

/** Setzt (oder entfernt) das Akzent-Stylesheet. Gibt zurück, ob ein Akzent gilt. */
export function applyAccent(accent: unknown, accentOnDark?: unknown): boolean {
  if (typeof document === 'undefined') return false;
  const css = buildAccentCss(accent, accentOnDark);
  let element = document.getElementById(STYLE_ID);
  if (css === null) {
    element?.remove();
    return false;
  }
  if (!element) {
    element = document.createElement('style');
    element.id = STYLE_ID;
    document.head.appendChild(element);
  }
  element.textContent = css;
  return true;
}

export interface RememberedAccent {
  accentColor: string;
  accentOnDark: string | null;
}

export function readRememberedAccent(): RememberedAccent {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { accentColor?: unknown; accentOnDark?: unknown };
      if (isHexColor(o.accentColor)) {
        return {
          accentColor: o.accentColor,
          accentOnDark: isHexColor(o.accentOnDark) ? o.accentOnDark : null,
        };
      }
    }
  } catch {
    // Speicher gesperrt oder beschädigt: Standard.
  }
  return { accentColor: DEFAULT_ACCENT, accentOnDark: null };
}

export function rememberAccent(accentColor: string, accentOnDark: string | null): void {
  try {
    if (accentColor.toLowerCase() === DEFAULT_ACCENT) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ accentColor, accentOnDark }));
  } catch {
    // nur Komfort
  }
}

/** Vor dem ersten Rendern aufrufen: der zuletzt bekannte Akzent gilt sofort, ohne Flackern. */
export function applyRememberedAccent(): void {
  const { accentColor, accentOnDark } = readRememberedAccent();
  applyAccent(accentColor, accentOnDark);
}

/** Kontrastwert als Text, z. B. 5,93 (abgerundet, damit „4,50" nie aus 4,496 wird). */
export function formatRatio(ratio: number): string {
  return (Math.floor(ratio * 100) / 100).toFixed(2).replace('.', ',');
}
