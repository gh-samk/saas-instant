#!/usr/bin/env node
/**
 * Prüft die Farbpaare aus packages/ui/src/tokens.css auf WCAG-AA-Kontrast,
 * für Hell UND Dunkel. Text braucht >= 4.5:1, UI-Elemente >= 3:1.
 * Prüft außerdem, dass die beiden Dunkel-Blöcke (Medienabfrage + data-theme)
 * identische Werte tragen.
 *
 * Aufruf:  node scripts/contrast-check.mjs [--table]
 * Exit 1 bei jedem Verstoß. --table gibt zusätzlich Markdown-Tabellen aus.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'ui', 'src', 'tokens.css');
const css = readFileSync(CSS, 'utf8');

/** Liefert den Inhalt des Blocks, dessen "{" bei `open` steht. */
function block(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error('Unausgeglichene Klammern in tokens.css');
}

function declarations(text) {
  const out = {};
  for (const m of text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

function blockAfter(marker) {
  const at = css.indexOf(marker);
  if (at < 0) throw new Error(`Nicht gefunden: ${marker}`);
  return block(css, css.indexOf('{', at));
}

const light = declarations(blockAfter(':root {'));
const darkMedia = declarations(blockAfter(':root:not([data-theme="light"])'));
const darkAttr = declarations(blockAfter(':root[data-theme="dark"]'));

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['farbe-flaeche', 'farbe-flaeche-2', 'farbe-flaeche-3', 'farbe-flaeche-4'];
/** [Vordergrund, Hintergründe[], Art] — Art: 'text' (4.5) oder 'ui' (3). */
const PAIRS = [
  ['farbe-text', SURFACES, 'text'],
  ['farbe-text-leise', SURFACES, 'text'],
  ['farbe-text-still', SURFACES, 'text'],
  ['farbe-read', SURFACES, 'text'],
  ['farbe-primaer', ['farbe-flaeche', 'farbe-flaeche-2', 'farbe-flaeche-4'], 'text'],
  ['farbe-primaer-text', ['farbe-primaer', 'farbe-primaer-hover'], 'text'],
  ['farbe-primaer-softtext', ['farbe-primaer-soft', 'farbe-primaer-softer', 'farbe-flaeche'], 'text'],
  ['farbe-primaer-softtext-hover', ['farbe-primaer-soft', 'farbe-primaer-softer', 'farbe-flaeche'], 'text'],
  ['farbe-gefahr', ['farbe-flaeche', 'farbe-flaeche-2'], 'text'],
  ['farbe-gefahr-text', ['farbe-gefahr'], 'text'],
  ['farbe-gefahr-bg-text', ['farbe-gefahr-bg', 'farbe-flaeche'], 'text'],
  ['farbe-erfolg-text', ['farbe-erfolg-bg', 'farbe-flaeche'], 'text'],
  ['farbe-warnung-text', ['farbe-warnung-bg', 'farbe-flaeche'], 'text'],
  ['e-vorschlag-text', ['e-vorschlag-bg', 'farbe-flaeche'], 'text'],
  ['e-bedenken-text', ['e-bedenken-bg', 'farbe-flaeche'], 'text'],
  ['e-einwand-text', ['e-einwand-bg', 'farbe-flaeche'], 'text'],
  ['e-beschluss-text', ['e-beschluss-bg', 'farbe-flaeche'], 'text'],
  ['farbe-eingeladen-text', ['farbe-flaeche', 'farbe-flaeche-2'], 'text'],
  // UI-Elemente (Rahmen, Punkte, Fokusring): >= 3:1
  ['farbe-fokus', ['farbe-flaeche', 'farbe-flaeche-2', 'farbe-flaeche-3'], 'ui'],
  ['farbe-rahmen-ui', ['farbe-flaeche', 'farbe-flaeche-2'], 'ui'],
  ['farbe-inaktiv', ['farbe-flaeche', 'farbe-flaeche-2'], 'ui'],
  ['farbe-eingeladen', ['farbe-flaeche', 'farbe-flaeche-2'], 'ui'],
  ['farbe-primaer', ['farbe-flaeche', 'farbe-flaeche-2'], 'ui'],
  ['farbe-gefahr-rahmen', ['farbe-gefahr-bg', 'farbe-flaeche'], 'ui'],
  ['farbe-erfolg-rahmen', ['farbe-erfolg-bg', 'farbe-flaeche'], 'ui'],
  ['farbe-warnung-rahmen', ['farbe-warnung-bg', 'farbe-flaeche'], 'ui'],
  ['e-vorschlag-rahmen', ['e-vorschlag-bg', 'farbe-flaeche'], 'ui'],
  ['e-bedenken-rahmen', ['e-bedenken-bg', 'farbe-flaeche'], 'ui'],
  ['e-einwand-rahmen', ['e-einwand-bg', 'farbe-flaeche'], 'ui'],
  ['e-beschluss-rahmen', ['e-beschluss-bg', 'farbe-flaeche'], 'ui'],
];

let failures = 0;
const rows = { Hell: [], Dunkel: [] };

// Die beiden Dunkel-Blöcke müssen identisch sein.
for (const k of new Set([...Object.keys(darkMedia), ...Object.keys(darkAttr)])) {
  if (darkMedia[k] !== darkAttr[k]) {
    console.error(`FEHLER: --${k} weicht zwischen Medienabfrage (${darkMedia[k]}) und data-theme (${darkAttr[k]}) ab`);
    failures++;
  }
}

for (const [mode, tokens] of [['Hell', light], ['Dunkel', { ...light, ...darkAttr }]]) {
  for (const [fg, bgs, kind] of PAIRS) {
    for (const bg of bgs) {
      if (!tokens[fg] || !tokens[bg]) {
        console.error(`FEHLER: Token fehlt (${fg} oder ${bg}) im Modus ${mode}`);
        failures++;
        continue;
      }
      const r = ratio(tokens[fg], tokens[bg]);
      const min = kind === 'text' ? 4.5 : 3;
      const ok = r >= min;
      if (!ok) {
        console.error(`FEHLER [${mode}] --${fg} ${tokens[fg]} auf --${bg} ${tokens[bg]}: ${r.toFixed(2)}:1 (< ${min})`);
        failures++;
      }
      rows[mode].push(
        `| \`--${fg}\` ${tokens[fg]} | \`--${bg}\` ${tokens[bg]} | ${kind === 'text' ? 'Text' : 'UI'} | ${r.toFixed(2)}:1 | ${ok ? 'ok' : 'FEHLER'} |`,
      );
    }
  }
}

if (process.argv.includes('--table')) {
  for (const mode of ['Hell', 'Dunkel']) {
    console.log(`\n### ${mode}\n\n| Vordergrund | Hintergrund | Art | Kontrast | AA |\n|---|---|---|---|---|`);
    console.log(rows[mode].join('\n'));
  }
}

const total = rows.Hell.length + rows.Dunkel.length;
if (failures > 0) {
  console.error(`\n${failures} Verstöße bei ${total} Paaren.`);
  process.exit(1);
}
console.log(`Kontrast-Prüfung bestanden: ${total} Paare (Hell + Dunkel), Dunkel-Blöcke identisch.`);
