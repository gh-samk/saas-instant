import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * ===========================================================================
 * WELCHER TAG IST HEUTE? DAS ENTSCHEIDET DIE ZEITZONE DES CONTAINERS
 * ===========================================================================
 *
 * Regel 1 der Projektkonventionen kennt nur Tagesdaten, keine Uhrzeiten. Gespeichert
 * wird über `today()` aus `@saas-instant/shared`, und `today()` liest die LOKALE
 * Zeit des Prozesses. Läuft der Prozess in UTC, die Betreiberin aber in
 * Berlin, dann liefert `today()` zwischen 00:00 und 02:00 mitteleuropäischer
 * Zeit den VORTAG.
 *
 * GEMESSEN, nicht vermutet: Der laufende Container meldete vor dieser Änderung
 *
 *   docker exec dev-control-api-1 node -e "console.log(new Date().toString())"
 *   -> Mon Aug 31 2026 10:02:08 GMT+0000 (Coordinated Universal Time)
 *
 * während die Entwicklungsmaschine daneben in Europe/Berlin lief. Die
 * Unit-Tests konnten den Fehler deshalb nie zeigen: sie liefen immer schon in
 * der richtigen Zeitzone.
 *
 * WAS DER FEHLER ANRICHTET, und warum er nicht auffällt: Ein Zahldatum, ein
 * Rechnungsdatum oder eine Notiz, die um 00:30 entsteht, bekommt den falschen
 * Kalendertag. Weil `@db.Date` die Uhrzeit gar nicht mitspeichert, lässt sich
 * hinterher nicht einmal mehr feststellen, dass es der falsche war.
 *
 * WAS DER FEHLER NICHT ANRICHTET, und warum diese Umstellung ungefährlich ist:
 * Fristen rechnen entweder mit absoluten Zeitstempeln (15 Minuten Notfall-Link,
 * 72 Stunden Bestätigungslink, Kontosperre) oder auf Kalendertagen (90 Tage,
 * 7 Monate, 24 Monate — `common/calendar.ts`, `organisation/fristen.ts`).
 * Beides ist von der Zeitzone unberührt; verschoben wird allein die Frage,
 * welcher Kalendertag gerade läuft.
 *
 * DIESER TEST HAT ZWEI TEILE, weil die Regel zwei Hälften hat:
 * 1. dass die Zeitzone überhaupt einen Unterschied macht (sonst prüfte Teil 2
 *    nichts), und
 * 2. dass beide Compose-Dateien sie für `control-api` festlegen.
 */

/** Das gebaute `@saas-instant/shared` — dieselbe Quelle, die die Anwendung lädt. */
const SHARED = join(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'dist');

/**
 * Ein fester Zeitpunkt IM Grenzfenster: 22:30 UTC = 00:30 Berliner Zeit.
 *
 * Als Millisekunden, weil er einem KINDPROZESS übergeben wird (siehe unten).
 */
const IN_WINDOW = Date.parse('2026-08-31T22:30:00Z');

/** Ein Zeitpunkt ausserhalb des Fensters — dort dürfen beide Zonen gleich sein. */
const OUTSIDE = Date.parse('2026-08-31T09:00:00Z');

/**
 * Fragt `today()` in einem FRISCHEN Node-Prozess mit gesetzter Zeitzone.
 *
 * WARUM EIN KINDPROZESS UND NICHT `process.env.TZ = …` IM TEST: Node liest die
 * Zeitzone einmal und behält sie. Unter Jest wirkt eine spätere Zuweisung
 * nicht mehr — der erste Versuch dieses Tests lief in UTC und bekam trotzdem
 * die Berliner Antwort. Ein Test, der die Zeitzone gar nicht umstellt, prüft
 * aber nichts; er wäre auf der kaputten Fassung genauso grün. Der Kindprozess
 * ist dieselbe Ausgangslage wie ein Container: Zeitzone steht in der Umgebung,
 * bevor der Prozess startet.
 *
 * Die Uhr wird im Kind über den Date-Konstruktor festgesetzt, damit der Test
 * nicht davon abhängt, wann er läuft. `today()` selbst wird NICHT nachgebaut,
 * sondern aus `@saas-instant/shared` geladen — eine Abschrift der Formel würde
 * genau den Fehler nicht finden, um den es geht.
 */
function todayIn(zone: string, timestamp: number): string {
  const script = [
    'const Echt = Date;',
    `globalThis.Date = class extends Echt {`,
    `  constructor(...a) { if (a.length === 0) super(${timestamp}); else super(...a); }`,
    '};',
    `const { today } = require(${JSON.stringify(SHARED)});`,
    'process.stdout.write(today());',
  ].join('\n');
  return execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: zone },
  }).trim();
}

describe('Die Zeitzone entscheidet über den Tagesdatum-Wert', () => {
  it('liefert in UTC den VORTAG — das ist der gemeldete Fehler', () => {
    expect(todayIn('UTC', IN_WINDOW)).toBe('2026-08-31');
  });

  it('liefert in Europe/Berlin den richtigen Tag', () => {
    // Um 00:30 Berliner Zeit ist in Berlin der 1. September. Genau dieser
    // Unterschied ist der Grund für die Festlegung unten.
    expect(todayIn('Europe/Berlin', IN_WINDOW)).toBe('2026-09-01');
  });

  it('macht ausserhalb des Fensters keinen Unterschied', () => {
    // Damit niemand glaubt, die Umstellung verschiebe alle Daten: sie wirkt
    // nur in den zwei Stunden nach Mitternacht mitteleuropäischer Zeit.
    expect(todayIn('UTC', OUTSIDE)).toBe('2026-08-31');
    expect(todayIn('Europe/Berlin', OUTSIDE)).toBe('2026-08-31');
  });
});

/**
 * Die Festlegung steht in den Compose-Dateien und nirgends sonst — es gibt
 * keinen Vorgabewert im Code, der sie ersetzen könnte. Also wird sie dort
 * geprüft, nach demselben Muster wie `kanaltrennung.spec.ts`: der Test liest
 * die Datei, nicht eine Abschrift davon.
 */
describe('Alle Compose-Dateien setzen die Zeitzone für die API', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..');

  /** Datei und Name des Dienstes, dessen Zeitzone geprüft wird. */
  const FILES = [
    ['docker-compose.yml', 'control-api'],
    ['reference/docker-compose.control.coolify.yml', 'control-api'],
    ['docker-compose.coolify.yml', 'api'],
  ] as const;

  /** Die Zeitzone ist über APP_TIMEZONE einstellbar, Vorgabe Europe/Berlin. */
  const TIMEZONE_LINE = '      TZ: ${APP_TIMEZONE:-Europe/Berlin}';

  /**
   * Schneidet den `environment:`-Block eines Dienstes heraus.
   *
   * Bewusst ohne YAML-Parser: eine neue Abhängigkeit nur für diesen Test wäre
   * unverhältnismässig. Die Einrückung ist in beiden Dateien dieselbe, und der
   * Test bricht sichtbar ab, wenn er den Block nicht findet — er wird nicht
   * still grün.
   */
  function environmentOfService(file: string, serviceName: string): string {
    const content = readFileSync(join(ROOT, file), 'utf8');
    const service = new RegExp(`^ {2}${serviceName}:$`, 'm').exec(content);
    if (!service) throw new Error(`Dienst ${serviceName} fehlt in ${file}.`);
    const fromService = content.slice(service.index);
    // Der nächste Dienst beginnt wieder mit genau zwei Leerzeichen.
    const next = /\n {2}\S[^\n]*:$/m.exec(fromService.slice(service[0].length));
    const block = next
      ? fromService.slice(0, service[0].length + next.index)
      : fromService;
    const environment = /^ {4}environment:$/m.exec(block);
    if (!environment) throw new Error(`${serviceName} hat kein environment in ${file}.`);
    return block.slice(environment.index);
  }

  it.each(FILES)('findet den Dienst in %s (sonst prüft der Test nichts)', (file, service) => {
    expect(environmentOfService(file, service).length).toBeGreaterThan(200);
  });

  it.each(FILES)('setzt in %s TZ mit der Vorgabe Europe/Berlin', (file, service) => {
    const environment = environmentOfService(file, service);
    // Ohne Kommentarzeilen: die Begründung nennt die Zeitzone ebenfalls.
    const lines = environment
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(lines).toContain(`\n${TIMEZONE_LINE}\n`);
  });

  it.each(FILES)('setzt in %s keine zweite, abweichende Zeitzone', (file, service) => {
    const match = environmentOfService(file, service).match(/^ {6}TZ:.*$/gm) ?? [];
    expect(match).toEqual([TIMEZONE_LINE]);
  });
});
