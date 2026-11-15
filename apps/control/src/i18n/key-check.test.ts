/**
 * Schlüsselprüfung: Jeder `t('…')`-Aufruf im Frontend-Code braucht einen
 * Eintrag im Wörterbuch. (Vitest-Datei `.test.ts`, weil `.spec.ts` unter Jest
 * läuft; siehe docs/i18n.md.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dictionaries } from './locales';

const SRC = join(__dirname, '..');
const CALL = /(?<![\w.])t\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('Schlüsselprüfung', () => {
  it('jeder t()-Schlüssel im Code existiert im Wörterbuch', () => {
    const dict = dictionaries.de;
    const missing: string[] = [];
    for (const file of files(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(CALL)) {
        const key = m[2];
        const known = key in dict || `${key}_one` in dict || `${key}_other` in dict;
        if (!known) missing.push(`${file.replace(SRC, 'src')}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
