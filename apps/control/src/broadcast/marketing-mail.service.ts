import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '../common/errors/business-error';
import type { MarketingApproval } from '../consent/consent.gate';
import { senderAddresses } from '../mail/sender';
import type { ErrorClass } from '../mail/mail.service';
import { classify } from '../mail/mail.service';
import type { FramedMail } from '../mail/layout';
import {
  marketingFooterText,
  marketingLayout,
  marketingBody,
  type MarketingBodyParts,
} from '../mail/layout';
import { buildTransport } from '../mail/transport';

/**
 * Eine werbliche Mail liess sich nicht zustellen. Trägt die FEHLERKLASSE,
 * damit die Warteschlange entscheiden kann, ob sie es noch einmal versucht
 * und ob der Fehlschlag gegen die Adresse zählt.
 */
export class MarketingMailError extends BusinessError {
  constructor(readonly errorClass: ErrorClass) {
    super(
      'werbemail_versand_fehlgeschlagen',
      'Die Rundmail konnte nicht versendet werden.',
      HttpStatus.BAD_GATEWAY,
      { errorClass },
    );
  }
}

/**
 * Der Wortlaut trägt keinen Abmeldelink. Die Mail geht nicht hinaus.
 *
 * Kann nur eintreten, wenn jemand den Schnappschuss einer Warteschlangenzeile
 * nachträglich verändert hat — genau deshalb wird es geprüft.
 */
export class WithoutUnsubscribeLinkError extends BusinessError {
  constructor() {
    super(
      'werbemail_ohne_abmeldelink',
      'Der Wortlaut enthält den Abmeldelink dieser Empfängerin nicht.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * ===========================================================================
 * DER WERBLICHE KANAL — ein eigener Dienst, kein Schalter
 * ===========================================================================
 *
 * R3: „Transaktionsmails und werbliche Mails sind getrennte Kanäle mit
 * getrennten Codepfaden."
 *
 * Diese Klasse ist der werbliche Pfad, `MailService` der transaktionale. Sie
 * teilen sich den Verbindungsaufbau (`mail/transport.ts`) und die
 * Absenderkonfiguration (`mail/absender.ts`) — und sonst nichts. Kein
 * Parameter, kein Flag, keine gemeinsame `versende`-Methode. Es gibt hier
 * bewusst keine Möglichkeit, eine Transaktionsmail zu verschicken, und im
 * `MailService` keine, eine werbliche zu verschicken.
 *
 * DIE ENTSCHEIDENDE ZEILE IST DIE SIGNATUR: Der Empfänger ist eine
 * `WerbeFreigabe`, keine Zeichenkette. Eine Freigabe gibt es nur aus
 * `WerbeFreigabe.pruefe()`, und die liest die Einwilligung aus der gesperrten
 * Datenbankzeile. Eine Adresse ohne bestätigtes Opt-in lässt sich hier nicht
 * einsetzen — nicht über die API, nicht durch Fehlbedienung, nicht durch einen
 * späteren Umbau, der die Prüfung vergisst. Der Übersetzer weist es ab.
 *
 * WAS JEDE WERBLICHE MAIL ZUSÄTZLICH TRÄGT und was der Transaktionskanal
 * NICHT hat:
 * - eine Fusszeile mit personalisiertem Abmeldelink und der Anbieterkennung,
 * - `List-Unsubscribe` und `List-Unsubscribe-Post` (RFC 8058, One-Click),
 * - eine eigene Absenderadresse (`news@`), damit sich die Zustellbarkeit der
 *   Rundmails von der der Rechnungen trennen lässt.
 *
 * WAS SIE AUSDRÜCKLICH NICHT TRÄGT: kein Zählpixel, keine umgeleiteten Links,
 * keine Öffnungs- oder Klickmessung. Das steht auf der Verbotsliste des
 * Auftrags, und es gibt hier keinen Code, der so etwas erzeugen könnte.
 *
 * UND NIE MEHR ALS EINE ADRESSE: `to` ist immer genau ein Empfänger, `cc` und
 * `bcc` werden nie gesetzt. `kanaltrennung.spec.ts` hält das fest.
 */
@Injectable()
export class MarketingMailService {
  private readonly logger = new Logger(MarketingMailService.name);

  // HIER STAND `aussteller: AusstellerKonfigService` ([A.33]). Er wurde nur
  // für die Anbieterkennung der Fusszeile gebraucht; die steht jetzt im
  // Rahmen und gilt für beide Kanäle. Eine Einspeisung, die nichts mehr
  // entscheidet, ist eine Abhängigkeit ohne Gegenwert.
  constructor(private readonly config: ConfigService) {}

  /**
   * Setzt die endgültige Mail zusammen: Rahmen, Rumpf, Fusszeile — in BEIDEN
   * Teilen.
   *
   * Wird beim EINSTELLEN in die Warteschlange aufgerufen, damit der
   * Schnappschuss in `MailVersand` genau das ist, was hinausgeht — und nicht
   * eine Vorstufe davon. Seit dem Rahmen sind das zwei Schnappschüsse, weil
   * es zwei Teile sind; ein Nachweis, der nur den Textteil kennt, belegt
   * etwas anderes als das, was die Empfängerin gesehen hat.
   */
  wording(
    parts: MarketingBodyParts,
    unsubscribeLink: string,
    consentedAt?: string,
  ): FramedMail {
    // ZWEI SCHRITTE, UND DIE REIHENFOLGE IST WESENTLICH: Erst setzt
    // `werbeRumpf` Vorüberschrift, Überschrift, Text und Knopf zum Rumpf
    // zusammen, dann legt `werbeRahmen` Kopf und Fusszeile darum. Die
    // Fusszeile entsteht IMMER hier und nie aus der Redaktion — sonst liesse
    // sie sich wegredigieren, und dann ginge eine werbliche Mail ohne
    // Abmeldemöglichkeit hinaus.
    return marketingLayout(marketingBody(parts), {
      unsubscribeLink,
      ...(consentedAt === undefined ? {} : { consentedAt }),
    });
  }

  /**
   * Verschickt genau eine werbliche Mail an genau eine Adresse.
   *
   * `wortlaut` ist der fertige Text aus dem Schnappschuss. Er wird vor dem
   * Versand noch einmal gegen den Abmeldelink DIESER Freigabe geprüft: Eine
   * werbliche Mail ohne Abmeldemöglichkeit ist auch mit Einwilligung
   * unzulässig, und ein Schnappschuss kann seit dem Einstellen verändert
   * worden sein.
   */
  async send(
    approval: MarketingApproval,
    subject: string,
    wording: FramedMail,
    unsubscribeLink: string,
  ): Promise<void> {
    // BEIDE TEILE werden geprüft. Ein HTML-Teil ohne Abmeldelink bei
    // vorhandenem Text-Abmeldelink wäre derselbe Verstoss — nur in der
    // Fassung, die die meisten Empfängerinnen tatsächlich zu sehen bekommen.
    if (
      !wording.text.includes(unsubscribeLink) ||
      !wording.html.includes(unsubscribeLink)
    ) {
      throw new WithoutUnsubscribeLinkError();
    }

    const addresses = senderAddresses(this.config);
    const transporter = buildTransport(this.config);
    try {
      await transporter.sendMail({
        from: addresses.broadcast,
        // GENAU EINE ADRESSE. Niemals eine Liste, niemals `bcc` — eine
        // Sammeladresse in `bcc` macht jeden personalisierten Abmeldelink
        // unmöglich und legt bei einem Tippfehler den ganzen Verteiler offen.
        to: approval.email,
        replyTo: addresses.replyTo,
        // Der Rückweg (Envelope-From) muss auf derselben Domäne liegen wie
        // `from`, sonst scheitert die strenge SPF-Ausrichtung (aspf=s) und
        // die Mail wird bei p=quarantine aussortiert. Siehe `mail/absender.ts`.
        envelope: { from: addresses.returnPath, to: [approval.email] },
        subject: subject,
        // BEIDE TEILE, immer. Eine reine HTML-Rundmail ist ein
        // Zustellungsrisiko: viele Spamfilter lesen zuerst den Textteil.
        text: wording.text,
        html: wording.html,
        headers: this.unsubscribeHeaders(unsubscribeLink),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Voller Wortlaut ins Anwendungslog (für den Betrieb), nach aussen nur
      // die Klasse: Eine Absage des Relays enthält oft die Zustelladresse im
      // Klartext, und die gehört in kein Datenfeld (R6).
      this.logger.error(`Rundmail konnte nicht versendet werden: ${reason}`);
      throw new MarketingMailError(classify(error, reason));
    }
  }

  /**
   * Die Kopfzeilen der Ein-Klick-Abmeldung (RFC 2369 und RFC 8058).
   *
   * `List-Unsubscribe-Post` ist der Teil, der den Abmelden-Knopf in Gmail,
   * Outlook und Apple Mail überhaupt erst erscheinen lässt. Ohne ihn melden
   * sich Leute über den Spam-Knopf ab — und der beschädigt die
   * Zustellbarkeit der ganzen Domäne, Rechnungen eingeschlossen.
   *
   * Beide Kopfzeilen müssen zusammen auftreten: `-Post` ohne `List-Unsubscribe`
   * ist wirkungslos, und der Postfachanbieter erwartet unter der URL einen
   * Endpunkt, der auf POST antwortet. Genau den gibt es
   * (`EinwilligungOeffentlichController.abmeldungEinKlick`).
   */
  private unsubscribeHeaders(unsubscribeLink: string): Record<string, string> {
    const mailto = this.config.get<string>('MAIL_UNSUBSCRIBE_MAILTO')?.trim();
    const entries = [`<${unsubscribeLink}>`];
    if (mailto) entries.push(`<mailto:${mailto}?subject=Abmeldung>`);
    return {
      'List-Unsubscribe': entries.join(', '),
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }


  /**
   * Der Textteil der Fusszeile, ohne Rahmen — für die Prüfung „trägt dieser
   * Wortlaut den Abmeldelink?" und für Vorschauen, die nur Text zeigen.
   *
   * Ruft dieselbe Funktion auf wie der Rahmen; ein zweiter Wortlaut an
   * zweiter Stelle liefe auseinander.
   */
  footerText(unsubscribeLink: string): string {
    return marketingFooterText(unsubscribeLink);
  }
}
