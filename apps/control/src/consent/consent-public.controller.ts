import { mailBrand } from '@saas-instant/shared';
import { Controller, Get, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { sourceFrom } from '../common/inquiry-source';
import { WithoutCsrf } from '../common/decorators/without-csrf.decorator';
import { BusinessError } from '../common/errors/business-error';
import { ConsentService } from './consent.service';
import { page } from './pages';

/**
 * Höchstlänge eines Tokens in der Adresse.
 *
 * 32 Zufallsbytes werden als base64url zu 43 Zeichen. Alles darüber ist
 * niemals ein von uns erzeugter Token; die Grenze hält Datenbankabfragen mit
 * überlangen Zeichenketten fern.
 */
const TOKEN_MAX = 64;

/**
 * ===========================================================================
 * BESTÄTIGUNG UND ABMELDUNG — DIE BEIDEN LINKS AUS DEM POSTFACH
 * ===========================================================================
 *
 * KEIN `SitzungGuard`, KEIN Schlüssel im Header, KEIN Konto. Das ist keine
 * Lücke, sondern die Anforderung: „Ein-Klick-Abmeldung: Token je Empfänger,
 * kein Login, keine Rückfrage, sofort wirksam." Eine Abmeldung, die eine
 * Anmeldung verlangt, ist keine.
 *
 * AN DIE STELLE DER SITZUNG TRITT DER TOKEN. 256 Bit aus `randomBytes`, je
 * Empfänger einer, eindeutig in der Datenbank. Was er kann, ist eng: die
 * eigene Adresse bestätigen oder die eigene Adresse abmelden. Er liest nichts,
 * er ändert nichts anderes, und er verrät auch nichts — die Seiten nennen
 * keine Adresse. Wer einen fremden Token abfängt, kann damit einen fremden
 * Newsletter abbestellen; mehr nicht.
 *
 * ZWEI WEGE ZUR ABMELDUNG, weil es zwei Aufrufer gibt:
 *
 * - `GET`  — der Mensch klickt den Link im Mailtext an.
 * - `POST` — der MAILCLIENT ruft ihn selbst auf. Das ist RFC 8058
 *   („One-Click"): Gmail, Outlook und Apple Mail zeigen neben dem Absender
 *   einen Abmelden-Knopf, wenn `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 *   gesetzt ist, und schicken dann einen POST an diese Adresse. Ohne diesen
 *   Weg bleibt der Knopf aus, und die Leute melden sich per Spam-Knopf ab —
 *   was die Zustellbarkeit der ganzen Domäne beschädigt, Rechnungen
 *   eingeschlossen.
 *
 * Die CSRF-Ausnahme am POST ist unvermeidlich und ungefährlich: Der Aufrufer
 * ist ein Mailclient ohne Cookie und ohne Sitzung. Was CSRF verhindern soll —
 * ein fremdes Formular handelt unter der Sitzung des Opfers — kann hier nicht
 * eintreten, weil keine Sitzung ausgewertet wird. Der schlimmste Missbrauch
 * ist, jemanden abzumelden, der sich nicht abmelden wollte; dagegen hilft
 * kein CSRF-Token, sondern nur, dass der Token geheim bleibt.
 *
 * BEIDE ROUTEN SIND IDEMPOTENT und antworten auf den zweiten Aufruf gleich.
 * Mailclients rufen Links zur Vorschau ungefragt auf.
 */
@Controller('consent')
export class ConsentPublicController {
  constructor(private readonly consent: ConsentService) {}

  /**
   * Die SEITE zur Bestätigung — sie schreibt nichts.
   *
   * [A.13] DIE BESTÄTIGUNG DARF NICHT AUS EINEM GET ENTSTEHEN. Mailscanner
   * (Microsoft Safe Links, Proofpoint, Mimecast) rufen jeden Link in
   * eingehender Post ungefragt ab, um ihn zu prüfen. Ein schreibender GET wird
   * dann vom SCANNER ausgelöst statt von dem Menschen, dem die Adresse gehört:
   * Der Doppel-Opt-in belegte den Scanner. Als Nachweis nach Paragraf 7 UWG und
   * Artikel 7 DSGVO wäre er damit wertlos — bei einem System, das
   * `Einwilligung` ausdrücklich als Nachweis führt.
   *
   * Der frühere Kommentar behandelte das Vorabrufen nur unter „Idempotenz".
   * Das ist die falsche Eigenschaft: Der zweite Aufruf schadet nicht, aber der
   * ERSTE war schon der falsche Urheber.
   *
   * Hier wird deshalb nur eine Seite mit einem Knopf ausgeliefert. Ob es den
   * Token überhaupt gibt, prüft erst der POST — die Seite verrät damit auch
   * nichts über fremde Token.
   */
  @Get('confirmation/:token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  confirmationPage(@Param('token') token: string, @Res() res: Response): void {
    if (!isPossibleToken(token)) {
      respond(res, HttpStatus.NOT_FOUND, UNKNOWN_CONFIRMATION);
      return;
    }
    res
      .status(HttpStatus.OK)
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Noch ein Klick, dann bist du dabei.',
          `Bitte bestätige, dass du Neuigkeiten von ${mailBrand().name} bekommen ` +
            'möchtest. Sie kommen selten, und du kannst dich in jeder ' +
            'einzelnen mit einem Klick wieder abmelden.',
          {
            action: `/api/consent/confirmation/${encodeURIComponent(token)}`,
            button: 'Ja, Neuigkeiten bekommen',
          },
        ),
      );
  }

  /** Der Klick, der aus einer Eintragung eine Einwilligung macht. */
  @WithoutCsrf(
    'Der Aufrufer ist ein Mensch aus seinem Postfach, ohne Konto und ohne ' +
      'Sitzung — es gibt keine fremde Sitzung, die sich missbrauchen liesse. ' +
      'An die Stelle des CSRF-Tokens tritt der 256-Bit-Token in der Adresse. ' +
      'Dieselbe Abwaegung wie bei der Ein-Klick-Abmeldung darunter.',
  )
  @Post('confirmation/:token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async confirmation(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!isPossibleToken(token)) {
      respond(res, HttpStatus.NOT_FOUND, UNKNOWN_CONFIRMATION);
      return;
    }
    try {
      await this.consent.confirm(token, sourceFrom(req));
      respond(res, HttpStatus.OK, {
        heading: 'Danke — deine Adresse ist bestätigt.',
        text:
          `Ab jetzt bekommst du Neuigkeiten von ${mailBrand().name}. Sie kommen ` +
          'selten und du kannst dich in jeder einzelnen mit einem Klick ' +
          'wieder abmelden.\n\n' +
          'Du musst nichts weiter tun. Dieses Fenster kannst du schliessen.',
      });
    } catch (exception) {
      respond(res, statusFrom(exception), UNKNOWN_CONFIRMATION);
    }
  }

  /** Ein-Klick-Abmeldung, angeklickt von einem Menschen. */
  @Get('unsubscribe/:token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async unsubscribeClick(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.executeUnsubscribe(token, req, res, 'html');
  }

  /**
   * Ein-Klick-Abmeldung nach RFC 8058, aufgerufen vom Mailclient.
   *
   * Der Body (`List-Unsubscribe=One-Click`) wird bewusst NICHT ausgewertet:
   * Massgeblich ist der Token in der Adresse. Kein `@Body()` heisst zugleich,
   * dass die globale `ValidationPipe` gar nicht erst greift — sie würde ein
   * unbekanntes Feld sonst mit `forbidNonWhitelisted` ablehnen, und die
   * Abmeldung scheiterte an einer Formalie.
   */
  @WithoutCsrf(
    'RFC 8058 One-Click: Den Aufruf macht der MAILCLIENT (Gmail, Outlook, ' +
      'Apple Mail), nicht der Browser der Empfängerin. Er hat kein ' +
      'CSRF-Cookie, und die Route wertet keine Sitzung aus — es gibt also ' +
      'keine fremde Sitzung, die sich missbrauchen liesse. An die Stelle des ' +
      'Tokens im Header tritt der 256-Bit-Token in der Adresse.',
  )
  @Post('unsubscribe/:token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async unsubscribeOneClick(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.executeUnsubscribe(token, req, res, 'text');
  }

  // ----------------------------------------------------------------- intern

  private async executeUnsubscribe(
    token: string,
    req: Request,
    res: Response,
    form: 'html' | 'text',
  ): Promise<void> {
    if (!isPossibleToken(token)) {
      this.respondUnsubscribe(res, HttpStatus.NOT_FOUND, form, UNKNOWN_UNSUBSCRIBE);
      return;
    }
    try {
      await this.consent.unsubscribe(token, sourceFrom(req));
      this.respondUnsubscribe(res, HttpStatus.OK, form, {
        heading: 'Du bist abgemeldet.',
        text:
          'Von uns kommen ab sofort keine Neuigkeiten mehr an diese ' +
          'Adresse. Das gilt auch für schon vorbereitete Mails — sie werden ' +
          'nicht mehr zugestellt.\n\n' +
          'Wir merken uns die Abmeldung dauerhaft, damit du nicht bei der ' +
          'nächsten Gelegenheit versehentlich wieder angeschrieben wirst. ' +
          'Rechnungen und Antworten auf deine eigenen Anfragen bekommst du ' +
          'weiterhin — das sind keine Neuigkeiten-Mails.',
      });
    } catch (exception) {
      this.respondUnsubscribe(
        res,
        statusFrom(exception),
        form,
        UNKNOWN_UNSUBSCRIBE,
      );
    }
  }

  private respondUnsubscribe(
    res: Response,
    status: number,
    form: 'html' | 'text',
    content: { heading: string; text: string },
  ): void {
    if (form === 'text') {
      // Der Mailclient zeigt den Body nicht an; er wertet nur den Status aus.
      res
        .status(status)
        .type('text/plain; charset=utf-8')
        .send(`${content.heading}\n`);
      return;
    }
    respond(res, status, content);
  }
}

const UNKNOWN_CONFIRMATION = {
  heading: 'Dieser Link ist nicht mehr gültig.',
  text:
    'Bestätigungslinks gelten 72 Stunden; danach löschen wir die Eintragung ' +
    'wieder. Möglicherweise ist das hier passiert, oder der Link war schon ' +
    'benutzt.\n\n' +
    'Trage dich bei Interesse einfach noch einmal ein.',
};

const UNKNOWN_UNSUBSCRIBE = {
  heading: 'Dieser Abmeldelink ist unbekannt.',
  text:
    'Vermutlich wurde die Adresse bereits ausgetragen — dann ist alles in ' +
    'Ordnung und du bekommst nichts mehr von uns.\n\n' +
    'Falls doch: Antworte auf eine unserer Mails, wir tragen dich von Hand aus.',
};

/** Sieht der Wert überhaupt aus wie ein von uns erzeugter Token? */
function isPossibleToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= TOKEN_MAX &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/** Der HTTP-Status eines fachlichen Fehlers, sonst „nicht gefunden". */
function statusFrom(exception: unknown): number {
  return exception instanceof BusinessError
    ? exception.getStatus()
    : HttpStatus.NOT_FOUND;
}

function respond(
  res: Response,
  status: number,
  content: { heading: string; text: string },
): void {
  res
    .status(status)
    .type('text/html; charset=utf-8')
    .send(page(content.heading, content.text));
}
