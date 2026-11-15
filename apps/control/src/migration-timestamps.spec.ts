import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Zwei Migrationen mit demselben Zeitstempel.
 *
 * WARUM DAS EINE PRÜFUNG WERT IST. Prisma ordnet Migrationen nach dem
 * Verzeichnisnamen. Bei gleichem Zeitstempel entscheidet der Rest des Namens —
 * also der Zufall, welches Wort alphabetisch vorn steht. Solange zwei
 * Migrationen voneinander unabhängig sind, ist das folgenlos. Hängt die eine
 * an der anderen, ist es ein Fehler, der sich erst beim nächsten frischen
 * Aufsetzen zeigt: In einer bestehenden Datenbank sind beide längst
 * angewandt, dort fällt nie etwas auf.
 *
 * STAND NACH DER BASELINE. Die frühere Migrationshistorie wurde durch EINE
 * Baseline-Migration ersetzt (kein Datenbestand zu retten, Tests laufen auf
 * frischer DB). Das historische Paar mit gleichem Zeitstempel existiert damit
 * nicht mehr; ab jetzt ist JEDER doppelte Zeitstempel ein Fehler.
 */

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

describe('Migrationen', () => {
  const directories = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('tragen keine doppelten Zeitstempel', () => {
    const byTimestamp = new Map<string, string[]>();
    for (const name of directories) {
      const timestamp = name.slice(0, 14);
      byTimestamp.set(timestamp, [
        ...(byTimestamp.get(timestamp) ?? []),
        name,
      ]);
    }

    const duplicates = [...byTimestamp.values()]
      .filter((names) => names.length > 1)
      .map((names) => names.sort());

    expect(duplicates).toEqual([]);
  });

  it('heissen alle nach dem Muster <14 Ziffern>_<beschreibung>', () => {
    const deviating = directories.filter(
      (name) => !/^\d{14}_[a-z0-9_]+$/.test(name),
    );
    expect(deviating).toEqual([]);
  });
});
