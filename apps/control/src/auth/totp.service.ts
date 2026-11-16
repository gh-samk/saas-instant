import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_NAME_DEFAULT } from '../common/app-defaults';
import {
  TOTP_PENDING_VALID_MS,
  buildOtpauthUrl,
  checkTotpCode,
  checkTotpStep,
  generateTotpSecret,
  isTotpPendingExpired,
  normalizeTotpCode,
  totpPendingValidUntil,
} from '@saas-instant/auth-core';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

// Die Frist (10 Minuten) und die Zeitfenster-Toleranz (± 30 Sekunden) wohnen in
// `@saas-instant/auth-core`.
export { TOTP_PENDING_VALID_MS };

/** Ergebnis der TOTP-Einrichtung — der Klartext ist nur hier sichtbar. */
export interface TotpSetup {
  secretBase32: string;
  otpauthUrl: string;
}

/**
 * TOTP als Rückfallebene, wenn kein Passkey zur Verfügung steht.
 * Das Geheimnis liegt ausschließlich verschlüsselt (AES-256-GCM) in der
 * Datenbank und wird niemals geloggt oder ins Audit-Log geschrieben.
 */
@Injectable()
export class TotpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Erzeugt ein neues Geheimnis, legt es VORLÄUFIG verschlüsselt ab und liefert
   * Klartext plus otpauth-URL für den QR-Code.
   *
   * Geschrieben wird ausschließlich `totpGeheimnisVorlaeufig`. Das aktive
   * `totpGeheimnis` bleibt unangetastet, bis `bestaetige` einen gültigen Code
   * aus der neuen App gesehen hat.
   *
   * Vorher überschrieb diese Methode das aktive Geheimnis SOFORT: wer den
   * Einrichtungsdialog nur öffnete und dann abbrach, hatte einen toten
   * Authenticator und keinen Hinweis darauf. Dieselbe Bauweise wie beim
   * E-Mail-Faktor, wo die Zieladresse auch erst mit der Bestätigung gilt.
   */
  async setUp(
    userId: string,
    email: string,
    now: Date = new Date(),
  ): Promise<TotpSetup> {
    const secretBase32 = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpSecretPending: this.crypto.encrypt(secretBase32),
        totpPendingValidUntil: totpPendingValidUntil(now),
      },
    });

    const issuer = this.config.get<string>(
      'CONTROL_TOTP_ISSUER',
      APP_NAME_DEFAULT,
    );
    return {
      secretBase32,
      otpauthUrl: buildOtpauthUrl(email, issuer, secretBase32),
    };
  }

  /**
   * Übernimmt das vorläufige Geheimnis als aktives — erst nach einem gültigen
   * Code aus der neuen App.
   *
   * Die drei Fehlschläge werden UNTERSCHIEDEN, weil der Aufrufer sie
   * unterschiedlich behandeln muss: nur `falsch` ist ein Rateversuch und darf
   * auf die Kontosperre zählen. „Kein Geheimnis" und „abgelaufen" sind
   * Zustandsfehler und würden den Zähler sonst grundlos hochtreiben — wer den
   * Dialog zu lange offen ließ, wäre plötzlich ausgesperrt.
   *
   * Das Übernehmen läuft als BEDINGTES `updateMany` auf genau den Wert, der
   * eben gelesen wurde. Hat eine zweite Einrichtung das vorläufige Geheimnis
   * zwischenzeitlich ersetzt, greift der Schreibvorgang nicht mehr und der
   * überholte Vorgang aktiviert nichts — dasselbe Muster wie beim Einlösen
   * eines Wiederherstellungscodes.
   */
  async confirm(
    userId: string,
    code: string,
    now: Date = new Date(),
  ): Promise<'ok' | 'no_secret' | 'expired' | 'wrong'> {
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        totpSecretPending: true,
        totpPendingValidUntil: true,
      },
    });
    const pending = account?.totpSecretPending ?? null;
    if (!pending) return 'no_secret';

    if (this.isExpired(account?.totpPendingValidUntil ?? null, now)) {
      // Aufräumen statt liegenlassen: ein abgelaufenes Geheimnis ist genau der
      // Zustand, der die Ratestrecke aus [K5] offen hielt.
      await this.discardPending(userId);
      return 'expired';
    }

    if (!this.check(pending, code)) return 'wrong';

    const written = await this.prisma.user.updateMany({
      where: { id: userId, totpSecretPending: pending },
      data: {
        totpSecret: pending,
        // Neues Geheimnis, neuer Zähler: der Schritt des alten gilt nicht mehr.
        totpLastStep: null,
        totpSecretPending: null,
        totpPendingValidUntil: null,
      },
    });
    return written.count === 1 ? 'ok' : 'no_secret';
  }

  /**
   * Ist die Frist des vorläufigen Geheimnisses abgelaufen?
   *
   * Ein FEHLENDER Zeitpunkt gilt als abgelaufen: so sieht ein Geheimnis aus,
   * das noch die fristlose Fassung geschrieben hat. Im Zweifel verfallen
   * lassen, nicht unbegrenzt gelten lassen.
   */
  isExpired(validUntil: Date | null, now: Date = new Date()): boolean {
    return isTotpPendingExpired(validUntil, now);
  }

  /** Verwirft ein vorläufiges Geheimnis, ohne das aktive anzufassen. */
  async discardPending(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecretPending: null, totpPendingValidUntil: null },
    });
  }

  /**
   * Prüft einen Code UND verbraucht seinen Zeitschritt (Replay-Schutz).
   *
   * Ein innerhalb des Fensters abgegriffener Code ließe sich sonst erneut
   * verwenden. Der zuletzt akzeptierte Schritt steht am Konto; das bedingte
   * UPDATE (`totpLastStep` leer oder kleiner) ist atomar, sodass von zwei
   * gleichzeitigen Einreichungen desselben Codes genau eine gewinnt.
   */
  async checkAndConsume(
    userId: string,
    totpSecretEncrypted: string | null,
    code: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!totpSecretEncrypted) return false;
    if (normalizeTotpCode(code) === null) return false;
    const secret = this.crypto.decrypt(totpSecretEncrypted);
    const step = checkTotpStep(secret, code, now);
    if (step === null) return false;
    const written = await this.prisma.user.updateMany({
      where: {
        id: userId,
        OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
      },
      data: { totpLastStep: step },
    });
    return written.count === 1;
  }

  /**
   * Prüft einen Code gegen das gespeicherte Geheimnis.
   * Ist kein Geheimnis hinterlegt, ist das Ergebnis false — der TOTP-Weg
   * steht dann schlicht nicht zur Verfügung.
   */
  check(totpSecretEncrypted: string | null, code: string): boolean {
    if (!totpSecretEncrypted) return false;
    if (normalizeTotpCode(code) === null) return false;
    const secret = this.crypto.decrypt(totpSecretEncrypted);
    return checkTotpCode(secret, code);
  }
}
