import { readFileSync } from 'fs';
import { join } from 'path';
import { setTestBrand } from '../mail/layout/test-brand';
import { escapeHtml, legalLinks, page, PAGES_TOKENS } from './pages';

beforeAll(() => setTestBrand());

describe('Die Seiten aus dem Postfach', () => {
  it('lässt nichts aus dem HTML-Kontext ausbrechen', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("O'Brien & Co")).toBe('O&#39;Brien &amp; Co');
  });

  it('escaped auch die Überschrift, nicht nur den Text', () => {
    const html = page('<b>Titel</b>', 'Text');
    expect(html).toContain('&lt;b&gt;Titel&lt;/b&gt;');
    expect(html).not.toContain('<b>Titel</b>');
  });

  it('macht aus Leerzeilen Absätze', () => {
    const html = page('Titel', 'Erster Absatz.\n\nZweiter Absatz.');
    expect(html).toContain('<p>Erster Absatz.</p>');
    expect(html).toContain('<p>Zweiter Absatz.</p>');
  });

  /**
   * Eine Seite mit einem Token in der Adresse gehört in keinen Index. Und ein
   * Abmeldevorgang darf keine Verbindung zu Dritten aufbauen — kein
   * JavaScript, keine Bilder, keine Schriften von fremden Servern.
   */
  it('ist in sich geschlossen und nicht indexierbar', () => {
    const html = page('Titel', 'Text');
    expect(html).toContain('noindex, nofollow');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    // Kein eingebundenes Stylesheet: Der Stil steht im Dokument.
    expect(html).not.toMatch(/<link/i);
  });

  /**
   * =======================================================================
   * „KEINE VERBINDUNG ZU DRITTEN" — die Regel, nicht ihr Stellvertreter
   * =======================================================================
   *
   * Die Seite laedt seit [A.31] die Hausschrift. Das ist kein Bruch der
   * Zusage, sondern ihre genaue Lesart: Verboten ist die Verbindung zu
   * DRITTEN, nicht jede Verbindung. Die zwei Dateien liegen unter derselben
   * Herkunft wie die Seite; die CSP der Verwaltung erlaubt genau das
   * (`font-src 'self'`).
   *
   * Geprueft wird deshalb, was wirklich zaehlt: JEDE ladende Adresse im
   * Dokument ist wurzelrelativ. Ein `url(https://fonts.gstatic.com/...)`
   * faellt durch, ein `url(//irgendwo)` ebenfalls — und zwar unabhaengig
   * davon, ob es eine Schrift, ein Bild oder ein Hintergrund waere.
   */
  it('laedt nichts von einem fremden Server', () => {
    const html = page('Titel', 'Text');
    const loaded = [...html.matchAll(/url\(\s*['"]?([^'")]+)/g)].map(
      (hit) => hit[1] ?? '',
    );

    // Es wird ueberhaupt etwas geladen — sonst prueft der Test nichts.
    expect(loaded.length).toBeGreaterThan(0);
    for (const address of loaded) {
      expect(address.startsWith('/')).toBe(true);
      expect(address.startsWith('//')).toBe(false);
    }
  });

  /**
   * Die Schrift darf ausfallen, ohne dass die Seite unlesbar wird — sie kommt
   * aus einem Postfach, manchmal ueber eine schlechte Verbindung.
   */
  it('behält einen Rückfallstapel, falls die Schrift nicht ankommt', () => {
    const html = page('Titel', 'Text');
    expect(html).toContain('font-display:swap');
    expect(html).toMatch(/font-family:'Inter',[^;]*sans-serif/);
    // Eine einzige Familie: keine Serifenschrift mehr.
    expect(html).not.toMatch(/Source\sSerif|Georgia|Times New Roman/);
  });

  /**
   * =======================================================================
   * WARUM HIER EINE ERLAUBNISLISTE STEHT UND KEIN VERBOT MEHR [A.31]
   * =======================================================================
   *
   * Vorher stand hier `expect(html).not.toMatch(/https?:\/\//i)` — kein
   * einziger absoluter Verweis. Gemeint war damit „diese Seite baut keine
   * Verbindung zu Dritten auf", und solange es keinen Grund für einen Verweis
   * gab, waren beide Sätze deckungsgleich.
   *
   * Sie sind es nicht mehr: Die Seite trägt jetzt eine Anbieterkennung, und
   * die besteht gerade aus Verweisen. Ein `<a href>` LÄDT NICHTS — er baut
   * keine Verbindung auf, bis jemand klickt. Die Zusicherung, um die es
   * wirklich geht, prüfen die Zeilen darüber: kein `<script>`, kein `<img>`,
   * kein `<link>`, kein `@font-face`.
   *
   * Der Ersatz ist deshalb keine Lockerung, sondern eine Verschärfung: Statt
   * „irgendein Verweis wäre falsch" steht hier „genau diese zwei sind
   * richtig, jeder andere ist falsch". Ein eingeschleuster Verweis auf eine
   * fremde Adresse fällt jetzt auf, obwohl er es vorher auch getan hätte —
   * ein Verweis auf `example.com/spende` dagegen fällt NEU auf.
   */
  it('trägt genau die zwei Rechtsverweise und keinen dritten', () => {
    const html = page('Titel', 'Text');
    const urls = html.match(/https?:\/\/[^"'\s<]+/g) ?? [];
    expect(urls.sort()).toEqual(legalLinks().map((l) => l.url).sort());
  });

  /**
   * Wer aus einem fremden Postfach kommt, soll die Seite zuordnen können,
   * ohne die Adresszeile zu lesen. Vorher stand „Beispielprodukt" nur im `<title>`.
   */
  it('nennt die Marke auf der Seite, nicht nur im Titel', () => {
    const html = page('Titel', 'Text');
    const body = html.slice(html.indexOf('<body'));
    expect(body).toContain('Beispielprodukt');
    expect(body).toContain('Impressum');
    expect(body).toContain('Datenschutz');
  });

  /**
   * Die Verweise dürfen NICHT relativ sein: Das nginx der Verwaltung fängt
   * jeden unbekannten Pfad mit `index.html` ab, die Oberfläche leitet auf `/`
   * um, und `/` liegt im geschützten Bereich. Ein relativer Datenschutz-Link
   * führte damit auf die Anmeldeseite der Verwaltung.
   */
  it('verweist absolut auf die Webseite des Betreibers', () => {
    for (const link of legalLinks()) {
      expect(link.url).toMatch(/^https:\/\/example\.com(\/|$)/);
    }
  });
});

/**
 * ===========================================================================
 * DIE ABSCHRIFT DER MARKENFARBEN LÄUFT NICHT AUSEINANDER
 * ===========================================================================
 *
 * Ein Design-Befund hat rohe Hex-Werte in `seiten.ts` beanstandet — zu Recht:
 * Diese Seiten landen in einem Browser, die Ausnahme des PDF-Stylesheets deckt
 * sie nicht. Laden lässt sich `tokens.css` hier aber nicht: Die Seite wird
 * serverseitig gerendert und darf keine zweite Verbindung aufbauen.
 *
 * DIESER TEST MACHT AUS DER ABSCHRIFT EINE VERBINDLICHE. Er liest die echte
 * Token-Datei und hält jeden Wert dagegen. Wer die Marke ändert und diese
 * Seiten vergisst, bekommt einen roten Test mit beiden Werten im Klartext.
 */
describe('Die Seiten benutzen die Farben des Projekts', () => {
  const TOKENS_CSS = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'ui',
    'src',
    'tokens.css',
  );

  /** Liest einen Token-Wert aus `packages/ui/src/tokens.css`. */
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
    ['farbe-flaeche', PAGES_TOKENS.surface],
    ['farbe-flaeche-2', PAGES_TOKENS.surface2],
    ['farbe-text', PAGES_TOKENS.text],
    ['farbe-text-leise', PAGES_TOKENS.textMuted],
    ['farbe-rahmen', PAGES_TOKENS.layout],
    ['farbe-primaer', PAGES_TOKENS.primary],
    ['farbe-primaer-hover', PAGES_TOKENS.primaryHover],
    ['farbe-gefahr', PAGES_TOKENS.danger],
  ])('stimmt bei --%s mit dem Projekt überein', (name, transcript) => {
    expect(transcript).toBe(fromTokens(name));
  });

  it('benutzt im Stylesheet die Variablen und keine rohen Werte mehr', () => {
    const html = page('Titel', 'Text');
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    // Die Deklaration am `:root` ist die EINZIGE Stelle mit Hex-Werten.
    const withoutRoot = style.replace(/:root\{[^}]*\}/, '');
    expect(withoutRoot).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(withoutRoot).not.toMatch(/rgba?\(/i);
    expect(withoutRoot).toContain('var(--farbe-flaeche-2)');
    expect(withoutRoot).toContain('var(--farbe-text)');
  });
});

/**
 * Ein Kasten, nicht zwei. `seite()` gab `<main>` ZWEIMAL aus — ein
 * Abschreibfehler mit zwei sichtbaren Folgen: `main` traegt Rahmen und
 * Polsterung, also lag ein Kasten im Kasten; und weil nur ein `</main>`
 * folgte, blieb das Element offen. Gemeldet am 07.09.2026 an der
 * ausgerollten Fassung.
 */
describe('Die Huelle hat genau einen Rahmen', () => {
  const examples = [
    page('Noch ein Klick', 'Bitte bestaetige.', { action: '/x', button: 'Ja' }),
    page('Danke', 'Deine Adresse ist bestaetigt.'),
  ];

  it.each(examples.map((h, i) => [i, h]))(
    '%s: oeffnet und schliesst <main> genau einmal',
    (_i, html) => {
      expect([...String(html).matchAll(/<main>/g)]).toHaveLength(1);
      expect([...String(html).matchAll(/<\/main>/g)]).toHaveLength(1);
    },
  );
});
