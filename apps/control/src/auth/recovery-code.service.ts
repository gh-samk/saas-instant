import { Injectable } from '@nestjs/common';
import {
  COUNT_CODES,
  findMatchingRecoveryCode,
  generateRecoveryCodes,
  normalizeCode,
} from '@saas-instant/auth-core';
import { PrismaService } from '../prisma/prisma.service';

// Anzahl, Zeichenvorrat, Normalform und Erzeugung wohnen in
// `@saas-instant/auth-core`; hier bleiben die Namen erreichbar.
export { COUNT_CODES, normalizeCode };

/**
 * Acht Wiederherstellungscodes je Benutzer, argon2id-gehasht.
 * Jeder Code ist genau EINMAL verwendbar.
 */
@Injectable()
export class RecoveryCodeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Erzeugt acht neue Codes und ersetzt alle bisherigen. Gibt den Klartext
   * zurück — das ist die einzige Gelegenheit, ihn zu sehen.
   */
  async generateNewCodes(userId: string): Promise<string[]> {
    const { codes, hashes } = await generateRecoveryCodes(COUNT_CODES);

    await this.prisma.$transaction(async (tx) => {
      // Zeilen-Lock auf den Benutzer, bevor gelöscht und angelegt wird.
      //
      // Ohne ihn löschen zwei gleichzeitige Aufrufe beide erst die alten Codes
      // und legen dann beide acht neue an — das Konto hätte SECHZEHN gültige
      // Wiederherstellungscodes statt acht. Aufgefallen durch den
      // Integrationslauf, der zu dieser Stelle bis dahin fehlte ([H4]).
      //
      // Dasselbe Mittel wie bei der Faktorentfernung: die Invariante spannt
      // über mehrere Zeilen, ein bedingtes UPDATE kann sie nicht ausdrücken.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({
        data: hashes.map((codeHash) => ({ userId, codeHash })),
      });
    });

    return codes;
  }

  /** Anzahl der noch nicht verbrauchten Codes. */
  async countOpen(userId: string): Promise<number> {
    return this.prisma.recoveryCode.count({
      where: { userId, consumedAt: null },
    });
  }

  /**
   * Löst einen Code ein. Gibt die ID des entwerteten Codes zurück oder null,
   * wenn der Code falsch oder bereits verbraucht ist.
   *
   * Die Entwertung ist atomar: `updateMany` mit der Bedingung
   * `verbrauchtAm: null` ist ein einzelnes bedingtes UPDATE. Nur der erste von
   * zwei gleichzeitigen Versuchen trifft eine Zeile, der zweite bekommt
   * `count === 0` und scheitert. Derselbe Code kann so nie zweimal gelten.
   */
  async resolve(userId: string, input: string): Promise<string | null> {
    const open = await this.prisma.recoveryCode.findMany({
      where: { userId, consumedAt: null },
      select: { id: true, codeHash: true },
    });

    const candidate = await findMatchingRecoveryCode(open, input);
    if (!candidate) return null;

    const result = await this.prisma.recoveryCode.updateMany({
      where: { id: candidate.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return result.count === 1 ? candidate.id : null;
  }
}
