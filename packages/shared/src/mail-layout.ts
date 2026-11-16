/**
 * ===========================================================================
 * DER GEMEINSAME MAILRAHMEN — Kopf, Karte, Fusszeile
 * ===========================================================================
 *
 * JEDE Mail des Produkts trägt denselben Kopf (die Wortmarke in
 * Serife) und dieselbe Fusszeile (die Anbieterkennung mit Impressum,
 * Datenschutz und AGB) — gleich, welche Anwendung sie verschickt
 * („Passwort zurücksetzen", Einladung, Anmeldecode, Benachrichtigung …).
 *
 * WARUM HIER. Zwei Fassungen derselben Marke laufen auseinander — eine
 * Vorlage mit Anbieterkennung und eine mit einem Satz statt der
 * Pflichtangaben. Deshalb gibt es genau eine Quelle, und jede Anwendung
 * rendert daraus.
 *
 * WAS HIER NICHT STEHT: der Rumpf. Wie ein Rumpf entsteht, entscheidet jede
 * Anwendung selbst — die Instanz etwa setzt Knopf und Code-Kasten. Der Rahmen nimmt den
 * fertigen Rumpf und legt Kopf und Fusszeile darum. Die Hausangaben setzt er
 * SELBST ein; es gibt keinen Parameter, mit dem ein Aufrufer sie weglassen
 * könnte.
 *
 * Tabellenlayout und Inline-Stile, weil E-Mail-Programme weder Flexbox noch
 * eine verlässliche Kaskade kennen. Jede Fläche trägt ihre Farbe doppelt (als
 * `bgcolor` und als `background-color`), und Text- und Flächenfarbe stehen
 * immer als Paar: Manche Programme drehen eigenmächtig auf dunkel um und
 * erwischen dabei nur eine der beiden Angaben.
 */

/**
 * Die Farbwerte der Marke — abgeschrieben aus `packages/ui/src/tokens.css`.
 * Eine E-Mail lädt kein Stylesheet; die Werte müssen im Quelltext stehen.
 * Wer dort einen Wert ändert, ändert ihn hier mit.
 */
export const MAIL_TOKENS = {
  /** `--farbe-flaeche` — die Karte, auf der die Mail steht. */
  surface: '#ffffff',
  /** `--farbe-flaeche-2` — der Hintergrund um die Karte herum. */
  surface2: '#f8fafc',
  /** `--farbe-text` — Fliesstext. */
  text: '#0f172a',
  /** `--farbe-text-leise` — Fusszeile und Nebensätze. */
  textMuted: '#425064',
  /** `--farbe-rahmen` — Kartenrand und Trennlinie über der Fusszeile. */
  layout: '#e2e8f0',
  /** `--farbe-primaer` — Wortmarke und Verweise. */
  primary: '#0369a1',
  /** `--farbe-flaeche-4` — die abgesetzte Fläche der Fusszeile. */
  surface4: '#fbfcfe',
} as const;

/**
 * Serife für Wortmarke und Überschriften. Georgia ist auf praktisch jedem
 * Gerät installiert — anders als ein Webfont kommt sie in der Mail an.
 */
export const MAIL_SERIF = "Georgia, 'Times New Roman', 'Nimbus Roman', serif";

/**
 * Die Grundschrift. EINFACHE Anführungszeichen um „Segoe UI": Der Wert steht
 * in `style="…"`-Attributen, und doppelte hätten das Attribut vorzeitig
 * beendet — so geschehen in jeder Mail, bis ein Test das geparste Dokument
 * prüfte.
 */
export const MAIL_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Alle Farbwerte als flache Liste — für Tests, die rohe Hex-Werte suchen. */
export const MAIL_COLOR_VALUES: readonly string[] = Object.values(MAIL_TOKENS);

/**
 * Die Marke des Mailrahmens: Wortmarke im Kopf, Anbieterkennung und Verweise
 * der Fusszeile (§ 5 DDG).
 *
 * NICHT FEST IM QUELLTEXT: Wer das Produkt betreibt, trägt Namen, Anbieter-
 * angaben und Verweise im Manifest ein (`mail`/`product`). Die Verwaltung
 * ruft beim Start `setMailBrand` auf. Ohne Aufruf gilt die neutrale
 * Vorgabe — Wortmarke ohne Anbieterzeilen. Die Fusszeile setzt der Rahmen
 * weiterhin SELBST ein: `houseFooter()` hat keinen Parameter, über den ein
 * Aufrufer sie weglassen oder austauschen könnte.
 */
export interface MailBrand {
  /** Wortmarke im Kopf jeder Mail (Produktname). */
  name: string;
  /** Anbieterzeilen der Fusszeile (Impressumsangaben), eine Zeile je Eintrag. */
  details: readonly string[];
  /** Absolute Adresse der Webseite; null, wenn es keine gibt. */
  url: string | null;
  /** Verweise der Fusszeile, absolut und ohne Parameter. */
  links: readonly { text: string; url: string }[];
}

/** Neutrale Vorgabe, solange nichts konfiguriert ist. */
export const MAIL_BRAND_DEFAULT: MailBrand = {
  name: 'SAAS Verwaltung',
  details: [],
  url: null,
  links: [],
};

let currentBrand: MailBrand = MAIL_BRAND_DEFAULT;

/** Setzt die Marke des Mailrahmens (Aufruf beim Start, aus dem Manifest). */
export function setMailBrand(brand: MailBrand): void {
  currentBrand = {
    name: brand.name,
    details: [...brand.details],
    url: brand.url,
    links: brand.links.map((l) => ({ ...l })),
  };
}

/** Die gerade gültige Marke. */
export function mailBrand(): MailBrand {
  return currentBrand;
}

/** Escaped Text für die Einbettung in HTML (Inhalt wie Attribut). */
export function escapeMailText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Ein Fusszeilenblock, fertig in beiden Fassungen. */
export interface MailFooter {
  html: string;
  text: string;
}

/**
 * Die Anbieterkennung als Fusszeile — OHNE ARGUMENTE. Ein Parameter wäre der
 * Schalter, über den sich eines Tages ein Abmeldelink oder ein
 * Redaktionstext hineinreichen liesse.
 */
export function houseFooter(): MailFooter {
  const t = MAIL_TOKENS;
  const brand = mailBrand();
  const references = brand.links.map(
    (l) =>
      `<a href="${escapeMailText(l.url)}" style="color:${t.textMuted};">` +
      `${escapeMailText(l.text)}</a>`,
  ).join(' &middot; ');

  const paragraphs: string[] = [];
  if (brand.details.length > 0) {
    paragraphs.push(
      `<p style="margin:0 0 8px;font-size:12px;color:${t.textMuted};">` +
        brand.details.map((line) => escapeMailText(line)).join('<br>') +
        '</p>',
    );
  }
  if (brand.links.length > 0) {
    paragraphs.push(
      `<p style="margin:0;font-size:12px;color:${t.textMuted};">${references}</p>`,
    );
  }
  // Ohne Angaben und Verweise bleibt eine leere Zeile statt eines kaputten Blocks.
  const html = paragraphs.length > 0 ? paragraphs.join('') : '&nbsp;';

  // Im Textteil die Adressen ausgeschrieben: Ein Linktext ohne Adresse ist
  // dort wertlos.
  const textParts = [...brand.details];
  if (brand.links.length > 0) {
    if (textParts.length > 0) textParts.push('');
    textParts.push(...brand.links.map((l) => l.url));
  }
  const text = textParts.join('\n');

  return { html, text };
}

/** Wie viele Zeichen der abgeleitete Vorschautext höchstens hat. */
const PREHEADER_CHARS = 90;

/** Kürzt einen Text auf einen brauchbaren Vorschautext (Postfachliste). */
export function preheaderFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= PREHEADER_CHARS) return oneLine;
  const shortened = oneLine.slice(0, PREHEADER_CHARS);
  const gap = shortened.lastIndexOf(' ');
  // Lieber am letzten ganzen Wort abschneiden als mitten hinein.
  return `${gap > 40 ? shortened.slice(0, gap) : shortened}…`;
}

export interface MailDocumentParts {
  /** Der `<title>` — BEREITS als HTML escaped (jede App escaped selbst). */
  titleHtml: string;
  /** Der Vorschautext — BEREITS escaped. */
  previewHtml: string;
  /** Der fertige Rumpf als HTML. Für seinen Inhalt steht der Aufrufer ein. */
  bodyHtml: string;
  /**
   * Ein Block ÜBER den Hausangaben — etwa eine werbliche Fusszeile
   * (Einwilligung, Abmeldelink). Die Hausangaben stehen immer.
   */
  extraFooterHtml?: string;
}

/**
 * Das HTML-Dokument: Kopf mit Wortmarke, Rumpf, Fusszeile auf eigener Fläche.
 *
 * DIE REIHENFOLGE IN DER FUSSZEILE IST PFLICHT: der Zusatz zuerst, die
 * Hausangaben darunter — so wie in `mailText`.
 */
export function mailDocument(parts: MailDocumentParts): string {
  const t = MAIL_TOKENS;
  const house = houseFooter();
  const footerHtml =
    parts.extraFooterHtml !== undefined
      ? `${parts.extraFooterHtml}<div style="height:16px;line-height:16px;">&nbsp;</div>${house.html}`
      : house.html;

  return [
    '<!doctype html>',
    '<html lang="de">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Die Anwendung hat keinen Dunkelmodus; eine Mail, die einen erfindet,
    // wäre eine Markenentscheidung ohne Auftrag.
    '<meta name="color-scheme" content="light">',
    '<meta name="supported-color-schemes" content="light">',
    `<title>${parts.titleHtml}</title>`,
    '<style>',
    // Die EINZIGE Regel im Stylesheet: schmalere Innenabstände auf kleinen
    // Bildschirmen. Wer sie nicht versteht, ignoriert sie.
    '@media screen and (max-width:480px){',
    '.sl-inner{padding-left:20px !important;padding-right:20px !important;}',
    '}',
    '</style>',
    '</head>',
    `<body style="margin:0;padding:0;background-color:${t.surface2};` +
      `color:${t.text};">`,
    // Vorschautext: unsichtbar im Dokument, sichtbar in der Postfachliste.
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;' +
      `mso-hide:all;">${parts.previewHtml}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
      `border="0" bgcolor="${t.surface2}" ` +
      `style="background-color:${t.surface2};border-collapse:collapse;">`,
    '<tr><td align="center" style="padding:32px 16px;">',
    // `table-layout:fixed` UND Umbruchregeln in den Zellen: `max-width` auf
    // einem `<table>` ist keine harte Grenze, ein langer Link zöge die Karte
    // sonst auseinander.
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
      `border="0" bgcolor="${t.surface}" ` +
      `style="max-width:600px;background-color:${t.surface};` +
      `border:1px solid ${t.layout};border-radius:12px;` +
      'border-collapse:separate;table-layout:fixed;">',
    // KOPF: die Wortmarke als Text, in Serife. Kein Bild — Bilder laden viele
    // Postfächer erst auf Nachfrage.
    `<tr><td class="sl-inner" style="padding:28px 32px 20px;">`,
    `<p style="margin:0;font-family:${MAIL_SERIF};font-size:20px;` +
      `line-height:1.3;font-weight:700;color:${t.primary};">${escapeMailText(mailBrand().name)}</p>`,
    '</td></tr>',
    // RUMPF. `word-break` für Outlooks Word-Renderer, `overflow-wrap` für
    // alle anderen.
    `<tr><td class="sl-inner" style="padding:0 32px 28px;font-family:${MAIL_FONT};` +
      `font-size:15.5px;line-height:1.6;color:${t.text};` +
      'word-break:break-word;overflow-wrap:anywhere;">',
    parts.bodyHtml,
    '</td></tr>',
    // FUSSZEILE auf eigener Fläche: sichtbar ein anderer Teil als der Rumpf.
    `<tr><td class="sl-inner" bgcolor="${t.surface4}" ` +
      `style="padding:20px 32px 28px;background-color:${t.surface4};` +
      `border-top:1px solid ${t.layout};font-family:${MAIL_FONT};` +
      `font-size:12.5px;line-height:1.6;color:${t.textMuted};` +
      'word-break:break-word;overflow-wrap:anywhere;">',
    footerHtml,
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('\n');
}

/** Der Textteil: Rumpf, darunter (optional) der Zusatz, dann die Hausangaben. */
export function mailText(bodyText: string, extraFooterText?: string): string {
  const house = houseFooter();
  const fuss =
    extraFooterText !== undefined ? `${extraFooterText}\n\n${house.text}` : house.text;
  return fuss.trim() === '' ? bodyText.trimEnd() : `${bodyText.trimEnd()}\n\n${fuss}`;
}
