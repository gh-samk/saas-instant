import { AllowWhileUninitialized } from '../vault/allow-while-locked.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { sourceFrom } from '../common/inquiry-source';
import { MailService } from '../mail/mail.service';
import {
  loginCookieOptions,
  COOKIE_LOGIN,
  COOKIE_TRUSTED_DEVICE,
  COOKIE_SESSION,
  trustedDeviceCookieOptions,
  sessionCookieOptions,
} from '../common/cookies';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionEvidenceAt } from '../common/decorators/session-evidence-at.decorator';
import { WithoutSecondFactor } from '../common/decorators/without-second-factor.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import {
  EmailCodeConfirmDto,
  EmailCodeSetupDto,
  FactorRemoveDto,
  PasskeyRegistrationDto,
  PasswordSetDto,
  TotpConfirmDto,
  SecondFactorEvidenceDto,
} from './dto/access.dto';
import { asRegistrationResponse } from './dto/webauthn-response';
import type { SessionUser } from './session.service';
import type { TotpSetup } from './totp.service';
import { AccessService } from './access.service';
import type { FactorsOverview, DeviceEntry } from './access.service';

/**
 * Verwaltung des eigenen Zugangs. Alle Routen setzen eine gültige Sitzung
 * voraus; schreibende Routen zusätzlich das CSRF-Token (globaler Guard).
 *
 * UND: jede Route hier verlangt den NACHWEIS EINES ZWEITEN FAKTORS, sofern sie
 * nicht ausdrücklich mit `@OhneZweitfaktor('…')` davon ausgenommen ist. Die
 * Reihenfolge der Guards ist wesentlich — erst Sitzung, dann Zweitfaktor.
 *
 * Diese Umkehr der Beweislast ist die Lehre aus [K4]: die Pflicht wurde vorher
 * an jeder Route einzeln nachgezogen, und jedes Mal blieb eine übrig. Zuletzt
 * `totp/einrichten` und `wiederherstellungscodes` — über beide zusammen lief
 * eine vollständige Kontoübernahme mit einem 25 Stunden alten Cookie.
 * `zugang-routen.spec.ts` zählt die Routen auf und lässt keine unmarkierte zu.
 *
 * Tresor: Kontopflege bleibt bei gesperrtem Tresor gesperrt (423). Nur die Routen der
 * Ersteinrichtung sind erreichbar, solange noch KEIN Tresor eingerichtet ist
 * (`@AllowWhileUninitialized`): der Assistent läuft vor der Tresor-Einrichtung.
 */
@Controller('access')
@UseGuards(SessionGuard, SecondFactorGuard)
export class AccessController {
  constructor(
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  // --- Passkey ------------------------------------------------------------

  /**
   * Startet die Registrierung eines neuen Passkeys.
   *
   * Verlangt zusätzlich zur Sitzung einen zweiten Faktor (aktuelles Passwort
   * oder TOTP-Code): ein Passkey ist ein einstufiger Dauerzugang, den sich ein
   * Angreifer mit erbeutetem Sitzungs-Cookie sonst selbst ausstellen könnte.
   *
   * AUSNAHME: Ist die Sitzung jünger als 10 Minuten, entfällt der Nachweis.
   * Das deckt die Ersteinrichtung ab, in der Passwort und TOTP unmittelbar
   * zuvor gesetzt wurden.
   */
  @AllowWhileUninitialized(
    'Ersteinrichtung des ersten Kontos läuft, bevor der Tresor existiert; danach gesperrt.',
  )
  @Post('passkey/start')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async passkeyStart(
    @LoggedInUser() user: SessionUser,
    @Body() _dto: SecondFactorEvidenceDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON }> {
    // Der Nachweis kommt vom ZweitfaktorGuard, bevor diese Methode läuft.
    const { options, flowToken } =
      await this.access.registrationStart(user);
    res.cookie(
      COOKIE_LOGIN,
      flowToken,
      loginCookieOptions(this.config),
    );
    return { options };
  }

  /**
   * Speichert einen neuen Passkey. Alle Merk-Geräte werden dabei entwertet,
   * darum wird auch das Merk-Cookie dieses Browsers gelöscht.
   */
  @WithoutSecondFactor(
    'Zweiter Schritt eines Vorgangs, dessen ERSTER Schritt (passkey/start) den '
      + 'Nachweis bereits verlangt hat. Ohne den dort ausgestellten '
      + 'Vorgangs-Token samt Challenge ist diese Route wirkungslos.',
  )
  @AllowWhileUninitialized(
    'Ersteinrichtung des ersten Kontos läuft, bevor der Tresor existiert; danach gesperrt.',
  )
  @Post('passkey/complete')
  @HttpCode(200)
  async passkeyComplete(
    @LoggedInUser() user: SessionUser,
    @Body() dto: PasskeyRegistrationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ passkeyId: string; label: string }> {
    const result = await this.access.registrationComplete(
      user.id,
      req.cookies?.[COOKIE_LOGIN] as string | undefined,
      asRegistrationResponse(dto.response),
      dto.label,
      sourceFrom(req),
    );
    res.clearCookie(COOKIE_LOGIN, loginCookieOptions(this.config));
    res.clearCookie(COOKIE_TRUSTED_DEVICE, trustedDeviceCookieOptions(this.config));
    res.cookie(
      COOKIE_SESSION,
      result.sessionToken,
      sessionCookieOptions(this.config),
    );
    return { passkeyId: result.passkeyId, label: result.label };
  }

  // --- Passwort -----------------------------------------------------------

  /**
   * Setzt oder ändert das eigene Passwort.
   *
   * Bei der Ersteinrichtung (noch kein Passwort hinterlegt) darf
   * `aktuellesPasswort` fehlen; sonst ist es Pflicht. Alle Merk-Geräte werden
   * entwertet, darum wird auch das Merk-Cookie dieses Browsers gelöscht.
   */
  @WithoutSecondFactor(
    'Prüft das aktuelle Passwort selbst — das IST der Nachweis. Ist noch kein '
      + 'Passwort gesetzt, verlangt der Dienst stattdessen eine Anmeldung, die '
      + 'höchstens zehn Minuten zurückliegt (Passkey oder Notfall-Link).',
  )
  @AllowWhileUninitialized(
    'Ersteinrichtung des ersten Kontos läuft, bevor der Tresor existiert; danach gesperrt.',
  )
  @Post('password')
  @HttpCode(200)
  // Dasselbe Limit wie auf den Anmelderouten: `aktuellesPasswort` zu raten ist
  // derselbe Angriff auf dasselbe Geheimnis, nur aus einer Sitzung heraus.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async passwordSet(
    @LoggedInUser() user: SessionUser,
    @SessionEvidenceAt() evidenceAt: Date | null,
    @Body() dto: PasswordSetDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const { sessionToken } = await this.access.setPassword(
      user,
      dto.newPassword,
      dto.currentPassword,
      sourceFrom(req),
      evidenceAt,
    );
    res.clearCookie(COOKIE_TRUSTED_DEVICE, trustedDeviceCookieOptions(this.config));
    // Die eigene Sitzung wurde soeben mitentwertet — hier kommt der Ersatz.
    // Ohne ihn folgt auf dieses 200 sofort ein 401 ([K3]).
    res.cookie(
      COOKIE_SESSION,
      sessionToken,
      sessionCookieOptions(this.config),
    );
    return { ok: true };
  }

  // --- TOTP ---------------------------------------------------------------

  /** Erzeugt ein neues TOTP-Geheimnis; Klartext nur in dieser einen Antwort. */
  @AllowWhileUninitialized(
    'Ersteinrichtung des ersten Kontos läuft, bevor der Tresor existiert; danach gesperrt.',
  )
  @Post('totp/setup')
  @HttpCode(200)
  async totpSetup(
    @LoggedInUser() user: SessionUser,
  ): Promise<TotpSetup> {
    return this.access.totpSetup(user);
  }

  /**
   * Bestätigt die TOTP-Einrichtung.
   *
   * WARUM DIE BEGRÜNDUNG UNTEN LÄNGER IST ALS BEI DEN ANDEREN ZWEITEN
   * SCHRITTEN ([K5]): „Ohne vorläufiges Geheimnis läuft die Route ins Leere"
   * war wahr und trug trotzdem nicht. MIT einem vorläufigen Geheimnis ist sie
   * ein Orakel auf sechs Ziffern, und der Treffer ergibt einen aktiven zweiten
   * Faktor. Der Zustand war dauerhaft und der Normalfall nach jedem
   * abgebrochenen Dialog.
   *
   * Getragen wird die Ausnahme jetzt von vier Dingen zusammen — keines davon
   * reicht allein: dem Limit an dieser Route, der Kontosperre und dem
   * Audit-Eintrag auf jeden Fehlschlag (`ZugangService.totpBestaetigen`) und
   * der Frist auf dem vorläufigen Geheimnis (`TOTP_VORLAEUFIG_GUELTIG_MS`),
   * das „alle abmelden" und der Passwortwechsel zusätzlich sofort entwerten.
   */
  @WithoutSecondFactor(
    'Zweiter Schritt eines Vorgangs, dessen ERSTER Schritt (totp/einrichten) '
      + 'den Nachweis bereits verlangt hat. Die Route ist trotzdem eine '
      + 'Ratestrecke auf einen zweiten Faktor, solange ein vorläufiges Geheimnis '
      + 'liegt: gebremst wird sie deshalb durch @Throttle, durch Fehlversuche '
      + 'auf der Kontosperre samt Audit-Eintrag und durch die Frist von zehn '
      + 'Minuten auf dem vorläufigen Geheimnis ([K5]).',
  )
  @AllowWhileUninitialized(
    'Ersteinrichtung des ersten Kontos läuft, bevor der Tresor existiert; danach gesperrt.',
  )
  @Post('totp/confirm')
  @HttpCode(200)
  // Dasselbe Limit wie auf den Anmelderouten: einen sechsstelligen Code zu
  // raten ist derselbe Angriff, egal an welcher Route er stattfindet.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async totpConfirm(
    @LoggedInUser() user: SessionUser,
    @Body() dto: TotpConfirmDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.access.totpConfirm(user, dto.code, sourceFrom(req));
    return { ok: true };
  }

  // --- Zweite Faktoren ----------------------------------------------------

  /**
   * Welche zweiten Faktoren sind eingerichtet, und welcher davon lässt sich
   * entfernen, ohne den letzten wegzunehmen?
   */
  @WithoutSecondFactor(
    'Lesend. Zeigt nur den eigenen Kontostand und ändert nichts.',
  )
  @Get('factors')
  async factors(
    @LoggedInUser() user: SessionUser,
  ): Promise<FactorsOverview> {
    return this.access.factors(user.id);
  }

  /**
   * Richtet den Faktor „Code per E-Mail" ein oder ändert seine Zieladresse.
   *
   * Beides ist derselbe Vorgang: es geht ein Bestätigungscode an die
   * gewünschte Adresse. Übernommen wird sie erst mit `bestaetigen` — ein
   * Tippfehler kann so keinen aktiven Faktor auf ein unerreichbares Postfach
   * umbiegen.
   *
   * VERLANGT `aktuellesPasswort` oder `totpCode` (entfällt bei einer Sitzung
   * unter zehn Minuten) und schickt bei einem echten Adresswechsel eine
   * Hinweismail an die BISHERIGE Adresse.
   */
  @AllowWhileUninitialized(
    'Ersteinrichtung des ersten Kontos läuft, bevor der Tresor existiert; danach gesperrt.',
  )
  @Post('factors/email-code/setup')
  @HttpCode(200)
  // Dasselbe Limit wie auf den Anmelderouten: hier verlässt ein Code das
  // System, das ist genauso schützenswert wie ein Anmeldeversuch.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async emailCodeSetup(
    @LoggedInUser() user: SessionUser,
    @Body() dto: EmailCodeSetupDto,
    @Req() req: Request,
  ): Promise<{ email: string; secondsValid: number }> {
    return this.access.emailCodeSetup(user, dto.email, sourceFrom(req));
  }

  /** Bestätigt den Einrichtungscode; erst danach gilt der Faktor. */
  @WithoutSecondFactor(
    'Zweiter Schritt eines Vorgangs, dessen ERSTER Schritt '
      + '(email-code/einrichten) den Nachweis bereits verlangt hat. Der Code aus '
      + 'der E-Mail ist hier selbst der Nachweis über die Zieladresse.',
  )
  @AllowWhileUninitialized(
    'Ersteinrichtung des ersten Kontos läuft, bevor der Tresor existiert; danach gesperrt.',
  )
  @Post('factors/email-code/confirm')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async emailCodeConfirm(
    @LoggedInUser() user: SessionUser,
    @Body() dto: EmailCodeConfirmDto,
    @Req() req: Request,
  ): Promise<{ ok: true; email: string }> {
    const { email } = await this.access.emailCodeConfirm(
      user,
      dto.code,
      sourceFrom(req),
    );
    return { ok: true, email };
  }

  /**
   * Entfernt einen zweiten Faktor. `art` ist `totp` oder `email-code`.
   *
   * Passkeys werden NICHT hierüber entfernt, sondern einzeln über
   * `DELETE /api/zugang/geraete/passkey:<id>` — dort greift dieselbe Sperre
   * gegen den letzten Faktor.
   */
  @Delete('factors/:kind')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async factorRemove(
    @LoggedInUser() user: SessionUser,
    @Param('kind') kind: string,
    @Body() _dto: FactorRemoveDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ invalidatedTrustedDevices: number }> {
    if (kind !== 'totp' && kind !== 'email-code') {
      throw new NotFoundException(
        'Unbekannte Faktorart. Erlaubt sind „totp" und „email-code".',
      );
    }
    const result = await this.access.factorRemove(
      user,
      kind,
      sourceFrom(req),
    );
    // Alle Merk-Geräte wurden entwertet, auch das dieses Browsers.
    res.clearCookie(COOKIE_TRUSTED_DEVICE, trustedDeviceCookieOptions(this.config));
    return result;
  }

  /**
   * Betriebsstand des Postausgangs — hinter der Sitzung.
   *
   * Gehörte früher an `/api/health`; dort war er anonym abfragbar und damit
   * ein Kontoverzeichnis auf Zuruf ([K2]). Hier ist er das, was er sein soll:
   * eine Betriebsanzeige für die Betreiberin. `letzterFehler.klasse` ist eine
   * feste Kategorie, niemals der Wortlaut des Relays.
   */
  @WithoutSecondFactor(
    'Lesend. Betriebsanzeige ohne Personenbezug.',
  )
  @Get('outbox')
  outbox(): {
    configured: boolean;
    tlsEnforced: boolean;
    lastError: { timestamp: string; errorClass: string } | null;
  } {
    return this.mail.sendState();
  }

  // --- Wiederherstellungscodes -------------------------------------------

  /** Erzeugt acht neue Codes und verwirft alle bisherigen. */
  @AllowWhileUninitialized(
    'Ersteinrichtung des ersten Kontos läuft, bevor der Tresor existiert; danach gesperrt.',
  )
  @Post('recovery-codes')
  @HttpCode(200)
  async recoveryCodes(
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<{ codes: string[] }> {
    const codes = await this.access.recoveryCodesNew(
      user,
      sourceFrom(req),
    );
    return { codes };
  }

  // --- Geräte -------------------------------------------------------------

  @WithoutSecondFactor(
    'Lesend. Zeigt die eigene Geräteliste und ändert nichts.',
  )
  @Get('devices')
  async devices(
    @LoggedInUser() user: SessionUser,
  ): Promise<{ devices: DeviceEntry[] }> {
    return { devices: await this.access.deviceList(user.id) };
  }

  @WithoutSecondFactor(
    'Ein Merk-Gerät zu widerrufen nimmt niemandem etwas weg, es macht die '
      + 'Anmeldung strenger. Der PASSKEY-Zweig derselben Route entfernt sehr wohl '
      + 'einen Faktor und prüft den Nachweis deshalb selbst (siehe '
      + 'ZugangService.widerrufe).',
  )
  @Delete('devices/:id')
  @HttpCode(200)
  async deviceRevoked(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: FactorRemoveDto,
    @SessionEvidenceAt() evidenceAt: Date | null,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ label: string }> {
    const result = await this.access.revoke(
      user,
      id,
      dto,
      sourceFrom(req),
      evidenceAt,
    );
    if (result.kind === 'passkey') {
      // Passkey-Änderung entwertet alle Merk-Geräte, auch das dieses Browsers.
      res.clearCookie(COOKIE_TRUSTED_DEVICE, trustedDeviceCookieOptions(this.config));
    }
    return { label: result.label };
  }

  @WithoutSecondFactor(
    'Beendet ausschließlich Sitzungen und Merk-Geräte — macht die Anmeldung '
      + 'strenger, nicht schwächer. Als Notbremse muss sie ohne Hürde erreichbar '
      + 'sein, gerade wenn jemand ein erbeutetes Cookie vermutet.',
  )
  @Post('devices/sign-out-all')
  @HttpCode(200)
  async signOutAll(
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ invalidated: number }> {
    const invalidated = await this.access.signOutAllDevices(
      user,
      sourceFrom(req),
    );
    // „Alle abmelden" beendet auch die eigene Sitzung — Cookies mit weg.
    res.clearCookie(COOKIE_TRUSTED_DEVICE, trustedDeviceCookieOptions(this.config));
    res.clearCookie(COOKIE_SESSION, sessionCookieOptions(this.config));
    return { invalidated };
  }
}
