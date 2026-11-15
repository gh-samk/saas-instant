import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { CoolifyClient } from './coolify.types';
import { CoolifyHttpClient } from './coolify.client';
import { CoolifyProvisioner } from './coolify.provisioner';
import { CoolifyNotConfiguredClient } from './coolify-not-configured.client';

/**
 * R1 ALS ABWESENHEIT — NACHGEPRÜFT, NICHT VERSPROCHEN.
 *
 * Harte Regel R1, wörtlich: „Kein Löschen von Deployments oder Datenbanken aus
 * dem CRM heraus — weder im UI noch in der API noch in einem Skript."
 *
 * Eine solche Zusage ist nur so viel wert wie ihre Prüfbarkeit. Dieser Test
 * geht deshalb über den QUELLBAUM und nicht über eine Erinnerung:
 *
 * 1. Die Schnittstelle `CoolifyClient` hat eine ABSCHLIESSENDE Methodenliste.
 *    Was dort nicht steht, lässt sich nirgends aufrufen.
 * 2. In keiner Datei, die Coolify anspricht, steht ein HTTP-DELETE oder ein
 *    Aufruf, dessen Name nach Löschen klingt.
 * 3. In keiner Datei des Backends steht ein Löschaufruf gegen die Modelle,
 *    die den Nachweis tragen (Instanz, Kennzahl, Sicherung, AuditLog) —
 *    R4 („nichts wird automatisch gelöscht") und R6.
 *
 * Der Test hat in Etappe 2 eine reale Entsprechung: Dort lag ein
 * Massenlöschpfad im Produktionsimage, weil Prüfcode mitgebaut wurde ([K3]).
 * Die Lehre ist dieselbe — die Eigenschaft muss geprüft werden, nicht die
 * Absicht.
 */

const SRC = join(__dirname, '..');

/** Alle .ts-Dateien unter src, ohne Prüfcode und ohne Frontend. */
function sourceFiles(): { path: string; content: string }[] {
  const found: { path: string; content: string }[] = [];
  const scan = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const kind = join(folder, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        // NUR das Frontend bleibt aussen vor (Vite baut es, nicht nest).
        //
        // `test-support` wird AUSDRÜCKLICH MITGEPRÜFT ([W5]). Es war vorher
        // ausgenommen — und genau dort steht die einzige Datei des ganzen
        // Baums mit `deleteMany` auf Kennzahl, Sicherung, Instanz und
        // AuditLog. Die Absicherung hing damit an einer Zeile in
        // `tsconfig.json`: Wer sie ändert, holt einen Massenlöschpfad ins
        // Artefakt zurück, ohne dass ein Test etwas sagt. Jetzt braucht diese
        // Datei eine benannte Ausnahme, und die zweite Absicherung
        // (`build-content.spec.ts`) hält weiterhin fest, dass sie nicht
        // mitgebaut wird.
        const excluded = ['components', 'context', 'lib', 'pages', 'utils'];
        if (excluded.includes(entry.name)) continue;
        scan(kind, `${name}/`);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('.test.ts')
      ) {
        found.push({ path: name, content: readFileSync(kind, 'utf8') });
      }
    }
  };
  scan(SRC, '');
  return found;
}

/** Nur die Dateien, die tatsächlich mit Coolify oder Instanzen zu tun haben. */
function instanceFiles(): { path: string; content: string }[] {
  return sourceFiles().filter(
    (d) =>
      d.path.startsWith('coolify/') ||
      d.path.startsWith('instances/') ||
      d.path.startsWith('provisioning/'),
  );
}

interface Location {
  path: string;
  number: number;
  row: string;
}

/**
 * Alle CODE-Zeilen der Instanz-/Coolify-Dateien — ohne Kommentarzeilen.
 *
 * Die Kommentare in diesen Dateien BENENNEN das Verbotene ausdrücklich („kein
 * DELETE", „kein Löschen"), weil dort die Begründung steht. Ein Test, der
 * daran anschlägt, zwänge dazu, die Begründung zu entfernen — genau das
 * Gegenteil dessen, was er erreichen soll.
 */
function codeLines(): Location[] {
  return instanceFiles().flatMap((d) =>
    d.content
      .split('\n')
      .map((row, number) => ({ path: d.path, number: number + 1, row }))
      .filter(({ row }) => {
        const trims = row.trim();
        return !trims.startsWith('*') && !trims.startsWith('//') && !trims.startsWith('/*');
      }),
  );
}

function asLocation(t: Location): string {
  return `${t.path}:${t.number} ${t.row.trim()}`;
}

/**
 * Die einzigen Methoden, die `CoolifyClient` haben darf.
 *
 * Diese Liste zu erweitern ist eine bewusste Handlung. Genau das ist der
 * Zweck: Wer eine Löschmethode ergänzen wollte, müsste sie hier eintragen.
 */
const ALLOWED_METHODS = [
  'version',
  'applications',
  'getApplication',
  'createApplication',
  'setEnvironmentVariable',
  'setDomain',
  'startDeploy',
  'getDeployment',
  'stopApplication',
].sort();

function methodsFrom(klass: new (...args: never[]) => unknown): string[] {
  return Object.getOwnPropertyNames(klass.prototype)
    .filter((name) => name !== 'constructor' && !name.startsWith('call'))
    .sort();
}

describe('R1 — kein Löschpfad gegen Coolify', () => {
  it('findet überhaupt Dateien (sonst prüft der Test nichts)', () => {
    expect(instanceFiles().length).toBeGreaterThanOrEqual(6);
  });

  it('durchsucht auch die Prüfhilfen ([W5])', () => {
    // Sie waren vorher ausgenommen — und enthalten den einzigen
    // Massenlöschpfad des Baums.
    const paths = sourceFiles().map((d) => d.path);
    expect(paths).toContain('test-support/company-provisioning.ts');
    expect(paths).toContain('test-support/coolify-mock.ts');
  });

  it('lässt die Schnittstelle nur die neun aufgezählten Methoden zu', () => {
    const mock: CoolifyClient = new CoolifyNotConfiguredClient();
    // Der Typ erzwingt Vollständigkeit, die Liste erzwingt Sparsamkeit.
    expect(Object.keys(mock).length).toBe(0);
    expect(methodsFrom(CoolifyNotConfiguredClient)).toEqual(ALLOWED_METHODS);
    expect(methodsFrom(CoolifyHttpClient)).toEqual(ALLOWED_METHODS);
  });

  it('lässt die Schnittstelle Provisioner nur create, status und stop zu', () => {
    // Die abschliessende Liste der Bereitstellungs-Schnittstelle (R1 als
    // Eigenschaft): anlegen, Auskunft, stoppen — nichts, was entfernt.
    expect(methodsFrom(CoolifyProvisioner)).toEqual(['create', 'status', 'stop']);
    const source = sourceFiles().find((d) => d.path === 'provisioning/provisioner.ts');
    expect(source).toBeDefined();
    const code = (source as { content: string }).content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((row) => !row.trim().startsWith('//'))
      .join('\n');
    const body = code.slice(code.indexOf('export interface Provisioner'), code.indexOf('export const PROVISIONER'));
    const declared = [...body.matchAll(/^\s{2}([a-z][A-Za-z]*)(?:\(|<)/gm)].map((m) => m[1]);
    expect([...new Set(declared)].sort()).toEqual(['create', 'status', 'stop']);
  });

  it('schickt an keiner Stelle ein HTTP-DELETE hinaus', () => {
    // Geprüft wird der CODE, nicht die Prosa: Kommentare dürfen das Wort
    // benutzen — sie sollen es sogar, weil dort die Begründung steht.
    const hits = codeLines().filter(({ row }) =>
      /(['"`])DELETE\1|method:\s*['"`]delete['"`]/i.test(row),
    );
    expect(hits.map(asLocation)).toEqual([]);
  });

  it('kennt keinen Aufruf NACH AUSSEN, dessen Name nach Löschen klingt', () => {
    // Wortgrenze und Aufrufklammer, damit Prosa in Kommentaren („kein
    // Löschen") nicht fälschlich anschlägt — geprüft wird der CODE.
    //
    // Zugriffe auf die EIGENE Datenbank (`this.prisma.…`) sind hier ausgenommen
    // und werden eine Ebene tiefer geprüft: Der Block „R4/R6" unten führt dafür
    // eine benannte Ausnahmeliste mit Begründung. Diese Aussage hier gilt dem
    // Weg NACH AUSSEN — nichts, was das CRM verlässt, darf löschen.
    const suspicion =
      /\b(delete|destroy|remove|purge|wipe|loesche|entferne|zerstoere)[A-Za-z]*\s*\(/i;
    const hits = codeLines()
      .filter(({ row }) => !row.includes('this.prisma.'))
      .filter(({ row }) => !row.includes('kontext.prisma.'))
      .filter(({ row }) => suspicion.test(row));
    expect(hits.map(asLocation)).toEqual([]);
  });

  it('fällt um, sobald ein Löschaufruf gegen Coolify eingebaut würde', () => {
    const suspicion =
      /\b(delete|destroy|remove|purge|wipe|loesche|entferne|zerstoere)[A-Za-z]*\s*\(/i;
    // Die Ausnahme gilt NUR für `this.prisma.` — ein Coolify-Aufruf schlägt an.
    const coolifyRow = 'await this.coolify.loescheAnwendung(uuid);';
    expect(coolifyRow.includes('this.prisma.')).toBe(false);
    expect(suspicion.test(coolifyRow)).toBe(true);
  });

  it('fällt um, sobald ein DELETE eingebaut würde (Gegenprobe)', () => {
    const pattern = /(['"`])DELETE\1|method:\s*['"`]delete['"`]/i;
    expect(pattern.test("await this.call('DELETE', `/applications/${uuid}`);")).toBe(true);
    expect(pattern.test("await this.call('GET', `/applications/${uuid}`);")).toBe(false);
    // Prosa in einem Kommentar schlägt NICHT an — sonst müsste die Begründung
    // aus dem Code verschwinden, damit der Test grün wird.
    expect(
      codeLines().some(({ row }) => row.includes('Es gibt hier kein')),
    ).toBe(false);
  });

  it('fällt um, sobald ein Löschaufruf eingebaut würde (Gegenprobe)', () => {
    const suspicion =
      /\b(delete|destroy|remove|purge|wipe|loesche|entferne|zerstoere)[A-Za-z]*\s*\(/i;
    expect(suspicion.test('await client.loescheAnwendung(uuid);')).toBe(true);
    expect(suspicion.test('await client.deleteApplication(uuid);')).toBe(true);
  });
});

describe('R4/R6 — nichts wird automatisch gelöscht', () => {
  /** Modelle, deren Zeilen der Nachweis sind. */
  const PROTECTED = ['instance', 'metric', 'backup', 'auditLog', 'reconciliationRun'];

  /**
   * DIE EINZIGE ERLAUBTE AUSNAHME — benannt, begründet, eng begrenzt ([W4]).
   *
   * `InstanceService.discardCreation` gibt eine CRM-Zeile über einen Vorgang
   * auf, der NIE STATTGEFUNDEN hat: Status `wird_erstellt`, in Coolify nichts
   * entstanden, keine Kennzahlen, keine Sicherungen. Ohne diesen Weg ist eine
   * gescheiterte Erstellung eine Sackgasse, denn `Instanz.companyId` ist
   * unique. Audit-Eintrag und Systemnotiz stehen VOR dem Verwerfen und
   * überleben es.
   *
   * Die Liste ist eine Datei-Liste, kein Freibrief: Taucht `instanz.delete`
   * irgendwo sonst auf, fällt der Test.
   */
  const DELETE_EXCEPTIONS: Record<string, string> = {
    'instances/instance.service.ts':
      'discardCreation — nur bei `wird_erstellt` OHNE Coolify-Anwendung, ' +
      'ohne Kennzahlen und ohne Sicherungen. „Ohne Coolify-Anwendung" heisst ' +
      'seit dem 11.09.2026: nie angelegt ODER dort nachweislich von Hand ' +
      'entfernt (Coolify antwortet 404) — ein Ausfall zählt nicht. Coolify ' +
      'wird dabei nur GELESEN. Der Nachweis steht vorher im Audit-Log und in ' +
      'einer Systemnotiz ([W4]).',
    'test-support/company-provisioning.ts':
      'PRÜFHILFE. `cleanUp(praefix)` räumt die Zeilen einer Integrationssuite ' +
      'weg und ist damit der einzige Massenlöschpfad im Baum. Sie ist in ' +
      '`tsconfig.json` vom Bauen ausgeschlossen, und `build-inhalt.spec.ts` ' +
      'prüft das an der Quelle nach — sie liegt NICHT im Auslieferungsartefakt ' +
      '([K3]). Sie steht hier trotzdem namentlich, damit die Absicherung nicht ' +
      'an einer stillschweigenden Ausnahme dieses Tests hängt ([W5]).',
  };

  it('hat im Backend keinen unbegründeten Löschaufruf gegen die Nachweis-Modelle', () => {
    const pattern = new RegExp(
      `\\b(?:${PROTECTED.join('|')})\\s*\\.\\s*(?:delete|deleteMany)\\s*\\(`,
      'i',
    );
    const hits = sourceFiles()
      .filter((d) => pattern.test(d.content))
      .map((d) => d.path)
      .filter((path) => DELETE_EXCEPTIONS[path] === undefined);
    expect(hits).toEqual([]);
  });

  it('verlangt für jede Ausnahme eine Begründung UND die Datei dazu', () => {
    const present = new Set(sourceFiles().map((d) => d.path));
    for (const [path, reason] of Object.entries(DELETE_EXCEPTIONS)) {
      expect(present.has(path)).toBe(true);
      expect(reason.length).toBeGreaterThan(60);
    }
  });

  it('lässt die Ausnahme nur mit ihren vier Bedingungen zu', () => {
    const source = sourceFiles().find(
      (d) => d.path === 'instances/instance.service.ts',
    );
    expect(source).toBeDefined();
    const text = (source as { content: string }).content;
    // Der Löschaufruf steht BEDINGT da — nicht nackt.
    expect(text).toContain("status: 'provisioning'");
    expect(text).toContain('_count.metrics > 0');
    expect(text).toContain('_count.backups > 0');

    // =================================================================
    // BEDINGUNG 2 — „in Coolify existiert nichts" — in ihrer neuen Form
    // =================================================================
    //
    // Hier stand `toContain('coolifyApplicationId: null')`. Das war die alte
    // Form: nur eine Zeile ohne Kennung durfte weg. Sie führte am 11.09.2026
    // in eine Sackgasse — nach einem halben Aufbau verlangte die Meldung, die
    // Anwendung in Coolify von Hand zu löschen, und danach ging es trotzdem
    // nicht weiter, weil die Kennung in der Zeile stehen blieb.
    //
    // Die Bedingung selbst ist NICHT gelockert, nur genauer gefasst. Drei
    // Zusicherungen halten sie fest:
    //
    // 1. Gelöscht wird mit GENAU der Kennung, die eben geprüft wurde — nicht
    //    pauschal. Hat der Aufbau inzwischen eine andere eingetragen, trifft
    //    die Bedingung nicht.
    expect(text).toContain('coolifyApplicationId: instance.coolifyApplicationId');
    // 2. Ob die Anwendung noch da ist, wird aus Coolify GELESEN, nicht
    //    angenommen.
    expect(text).toContain('status(instance.coolifyApplicationId)');
    // 3. Scheitert das Lesen, wird VERWEIGERT — ein Ausfall ist kein „weg"
    //    ([K2]). Sonst verschwände die Zeile neben einer laufenden Anwendung.
    expect(text).toMatch(
      /status\(instance\.coolifyApplicationId\)[\s\S]{0,120}\}\s*catch\s*\{\s*throw new DiscardNotPossibleError/,
    );
  });

  it('fällt um, sobald ein solcher Aufruf eingebaut würde (Gegenprobe)', () => {
    const pattern = new RegExp(
      `\\b(?:${PROTECTED.join('|')})\\s*\\.\\s*(?:delete|deleteMany)\\s*\\(`,
      'i',
    );
    expect(pattern.test('await this.prisma.instance.deleteMany({ where: {} });')).toBe(
      true,
    );
    expect(pattern.test('await this.prisma.instance.findMany({});')).toBe(false);
  });
});

describe('Kein Wiederherstellungsknopf (E3-15)', () => {
  it('kennt keinen Endpunkt und keinen Client-Aufruf zum Zurückspielen', () => {
    // Nur die Instanz-/Coolify-Dateien: „Wiederherstellungscode" ist im
    // Zugangsbereich ein ganz anderer, legitimer Begriff.
    const pattern = /\b(wiederherstell|restore|einspiel|zurueckspiel)[A-Za-z]*\s*\(/i;
    const hits = codeLines().filter(({ row }) => pattern.test(row));
    expect(hits.map(asLocation)).toEqual([]);
  });
});
