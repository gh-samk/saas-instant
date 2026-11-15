import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * ===========================================================================
 * R3 ALS EIGENSCHAFT DES QUELLTEXTES, NICHT ALS VERABREDUNG
 * ===========================================================================
 *
 * „Transaktionsmails und werbliche Mails sind getrennte Kanäle mit getrennten
 * Codepfaden." — „Ein Empfänger ohne bestätigtes Opt-in kann technisch keine
 * werbliche Mail erhalten, auch nicht durch Fehlbedienung."
 *
 * Die Laufzeitprüfungen stehen in `werbemail.spec.ts` und in den
 * Integrationstests. Hier geht es um das, was eine Laufzeitprüfung NICHT
 * zeigen kann: dass es die verbotenen Wege gar nicht gibt. Diese Suite liest
 * den Quelltext und hält ihn gegen die Regel — nach demselben Muster wie
 * `coolify/kein-loeschpfad.spec.ts` (R1) und `controller-schutz.spec.ts`.
 *
 * Sie schlägt fehl, sobald jemand
 * - eine Sammeladresse in bcc einführt,
 * - dem Transaktionskanal einen Einwilligungsbezug gibt (oder umgekehrt),
 * - eine `WerbeFreigabe` ausserhalb des Tores erzeugt,
 * - Öffnungs- oder Klickmessung einbaut.
 */

const SRC = join(__dirname, '..');

/** Alle .ts-Dateien unter src, ohne Prüfcode. */
function allSources(): { path: string; content: string }[] {
  const found: { path: string; content: string }[] = [];
  const search = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        search(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.spec.ts')) continue;
      found.push({ path, content: readFileSync(path, 'utf8') });
    }
  };
  search(SRC);
  return found;
}

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8');
}

/**
 * Entfernt reine Kommentarzeilen.
 *
 * NÖTIG, WEIL DIE KOMMENTARE DIE VERBOTENEN BEGRIFFE NENNEN — sie erklären ja
 * gerade, dass es diese Dinge nicht gibt. Geprüft werden soll der CODE.
 *
 * Bewusst zeilenweise und nur am Zeilenanfang: Ein Stripper, der auch `//`
 * mitten in einer Zeile entfernte, schnitte jede URL in einer Zeichenkette ab
 * — und genau dort könnte sich ein Zählparameter verstecken.
 */
function withoutComments(origin: string): string {
  return origin
    .split('\n')
    .filter((row) => !/^\s*(\/\/|\*|\/\*)/.test(row))
    .join('\n');
}

describe('Die beiden Kanäle sind getrennt', () => {
  it('findet überhaupt Quelltext (sonst prüft der Test nichts)', () => {
    expect(allSources().length).toBeGreaterThan(50);
  });

  /**
   * DIE ZEILE, AUF DIE ES ANKOMMT. Nimmt `versende` eines Tages wieder eine
   * Zeichenkette entgegen, ist R3 nur noch eine Verabredung.
   */
  it('nimmt im werblichen Kanal nur eine WerbeFreigabe als Empfänger an', () => {
    const origin = read('broadcast', 'marketing-mail.service.ts');
    expect(origin).toMatch(/async send\(\s*approval: MarketingApproval,/);
    // Kein zweiter Weg hinaus.
    expect(origin.match(/sendMail\(/g) ?? []).toHaveLength(1);
  });

  it('erzeugt eine WerbeFreigabe ausschliesslich im Tor', () => {
    const producer = allSources().filter((file) =>
      /new MarketingApproval\(/.test(file.content),
    );
    expect(producer.map((file) => file.path.replace(SRC, ''))).toEqual([
      join('/consent', 'consent.gate.ts'),
    ]);
    // Und der Konstruktor ist privat, damit es dabei bleibt.
    expect(read('consent', 'consent.gate.ts')).toContain(
      'private constructor(',
    );
  });

  it('liest im Transaktionskanal keine Einwilligung', () => {
    const origin = read('mail', 'mail.service.ts').toLowerCase();
    // Vorkommen in Kommentaren sind erlaubt; es geht um Code. Geprüft wird
    // deshalb auf die beiden Formen, mit denen ein Bezug entstünde.
    expect(origin).not.toContain('consentservice');
    expect(origin).not.toContain('werbefreigabe');
    expect(origin).not.toContain('marketingapproval');
    expect(origin).not.toContain('prisma.consent');
  });

  it('setzt im Transaktionskanal keine Abmeldekopfzeilen', () => {
    const origin = read('mail', 'mail.service.ts');
    expect(origin).not.toContain('List-Unsubscribe');
  });

  it('hängt das Rundmail-Modul nicht am MailModule', () => {
    // Der Import fehlt ABSICHTLICH: Ein späterer Umbau, der den
    // Transaktionsversand hier benutzen wollte, müsste ihn zuerst hinzufügen
    // und fiele damit im Review auf.
    expect(read('broadcast', 'broadcast.module.ts')).not.toContain(
      "from '../mail/mail.module'",
    );
  });
});

describe('Der gemeinsame Mailrahmen bleibt kanalblind', () => {
  /**
   * ===========================================================================
   * DER RAHMEN IST DIE NEUE STELLE, AN DER R3 FALLEN KÖNNTE
   * ===========================================================================
   *
   * Beide Kanäle benutzen seit dem Mailrahmen dieselbe Datei für Kopf,
   * Typografie und Dokumentaufbau. Das ist richtig so — es ist dieselbe Lage
   * wie bei `mail/transport.ts`: Gemeinsam benutzt wird das, was NICHTS
   * entscheidet. Zwei Abschriften der Marke wären zwei Stellen, an denen sie
   * auseinanderläuft.
   *
   * Gefährlich wäre erst der nächste Schritt: ein Feld `kanal` am Rahmen, mit
   * dem sich die Fusszeile umschalten liesse. Eine falsche Zeichenkette an
   * einer Aufrufstelle, und eine Rechnungsmail trüge einen Abmeldelink — oder
   * eine Rundmail keinen. Beides sähe niemand im Postausgangslog.
   *
   * Deshalb prüfen die folgenden Tests genau das: dass es diesen Schalter
   * nicht gibt und dass die beiden Wege getrennt bleiben.
   */
  it('kennt im Rahmen keinen Kanal-Schalter', () => {
    const origin = withoutComments(read('mail', 'layout', 'layout.ts'));
    expect(origin).not.toMatch(/channel/i);
    expect(origin).not.toMatch(/'marketing'|'transactional'/);
  });

  it('exportiert genau zwei Einstiege, und der gemeinsame Kern ist keiner', () => {
    const origin = read('mail', 'layout', 'layout.ts');
    expect(origin).toMatch(/export function transactionalLayout\(/);
    expect(origin).toMatch(/export function marketingLayout\(/);
    // `baue` ist NICHT exportiert — sonst liesse sich die Fusszeile an beiden
    // Einstiegen vorbei setzen.
    expect(origin).toMatch(/\nfunction build\(/);
    expect(origin).not.toMatch(/export function build\(/);
  });

  it('gibt dem Transaktionsrahmen keinen Platz für einen Abmeldelink', () => {
    const origin = read('mail', 'layout', 'layout.ts');
    const signature = /export function transactionalLayout\(([^)]*)\)/.exec(origin);
    expect(signature).not.toBeNull();
    expect(signature![1]).toBe('body: Body');
    // Und der werbliche Einstieg verlangt einen.
    const marketing = /export function marketingLayout\(([\s\S]*?)\): FramedMail/.exec(
      origin,
    );
    expect(marketing![1]).toContain('footer: MarketingFooter');
  });

  it('ruft den werblichen Rahmen ausschliesslich im werblichen Modul auf', () => {
    const caller = allSources()
      .filter((file) => /\bmarketingLayout\(/.test(withoutComments(file.content)))
      .map((file) => file.path.replace(SRC, ''));
    expect(caller.sort()).toEqual(
      [
        join('/mail', 'layout', 'layout.ts'),
        join('/broadcast', 'marketing-mail.service.ts'),
      ].sort(),
    );
  });

  it('baut im Transaktionskanal keinen werblichen Rahmen', () => {
    const origin = withoutComments(read('mail', 'mail.service.ts'));
    expect(origin).toContain('transactionalLayout(');
    expect(origin).not.toContain('marketingLayout');
    expect(origin).not.toContain('marketingFooterText');
  });
});

describe('Jede Mail geht mit beiden Teilen hinaus', () => {
  /**
   * Eine reine HTML-Mail ist ein Zustellungsrisiko: Viele Spamfilter lesen
   * zuerst den Textteil, manche Programme zeigen ausschliesslich ihn. Bei
   * einer Domäne, die ohne DKIM auf `p=quarantine` steht, ist das kein
   * theoretisches Risiko — es träfe zuerst die Rechnungen.
   */
  it('setzt an jedem sendMail-Aufruf text UND html', () => {
    const sendPaths = [
      read('mail', 'mail.service.ts'),
      read('broadcast', 'marketing-mail.service.ts'),
    ];
    for (const origin of sendPaths) {
      const calls = origin.match(/sendMail\(\{[\s\S]*?\n      \}\)/g) ?? [];
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^\s*(text|html):/m);
      expect(calls[0]).toMatch(/\btext:/);
      expect(calls[0]).toMatch(/\bhtml:/);
    }
  });
});

describe('Nie mehrere Adressen in einer Mail', () => {
  it('kennt in keinem Versandpfad ein bcc oder cc', () => {
    const sendPaths = [
      read('mail', 'mail.service.ts'),
      read('broadcast', 'marketing-mail.service.ts'),
      read('broadcast', 'queue.service.ts'),
    ];
    for (const origin of sendPaths.map(withoutComments)) {
      expect(origin).not.toMatch(/\bbcc\s*:/i);
      expect(origin).not.toMatch(/(^|[^b])\bcc\s*:/i);
    }
  });

  it('übergibt im Umschlag genau einen Empfänger', () => {
    const origin = read('broadcast', 'marketing-mail.service.ts');
    expect(origin).toContain('to: [approval.email]');
  });
});

describe('Keine Öffnungs- und Klickmessung (Verbotsliste des Auftrags)', () => {
  const FORBIDDEN = [
    /z(ae|ä)hlpixel/i,
    /tracking[-_ ]?pixel/i,
    /\butm_/i,
    /open\.gif/i,
    /\bpixel\.(gif|png)\b/i,
    /click[-_ ]?tracking/i,
    /klickmessung/i,
    /\bredirect\?/i,
  ];

  it('enthält in den Mail-Modulen keine Spur davon', () => {
    const affected = allSources().filter((file) =>
      /(\/mail\/|\/broadcast\/|\/consent\/)/.test(file.path),
    );
    expect(affected.length).toBeGreaterThan(5);
    for (const file of affected) {
      const code = withoutComments(file.content);
      for (const pattern of FORBIDDEN) {
        expect(code).not.toMatch(pattern);
      }
    }
  });
});
