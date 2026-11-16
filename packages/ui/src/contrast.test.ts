import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Die Kontrast-Suite (`scripts/contrast-check.mjs`) als Test: Farbpaare in Hell
 * UND Dunkel, dazu der strengere Maßstab für kleinen Sekundärtext (13-14 px,
 * `--farbe-text-leise`, mindestens 7:1). Ein Token, das darunter rutscht, lässt
 * diesen Test scheitern, nicht erst die CI-Stufe nebenan.
 */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'contrast-check.mjs');

function run(...args: string[]): string {
  return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('Kontrast der Farbtoken', () => {
  it('besteht für alle Paare in beiden Modi', () => {
    expect(run()).toContain('Kontrast-Prüfung bestanden');
  });

  it('prüft Sekundärtext als kleinen Text (>= 7:1) auf allen Flächen, Hell und Dunkel', () => {
    const table = run('--table');
    const rows = table
      .split('\n')
      .filter((l) => l.includes('`--farbe-text-leise`') && l.includes('Text klein'));
    // vier Flächen x zwei Modi
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      const ratio = Number(/\| ([\d.]+):1 \|/.exec(row)?.[1]);
      expect(ratio).toBeGreaterThanOrEqual(7);
    }
  });
});
