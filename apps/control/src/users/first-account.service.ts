import { Injectable, Logger } from '@nestjs/common';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { EmergencyService } from '../auth/emergency.service';
import { PrismaService } from '../prisma/prisma.service';
import { isPlausibleAddress, normalizeAddress } from '../consent/address';
import { FirstAccountNotPossibleError } from './user.errors';

/** So lange gilt der Registrierlink des ersten Kontos. */
export const FIRST_ACCOUNT_VALID_MS = 15 * 60 * 1000;

/**
 * DAS ALLERERSTE KONTO — der einzige Weg in eine leere Verwaltung.
 *
 * WARUM ES DAS BRAUCHT: Bis hierher gab es keinen. `emergency enrollment`
 * verlangt ein BESTEHENDES Konto (`emergency.service.ts`: „Es gibt kein Konto mit
 * der Kennung"), und das Seed-Skript bricht unter `NODE_ENV=production`
 * absichtlich ab. Eine frisch ausgerollte Verwaltung war damit verschlossen:
 * Man brauchte ein Konto, um ein Konto anzulegen. `docs/operations/emergency-access.md`
 * benannte die Lücke, ohne sie zu schliessen.
 *
 * DIE SPERRE IST DIE GANZE SICHERHEIT DIESES WEGES: Er arbeitet NUR, solange
 * die Tabelle leer ist. Sobald ein einziges Konto existiert — auch ein
 * deaktiviertes, auch eines ohne Zugang — verweigert er den Dienst und
 * verweist auf die Nutzerverwaltung. Damit lässt er sich später nicht als
 * Hintertür benutzen, und wer Zugriff auf den Container hat, kommt über
 * `emergency enrollment` ohnehin an jedes Konto.
 *
 * ES ENTSTEHT EIN PASSKEY-LINK, kein Passwort-Link. Der Passkey ersetzt
 * Passwort und zweiten Faktor zugleich (`auth.controller.ts`, „Weg 2") — das
 * erste Konto kommt damit OHNE funktionierenden Mailversand hinein. Ein
 * Passwort-Link führte in die Sackgasse: Nach dem Passwort verlangt die
 * Anmeldung einen zweiten Faktor, und der erste wäre der E-Mail-Code.
 */
@Injectable()
export class FirstAccountService {
  private readonly logger = new Logger(FirstAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emergency: EmergencyService,
  ) {}

  async create(
    rawAddress: string,
    name: string,
    actor: string,
  ): Promise<{ url: string; expiresAt: Date; username: string }> {
    const email = normalizeAddress(rawAddress);
    if (!isPlausibleAddress(email)) {
      throw new FirstAccountNotPossibleError(
        `"${rawAddress}" ist keine brauchbare E-Mail-Adresse.`,
      );
    }
    const cleanName = name.trim();
    if (cleanName === '') {
      throw new FirstAccountNotPossibleError('Der Name darf nicht leer sein.');
    }

    // Die Sperre. Bewusst OHNE Filter auf `deaktiviertAm`: Auch ein gesperrtes
    // Konto ist ein Konto, und dann ist `emergency unlock` der richtige Weg.
    const existing = await this.prisma.user.count();
    if (existing > 0) {
      throw new FirstAccountNotPossibleError(
        `Es gibt bereits ${existing} Konto/Konten. Dieser Weg steht nur einer ` +
          'leeren Verwaltung offen. Für weitere Konten: Nutzerverwaltung in der ' +
          'Oberfläche, oder "emergency enrollment <kennung>" für ein ' +
          'bestehendes.',
      );
    }

    const user = await this.prisma.user.create({
      data: {
        name: cleanName,
        email,
        // Adresse als Nutzername, wie beim Eintragen über die Oberfläche.
        username: email,
        // `inhaber` ist dem Konto aus der Ersteinrichtung vorbehalten — nicht,
        // weil es mehr dürfte, sondern damit im Nachweis erkennbar bleibt,
        // welches Konto am Anfang stand.
        role: 'owner',
        // Der E-Mail-Code als zweiter Faktor für spätere Anmeldungen. Für
        // DIESE Anmeldung wird er nicht gebraucht (Passkey ist einstufig),
        // aber ohne ihn wäre das Konto nach dem Entfernen des Passkeys eine
        // Sackgasse — derselbe Fehler wie beim Eintragen (A.9).
        loginCodeEnabled: true,
      },
      select: { id: true, username: true },
    });

    await this.audit.log({
      userId: null,
      actor,
      action: AUDIT_ACTION.userRegistered,
      objectType: 'User',
      objectId: user.id,
      // KEINE Adresse im Nachweis — wie überall in der Benutzerverwaltung.
      afterValue: { reason: 'first-account', role: 'owner' },
      ip: null,
      userAgent: null,
    });

    const link = await this.emergency.generateLink(
      user.username,
      'passkey',
      actor,
      new Date(),
      FIRST_ACCOUNT_VALID_MS,
    );
    this.logger.log(
      `Erstes Konto angelegt (${user.id}); Registrierlink gültig ` +
        `${Math.round(FIRST_ACCOUNT_VALID_MS / 60_000)} Minuten.`,
    );
    return { ...link, username: user.username };
  }
}
