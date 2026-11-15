import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';

/** Es werden immer genau acht Codes ausgegeben. */
export const COUNT_CODES = 8;
/** Zeichen je Code (zwei Gruppen zu vier). */
const CHARS_PER_GROUP = 4;
/**
 * Zeichenvorrat ohne verwechselbare Zeichen (kein 0/O, 1/l/I). Die Codes
 * werden ausgedruckt und von Hand abgetippt.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/**
 * Bringt eine Eingabe auf die Normalform, gegen die gehasht wird:
 * Kleinbuchstaben, nur Zeichen aus dem Alphabet, keine Trenner.
 * So sind „ABCD-EFGH", „abcd efgh" und „abcdefgh" derselbe Code.
 */
export function normalizeCode(input: string): string {
  const small = input.toLowerCase();
  let result = '';
  for (const chars of small) {
    if (ALPHABET.includes(chars)) result += chars;
  }
  return result;
}

function generateCode(): string {
  let raw = '';
  for (let i = 0; i < CHARS_PER_GROUP * 2; i += 1) {
    raw += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `${raw.slice(0, CHARS_PER_GROUP)}-${raw.slice(CHARS_PER_GROUP)}`;
}

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
    const codes: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < COUNT_CODES; i += 1) {
      const code = generateCode();
      codes.push(code);
      hashes.push(
        await argon2.hash(normalizeCode(code), { type: argon2.argon2id }),
      );
    }

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
    const normalized = normalizeCode(input);
    if (normalized.length === 0) return null;

    const open = await this.prisma.recoveryCode.findMany({
      where: { userId, consumedAt: null },
      select: { id: true, codeHash: true },
    });

    for (const candidate of open) {
      let matches = false;
      try {
        matches = await argon2.verify(candidate.codeHash, normalized);
      } catch {
        // Beschädigter Hash: dieser Code ist unbrauchbar, nicht der ganze Vorgang.
        matches = false;
      }
      if (!matches) continue;

      const result = await this.prisma.recoveryCode.updateMany({
        where: { id: candidate.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return result.count === 1 ? candidate.id : null;
    }

    return null;
  }
}
