import { houseLinks } from './provider';
import { MAIL_TOKENS } from './brand';
import { setTestBrand } from './test-brand';

beforeAll(() => setTestBrand());
import { transactionalLayout, marketingLayout } from './layout';
import { htmlFromText } from './sanitizer';

/**
 * ===========================================================================
 * DER RAHMEN, GEPARST — nicht als Zeichenkette verglichen
 * ===========================================================================
 *
 * WARUM ES DIESE DATEI GIBT. `rahmen.spec.ts` prüft das erzeugte Dokument mit
 * `toContain`. Damit war ein Fehler unsichtbar, den jede verschickte Mail
 * hatte: `MAIL_SCHRIFT` enthielt `"Segoe UI"` in DOPPELTEN Anführungszeichen
 * und wurde in `style="…"` eingesetzt. Im Rohtext stand die Schriftliste
 * vollständig da — jeder `toContain`-Test war grün. Der HTML-Parser sah etwas
 * anderes: Das `style`-Attribut endete nach `BlinkMacSystemFont, `, und
 * Schriftgrösse, Zeilenhöhe, Fettung und die Akzentfarbe `#0369a1` lagen als
 * Attributmüll daneben. Die Wortmarke im Kopf war weder grün noch fett.
 *
 * Gefunden wurde das am tatsächlich versendeten Ergebnis (Mailpit), nicht am
 * Test. Die Lehre steht in der Überschrift: Das Ergebnis wird GEPARST geprüft.
 *
 * WARUM `require` UND EINE EIGENE TYPBESCHREIBUNG. `jsdom` liegt als
 * Entwicklungsabhängigkeit bereits vor (Vitest benutzt es als Umgebung),
 * bringt aber keine Typen mit, und dieses Projekt lädt kein `@types`-Paket
 * dafür nach. Die Backend-Typprüfung kennt ausserdem keine DOM-Bibliothek.
 * Beschrieben wird deshalb genau der Ausschnitt, der hier gebraucht wird —
 * dieselbe Bauweise wie das `require` in `controller-schutz.spec.ts`.
 */

interface ParsedElement {
  tagName: string;
  getAttribute(name: string): string | null;
  getAttributeNames(): string[];
}

interface ParsedDocument {
  querySelectorAll(selection: string): ArrayLike<ParsedElement>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string) => { window: { document: ParsedDocument } };
};

function allElements(html: string): ParsedElement[] {
  const dom = new JSDOM(html);
  return Array.from(dom.window.document.querySelectorAll('*'));
}

/** Alle Attributnamen, die im ganzen Dokument vorkommen. */
function allAttributeNames(html: string): string[] {
  return [...new Set(allElements(html).flatMap((e) => e.getAttributeNames()))];
}

/** Alle `style`-Werte, so wie der Parser sie sieht. */
function allStyles(html: string): string[] {
  return allElements(html)
    .map((e) => e.getAttribute('style'))
    .filter((value): value is string => value !== null);
}

const BODY = {
  subject: 'Neues aus Beispielprodukt',
  html: htmlFromText('Hallo Beispielorganisation.'),
  text: 'Hallo Beispielorganisation.',
};

const UNSUBSCRIBE_LINK = 'https://verwaltung.example.com/api/consent/unsubscribe/abc123';

describe('Das gerahmte Dokument, wie ein Parser es liest', () => {
  it('lässt kein style-Attribut vorzeitig enden', () => {
    for (const mail of [
      transactionalLayout(BODY),
      marketingLayout(BODY, { unsubscribeLink: UNSUBSCRIBE_LINK }),
    ]) {
      // Der Parser darf NUR die Attribute finden, die auch gemeint sind.
      // Bricht ein Attributwert auf, werden aus seinen Resten eigene
      // Attributnamen — „segoe", „ui\"," und so weiter.
      const names = allAttributeNames(mail.html);
      expect(names).toEqual(
        expect.arrayContaining(['style', 'lang', 'charset', 'content']),
      );
      for (const name of names) {
        expect(name).toMatch(/^[a-z-]+$/);
      }
      expect(names).not.toContain('segoe');
      expect(names.some((n) => n.includes('sans-serif'))).toBe(false);
      expect(names.some((n) => n.includes('roboto'))).toBe(false);
    }
  });

  it('behält im Kopf die Markenfarbe, die Grösse und die Fettung', () => {
    const styles = allStyles(transactionalLayout(BODY).html);
    const header = styles.find((s) => s.includes(MAIL_TOKENS.primary));

    // Ohne die Behebung ist `kopf` undefined: Die Farbe fiel mitsamt allem,
    // was nach der Schriftliste stand, aus dem Attribut heraus.
    expect(header).toBeDefined();
    // 20 px und SERIFE — seit Etappe 7 dieselbe Anmutung wie in der
    // Anwendung. Vorher stand hier die Grotesk des Fliesstexts, und zwei
    // Geschäftsbriefe desselben Hauses sahen verschieden aus.
    expect(header).toContain('font-size:20px');
    expect(header).toContain('Georgia');
    expect(header).toContain('line-height:1.3');
    expect(header).toContain('font-weight:700');
    expect(header).toContain(`color:${MAIL_TOKENS.primary}`);
  });

  it('behält im Rumpf Schriftgrösse und Textfarbe', () => {
    const styles = allStyles(transactionalLayout(BODY).html);
    const body = styles.find(
      (s) => s.includes('font-size:15.5px') && s.includes('font-family'),
    );

    expect(body).toBeDefined();
    expect(body).toContain(`color:${MAIL_TOKENS.text}`);
    expect(body).toContain('line-height:1.6');
  });

  it('behält in der Fusszeile die leise Textfarbe und die Trennlinie', () => {
    const mail = marketingLayout(BODY, {
      unsubscribeLink: UNSUBSCRIBE_LINK,
    });
    const foot = allStyles(mail.html).find(
      (s) => s.includes('border-top') && s.includes('font-family'),
    );

    expect(foot).toBeDefined();
    expect(foot).toContain(`color:${MAIL_TOKENS.textMuted}`);
    expect(foot).toContain('font-size:12.5px');
    // Die Fusszeile steht auf EIGENER Fläche, nicht nur hinter einer Linie.
    expect(foot).toContain('background-color:#fbfcfe');
  });

  /**
   * Dieselbe Zusicherung wie in `rahmen.spec.ts`, aber am GEPARSTEN Dokument
   * — und genau deshalb steht sie hier ein zweites Mal. Die Umbruchregeln
   * stehen im selben `style`-Attribut wie die Schriftliste, und das ist das
   * Attribut, das der `"Segoe UI"`-Fehler seinerzeit vorzeitig beendet hat.
   * Ein Zeichenkettenvergleich haette danach immer noch „word-break" im
   * Rohtext gefunden, obwohl der Browser die Regel nie zu sehen bekam.
   */
  it('legt die Umbruchregeln wirklich ins style-Attribut der Textzellen', () => {
    const mail = marketingLayout(BODY, {
      unsubscribeLink: UNSUBSCRIBE_LINK,
    });
    const withWrap = allStyles(mail.html).filter(
      (s) =>
        s.includes('word-break:break-word') &&
        s.includes('overflow-wrap:anywhere'),
    );

    // Rumpf und Fusszeile — die Kopfzelle traegt nur die Wortmarke.
    expect(withWrap).toHaveLength(2);
    // Und die Regel steht IM selben Attribut wie die Schrift, ist also nicht
    // hinter einem vorzeitig beendeten `style` gelandet.
    for (const style of withWrap) expect(style).toContain('font-family');
  });

  it('reicht die vollständige Schriftliste in EIN Attribut', () => {
    const withFont = allStyles(transactionalLayout(BODY).html).filter((s) =>
      s.includes('font-family'),
    );

    expect(withFont.length).toBeGreaterThan(0);
    // SEIT ETAPPE 7 GIBT ES ZWEI STAPEL: Grotesk für den Fliesstext, Serife
    // für Wortmarke und Überschrift. Der Punkt des Tests bleibt derselbe —
    // die Liste muss VOLLSTÄNDIG in EINEM Attribut ankommen. Der Fehler, der
    // ihn ausgelöst hat, war ein `"` mitten in der Liste; er schnitt alles
    // dahinter ab. Deshalb wird das ENDE geprüft, nicht ein Wort in der Mitte.
    for (const style of withFont) {
      const list = /font-family:([^;]+)/.exec(style)?.[1] ?? '';
      const isSerif = list.includes('Georgia');
      if (isSerif) {
        // Der Serifenstapel, ungekürzt bis zur generischen Familie.
        expect(list.trimEnd().endsWith('serif')).toBe(true);
        expect(list).toContain("'Times New Roman'");
      } else {
        expect(list).toContain('sans-serif');
        expect(list).toContain("'Segoe UI'");
      }
    }
  });

  /**
   * DIE ZWEITE ATTRIBUTSTELLE: der Abmeldelink. Ein `"` darin bräche aus
   * `href="…"` aus und könnte eigene Attribute anhängen. Heute ist das nicht
   * ausnutzbar — der Link besteht aus einer Basis-URL aus der Umgebung und
   * einem serverseitig erzeugten Token. Der Test hält fest, dass es auch dann
   * nicht ginge, wenn sich daran etwas änderte.
   */
  it('lässt einen Abmeldelink nicht aus dem href ausbrechen', () => {
    const malicious = `${UNSUBSCRIBE_LINK}" onmouseover="alert(1)`;
    const mail = marketingLayout(BODY, {
      unsubscribeLink: malicious,
    });

    const names = allAttributeNames(mail.html);
    expect(names).not.toContain('onmouseover');

    const links = allElements(mail.html).filter(
      (e) => e.tagName.toLowerCase() === 'a',
    );
    // Die Verweise: der geprüfte Abmeldelink und die des Hauses. Die
    // Zusicherung gilt dem EINEN, der einen Anfuehrungsstrich enthaelt.
    expect(links).toHaveLength(1 + houseLinks().length);
    expect(links[0]!.getAttribute('href')).toBe(malicious);
    expect(links[0]!.getAttributeNames().sort()).toEqual(['href', 'style']);
  });

  /**
   * DER BETREFF STEHT IM `<title>` und kommt aus der Redaktion. Er ist
   * Textinhalt, kein Attribut — aber er darf das Dokument trotzdem nicht
   * aufbrechen.
   */
  it('lässt einen Betreff mit Anführungszeichen das Dokument nicht aufbrechen', () => {
    const mail = transactionalLayout({
      ...BODY,
      subject: 'Der "Herbstbrief" von Beispielprodukt',
    });

    const names = allAttributeNames(mail.html);
    for (const name of names) {
      expect(name).toMatch(/^[a-z-]+$/);
    }
    expect(names).not.toContain('herbstbrief');
  });
});
