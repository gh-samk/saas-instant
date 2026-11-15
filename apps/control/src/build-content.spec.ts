import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * WAS DARF INS AUSLIEFERUNGSARTEFAKT? ([K3])
 *
 * `nest build` übersetzte bis hierher ALLES unter `src` — auch die 38
 * Spec-Dateien und die drei Module unter `src/test-support`. Darunter
 * `organisation-aufbau.ts` mit `raeumeAuf(praefix)`: löscht per `startsWith`
 * erst das Audit-Log, dann alle Notizen, dann alle Organisationen. Mit dem
 * leeren Präfix trifft es den ganzen Bestand, ohne Schranke und ohne
 * Rückfrage. Damit lag ein Massenlöschpfad im Produktionsimage, und „kein
 * Löschpfad" (R1) samt Unversehrtheit des Nachweises (R6) war dort eine
 * Verabredung statt einer Eigenschaft.
 *
 * Der Ausschluss steht in `tsconfig.json`. Dieser Test hält ihn fest — und
 * zwar an der Quelle: `tsc --listFilesOnly` nennt genau die Dateien, die der
 * Übersetzer ins Programm nimmt. Er braucht kein vorher gebautes `dist/` und
 * kann deshalb nicht dadurch grün werden, dass gerade niemand gebaut hat.
 *
 * Zusätzlich wird ein VORHANDENES `dist/` geprüft: ein von Hand
 * zusammengestelltes oder veraltetes Artefakt fällt sonst durch beide Netze.
 */

jest.setTimeout(120_000);

const PACKAGE_ROOT = join(__dirname, '..');

/** Dateien, die der Übersetzer für das Backend-Artefakt einliest. */
function programFiles(): string[] {
  const output = execFileSync(
    join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc'),
    ['-p', 'tsconfig.json', '--listFilesOnly'],
    { cwd: PACKAGE_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('/apps/control/src/'))
    .map((line) => line.slice(line.indexOf('/apps/control/src/') + 18));
}

/** Alle .js-Module eines gebauten `dist/`. */
function distModule(): string[] {
  const root = join(PACKAGE_ROOT, 'dist');
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const scan = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scan(join(folder, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.js')) {
        found.push(`${prefix}${entry.name}`);
      }
    }
  };
  scan(root, '');
  return found;
}

/**
 * Was im Artefakt NICHTS zu suchen hat, mit dem Grund daneben. Die Liste darf
 * nur wachsen, wenn jemand den Grund geprüft hat.
 */
const FORBIDDEN: { muster: RegExp; reason: string }[] = [
  {
    muster: /^test-support\//,
    reason:
      'Prüfhilfen. `organisation-aufbau` löscht Organisationen, Notizen und ' +
      'Audit-Zeilen per Präfix — ein Massenlöschpfad ohne Schranke ([K3]).',
  },
  {
    muster: /\.spec\.[jt]s$/,
    reason: 'Prüfcode gehört nicht in das ausgelieferte Artefakt.',
  },
  {
    muster: /\.test\.[jt]s$/,
    reason: 'Prüfcode gehört nicht in das ausgelieferte Artefakt.',
  },
  {
    muster: /^(components|context|lib|pages|utils)\//,
    reason: 'Frontend. Wird von Vite gebaut, nicht von nest build.',
  },
  {
    muster: /\.tsx$/,
    reason: 'Frontend. Wird von Vite gebaut, nicht von nest build.',
  },
];

function violations(files: string[]): string[] {
  return files.filter((file) =>
    FORBIDDEN.some((rule) => rule.muster.test(file)),
  );
}

describe('Auslieferungsartefakt des Backends', () => {
  it('findet überhaupt Module (sonst prüft der Test nichts)', () => {
    expect(programFiles().length).toBeGreaterThanOrEqual(50);
  });

  it('nimmt weder Prüfcode noch Prüfhilfen ins Programm ([K3])', () => {
    expect(violations(programFiles())).toEqual([]);
  });

  it('nimmt insbesondere `test-support/organisation-aufbau` nicht mit', () => {
    // Namentlich, damit beim nächsten Umbenennen auffällt, worum es ging.
    const files = programFiles();
    expect(files).not.toContain('test-support/company-provisioning.ts');
    expect(files.some((d) => d.startsWith('test-support/'))).toBe(false);
  });

  it('behält main.ts und die CLI im Programm (der Ausschluss ging nicht zu weit)', () => {
    const files = programFiles();
    expect(files).toContain('main.ts');
    expect(files).toContain('cli/emergency.ts');
    expect(files).toContain('companies/company.controller.ts');
  });

  it('hat auch in einem bereits gebauten dist/ nichts Verbotenes', () => {
    const module = distModule();
    if (module.length === 0) {
      // Kein Build vorhanden — die Aussage oben trägt trotzdem.
      return;
    }
    expect(violations(module)).toEqual([]);
    expect(module).toContain('main.js');
  });
});
