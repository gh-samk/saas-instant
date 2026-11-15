import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';
import { InvoiceDocumentService } from './document.service';
import { InvoiceSendService } from './send.service';

/**
 * R2 ALS ABWESENHEIT — NACHGEPRÜFT, NICHT VERSPROCHEN.
 *
 * Harte Regel R2, wörtlich: „Nach dem Festschreiben existiert kein Löschbefehl
 * und kein Änderungsbefehl für eine Rechnung — nicht im UI, nicht in der API,
 * nicht in einem Service."
 *
 * Dieselbe Bauweise wie `coolify/no-delete-path.spec.ts`, aus demselben
 * Grund: Eine solche Zusage ist nur so viel wert wie ihre Prüfbarkeit. Der
 * Test geht deshalb über den QUELLBAUM und nicht über eine Erinnerung.
 *
 * DREI AUSSAGEN:
 * 1. Es gibt im ganzen Backend GENAU VIER Dateien, die schreibend auf
 *    `rechnung` oder `rechnungsposten` zugreifen. Jede weitere ist ein roter
 *    Test — nicht ein stiller Änderungspfad.
 * 2. Die Menge der Schreibaufrufe je Datei ist AUFGEZÄHLT. Wer einen fünften
 *    `rechnung.update` einbaut, muss ihn hier eintragen und dabei begründen.
 * 3. Jeder Löschaufruf steht in einer Methode, die vorher `ENTWURF` geprüft
 *    hat.
 *
 * Der Rest — dass ein Aufruf mit der Kennung einer festgeschriebenen Rechnung
 * abgewiesen wird — steht als LAUFENDER Nachweis in
 * `invoice.integration.spec.ts`. Abwesenheit im Code und abgewiesener Aufruf
 * sind zwei verschiedene Aussagen, und der Auftrag verlangt beide.
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
        const excluded = [
          'components',
          'context',
          'lib',
          'pages',
          'utils',
          'test-support',
        ];
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

/** Jeder Schreibaufruf gegen die beiden Rechnungsmodelle. */
const WRITE_CALL =
  /\b(invoice|invoiceLine)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/gi;

interface Fund {
  path: string;
  number: number;
  call: string;
}

function writeCalls(): Fund[] {
  return sourceFiles().flatMap((file) =>
    file.content
      .split('\n')
      .map((row, number) => ({ row, number: number + 1 }))
      .filter(({ row }) => {
        const t = row.trim();
        // Kommentare dürfen die Aufrufe benennen — dort steht die Begründung.
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .flatMap(({ row, number }) =>
        [...row.matchAll(WRITE_CALL)].map((hits) => ({
          path: file.path,
          number,
          call: `${hits[1]}.${hits[2]}`,
        })),
      ),
  );
}

/**
 * DIE AUFGEZÄHLTE MENGE.
 *
 * Jeder Eintrag ist eine abgenommene Entscheidung. Die Liste zu erweitern ist
 * eine bewusste Handlung — genau das ist ihr Zweck.
 */
const ALLOWED: Record<string, string[]> = {
  // Entwurf anlegen, Entwurf ändern (ersetzen), Entwurf löschen,
  // Festschreiben, Storno anlegen, Original auf `storniert` setzen,
  // Versand vermerken.
  'invoices/invoice.service.ts': [
    'invoice.create',
    'invoiceLine.createMany',
    'invoice.update',
    'invoiceLine.deleteMany',
    'invoiceLine.createMany',
    'invoiceLine.deleteMany',
    'invoice.delete',
    'invoice.update',
    'invoice.create',
    'invoiceLine.createMany',
    'invoice.update',
    'invoice.updateMany',
  ],
  // Zahldatum, gezahlter Betrag, Status — und der Übertragungsvermerk.
  // KEINE Beträge, keine Posten, kein Schnappschuss, keine Nummer.
  'invoices/payment.service.ts': ['invoice.update', 'invoice.update'],
  // AUSSCHLIESSLICH `pdfContent` und `xmlContent`.
  //
  // [W2]: Aus dem `update` wurde ein BEDINGTES `updateMany`
  // (`where: { id, pdfContent: null }`). Der Aufruf schreibt damit noch
  // weniger als vorher: nur dann, wenn noch gar kein Dokument abgelegt ist.
  // Wer das Rennen verliert, gibt die gespeicherte Fassung aus, statt sie zu
  // überschreiben — ein Beleg hat genau eine Ausfertigung.
  'invoices/document.service.ts': ['invoice.updateMany'],
};

describe('R2 — kein Änderungs- und kein Löschbefehl an einer Rechnung', () => {
  it('findet überhaupt Dateien (sonst prüft der Test nichts)', () => {
    expect(sourceFiles().length).toBeGreaterThanOrEqual(40);
    expect(writeCalls().length).toBeGreaterThan(0);
  });

  it('lässt nur die drei aufgezählten Dateien schreibend zugreifen', () => {
    const files = [...new Set(writeCalls().map((f) => f.path))].sort();
    expect(files).toEqual(Object.keys(ALLOWED).sort());
  });

  it('kennt je Datei genau die aufgezählten Schreibaufrufe', () => {
    const byFile = new Map<string, string[]>();
    for (const fund of writeCalls()) {
      byFile.set(fund.path, [...(byFile.get(fund.path) ?? []), fund.call]);
    }
    for (const [path, expected] of Object.entries(ALLOWED)) {
      expect([...(byFile.get(path) ?? [])].sort()).toEqual(
        [...expected].sort(),
      );
    }
  });

  /**
   * DIE BEIDEN LÖSCHAUFRUFE HÄNGEN AM ENTWURF.
   *
   * Geprüft wird die Methode, in der sie stehen: `draftUpdate` ersetzt die
   * Posten eines Entwurfs, `draftDelete` wirft einen Entwurf weg. Beide
   * rufen davor `lockAndCheck(tx, id, ENTWURF)` auf — die Zeile steht im
   * selben Abschnitt und wird hier mitgeprüft.
   */
  it('stellt jedem Löschaufruf eine Entwurfsprüfung voran', () => {
    const renderer = readFileSync(join(__dirname, 'invoice.service.ts'), 'utf8');
    const rows = renderer.split('\n');
    const deletionRows = rows
      .map((row, number) => ({ row, number }))
      .filter(({ row }) =>
        /\b(invoice|invoiceLine)\s*\.\s*(delete|deleteMany)\s*\(/.test(row),
      );

    expect(deletionRows).toHaveLength(3);
    for (const { number } of deletionRows) {
      const before = rows.slice(Math.max(0, number - 20), number).join('\n');
      expect(before).toContain('lockAndCheck(tx, id, DRAFT)');
    }
  });

  /**
   * DIE ÖFFENTLICHE OBERFLÄCHE DER DIENSTE, AUFGEZÄHLT.
   *
   * Es gibt kein allgemeines „ändere Rechnung" und kein „lösche Rechnung".
   * Jede Methode, die schreibt, trägt ihren Zustand im Namen.
   */
  it('hat keinen Dienst mit einem allgemeinen Änderungs- oder Löschbefehl', () => {
    const methods = (klass: Function): string[] =>
      Object.getOwnPropertyNames(klass.prototype)
        .filter((name) => name !== 'constructor')
        .sort();

    expect(methods(InvoiceService)).toEqual([
      // `dateWindow` liest das zulässige Fenster für das Rechnungsdatum ([W1]);
      // `metrics` und `list` sind REIN LESEND (Kacheln, globale Rechnungsliste).
      // Keine von ihnen fasst eine Zeile an.
      'cancel',
      'dateWindow',
      'draftCreate',
      'draftData',
      'draftDelete',
      'draftUpdate',
      'finalize',
      'get',
      'list',
      'listForCompany',
      'lockAndCheck',
      'metrics',
      'sendNote',
    ]);
    expect(methods(PaymentService)).toEqual([
      'get',
      'note',
      'noteTransfer',
    ]);
    expect(methods(InvoiceDocumentService)).toEqual([
      'buildDocument',
      'create',
      'filename',
      'getOrCreate',
      'getXml',
    ]);
    expect(methods(InvoiceSendService)).toEqual([
      'amountReadable',
      'invoiceText',
      'loadSendable',
      'remind',
      'reminderText',
      'send',
    ]);
  });

  it('fällt um, sobald ein Löschaufruf dazukäme (Gegenprobe)', () => {
    const pattern =
      /\b(invoice|invoiceLine)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/i;
    expect(pattern.test('await this.prisma.invoice.deleteMany({ where: {} });')).toBe(
      true,
    );
    expect(pattern.test('await this.prisma.invoice.findMany({});')).toBe(false);
  });
});

/**
 * ZEHN JAHRE AUFBEWAHRUNG — die Löschwege an der Organisation dürfen
 * Rechnungen NICHT mitreißen.
 *
 * Die steuerliche Aufbewahrungspflicht sticht jedes Löschverlangen. In
 * `company.service.ts` liegen beide Löschwege: Die Kontaktdatenlöschung
 * räumt Felder und Notizen, die vollständige Löschung entfernt die Zeile.
 * Keiner von beiden darf eine Rechnung anfassen.
 *
 * DER TEST VERBOT ZUERST JEDE ERWÄHNUNG, auch lesende. Das ging so lange gut,
 * wie es nur die Kontaktdatenlöschung gab. Mit `vollstaendigLoeschen` kam ein
 * `rechnung.count` dazu — und zwar als GEGENTEIL eines Übergriffs: Es ist die
 * Bedingung, die das Löschen abbricht, sobald auch nur ein Entwurf existiert.
 * Ein Verbot, das diese Prüfung untersagt, schützt Rechnungen nicht, es
 * verhindert ihren Schutz.
 *
 * Deshalb jetzt zwei Aussagen statt einer: SCHREIBEN ist ausgeschlossen, und
 * gelesen wird ausschließlich gezählt. `count` kann eine Rechnung weder
 * ändern noch ausliefern — es beantwortet genau eine Frage: „gibt es welche?"
 */
describe('Die Löschwege an der Organisation fassen keine Rechnung an', () => {
  function codeLinesOfCompany(): string[] {
    const renderer = readFileSync(
      join(SRC, 'companies', 'company.service.ts'),
      'utf8',
    );
    return renderer.split('\n').filter((row) => {
      const t = row.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    });
  }

  /** Jede Zeile, die in company.service.ts ein Rechnungsmodell berührt. */
  function invoiceAccesses(): string[] {
    return codeLinesOfCompany().filter((row) =>
      /\b(tx|this\.prisma|db)\s*\.\s*(invoice|invoiceLine)\b/i.test(row),
    );
  }

  it('schreibt in company.service.ts nie an einer Rechnung', () => {
    expect(
      invoiceAccesses().filter((row) =>
        /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/i.test(
          row,
        ),
      ),
    ).toEqual([]);
  });

  it('liest dort ausschliesslich per count — nie einen Inhalt', () => {
    // `findMany`/`findFirst` holten Beträge und Empfängerangaben in einen
    // Dienst, der sie nicht braucht. Gefragt ist nur, OB es welche gibt.
    const notCounted = invoiceAccesses().filter(
      (row) => !/\.\s*count\s*\(/i.test(row),
    );
    expect(notCounted).toEqual([]);
  });

  it('hat die Prüfung überhaupt (sonst prüft dieser Test nichts)', () => {
    // Gegenprobe zur Lockerung oben: Fiele der `count` weg, liesse sich eine
    // Organisation mitsamt bestehender Rechnung löschen — und der Test hier
    // wäre stumm, weil „keine Zugriffe" ihm genügt.
    expect(invoiceAccesses().length).toBeGreaterThan(0);
  });
});
