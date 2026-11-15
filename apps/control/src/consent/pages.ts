import { mailBrand } from '@saas-instant/shared';
/**
 * KLEINE HTML-SEITEN FÜR BESTÄTIGUNG UND ABMELDUNG.
 *
 * ===========================================================================
 * WARUM DAS HIER UND NICHT IN DER OBERFLÄCHE STEHT
 * ===========================================================================
 *
 * Beide Links werden AUS EINEM POSTFACH heraus angeklickt, von jemandem, der
 * kein Konto hat und keines bekommen soll. Eine Route, die dafür JSON
 * zurückgibt, zeigt im Browser eine geschweifte Klammer — das ist keine
 * Antwort auf „bin ich jetzt abgemeldet?".
 *
 * Die Seiten sind bewusst winzig, ohne Bilder, ohne Schriftarten von fremden
 * Servern, ohne JavaScript und ohne Zählpixel. Ein Abmeldevorgang darf keine
 * Verbindung zu Dritten aufbauen — und die Verbotsliste des Auftrags nennt
 * Zählpixel und umgeleitete Links ausdrücklich.
 *
 * DER GLOBALE FEHLERFILTER antwortet mit JSON. Deshalb werfen die beiden
 * Routen nicht, sondern rendern ihre Fehlerfälle selbst als Seite mit dem
 * passenden Status.
 */

/**
 * ===========================================================================
 * DIE FARBEN STEHEN HIER — UND ES SIND DIE ECHTEN PROJEKTWERTE
 * ===========================================================================
 *
 * Ein Design-Befund hat rohe Hex-Werte an dieser Stelle beanstandet, und zu
 * Recht: Anders als das PDF-Stylesheet landen diese Seiten in einem BROWSER.
 * Die Ausnahme, die für den Druck gilt, deckt sie nicht.
 *
 * WARUM SIE TROTZDEM NICHT AUS `packages/ui/src/tokens.css` GELESEN WERDEN:
 * Die Seite wird SERVERSEITIG gerendert und lädt kein Stylesheet — bewusst.
 * Sie wird aus einem fremden Postfach angeklickt, oft ohne Sitzung, manchmal
 * in einem Vorschaufenster; sie darf keine zweite Verbindung aufbauen, weder
 * für CSS noch für Schriften. Ein Backend-Bündel, das `tokens.css` einliest,
 * gäbe es dafür nicht: `nest build` hat keinen CSS-Loader.
 *
 * DIE AUFLÖSUNG IST NICHT „AUSNAHME", SONDERN „ABGESICHERTE ABSCHRIFT":
 * Die Werte unten sind Zeichen für Zeichen die aus `tokens.css`, und
 * `seiten.spec.ts` liest diese Datei und hält sie dagegen. Ändert jemand die
 * Marke, wird der Test rot und nennt beide Werte. Damit ist die Abschrift
 * genauso verbindlich wie ein Import — nur ohne die Verbindung nach draussen,
 * die es hier nicht geben darf.
 */
export const PAGES_TOKENS = {
  /** `--farbe-flaeche` — Karten. */
  surface: '#ffffff',
  /** `--farbe-flaeche-2` — Seitenhintergrund. */
  surface2: '#f6f7f5',
  /** `--farbe-text` — Primärtext. */
  text: '#1e2621',
  /** `--farbe-text-leise` — Sekundärtext. */
  textMuted: '#54605a',
  /** `--farbe-rahmen` — Standardrahmen. */
  layout: '#e3e7e1',
  /** `--farbe-primaer` — Marke: Wortmarke, Knopf, Fokus. */
  primary: '#3a7d6b',
  /** `--farbe-primaer-hover` — Knopf unter dem Zeiger. */
  primaryHover: '#2f6a5a',
  /** `--farbe-gefahr` — Fehlermeldungen im Formular (Einwand-Rot). */
  danger: '#c0453f',
} as const;

/**
 * ===========================================================================
 * DIE SEITE SAGT JETZT, WESSEN SEITE SIE IST
 * ===========================================================================
 *
 * Vorher stand der Produktname ausschliesslich im `<title>`, also im Browsertab.
 * Auf der Seite selbst gab es weder Wortmarke noch Anbieterkennung: Wer aus
 * einem fremden Postfach hierher kam, konnte nur an der Adresszeile erkennen,
 * ob er am richtigen Ort ist. Das ist genau die Prüfung, die man von einer
 * Empfaengerin nicht verlangen sollte — und die eine Nachahmung am billigsten
 * unterlaeuft.
 *
 * Die Verweise (Manifest: `mail.legalLinks`) sind ABSOLUT und zeigen auf die Webseite des Betreibers. Relativ
 * gesetzt liefen sie gegen die Verwaltung: Deren nginx faengt jeden
 * unbekannten Pfad mit `index.html` ab, die Oberflaeche leitet auf `/` um, und
 * `/` liegt im geschuetzten Bereich. Wer aus dem Postfach auf „Datenschutz"
 * klickte, landete auf der ANMELDESEITE der Verwaltung — die verwirrendste
 * Antwort, die man geben kann.
 */

export function legalLinks(): readonly { text: string; url: string }[] {
  return mailBrand().links;
}

/**
 * @deprecated Die Verweise kommen aus dem Manifest (`mail.legalLinks`) und
 * stehen erst nach dem Start fest — `rechtslinks()` liefert den aktuellen
 * Stand. Diese Konstante ist die neutrale Vorgabe (keine Verweise).
 */
export const LEGAL_LINKS: readonly { text: string; url: string }[] = [];

/** Escaped alles, was den HTML-Kontext verlassen könnte. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * ===========================================================================
 * KOPF UND FUSS LIEGEN FREI [A.35]
 * ===========================================================================
 *
 * Das Aufnahmeformular braucht dieselbe Huelle: kein JavaScript, keine
 * Fremdressource, `noindex`, die Hausschrift, die Wortmarke, die
 * Rechtsverweise. Es braucht aber ETWAS ANDERES DAZWISCHEN — Eingabefelder,
 * mehrere Schritte, eine Fehlerliste.
 *
 * `seite()` dafuer zu ueberladen hiesse, einer Funktion mit einem Knopf einen
 * zweiten Zweck aufzuladen, bis sie beides halb kann. Stattdessen liegen Kopf
 * und Fuss frei, und jede Seite setzt ihren eigenen Rumpf dazwischen.
 *
 * DIE ZUSICHERUNGEN GELTEN DAMIT FUER BEIDE — aber nur, weil sie auch fuer
 * beide GEPRUEFT werden: `aufnahme/formular-seiten.spec.ts` wiederholt sie.
 * Ein gemeinsamer Baustein beweist nichts ueber den zweiten Aufrufer, solange
 * niemand ihn misst.
 */
export function pagesHeader(heading: string): string {
  return [
    '<!doctype html>',
    '<html lang="de">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Suchmaschinen haben auf einer Seite mit Token in der Adresse nichts zu
    // suchen. Die RobotsMiddleware setzt zusätzlich den Header.
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(heading)} – ${escapeHtml(mailBrand().name)}</title>`,
    '<style>',
    // Die Marke als CSS-Variablen, wie in der Anwendung — nur eben hier
    // deklariert statt geladen. Herkunft und Absicherung: siehe oben.
    `:root{--farbe-flaeche:${PAGES_TOKENS.surface};`,
    `--farbe-flaeche-2:${PAGES_TOKENS.surface2};`,
    `--farbe-text:${PAGES_TOKENS.text};`,
    `--farbe-text-leise:${PAGES_TOKENS.textMuted};`,
    `--farbe-rahmen:${PAGES_TOKENS.layout};`,
    `--farbe-primaer:${PAGES_TOKENS.primary};`,
    `--farbe-primaer-hover:${PAGES_TOKENS.primaryHover};`,
    `--farbe-gefahr:${PAGES_TOKENS.danger};}`,
    // ===================================================================
    // DIE HAUSSCHRIFT, VOM EIGENEN SERVER
    // ===================================================================
    //
    // Die Regel lautet „keine Verbindung zu DRITTEN", nicht „keine
    // Schrift". Diese beiden Dateien liegen unter derselben Herkunft wie
    // die Seite selbst; die CSP der Verwaltung erlaubt genau das
    // (`font-src 'self'`, ops/nginx/sicherheitskopfzeilen.conf). Niemand
    // ausserhalb erfaehrt dadurch etwas.
    //
    // DER PFAD IST FEST UND DESHALB NICHT DER DER OBERFLÄCHE: Vite gibt
    // den Schriften im Bündel einen Hash im Namen. Die Oberfläche bekommt
    // ihn aus dem Bündel, diese Seite wird serverseitig als Zeichenkette
    // gebaut und kann ihn nicht kennen. `scripts/copy-fonts.mjs`
    // legt die zwei lateinischen Teilmengen beim Bauen unter festem Namen
    // in `public/` ab.
    //
    // `font-display:swap`: Die Seite ist sofort lesbar, auch wenn die
    // Schrift noch laedt oder gar nicht ankommt. Der Systemstapel bleibt
    // deshalb als Rueckfallebene stehen.
    "@font-face{font-family:'Hanken Grotesk';font-style:normal;",
    'font-weight:100 900;font-display:swap;',
    "src:url('/fonts/hanken-grotesk-latin-wght-normal.woff2') format('woff2');}",
    "@font-face{font-family:'Source Serif 4';font-style:normal;",
    'font-weight:200 900;font-display:swap;',
    "src:url('/fonts/source-serif-4-latin-wght-normal.woff2') format('woff2');}",
    // OHNE DAS RAGT JEDES EINGABEFELD RECHTS HERAUS: `width:100%` plus
    // Polsterung plus Rahmen ergibt mehr als die Breite des Kastens, und der
    // rechte Abstand ist dann kleiner als der linke. Gemeldet am 07.09.2026.
    '*,*::before,*::after{box-sizing:border-box;}',
    "body{font-family:'Hanken Grotesk',system-ui,-apple-system,\"Segoe UI\",sans-serif;",
    'margin:0;padding:2rem 1.5rem 3rem;',
    'background:var(--farbe-flaeche-2);color:var(--farbe-text);}',
    '.sl-huelle{max-width:34rem;margin:0 auto;}',
    // KOPF: die Wortmarke als Text, wie im Mailrahmen. Kein Bild — ein Logo,
    // das nicht laedt, ist schlechter als gar keines.
    ".sl-marke{font-family:'Source Serif 4',Georgia,'Times New Roman',serif;",
    'font-size:1.3rem;',
    'font-weight:700;color:var(--farbe-primaer);margin:0 0 1.25rem;}',
    'main{background:var(--farbe-flaeche);',
    'border:1px solid var(--farbe-rahmen);border-radius:12px;padding:2rem;}',
    // Überschriften stehen in der Anwendung in der Serife — hier auch.
    "h1{font-family:'Source Serif 4',Georgia,'Times New Roman',serif;",
    'font-size:1.45rem;margin:0 0 1rem;}',
    'p{line-height:1.6;margin:0 0 .75rem;color:var(--farbe-text-leise);}',
    // Der Knopf trägt dieselbe Marke wie die Anwendung, ohne geladenes CSS.
    'button{font:inherit;font-weight:600;cursor:pointer;margin-top:.5rem;',
    'padding:.7rem 1.4rem;border-radius:10px;border:1px solid var(--farbe-primaer);',
    'background:var(--farbe-primaer);color:var(--farbe-flaeche);}',
    'button:hover{background:var(--farbe-primaer-hover);',
    'border-color:var(--farbe-primaer-hover);}',
    'button:focus-visible{outline:3px solid var(--farbe-primaer);outline-offset:2px;}',
    // FUSS: klein und leise, aber vorhanden.
    '.sl-fuss{margin:1.25rem 0 0;font-size:.8125rem;',
    'color:var(--farbe-text-leise);}',
    '.sl-fuss a{color:var(--farbe-text-leise);}',
    '</style>',
    '</head>',
    '<body><div class="sl-huelle">',
    `<p class="sl-marke">${escapeHtml(mailBrand().name)}</p>`,
  ].join('\n');
}

/** Die Fusszeile mit den Rechtsverweisen. Fuer beide oeffentlichen Seiten. */
export function pagesFoot(): string {
  return [
    '<p class="sl-fuss">',
    legalLinks().map(
      (l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.text)}</a>`,
    ).join(' &middot; '),
    '</p>',
    '</div></body></html>',
  ].join('\n');
}

/**
 * Baut eine Seite. `text` wird IMMER escaped — auf diesen Routen gibt es
 * keinen Fremdtext, der HTML sein dürfte.
 */
export function page(
  heading: string,
  text: string,
  /**
   * Ein Formular mit genau einem Knopf, das per POST auf `aktion` schickt.
   *
   * [A.13] Gebraucht für die Bestätigung der Einwilligung: Sie darf NICHT durch
   * einen GET zustande kommen. Mailscanner (Microsoft Safe Links, Proofpoint,
   * Mimecast) rufen Links in eingehender Post ungefragt ab; ein GET, der
   * schreibt, wird dann vom SCANNER ausgelöst und nicht von dem Menschen, dem
   * die Adresse gehört. Der Doppel-Opt-in belegte damit den Scanner — als
   * Nachweis nach Paragraf 7 UWG und Artikel 7 DSGVO wäre er wertlos.
   *
   * Ein POST löst kein Scanner aus. Der Knopf ist zugleich die ehrlichere
   * Oberfläche: Er fragt, statt zu vollenden.
   */
  form?: { action: string; button: string },
): string {
  return [
    pagesHeader(heading),
    // EIN `<main>`, nicht zwei. Hier standen zwei — ein Abschreibfehler mit
    // zwei sichtbaren Folgen: `main` traegt Rahmen und Polsterung, also lag
    // ein Kasten im Kasten; und weil nur ein `</main>` folgte, blieb das
    // Element offen. Gemeldet am 07.09.2026 an der ausgerollten Fassung.
    '<main>',
    `<h1>${escapeHtml(heading)}</h1>`,
    ...text.split('\n\n').map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    ...(form
      ? [
          `<form method="post" action="${escapeHtml(form.action)}">`,
          `<button type="submit">${escapeHtml(form.button)}</button>`,
          '</form>',
        ]
      : []),
    '</main>',
    pagesFoot(),
  ].join('\n');
}
