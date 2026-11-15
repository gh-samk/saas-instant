import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../../common/errors/business-error';
import { mailDocument, mailBrand, mailText, preheaderFrom } from '@saas-instant/shared';
import { MAIL_FONT, MAIL_SERIF, MAIL_TOKENS } from './brand';
import { escapeContent, textFrom } from './sanitizer';

/**
 * ===========================================================================
 * DER MAILRAHMEN — Kopf, Rumpf, Fusszeile, für jede Mail derselbe
 * ===========================================================================
 *
 * Jede Mail der Verwaltung geht ab jetzt mit ZWEI Teilen hinaus: einem
 * HTML-Teil und einem Textteil (`multipart/alternative`). Der Textteil ist
 * nicht das Anhängsel, das man später nachreicht — viele Spamfilter lesen ihn
 * zuerst, manche Programme zeigen ausschliesslich ihn, und eine reine
 * HTML-Mail ist ein Zustellungsrisiko. Bei einer Domäne, die ohne DKIM auf
 * `p=quarantine` steht (siehe `../absender.ts`), ist das kein theoretisches.
 *
 * ===========================================================================
 * ZWEI FUNKTIONEN, KEIN KANAL-SCHALTER — und warum das hier besonders zählt
 * ===========================================================================
 *
 * Die naheliegende Bauweise wäre eine Funktion `baueRahmen({ kanal, … })` mit
 * `kanal: 'transaktion' | 'werblich'`. Genau die gibt es hier NICHT.
 *
 * R3 verlangt getrennte Codepfade, und `werbemail.service.ts` sagt im
 * Klassenkommentar, worauf es dabei ankommt: „kein Parameter, kein Flag, keine
 * gemeinsame `versende`-Methode". Ein Kanalfeld am Rahmen wäre wieder genau
 * dieser Schalter — eine falsche Zeichenkette an einer Aufrufstelle, und eine
 * Rechnungsmail trägt einen Abmeldelink oder eine Rundmail keinen. Beides ist
 * ein Fehler, den niemand im Postausgangslog sieht.
 *
 * Deshalb:
 * - `transaktionsRahmen(rumpf)` hat keinen Parameter, in dem ein Abmeldelink
 *   Platz hätte. Es gibt keinen Aufruf, mit dem sich einer hineinreichen liesse.
 * - `werbeRahmen(rumpf, fusszeile)` verlangt einen. Ohne Abmeldelink lässt sich
 *   die Funktion nicht aufrufen, mit einem leeren bricht sie ab.
 *
 * Der gemeinsame Teil — Kopf, Typografie, Farben, Aufbau des Dokuments — ist
 * `baue()` und wird NICHT exportiert. Dieselbe Begründung wie bei
 * `transport.ts`: Gemeinsam benutzt wird das, was nichts entscheidet. Eine
 * zweite Abschrift des Dokumentaufbaus wäre eine zweite Stelle, an der die
 * Marke auseinanderläuft.
 *
 * ===========================================================================
 * WAS DER RAHMEN NICHT TUT
 * ===========================================================================
 *
 * Kein Zählpixel, kein umgeleiteter Link, keine Öffnungsmessung. Es gibt hier
 * kein `<img>` — auch kein „harmloses" Logo von einem Server, denn ein Bild,
 * das beim Öffnen geladen wird, MELDET das Öffnen, ganz gleich wie man es
 * nennt. Ein mitgeschicktes Logo (CID-Anhang) wäre erlaubt und liesse sich
 * später ergänzen; es gibt heute schlicht kein Bildmaterial im Projekt.
 *
 * Der EINZIGE Verweis, den eine Mail enthalten kann, ist der Abmeldelink des
 * werblichen Kanals. Aus dem Redaktionsfeld kommt keiner: Der Säuberer lässt
 * kein `<a>` durch.
 */

/** Der Rumpf einer Mail, in beiden Fassungen. */
export interface Body {
  /**
   * Der Betreff. Steht im `<title>` — manche Postfächer benutzen ihn als
   * Vorschautitel. Sichtbar im Dokument steht er NICHT: Ihn ein zweites Mal
   * über die Nachricht zu setzen ist die häufigste Verdopplung in
   * Mailvorlagen.
   */
  subject: string;
  /**
   * Der Rumpf als HTML-Fragment. MUSS bereits durch `saeubere()` gelaufen
   * sein — der Rahmen säubert nicht selbst, sonst wüsste niemand mehr, wo die
   * Vertrauensgrenze liegt.
   */
  html: string;
  /** Derselbe Rumpf als reiner Text. */
  text: string;
  /**
   * Der Vorschautext, den viele Postfächer neben dem Betreff zeigen.
   *
   * Ohne ihn nähmen sie die ersten Wörter des HTML — und das wäre bei diesem
   * Rahmen immer der Produktname, in jeder Mail dieselben Zeichen. Fehlt er,
   * wird er aus dem TEXTTEIL abgeleitet, nie aus dem HTML: aus dem HTML
   * rutschte ein Tag-Rest mit hinein.
   */
  preheader?: string;
}

/** Was die Fusszeile einer werblichen Mail trägt. */
export interface MarketingFooter {
  /** Der personalisierte Abmeldelink dieser Empfängerin. Pflicht. */
  unsubscribeLink: string;
  /**
   * WANN die Einwilligung bestätigt wurde, als lesbares Tagesdatum
   * (`03.03.2026`). Optional: Einträge aus der Zeit vor dem Feld haben keines,
   * und ein erfundenes Datum wäre genau der Fehler, den der Satz belegen soll.
   */
  consentedAt?: string;
}

/*
 * HIER STAND `anbieter: readonly string[]` — die Anbieterkennung als
 * Parameter des werblichen Kanals ([A.33]).
 *
 * Sie ist keine Eigenschaft dieses Kanals, sondern eine des Absenders: Auch
 * eine Rechnung ist ein Geschäftsbrief. Dass ausgerechnet die Rundmail sie
 * trug und die Rechnung nicht, war die Umkehrung dessen, worauf es ankommt.
 *
 * Sie steht jetzt in `hausFusszeile()` und gilt für BEIDE Kanäle. Der
 * Aufrufer kann sie weder weglassen noch austauschen — es gibt keinen
 * Parameter mehr, über den das ginge.
 */

/** Eine fertige Mail in beiden Fassungen. */
export interface FramedMail {
  html: string;
  text: string;
}

/**
 * Eine werbliche Mail sollte ohne brauchbaren Abmeldelink gerahmt werden.
 *
 * Das ist kein Eingabefehler einer Benutzerin, sondern ein Programmfehler —
 * er kann nur entstehen, wenn ein Aufrufer den Link vergisst oder eine
 * gespeicherte Zeile beschädigt ist. Er wird trotzdem als fachlicher Fehler
 * geworfen und nicht als nackte `Error`: So landet er im einheitlichen
 * Fehlerformat (Regel 3 der Projektkonventionen) statt als 500 ohne Code.
 */
export class LayoutWithoutUnsubscribeLinkError extends BusinessError {
  constructor() {
    super(
      'rahmen_ohne_abmeldelink',
      'Eine werbliche Mail lässt sich ohne Abmeldelink nicht zusammensetzen.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Der Einleitungssatz der werblichen Fusszeile. Steht an genau einer Stelle. */
/**
 * Der Satz, der die Einwilligung benennt — MIT DATUM, wo eines vorliegt.
 *
 * Der Entwurf verlangt ihn ausdrücklich („Sie erhalten diese Mail, weil Sie
 * am TT.MM.JJJJ eingewilligt haben"), und das ist mehr als Höflichkeit: Ohne
 * Datum ist der Satz eine Behauptung, mit Datum eine Angabe, die sich
 * nachprüfen lässt. Wer sich nicht erinnert, am 3. März irgendwo ein Häkchen
 * gesetzt zu haben, hat einen Anhaltspunkt für die Rückfrage.
 *
 * OHNE DATUM BLEIBT DER ALTE SATZ. Eine Einwilligung aus der Zeit vor dem
 * Feld hat keines; eines zu erfinden wäre genau der Fehler, den der Satz
 * belegen soll.
 */
function marketingIntroduction(consentedAt?: string): string {
  const reason =
    `Du bekommst diese Mail, weil du dich für Neuigkeiten von ${mailBrand().name} ` +
    'eingetragen und deine Adresse bestätigt hast';
  return consentedAt === undefined || consentedAt.trim() === ''
    ? `${reason}.`
    : `${reason} — am ${consentedAt.trim()}.`;
}

/** Die Überschrift über dem Abmeldelink. */
const MARKETING_UNSUBSCRIBE = 'Abmelden — ein Klick, keine Rückfrage, sofort wirksam:';

/** Ein Fusszeilenblock, fertig in beiden Fassungen. */
interface Footer {
  html: string;
  text: string;
}

/**
 * DIE ANBIETERKENNUNG steht seit dem 12.09.2026 im GEMEINSAMEN Mailrahmen
 * (`@saas-instant/shared`, `mail-rahmen.ts`), zusammen mit Kopf, Karte und
 * Vorschautext — derselbe Rahmen, den die Kundeninstanzen benutzen. Die
 * Zusicherung bleibt dieselbe: Die Hausangaben setzt der Rahmen selbst ein,
 * es gibt keinen Parameter, sie wegzulassen oder zu verändern, und
 * `transaktionsRahmen(rumpf)` bleibt einargumentig.
 */

/**
 * Setzt das Dokument zusammen. NICHT EXPORTIERT — der einzige Weg hierher
 * führt über `transaktionsRahmen` oder `werbeRahmen`.
 *
 * Tabellenlayout und Inline-Stile, weil E-Mail-Programme weder Flexbox noch
 * eine verlässliche Kaskade kennen. Jede Fläche trägt ihre Farbe doppelt (als
 * `bgcolor` und als `background-color`), und Text- und Flächenfarbe stehen
 * immer als Paar: Manche Programme drehen eigenmächtig auf dunkel um und
 * erwischen dabei nur eine der beiden Angaben — helle Schrift auf hellem Grund
 * ist das Ergebnis, wenn man sich darauf verlässt, dass sie es lassen.
 */
function build(body: Body, marketing: Footer | null): FramedMail {
  const preview = (body.preheader ?? preheaderFrom(body.text)).trim();

  // Kopf, Karte und Hausangaben kommen aus dem GEMEINSAMEN Rahmen. Hier wird
  // nur entschieden, was ÜBER den Hausangaben steht: der werbliche Zusatz
  // oder nichts. Die Reihenfolge (Zusatz zuerst, Hausangaben darunter) hält
  // der gemeinsame Rahmen ein — `werbeFusszeileText(...)` bleibt damit eine
  // zusammenhängende Teilzeichenkette von `mail.text`, und genau das prüft
  // der Gleichlauf-Test zwischen Schnappschuss und Versand.
  const html = mailDocument({
    titleHtml: escapeContent(body.subject),
    previewHtml: escapeContent(preview),
    bodyHtml: body.html,
    ...(marketing ? { extraFooterHtml: marketing.html } : {}),
  });
  const text = mailText(body.text, marketing?.text);

  return { html, text };
}

/**
 * Der Rahmen für TRANSAKTIONSMAILS — Anmeldecode, Rechnung,
 * Zahlungserinnerung, Notfall-Hinweis, Demo-Zugang, Bestätigungsmail.
 *
 * ES GIBT HIER KEINE FUSSZEILE UND KEINEN PARAMETER FÜR EINE. Das ist der
 * Kern der Kanaltrennung an dieser Stelle: Ein Abmeldelink unter einer
 * Rechnung wäre nicht nur falsch, er wäre irreführend — es gibt nichts, wovon
 * sich abmelden liesse, und die Bestätigungsmail des Double-Opt-in geht sogar
 * ausdrücklich VOR jeder Einwilligung hinaus (siehe
 * `mail.service.ts`, `sendeEinwilligungsBestaetigung`).
 */
export function transactionalLayout(body: Body): FramedMail {
  return build(body, null);
}

/**
 * Der Rahmen für WERBLICHE MAILS. Ohne Abmeldelink nicht aufrufbar.
 *
 * Die Fusszeile wird HIER gebaut und nicht aus der Vorlage genommen: Eine
 * Fusszeile, die in der Redaktion steht, lässt sich löschen — und dann geht
 * eine werbliche Mail ohne Abmeldemöglichkeit und ohne Anbieterkennung
 * hinaus. Der Redaktionsbereich kann den Rumpf ändern, diesen Teil nicht.
 *
 * IM HTML-TEIL IST „Abmelden" EIN LINK, IM TEXTTEIL STEHT DIE ADRESSE
 * AUSGESCHRIEBEN. Das ist kein Versehen: In einer Klartextmail ist ein
 * Linktext ohne Adresse wertlos, und die Ein-Klick-Abmeldung soll ohne Suchen
 * funktionieren. Beide Fassungen enthalten also denselben Link, nur in der
 * Form, die im jeweiligen Teil benutzbar ist.
 */
export function marketingLayout(
  body: Body,
  footer: MarketingFooter,
): FramedMail {
  const link = footer.unsubscribeLink.trim();
  if (link === '' || !/^https?:\/\//i.test(link)) {
    throw new LayoutWithoutUnsubscribeLinkError();
  }
  const t = MAIL_TOKENS;

  const html = [
    `<p style="margin:0 0 12px;color:${t.textMuted};">`,
    escapeContent(marketingIntroduction(footer.consentedAt)),
    '</p>',
    `<p style="margin:0 0 16px;color:${t.textMuted};">`,
    `${escapeContent(MARKETING_UNSUBSCRIBE)}<br>`,
    // Der einzige Verweis, den eine Mail dieses Hauses enthält. Er zeigt auf
    // die eigene Domäne, nicht auf eine Umleitung — eine Umleitung wäre eine
    // Klickmessung, auch wenn sie niemand so nennt.
    `<a href="${escapeContent(link)}" style="color:${t.primary};">Abmelden</a>`,
    '</p>',
  ].join('');

  const text = [
    '--',
    marketingIntroduction(footer.consentedAt),
    '',
    MARKETING_UNSUBSCRIBE,
    link,
  ].join('\n');

  return build(body, { html, text });
}

/**
 * Der Textteil einer werblichen Mail OHNE den Rahmen — für den Schnappschuss
 * und die Prüfung „trägt der Wortlaut den Abmeldelink?".
 *
 * Vorhanden, damit `WerbeMailService.wortlaut()` und `werbeRahmen()` denselben
 * Fusszeilentext ergeben. Ein zweiter Wortlaut an zweiter Stelle liefe
 * auseinander, und die Prüfung prüfte dann etwas anderes als das, was
 * hinausgeht.
 */
export function marketingFooterText(
  unsubscribeLink: string,
  consentedAt?: string,
): string {
  return [
    '--',
    marketingIntroduction(consentedAt),
    '',
    MARKETING_UNSUBSCRIBE,
    unsubscribeLink.trim(),
  ].join('\n');
}

/**
 * Ein Ziel für den Handlungsknopf, das keines ist.
 *
 * Der Knopf ist der EINZIGE Ort, an dem die Redaktion eine Adresse in eine
 * Mail bringen kann — der Säuberer lässt im Fliesstext kein `<a>` durch. Also
 * wird sie hier geprüft, und zwar streng: nur `http` und `https`. Alles
 * andere (`javascript:`, `data:`, ein Schema, das ein Mailprogramm anders
 * auflöst als der Browser) hat in einer Mail nichts verloren.
 */
export class LayoutButtonTargetError extends BusinessError {
  constructor(target: string) {
    super(
      'mail_knopfziel_ungueltig',
      `„${target}" ist kein gültiges Ziel für den Knopf. ` +
        'Erlaubt sind nur vollständige Adressen mit http:// oder https://.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { target },
    );
  }
}

/** Die Bausteine, aus denen sich ein werblicher Rumpf zusammensetzt. */
export interface MarketingBodyParts {
  subject: string;
  /** Die kleine Zeile über der Überschrift. Optional. */
  eyebrow?: string | null;
  /** Die Serif-Überschrift. Optional. */
  heading?: string | null;
  /** Der redigierte Rumpf, BEREITS gesäubert. */
  html: string;
  /** Derselbe Rumpf als Text. */
  text: string;
  /** Beschriftung und Ziel des Knopfes. Beide oder keiner. */
  buttonText?: string | null;
  buttonTarget?: string | null;
}

/**
 * ===========================================================================
 * DER WERBLICHE RUMPF — Vorüberschrift, Überschrift, Text, Knopf
 * ===========================================================================
 *
 * WARUM DIESE VIER FELDER NICHT IM FLIESSTEXT STEHEN KÖNNEN: Der Säuberer
 * lässt kein `<a>` durch, und das soll er auch nicht — sonst wäre jede
 * Redaktion ein Weg, eine beliebige Adresse in eine Mail dieses Hauses zu
 * setzen. Eine Serif-Überschrift ist ausserdem keine Formatierung, sondern
 * eine Rolle im Rahmen: Sie steht in derselben Schrift wie die Wortmarke.
 *
 * WAS FEHLT, WIRD WEGGELASSEN — nicht ersetzt. Eine Vorlage ohne
 * Vorüberschrift bekommt keine leere Zeile, und eine ohne Knopf keinen
 * grauen Kasten. Vorlagen aus der Zeit vor diesen Feldern rahmen sich genau
 * wie vorher.
 *
 * DER KNOPF BRAUCHT BEIDES. Ein Knopf ohne Ziel ist eine Schaltfläche, die
 * nichts tut; ein Ziel ohne Beschriftung ein unsichtbarer Link. Fehlt eines,
 * entfällt er ganz — geräuschlos, weil das Formular es bereits abweist und
 * eine halbe Angabe hier nur aus einem alten Datensatz stammen kann.
 *
 * IM TEXTTEIL STEHT DIE ADRESSE AUSGESCHRIEBEN, wie in der Fusszeile und aus
 * demselben Grund: Ein Linktext ohne Adresse ist in einer Klartextmail
 * wertlos.
 */
export function marketingBody(parts: MarketingBodyParts): Body {
  const t = MAIL_TOKENS;
  const before = (parts.eyebrow ?? '').trim();
  const over = (parts.heading ?? '').trim();
  const buttonText = (parts.buttonText ?? '').trim();
  const buttonTarget = (parts.buttonTarget ?? '').trim();
  const button = buttonText !== '' && buttonTarget !== '';

  if (button && !/^https?:\/\//i.test(buttonTarget)) {
    throw new LayoutButtonTargetError(buttonTarget);
  }

  const html = [
    before === ''
      ? ''
      : `<p style="margin:0 0 6px;font-size:12px;letter-spacing:0.08em;` +
        `text-transform:uppercase;color:${t.textMuted};">` +
        `${escapeContent(before)}</p>`,
    over === ''
      ? ''
      : `<p style="margin:0 0 16px;font-family:${MAIL_SERIF};` +
        `font-size:22px;line-height:1.3;font-weight:700;color:${t.text};">` +
        `${escapeContent(over)}</p>`,
    parts.html,
    button
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
        `style="margin:20px 0 0;border-collapse:collapse;"><tr><td ` +
        `bgcolor="${t.primary}" style="background-color:${t.primary};` +
        `border-radius:8px;"><a href="${escapeContent(buttonTarget)}" ` +
        `style="display:inline-block;padding:11px 20px;font-family:${MAIL_FONT};` +
        `font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">` +
        `${escapeContent(buttonText)}</a></td></tr></table>`
      : '',
  ].join('');

  const text = [
    before === '' ? null : before.toUpperCase(),
    over === '' ? null : over,
    before === '' && over === '' ? null : '',
    parts.text,
    button ? '' : null,
    button ? `${buttonText}: ${buttonTarget}` : null,
  ]
    .filter((row) => row !== null)
    .join('\n');

  return { subject: parts.subject, html, text };
}

/**
 * Bequemer Weg für die sechs Mails, deren Wortlaut als reiner Text im
 * Quelltext steht: aus dem Text beide Fassungen des RUMPFS machen.
 *
 * Die Texte werden dafür NICHT umgeschrieben — sie werden nur in Absätze
 * gesetzt. `textAus` kommt danach wieder auf denselben Text.
 */
export function bodyFromHtml(subject: string, html: string): Body {
  return { subject, html, text: textFrom(html) };
}
