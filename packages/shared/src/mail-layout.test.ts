import { afterEach, describe, expect, it } from 'vitest';
import {
  MAIL_BRAND_DEFAULT,
  MAIL_SERIF,
  escapeMailText,
  houseFooter,
  mailDocument,
  mailText,
  mailBrand,
  preheaderFrom,
  setMailBrand,
} from './mail-layout';

const PARTS = { titleHtml: 'Betreff', previewHtml: 'Vorschau', bodyHtml: '<p>Rumpf</p>' };

const HOUSE_DETAILS = ['Beispiel GmbH, Musterweg 1, 12345 Musterstadt', 'USt-IdNr. DE000000000'];
const HOUSE_LINKS = [
  { text: 'example.com', url: 'https://example.com' },
  { text: 'Impressum', url: 'https://example.com/impressum' },
];

function applyBrand(): void {
  setMailBrand({
    name: 'Beispielprodukt',
    details: HOUSE_DETAILS,
    url: 'https://example.com',
    links: HOUSE_LINKS,
  });
}

afterEach(() => setMailBrand(MAIL_BRAND_DEFAULT));

describe('Der gemeinsame Mailrahmen', () => {
  it('ist ohne Konfiguration neutral: Wortmarke SAAS Verwaltung, keine Anbieterzeilen', () => {
    expect(mailBrand()).toEqual(MAIL_BRAND_DEFAULT);
    const html = mailDocument(PARTS);
    expect(html).toMatch(/>SAAS Verwaltung<\/p>/);
    expect(houseFooter().text).toBe('');
    expect(mailText('Rumpf')).toBe('Rumpf');
  });

  it('trägt im Kopf die konfigurierte Wortmarke in Serife', () => {
    applyBrand();
    const html = mailDocument(PARTS);
    expect(html).toContain(`font-family:${MAIL_SERIF}`);
    expect(html).toMatch(/>Beispielprodukt<\/p>/);
    // Kopf VOR Rumpf.
    expect(html.indexOf('>Beispielprodukt</p>')).toBeLessThan(html.indexOf('<p>Rumpf</p>'));
  });

  it('escaped den Markennamen', () => {
    setMailBrand({ ...MAIL_BRAND_DEFAULT, name: 'A <b> & B' });
    expect(mailDocument(PARTS)).toContain('>A &lt;b&gt; &amp; B</p>');
  });

  it('setzt die Anbieterkennung immer ein — jede Zeile und alle Verweise', () => {
    applyBrand();
    const html = mailDocument(PARTS);
    for (const line of HOUSE_DETAILS) expect(html).toContain(escapeMailText(line));
    for (const l of HOUSE_LINKS) expect(html).toContain(`href="${l.url}"`);
    expect(html).toContain(houseFooter().html);
  });

  it('stellt einen Zusatz ÜBER die Hausangaben, in HTML und Text', () => {
    applyBrand();
    const html = mailDocument({ ...PARTS, extraFooterHtml: '<p>ZUSATZ</p>' });
    expect(html.indexOf('ZUSATZ')).toBeLessThan(html.indexOf(escapeMailText(HOUSE_DETAILS[0])));

    const text = mailText('Rumpf', 'ZUSATZ');
    expect(text.indexOf('ZUSATZ')).toBeLessThan(text.indexOf(HOUSE_DETAILS[0]));
  });

  it('hängt die Hausangaben an den Textteil — mit ausgeschriebenen Adressen', () => {
    applyBrand();
    const text = mailText('Hallo,\n\nRumpf.\n\n\n');
    expect(text.startsWith('Hallo,\n\nRumpf.\n\n')).toBe(true);
    for (const line of HOUSE_DETAILS) expect(text).toContain(line);
    for (const l of HOUSE_LINKS) expect(text).toContain(l.url);
  });

  it('escaped Titel und Vorschau nicht selbst — das tut der Aufrufer', () => {
    expect(mailDocument({ ...PARTS, titleHtml: 'A &amp; B' })).toContain('<title>A &amp; B</title>');
  });

  it('kürzt den Vorschautext am letzten ganzen Wort', () => {
    const long = 'wort '.repeat(40);
    const short = preheaderFrom(long);
    expect(short.endsWith('…')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(91);
    expect(preheaderFrom('  kurz   und\nknapp ')).toBe('kurz und knapp');
  });
});
