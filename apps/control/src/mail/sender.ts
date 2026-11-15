import type { ConfigService } from '@nestjs/config';
import type { MailManifest } from '../manifest/sections/mail';

/**
 * ABSENDER, ANTWORTADRESSE UND RÜCKWEG — und warum das keine Kosmetik ist.
 *
 * ===========================================================================
 * DER GEMESSENE ZUSTAND DER DOMÄNE (31.08.2026)
 * ===========================================================================
 *
 *   SPF    "v=spf1 ip4:167.233.107.57 ip6:2a01:4f8:c015:4ecc::1 ~all"
 *   DMARC  "v=DMARC1; p=quarantine; rua=…; adkim=s; aspf=s"
 *   DKIM   unter 19 geprüften Selektoren NICHT gefunden
 *
 * Ohne DKIM besteht DMARC ausschließlich über SPF. `aspf=s` verlangt dabei
 * STRENGE Ausrichtung: die Domäne des ENVELOPE-FROM (Return-Path) muss exakt
 * die Domäne des sichtbaren `From:` sein — `example.com` und nicht
 * `bounces.mailer.example`, nicht `example.app`, auch keine Subdomäne.
 *
 * Stimmt sie nicht, ist DMARC verletzt, und `p=quarantine` heißt dann: die
 * Mail landet im Spam. Das trifft ZUERST die Rechnungen — die Rundmail merkt
 * niemand, eine nicht angekommene Rechnung schon.
 *
 * Deshalb wird der Envelope-From hier ausdrücklich gesetzt und die Ausrichtung
 * beim Start GEPRÜFT (`pruefeAbsenderAusrichtung`, aufgerufen in `main.ts`).
 * Nodemailer nähme sonst je nach Relay irgendeine Adresse.
 *
 * DER HANDGRIFF, DER DEM BETREIBER BLEIBT, ist DKIM: Schlüsselpaar erzeugen,
 * öffentlichen Teil als TXT unter `<selektor>._domainkey.<maildomäne>`
 * veröffentlichen, privaten Teil im Postausgang hinterlegen. Erst danach
 * übersteht die Ausrichtung auch eine Weiterleitung, bei der SPF immer bricht.
 * Ausführlich in `docs/operations/billing.md`.
 */

/** Der eingetragene Mail-Abschnitt des Manifests (null vor dem Start). */
export function registeredMailDefaults(): MailManifest | null {
  return manifestMail;
}

/**
 * Rückfall, wenn weder `MAIL_DOMAIN` noch ein Manifest gesetzt ist — die
 * reservierte Beispiel-Domäne, damit keine fremde Domäne als Absender erfunden
 * wird.
 */
export const MAIL_DOMAIN_DEFAULT = 'example.com';

/**
 * Die Mail-Angaben aus dem Manifest. Der Start (`MailModule`) trägt sie ein,
 * damit `absenderadressen(config)` überall — auch in `main.ts` vor dem ersten
 * Versand — dieselben Werte sieht. Umgebungsvariablen haben Vorrang.
 */
let manifestMail: MailManifest | null = null;

export function registerMailManifest(mail: MailManifest | null): void {
  manifestMail = mail;
}

export interface SenderAddresses {
  domain: string;
  /**
   * Allgemeiner Verwaltungsversand (Anmeldecodes, Demo, Bestätigungsmail).
   *
   * Liest weiterhin `SMTP_FROM` — der Wert steht seit Etappe 1 in jeder
   * Betriebsumgebung. Er wird hier gelesen und NICHT im `MailService`, damit
   * die Ausrichtungsprüfung ihn mit erfasst: Eine `SMTP_FROM` auf fremder
   * Domäne bricht die strenge SPF-Ausrichtung genauso wie ein falscher
   * Rückweg.
   */
  admin: string;
  /** Rechnungen und Zahlungserinnerungen. */
  invoice: string;
  /** Werbliche Rundmails. Eigene Adresse, damit sich Reputation trennen lässt. */
  broadcast: string;
  /** Antwortadresse beider Kanäle: hier liest ein Mensch mit. */
  replyTo: string;
  /**
   * Envelope-From (Return-Path). NACKTE Adresse, ohne Anzeigename.
   *
   * Vorgabe ist die Adresse aus `SMTP_FROM`. Ein eigenes Postfach für
   * Rückläufer ist besser — dann `MAIL_RETURN_PATH` setzen, nachdem es
   * angelegt UND jemandem zum Lesen zugewiesen wurde. Siehe den Block
   * über `absenderadressen`.
   */
  returnPath: string;
}

/**
 * ===========================================================================
 * DIE VORGABEN ERFINDEN KEINE POSTFÄCHER MEHR [A.30]
 * ===========================================================================
 *
 * WAS SCHIEFGING, gemessen am 07.09.2026 gegen den echten Postausgang
 * einem Postausgang mit Absenderbindung und dem Konto `noreply@example.com`:
 *
 *     MAIL FROM:<bounce@example.com>
 *     553 5.7.1 <bounce@example.com>: Sender address rejected:
 *                                      not owned by user noreply@example.com
 *
 * Der Postausgang ist ein Postfix mit Absenderbindung: Das angemeldete Konto
 * darf ausschliesslich unter EIGENEN Adressen einliefern. `bounce@`,
 * `kontakt@`, `news@` und `rechnung@` gab es auf dem Server nie — sie standen
 * nur hier als Vorgabe. Damit scheiterte JEDE Mail, und zwar an der ersten
 * Zeile des Umschlags: Anfrage-Benachrichtigung, Demo-Zugang, Anmeldecode,
 * Rechnung. Nach aussen sah man davon nichts, denn der Anfrageweg antwortet
 * absichtlich immer mit `200`.
 *
 * DIE LEHRE: Eine Vorgabe darf nichts behaupten, was niemand eingerichtet
 * hat. `bounce@` war eine gute Absicht — ein eigenes Postfach für Rückläufer
 * IST richtig —, aber als Vorgabe war sie eine Wette darauf, dass jemand sie
 * anlegt. Verloren wird diese Wette lautlos.
 *
 * DESHALB FÄLLT ALLES AUF `SMTP_FROM` ZURÜCK. Das ist die eine Adresse, von
 * der man weiss, dass der Postausgang sie annimmt — sie ist ja das Konto, mit
 * dem er sich anmeldet. Sie liegt zwangsläufig auf der Maildomäne und erfüllt
 * damit auch die strenge DMARC-Ausrichtung (`aspf=s`).
 *
 * DIE GETRENNTEN ADRESSEN BLEIBEN VORGESEHEN, nur eben nicht mehr als stille
 * Vorgabe: Wer `bounce@`, `news@` und `rechnung@` anlegt, trägt sie in
 * `MAIL_RETURN_PATH`, `MAIL_SENDER_BROADCAST` und `MAIL_SENDER_INVOICE` ein
 * und bekommt die getrennte Reputation zurück. Vorher schadet die Trennung
 * mehr, als sie nützt: getrennte Reputation von null Mails ist nichts wert.
 *
 * AUSNAHME IST DIE ANTWORTADRESSE. Sie prüft kein Postausgang — sie fällt
 * erst auf, wenn jemand antwortet und die Antwort zurückkommt. Sie
 * kommt aus dem Manifest (`mail.replyTo`) oder `MAIL_REPLY_TO`; ohne beides
 * fällt sie auf das Postausgangskonto zurück. `noreply@` als Antwortadresse
 * ist die andere Art, Post zu verlieren — wer sie setzt, setzt `replyTo`.
 */

/** Liest die Absenderadressen aus der Umgebung. */
export function senderAddresses(config: ConfigService): SenderAddresses {
  const m = manifestMail;
  const manifestAddress = m ? addressFrom(m.senderAddress) : null;
  const domain =
    (
      config.get<string>('MAIL_DOMAIN') ??
      m?.domain ??
      (manifestAddress ? domainFrom(manifestAddress) : '')
    )
      .trim()
      .toLowerCase() || MAIL_DOMAIN_DEFAULT;
  const admin = config.get<string>(
    'SMTP_FROM',
    m
      ? `${m.senderName} <${m.senderAddress}>`
      : `SAAS Verwaltung <noreply@${domain}>`,
  );
  // Die NACKTE Adresse des Postausgangskontos — sie ist die Rückfallebene
  // für alles, was sonst ein eigenes Postfach bräuchte.
  const account = addressFrom(admin);
  return {
    domain,
    admin,
    invoice: config.get<string>('MAIL_SENDER_INVOICE', admin),
    broadcast: config.get<string>('MAIL_SENDER_BROADCAST', admin),
    replyTo: config.get<string>('MAIL_REPLY_TO', m?.replyTo ?? account),
    returnPath: config.get<string>('MAIL_RETURN_PATH', account),
  };
}

/**
 * Schält die nackte Adresse aus „Anzeigename <a@b>" heraus.
 *
 * Der Envelope-From darf keinen Anzeigenamen tragen; SMTP will im
 * `MAIL FROM:`-Befehl genau eine Adresse sehen.
 */
export function addressFrom(value: string): string {
  const hit = /<([^>]+)>/.exec(value);
  return (hit ? hit[1] : value).trim().toLowerCase();
}

/** Domänenteil einer Adresse, klein geschrieben. Leer, wenn keiner da ist. */
export function domainFrom(value: string): string {
  const address = addressFrom(value);
  const stelle = address.lastIndexOf('@');
  return stelle < 0 ? '' : address.slice(stelle + 1);
}

/**
 * Bricht den Start ab, wenn eine Absenderadresse nicht auf der Maildomäne
 * liegt.
 *
 * NUR IN PRODUKTION — dieselbe Bauweise wie `pruefeTlsPflicht`. Lokal wird
 * gegen Mailpit verschickt, das nimmt jede Adresse an, und ein erzwungener
 * Abbruch machte die Entwicklung unmöglich.
 *
 * Eine Warnung wäre hier zu wenig: Eine falsch ausgerichtete Absenderadresse
 * ist im Postausgangslog unauffällig. Sichtbar wird sie erst daran, dass
 * Rechnungen nicht ankommen — und dann meist Wochen später.
 */
export function checkSenderAlignment(
  nodeEnv: string | undefined,
  addresses: SenderAddresses,
): void {
  if (nodeEnv !== 'production') return;
  const toCheck: [string, string][] = [
    ['SMTP_FROM', addresses.admin],
    ['MAIL_SENDER_INVOICE', addresses.invoice],
    ['MAIL_SENDER_BROADCAST', addresses.broadcast],
    ['MAIL_RETURN_PATH', addresses.returnPath],
  ];
  // Leer = Mail ist noch nicht eingerichtet (frische Installation ohne SMTP).
  // Das ist kein Ausrichtungsfehler und darf den Start nicht verhindern; wer
  // eine Adresse einträgt, wird weiter streng geprüft.
  const wrong = toCheck.filter(
    ([, value]) =>
      value.trim() !== '' && domainFrom(value) !== addresses.domain,
  );
  if (wrong.length === 0) return;
  throw new Error(
    'Absenderadressen liegen nicht auf MAIL_DOMAIN=' +
      `${addresses.domain}: ` +
      wrong.map(([name, value]) => `${name}=${domainFrom(value)}`).join(', ') +
      '. DMARC steht auf p=quarantine mit aspf=s (strenge Ausrichtung); ' +
      'mit abweichender Domäne landen die Mails im Spam. Siehe ' +
      'docs/operations/billing.md.',
  );
}
