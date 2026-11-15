import { readFileSync } from 'fs';
import { join } from 'path';
import { houseDetails, houseLinks } from './provider';
import { setTestBrand } from './test-brand';
import { MAIL_COLOR_VALUES, MAIL_FONT, MAIL_TOKENS } from './brand';
import {
  LayoutWithoutUnsubscribeLinkError,
  transactionalLayout,
  marketingFooterText,
  marketingLayout,
} from './layout';
import { htmlFromText, sanitize, textFrom } from './sanitizer';

beforeAll(() => setTestBrand());

const UNSUBSCRIBE_LINK = 'https://verwaltung.example.com/api/consent/unsubscribe/abc';

function body(text = 'Hallo,\n\nhier steht die Nachricht.') {
  return { subject: 'Ein Betreff', html: htmlFromText(text), text };
}

describe('Jede Mail hat beide Teile', () => {
  it('liefert im Transaktionskanal HTML und Text', () => {
    const mail = transactionalLayout(body());
    expect(mail.html).toMatch(/^<!doctype html>/);
    expect(mail.html.trimEnd()).toMatch(/<\/html>$/);
    // `startsWith` statt `toBe`: Seit [A.33] endet JEDER Textteil mit der
    // Anbieterkennung. Der Rumpf steht unveraendert davor.
    expect(mail.text.startsWith('Hallo,\n\nhier steht die Nachricht.')).toBe(
      true,
    );
  });

  it('liefert im werblichen Kanal HTML und Text', () => {
    const mail = marketingLayout(body(), {
      unsubscribeLink: UNSUBSCRIBE_LINK,
    });
    expect(mail.html).toContain('<!doctype html>');
    expect(mail.text).toContain('hier steht die Nachricht.');
  });

  it('trägt den Rumpf in beiden Teilen inhaltlich gleich', () => {
    const mail = transactionalLayout(body('Erster Absatz.\n\nZweiter Absatz.'));
    expect(mail.text).toContain('Erster Absatz.');
    expect(mail.text).toContain('Zweiter Absatz.');
    expect(textFrom(mail.html)).toContain('Erster Absatz.');
    expect(textFrom(mail.html)).toContain('Zweiter Absatz.');
  });

  it('setzt einen Vorschautext aus dem TEXTTEIL, nicht aus dem HTML', () => {
    const mail = transactionalLayout(body('Der erste Satz zählt.\n\nDer Rest.'));
    expect(mail.html).toContain('Der erste Satz zählt.');
    // Aus dem HTML abgeleitet stünde hier ein Tag-Rest.
    expect(mail.html).not.toMatch(/display:none[^>]*>[^<]*&lt;p&gt;/);
  });

  it('kürzt einen langen Vorschautext am Wortende', () => {
    const lang = `${'Wort '.repeat(60)}Ende.`;
    const mail = transactionalLayout(body(lang));
    const preview = /opacity:0;[^>]*>([^<]*)</.exec(mail.html)?.[1] ?? '';
    expect(preview.length).toBeLessThanOrEqual(95);
    expect(preview).toMatch(/…$/);
    expect(preview).not.toMatch(/Wor…$/);
  });

  it('nimmt einen ausdrücklich gesetzten Vorschautext', () => {
    const mail = transactionalLayout({ ...body(), preheader: 'Dein Code.' });
    expect(mail.html).toContain('Dein Code.');
  });

  it('escaped den Betreff im Titel', () => {
    const mail = transactionalLayout({ ...body(), subject: '<script>x</script>' });
    expect(mail.html).toContain('<title>&lt;script&gt;x&lt;/script&gt;</title>');
    expect(mail.html).not.toContain('<script>x</script>');
  });
});

describe('Die Kanäle unterscheiden sich genau an der Fusszeile', () => {
  it('gibt einer Transaktionsmail KEINEN Abmeldelink', () => {
    const mail = transactionalLayout(body());
    expect(mail.html.toLowerCase()).not.toContain('abmelde');
    expect(mail.text.toLowerCase()).not.toContain('abmelde');
    expect(mail.html.toLowerCase()).not.toContain('unsubscribe');
  });

  /**
   * =======================================================================
   * VON DER VERBOTSLISTE ZUR ERLAUBNISLISTE [A.33]
   * =======================================================================
   *
   * Hier stand `expect(mail.html).not.toMatch(/<a\s/i)` — kein einziger
   * Verweis in einer Transaktionsmail. Gemeint war „kein ABMELDELINK";
   * solange der Abmeldelink der einzig denkbare Verweis war, waren beide
   * Sätze deckungsgleich, und das Verbot war die billigere Formulierung.
   *
   * Mit der Anbieterkennung sind sie es nicht mehr. Die eigentliche Regel
   * prüft der Test darüber (`not.toContain('abmelde')`), und dieser hier
   * sagt jetzt positiv, was erlaubt ist. Das ist strenger, nicht lockerer:
   * `not.toMatch(/<a\s/)` liess jede Zukunft ohne Verweis durch; eine
   * Mengengleichheit lässt genau diese drei durch. Ein eingeschmuggeltes
   * `example.com/spende?utm_source=mail` fällt jetzt auf.
   */
  it('trägt in einer Transaktionsmail genau die Verweise des Hauses', () => {
    const mail = transactionalLayout(body());
    const targets = [...mail.html.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map(
      (hit) => hit[1] ?? '',
    );
    expect(targets.sort()).toEqual(houseLinks().map((l) => l.url).sort());
  });

  /**
   * =======================================================================
   * DIESER TEST STAND FRÜHER AUF DEM KOPF [A.33]
   * =======================================================================
   *
   * Er hiess „gibt einer Transaktionsmail KEINE Anbieterkennung" und
   * begründete das mit: „der Auftrag nennt sie ausdrücklich als Zusatz des
   * WERBLICHEN Kanals". Das ist ein Argument aus einem früheren Auftrag,
   * nicht aus der Sache.
   *
   * Sachlich zeigt es in die andere Richtung: Eine Rechnung, eine
   * Zahlungserinnerung und eine Auftragsbestätigung sind Geschäftsbriefe.
   * § 5 DDG verlangt eine leicht erkennbare Anbieterkennzeichnung, § 125a
   * i. V. m. § 177a HGB die Register- und Vertretungsangaben. Dass
   * ausgerechnet die Rundmail sie trug und die Rechnung nicht, war die
   * Umkehrung dessen, worauf es ankommt — ein Mangel, kein Schutz.
   *
   * Was der alte Test WIRKLICH hielt — „der werbliche Zusatz sickert nicht
   * in den Transaktionskanal" — tragen jetzt `not.toContain('abmelde')` und
   * die Erlaubnisliste der Verweise, und zwar genauer.
   */
  it('trägt die Anbieterkennung in JEDER Mail, auch im Transaktionskanal', () => {
    const mail = transactionalLayout(body());
    for (const row of houseDetails()) {
      expect(mail.text).toContain(row);
    }
    // Im HTML mit escapetem „&" aus dem Firmennamen.
    expect(mail.html).toContain('Beispiel GmbH, Musterweg 1');
  });

  it('unterscheidet die Kanäle NUR am werblichen Zusatz', () => {
    const transactional = transactionalLayout(body());
    const marketing = marketingLayout(body(), { unsubscribeLink: UNSUBSCRIBE_LINK });

    // Beide tragen dieselbe Anbieterkennung …
    for (const row of houseDetails()) {
      expect(transactional.text).toContain(row);
      expect(marketing.text).toContain(row);
    }
    // … und der einzige Unterschied ist der werbliche Teil.
    expect(marketing.text).toContain(UNSUBSCRIBE_LINK);
    expect(transactional.text).not.toContain(UNSUBSCRIBE_LINK);
  });

  it('gibt einer werblichen Mail GENAU EINEN Abmeldelink', () => {
    const mail = marketingLayout(body(), {
      unsubscribeLink: UNSUBSCRIBE_LINK,
    });
    // Fünf Verweise: der Abmeldelink und die vier des Hauses. Genau EIN
    // Abmeldelink bleibt die Zusicherung — geprüft als Zählung, nicht als
    // „mindestens einer".
    const targets = [...mail.html.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map(
      (hit) => hit[1] ?? '',
    );
    expect(targets.filter((target) => target === UNSUBSCRIBE_LINK)).toHaveLength(1);
    expect(targets.sort()).toEqual(
      [UNSUBSCRIBE_LINK, ...houseLinks().map((l) => l.url)].sort(),
    );
  });

  it('schreibt den Abmeldelink im Textteil aus', () => {
    // Ein Linktext „Abmelden" ohne Adresse ist in einer Klartextmail wertlos.
    const mail = marketingLayout(body(), {
      unsubscribeLink: UNSUBSCRIBE_LINK,
    });
    expect(mail.text).toContain(UNSUBSCRIBE_LINK);
  });

  it('nennt jede Zeile der Anbieterkennung GENAU EINMAL', () => {
    // Der werbliche Kanal hatte seine eigene Fassung; jetzt gibt es nur noch
    // die eine. Doppelt stünde sie da, wenn jemand die alte zurückholt.
    const mail = marketingLayout(body(), { unsubscribeLink: UNSUBSCRIBE_LINK });
    for (const row of houseDetails()) {
      expect(mail.text.split(row)).toHaveLength(2);
    }
  });

  it('lässt sich werblich ohne brauchbaren Abmeldelink nicht bauen', () => {
    for (const link of ['', '   ', 'javascript:alert(1)', 'unsubscribe', 'ftp://x/y']) {
      expect(() =>
        marketingLayout(body(), { unsubscribeLink: link }),
      ).toThrow(LayoutWithoutUnsubscribeLinkError);
    }
  });

  it('hat für den Transaktionskanal überhaupt keinen Fusszeilen-Parameter', () => {
    // Die Zusicherung steht im Typ und damit im Quelltext: `transaktionsRahmen`
    // nimmt genau ein Argument. Gäbe es ein zweites, liesse sich ein
    // Abmeldelink hineinreichen — und R3 wäre wieder eine Verabredung.
    expect(transactionalLayout).toHaveLength(1);
    expect(marketingLayout).toHaveLength(2);
  });

  it('erzeugt für Schnappschuss und Versand denselben Fusszeilentext', () => {
    const fromLayout = marketingLayout(body(), {
      unsubscribeLink: UNSUBSCRIBE_LINK,
    }).text;
    expect(fromLayout).toContain(marketingFooterText(UNSUBSCRIBE_LINK));
  });
});

describe('Der Rahmen lässt aus dem Rumpf nichts durchschlagen', () => {
  it('nimmt nur den gesäuberten Rumpf auf', () => {
    const malicious = sanitize('<script>alert(1)</script><p onclick="x">Text</p>');
    const mail = transactionalLayout({
      subject: 'Test',
      html: malicious,
      text: textFrom(malicious),
    });
    expect(mail.html).not.toContain('alert(1)');
    expect(mail.html).not.toMatch(/onclick/i);
  });

  it('bleibt ein gültiges Dokument, auch wenn der Rumpf leer ist', () => {
    const mail = transactionalLayout({ subject: 'Test', html: '', text: '' });
    expect(mail.html).toContain('<body');
    expect(mail.html.trimEnd()).toMatch(/<\/html>$/);
    // Auch ohne Rumpf bleibt die Anbieterkennung — sie ist keine Zugabe zum
    // Inhalt, sondern eine Angabe ueber den Absender.
    expect(mail.text.trim().startsWith(houseDetails()[0]!)).toBe(true);
  });

  it('enthält weder Bild noch Skript noch fremde Ressource', () => {
    const mail = marketingLayout(body(), {
      unsubscribeLink: UNSUBSCRIBE_LINK,
    });
    expect(mail.html).not.toMatch(/<img/i);
    expect(mail.html).not.toMatch(/<script/i);
    expect(mail.html).not.toMatch(/<link/i);
    expect(mail.html).not.toMatch(/@font-face/i);
    expect(mail.html).not.toMatch(/background-image/i);
    // Die VOLLSTAENDIGE Menge der Adressen im Dokument — Abmeldelink plus
    // die vier des Hauses, sonst nichts. Weiterhin eine Mengengleichheit
    // und kein `toContain`: Eine vierte Adresse faellt auf.
    const urls = mail.html.match(/https?:\/\/[^"'\s<]+/g) ?? [];
    expect(urls.sort()).toEqual(
      [UNSUBSCRIBE_LINK, ...houseLinks().map((l) => l.url)].sort(),
    );
  });

  /**
   * =======================================================================
   * EINE UNBRECHBARE ADRESSE SPRENGT DIE KARTE NICHT MEHR [A.32]
   * =======================================================================
   *
   * Gemessen an der echten Bestätigungsmail: Der Link des Double-Opt-in ist
   * 105 Zeichen ohne ein einziges Leerzeichen. `max-width:600px` auf einem
   * `<table>` ist keine harte Grenze — eine Tabelle rechnet ihre
   * Mindestbreite aus dem längsten unbrechbaren Inhalt und wächst darüber
   * hinaus. Die Bestätigungsmail war deshalb sichtbar breiter als jede
   * andere; im Postfach nebeneinander fiel es sofort auf.
   *
   * Geprüft wird beides zusammen, weil keines allein reicht: die feste
   * Spaltenberechnung an der Tabelle und die Umbrucherlaubnis in den Zellen,
   * die Text tragen. Die Kopfzelle braucht sie nicht — dort steht nur die
   * Wortmarke.
   */
  it('bricht eine unbrechbare Adresse, statt die Karte zu sprengen', () => {
    const link = `https://verwaltung.example.com/api/consent/confirmation/${'a'.repeat(60)}`;
    const text = `Hier entlang:\n\n    ${link}\n`;
    const mail = marketingLayout(
      { subject: 'Test', html: htmlFromText(text), text },
      { unsubscribeLink: UNSUBSCRIBE_LINK },
    );

    expect(mail.html).toContain('table-layout:fixed');

    // Rumpf- und Fusszeilenzelle tragen beide Regeln; die Kopfzelle nicht.
    const cells = [...mail.html.matchAll(/<td[^>]*style="([^"]*)"/g)].map(
      (hit) => hit[1] ?? '',
    );
    const withWrap = cells.filter((style) =>
      /word-break:break-word/.test(style) && /overflow-wrap:anywhere/.test(style),
    );
    // Vier Zellen: die aeussere Huelle mit dem Aussenabstand, der Kopf mit
    // der Wortmarke, der Rumpf und die Fusszeile. Umbrechen duerfen die
    // beiden, die Text tragen.
    expect(cells).toHaveLength(4);
    expect(withWrap).toHaveLength(2);
  });

  it('trägt keine Spur einer Öffnungs- oder Klickmessung', () => {
    const mail = marketingLayout(body(), {
      unsubscribeLink: UNSUBSCRIBE_LINK,
    });
    for (const pattern of [/utm_/i, /pixel/i, /\/open\b/i, /track/i, /redirect/i]) {
      expect(mail.html).not.toMatch(pattern);
      expect(mail.text).not.toMatch(pattern);
    }
  });
});

/**
 * ===========================================================================
 * DIE MARKE LÄUFT NICHT AUSEINANDER
 * ===========================================================================
 *
 * Dasselbe Testmuster wie in `../../einwilligung/seiten.spec.ts` — und aus
 * demselben Anlass: Dort stand die Fläche als `#f7f7f5` statt `#f6f7f5`, aus
 * dem Gedächtnis nachgebaut, ein Zeichen daneben, monatelang unbemerkt. Der
 * Test liest die echte Token-Datei und hält jeden Wert dagegen.
 */
describe('Der Rahmen benutzt die Farben des Projekts', () => {
  const TOKENS_CSS = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages',
    'ui',
    'src',
    'tokens.css',
  );

  function fromTokens(name: string): string {
    const content = readFileSync(TOKENS_CSS, 'utf8');
    const hit = new RegExp(`--${name}:\\s*([^;]+);`).exec(content);
    if (!hit) throw new Error(`Token --${name} steht nicht in tokens.css.`);
    return hit[1]!.trim();
  }

  it('findet die Token-Datei überhaupt (sonst prüft der Test nichts)', () => {
    expect(readFileSync(TOKENS_CSS, 'utf8').length).toBeGreaterThan(200);
  });

  it.each([
    ['farbe-flaeche', MAIL_TOKENS.surface],
    ['farbe-flaeche-2', MAIL_TOKENS.surface2],
    ['farbe-text', MAIL_TOKENS.text],
    ['farbe-text-leise', MAIL_TOKENS.textMuted],
    ['farbe-rahmen', MAIL_TOKENS.layout],
    ['farbe-primaer', MAIL_TOKENS.primary],
  ])('stimmt bei --%s mit dem Projekt überein', (name, transcript) => {
    expect(transcript).toBe(fromTokens(name));
  });

  it('benutzt im erzeugten Dokument AUSSCHLIESSLICH diese Werte', () => {
    // Schärfer als die Prüfung in `seiten.spec.ts`: E-Mail-HTML braucht die
    // Farben inline an jedem Element, eine `:root`-Deklaration käme nicht an.
    // Also darf kein einziger Hex-Wert im Dokument stehen, der nicht aus der
    // Abschrift stammt — ein „schnell mal" eingefügtes Grau fällt sofort auf.
    const mail = marketingLayout(body(), {
      unsubscribeLink: UNSUBSCRIBE_LINK,
    });
    const found = new Set(
      (mail.html.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((value) =>
        value.toLowerCase(),
      ),
    );
    expect([...found].sort()).toEqual([...MAIL_COLOR_VALUES].sort());
    expect(mail.html).not.toMatch(/rgba?\(/i);
  });

  it('benutzt eine Schrift, die kein Postfach nachladen muss', () => {
    const mail = transactionalLayout(body());
    expect(mail.html).toContain(MAIL_FONT);
    // Die Webfonts der Anwendung kommen in einer Mail nie an.
    expect(mail.html).not.toContain('Hanken Grotesk');
    expect(mail.html).not.toContain('Source Serif');
  });
});

describe('Etappe 7 — die Fusszeile nennt das Einwilligungsdatum', () => {
  const BODY = { subject: 'Betreff', html: '<p>Text.</p>', text: 'Text.' };
  const LINK = 'https://verwaltung.example/api/consent/unsubscribe/t';

  /**
   * Der Entwurf verlangt den Satz ausdrücklich („Sie erhalten diese Mail,
   * weil Sie am TT.MM.JJJJ eingewilligt haben"), und das ist mehr als
   * Höflichkeit: Ohne Datum ist der Satz eine Behauptung, mit Datum eine
   * Angabe, die sich nachprüfen lässt.
   */
  it('nennt das Datum in BEIDEN Fassungen', () => {
    const mail = marketingLayout(BODY, {
      unsubscribeLink: LINK,
      consentedAt: '03.03.2026',
    });
    expect(mail.html).toContain('am 03.03.2026');
    expect(mail.text).toContain('am 03.03.2026');
  });

  it('ERFINDET KEINES, wenn keines vorliegt', () => {
    // Eine Einwilligung aus der Zeit vor dem Feld hat keinen Zeitpunkt. Ein
    // erfundenes Datum wäre genau der Fehler, den der Satz belegen soll.
    const mail = marketingLayout(BODY, { unsubscribeLink: LINK });
    expect(mail.html).toContain('eingetragen und deine Adresse bestätigt hast');
    expect(mail.html).not.toContain('am undefined');
    expect(mail.html).not.toMatch(/am\s*\./);
  });

  it('behandelt eine leere Angabe wie eine fehlende', () => {
    const mail = marketingLayout(BODY, {
      unsubscribeLink: LINK,
      consentedAt: '   ',
    });
    expect(mail.html).not.toContain('am  ');
    expect(mail.html).toContain('bestätigt hast.');
  });

  it('HÄLT TEXT- UND HTML-FUSSZEILE IM GLEICHLAUT', () => {
    // `werbeFusszeileText` und `werbeRahmen` müssen denselben Wortlaut
    // ergeben — sonst prüft die Versandprüfung etwas anderes als das, was
    // hinausgeht.
    const mail = marketingLayout(BODY, {
      unsubscribeLink: LINK,
      consentedAt: '03.03.2026',
    });
    const onlyText = marketingFooterText(LINK, '03.03.2026');
    expect(mail.text).toContain(onlyText);
  });
});
