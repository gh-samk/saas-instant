import { EventEmitter } from 'events';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { keyring } from '../crypto/keyring';
import { PrismaService } from '../prisma/prisma.service';
import { base32Decode, base32Encode, groupsOfEight } from './base32';

/** argon2id-Parameter: mindestens m = 64 MiB, t = 3, p = 1 (werden je Eintrag gespeichert). */
export const KDF_PARAMS = {
  memoryKib: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
} as const;

export const PASSPHRASE_MIN_LENGTH = 12;
const PASSPHRASE_MAX_LENGTH = 256;
const RECOVERY_BYTES = 32;

export type VaultState = 'uninitialized' | 'locked' | 'unlocked';

export interface VaultEntryInfo {
  id: string;
  kind: 'passphrase' | 'recovery';
  label: string;
  userId: string | null;
  createdAt: Date;
}

export interface VaultActor {
  userId: string | null;
  actor: string;
  ip?: string | null;
  userAgent?: string | null;
}

interface WrapRow {
  id: string;
  kind: string;
  label: string;
  userId: string | null;
  kdfMemoryKib: number;
  kdfTimeCost: number;
  kdfParallelism: number;
  salt: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  wrappedDek: Uint8Array;
}

/** Fehlversuche beim Entsperren: ab dem fünften wächst die Wartezeit (30 s, 60 s, ... höchstens 15 min). */
const FREE_ATTEMPTS = 5;
const BASE_WAIT_MS = 30_000;
const MAX_WAIT_MS = 15 * 60_000;

const wrapAad = (kind: string, id: string): Buffer =>
  Buffer.from(`vault:${kind}:${id}`, 'utf8');

async function deriveKek(
  secret: Buffer | string,
  salt: Uint8Array,
  p: { memoryKib: number; timeCost: number; parallelism: number },
): Promise<Buffer> {
  return argon2.hash(secret, {
    type: argon2.argon2id,
    raw: true,
    salt: Buffer.from(salt),
    memoryCost: p.memoryKib,
    timeCost: p.timeCost,
    parallelism: p.parallelism,
    hashLength: 32,
  });
}

/**
 * TRESOR: verwahrt den Datenschlüssel (DEK) der Feldverschlüsselung.
 *
 * - Der DEK (32 Byte, zufällig) wird beim Einrichten erzeugt und NIE im Klartext
 *   gespeichert. Gespeichert wird er mehrfach "eingepackt": je Admin-Passphrase
 *   einmal (KEK = argon2id) und einmal mit dem Wiederherstellungsschlüssel.
 * - Nach jedem Start ist der Tresor gesperrt; der DEK liegt nur im Prozessspeicher.
 * - Umpacken (Passphrase ändern/hinzufügen, Wiederherstellungsschlüssel neu)
 *   ändert nur die Verpackungen, nie den DEK: festgeschriebene Rechnungen lassen
 *   sich nicht neu verschlüsseln.
 *
 * Die Prüfung der Passphrase ist die GCM-Authentisierung beim Auspacken
 * (zeitkonstant, in OpenSSL). Bei fehlenden Einträgen läuft trotzdem eine
 * Ableitung, damit sich "kein Eintrag" nicht an der Antwortzeit ablesen lässt.
 */
@Injectable()
export class VaultService {
  private readonly logger = new Logger(VaultService.name);
  private readonly events = new EventEmitter();
  private dek: Buffer | null = null;
  /** Laufende Wartungsläufe (z. B. encrypt-existing), während derer die Verwaltung noch 423 meldet. */
  private readonly holds = new Set<Promise<unknown>>();
  private kdf: { memoryKib: number; timeCost: number; parallelism: number } = KDF_PARAMS;
  private failures = new Map<string, { count: number; blockedUntil: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    this.events.setMaxListeners(50);
  }

  /**
   * NUR FÜR TESTS: günstigere argon2-Parameter, damit Suiten nicht je Datei
   * Sekunden mit der Schlüsselableitung verbringen. Außerhalb von Jest wirkungslos
   * (wirft), dort gelten immer `KDF_PARAMS`.
   */
  useKdfParamsForTests(params: { memoryKib: number; timeCost: number; parallelism: number }): void {
    if (process.env['JEST_WORKER_ID'] === undefined) {
      throw new Error('useKdfParamsForTests ist nur unter Jest erlaubt.');
    }
    this.kdf = params;
  }

  // --- Zustand ----------------------------------------------------------------

  isUnlocked(): boolean {
    return this.dek !== null && keyring.unlocked;
  }

  /** Entsperrt UND kein Wartungslauf aktiv: erst dann nimmt die API Anfragen an. */
  isReady(): boolean {
    return this.isUnlocked() && this.holds.size === 0;
  }

  /** Hält die API (423), bis `work` beendet ist; Fehler werden nicht weitergereicht. */
  hold(work: Promise<unknown>): void {
    const tracked: Promise<unknown> = work
      .catch(() => undefined)
      .finally(() => this.holds.delete(tracked));
    this.holds.add(tracked);
  }

  async settled(): Promise<void> {
    await Promise.all([...this.holds]);
  }

  async isInitialized(): Promise<boolean> {
    return (await this.prisma.vault.count()) > 0;
  }

  async state(): Promise<VaultState> {
    if (this.isUnlocked()) return 'unlocked';
    return (await this.isInitialized()) ? 'locked' : 'uninitialized';
  }

  async status(): Promise<{ state: VaultState; passphrases: number; hasRecovery: boolean }> {
    const rows = await this.prisma.vault.groupBy({ by: ['kind'], _count: { _all: true } });
    const count = (k: string): number =>
      rows.find((r) => r.kind === k)?._count._all ?? 0;
    const state: VaultState = this.isUnlocked()
      ? 'unlocked'
      : rows.length > 0
        ? 'locked'
        : 'uninitialized';
    return { state, passphrases: count('passphrase'), hasRecovery: count('recovery') > 0 };
  }

  /** Läuft `callback` sofort, wenn schon entsperrt, sonst beim (nächsten) Entsperren. */
  onUnlocked(callback: () => void): void {
    if (this.isUnlocked()) {
      callback();
      return;
    }
    this.events.once('unlocked', callback);
  }

  /** Dauerhafter Beobachter: jedes Entsperren (z. B. Zeitplan, Einmal-Lauf). */
  onEveryUnlock(callback: () => void): void {
    this.events.on('unlocked', callback);
  }

  async listEntries(): Promise<VaultEntryInfo[]> {
    const rows = await this.prisma.vault.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, label: true, userId: true, createdAt: true },
    });
    return rows.map((r) => ({ ...r, kind: r.kind as 'passphrase' | 'recovery' }));
  }

  // --- Einrichten --------------------------------------------------------------

  /**
   * Erzeugt den DEK, packt ihn mit der Passphrase und mit einem neuen
   * Wiederherstellungsschlüssel ein und entsperrt. Der Wiederherstellungs-
   * schlüssel wird NUR HIER zurückgegeben (Base32 in Achtergruppen).
   */
  async initialize(
    passphrase: string,
    actor: VaultActor,
    label = 'Passphrase',
  ): Promise<{ recoveryKey: string }> {
    this.assertPassphrase(passphrase);
    const dek = randomBytes(32);
    const recovery = randomBytes(RECOVERY_BYTES);
    const rows = [
      await this.wrap('passphrase', label, actor.userId, passphrase, dek),
      await this.wrap('recovery', 'Wiederherstellungsschlüssel', null, recovery, dek),
    ];

    await this.prisma.$transaction(async (tx) => {
      // Zwei gleichzeitige Einrichtungen dürfen nicht beide gewinnen.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7165300001)`;
      if ((await tx.vault.count()) > 0) {
        throw new ConflictException({
          errorCode: 'vault_already_initialized',
          message: 'Der Tresor ist bereits eingerichtet.',
        });
      }
      await tx.vault.createMany({ data: rows });
    });

    this.open(dek);
    await this.audit.log({
      userId: actor.userId,
      actor: actor.actor,
      action: AUDIT_ACTION.vaultInitialized,
      objectType: 'Vault',
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { recoveryKey: groupsOfEight(base32Encode(recovery)) };
  }

  // --- Entsperren / Sperren ----------------------------------------------------

  /**
   * Entsperrt mit Passphrase ODER Wiederherstellungsschlüssel. Wirft bei
   * falschem Geheimnis (401) bzw. zu vielen Fehlversuchen (429).
   */
  async unlock(secret: string, actor: VaultActor, rateKey = 'global'): Promise<void> {
    this.assertNotBlocked(rateKey);
    const rows = (await this.prisma.vault.findMany()) as WrapRow[];
    if (rows.length === 0) {
      throw new ConflictException({
        errorCode: 'vault_uninitialized',
        message: 'Der Tresor ist noch nicht eingerichtet.',
      });
    }

    const recoveryBytes = base32Decode(secret);
    const asRecovery =
      recoveryBytes !== null && recoveryBytes.length === RECOVERY_BYTES
        ? recoveryBytes
        : null;
    const recoveryRows = asRecovery ? rows.filter((r) => r.kind === 'recovery') : [];
    const passphraseRows = rows.filter((r) => r.kind === 'passphrase');
    const candidates: { row: WrapRow; input: Buffer | string }[] = [
      ...recoveryRows.map((row) => ({ row, input: asRecovery as Buffer })),
      ...passphraseRows.map((row) => ({ row, input: secret })),
    ];

    let dek: Buffer | null = null;
    let usedKind: string | null = null;
    for (const { row, input } of candidates) {
      dek = await this.unwrap(row, input);
      if (dek) {
        usedKind = row.kind;
        break;
      }
    }
    if (candidates.length === 0) {
      // Gleiche Rechenzeit wie bei einem echten Versuch.
      await deriveKek(secret, randomBytes(16), this.kdf);
    }

    if (!dek) {
      this.registerFailure(rateKey);
      await this.audit.log({
        userId: actor.userId,
        actor: actor.actor,
        action: AUDIT_ACTION.vaultUnlockError,
        objectType: 'Vault',
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      throw new HttpException(
        {
          errorCode: 'vault_wrong_secret',
          message: 'Passphrase oder Wiederherstellungsschlüssel ist falsch.',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    this.failures.delete(rateKey);
    const wasUnlocked = this.isUnlocked();
    if (!wasUnlocked) this.open(dek);
    else dek.fill(0);
    await this.audit.log({
      userId: actor.userId,
      actor: actor.actor,
      action: AUDIT_ACTION.vaultUnlocked,
      objectType: 'Vault',
      afterValue: { via: usedKind },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  /** Vergisst den DEK. Sonst gibt es keinen Weg in den gesperrten Zustand außer dem Neustart. */
  async lock(actor?: VaultActor): Promise<void> {
    this.dek?.fill(0);
    this.dek = null;
    keyring.clear();
    if (actor) {
      await this.audit.log({
        userId: actor.userId,
        actor: actor.actor,
        action: AUDIT_ACTION.vaultLocked,
        objectType: 'Vault',
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }
  }

  // --- Umpacken ---------------------------------------------------------------

  async addPassphrase(
    passphrase: string,
    label: string,
    owner: string | null,
    actor: VaultActor,
  ): Promise<VaultEntryInfo> {
    const dek = this.requireDek();
    this.assertPassphrase(passphrase);
    const row = await this.wrap('passphrase', label.trim() || 'Passphrase', owner, passphrase, dek);
    await this.prisma.vault.create({ data: row });
    await this.audit.log({
      userId: actor.userId,
      actor: actor.actor,
      action: AUDIT_ACTION.vaultPassphraseAdded,
      objectType: 'Vault',
      objectId: row.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { id: row.id, kind: 'passphrase', label: row.label, userId: row.userId, createdAt: new Date() };
  }

  /** Ersetzt die Verpackung eines Passphrase-Eintrags. Die ALTE Passphrase muss stimmen. */
  async changePassphrase(
    entryId: string,
    currentPassphrase: string,
    newPassphrase: string,
    actor: VaultActor,
  ): Promise<void> {
    const dek = this.requireDek();
    this.assertPassphrase(newPassphrase);
    const entry = (await this.prisma.vault.findUnique({ where: { id: entryId } })) as WrapRow | null;
    if (!entry || entry.kind !== 'passphrase') {
      throw new NotFoundException({
        errorCode: 'vault_entry_not_found',
        message: 'Eintrag nicht gefunden.',
      });
    }
    const verified = await this.unwrap(entry, currentPassphrase);
    if (!verified || !constantTimeEqual(verified, dek)) {
      throw new HttpException(
        { errorCode: 'vault_wrong_secret', message: 'Die bisherige Passphrase ist falsch.' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const fresh = await this.wrap('passphrase', entry.label, entry.userId, newPassphrase, dek);
    // Neue Zeile, dann alte weg: es gibt keinen Zeitpunkt ohne gültigen Eintrag.
    await this.prisma.$transaction([
      this.prisma.vault.create({ data: fresh }),
      this.prisma.vault.delete({ where: { id: entry.id } }),
    ]);
    await this.audit.log({
      userId: actor.userId,
      actor: actor.actor,
      action: AUDIT_ACTION.vaultPassphraseChanged,
      objectType: 'Vault',
      objectId: fresh.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  /** Neuer Wiederherstellungsschlüssel; der alte wird ungültig. Wird nur hier zurückgegeben. */
  async regenerateRecovery(actor: VaultActor): Promise<{ recoveryKey: string }> {
    const dek = this.requireDek();
    const recovery = randomBytes(RECOVERY_BYTES);
    const row = await this.wrap('recovery', 'Wiederherstellungsschlüssel', null, recovery, dek);
    await this.prisma.$transaction([
      this.prisma.vault.deleteMany({ where: { kind: 'recovery' } }),
      this.prisma.vault.create({ data: row }),
    ]);
    await this.audit.log({
      userId: actor.userId,
      actor: actor.actor,
      action: AUDIT_ACTION.vaultRecoveryRegenerated,
      objectType: 'Vault',
      objectId: row.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { recoveryKey: groupsOfEight(base32Encode(recovery)) };
  }

  // --- intern -----------------------------------------------------------------

  private open(dek: Buffer): void {
    this.dek = dek;
    keyring.set(dek);
    this.events.emit('unlocked');
  }

  private requireDek(): Buffer {
    if (!this.dek) {
      throw new HttpException(
        { errorCode: 'vault_locked', message: 'Der Tresor ist gesperrt.' },
        HttpStatus.LOCKED,
      );
    }
    return this.dek;
  }

  private assertPassphrase(passphrase: unknown): asserts passphrase is string {
    if (
      typeof passphrase !== 'string' ||
      passphrase.length < PASSPHRASE_MIN_LENGTH ||
      passphrase.length > PASSPHRASE_MAX_LENGTH
    ) {
      throw new BadRequestException({
        errorCode: 'vault_passphrase_invalid',
        message: `Die Passphrase muss mindestens ${PASSPHRASE_MIN_LENGTH} Zeichen lang sein.`,
      });
    }
  }

  private async wrap(
    kind: 'passphrase' | 'recovery',
    label: string,
    userId: string | null,
    secret: Buffer | string,
    dek: Buffer,
  ) {
    const id = randomUUID();
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const kek = await deriveKek(secret, salt, this.kdf);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    cipher.setAAD(wrapAad(kind, id));
    const wrappedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
    kek.fill(0);
    return {
      id,
      kind,
      label,
      userId,
      kdf: 'argon2id',
      kdfMemoryKib: this.kdf.memoryKib,
      kdfTimeCost: this.kdf.timeCost,
      kdfParallelism: this.kdf.parallelism,
      salt,
      iv,
      tag: cipher.getAuthTag(),
      wrappedDek,
    };
  }

  private async unwrap(row: WrapRow, secret: Buffer | string): Promise<Buffer | null> {
    const kek = await deriveKek(secret, row.salt, {
      memoryKib: row.kdfMemoryKib,
      timeCost: row.kdfTimeCost,
      parallelism: row.kdfParallelism,
    });
    try {
      const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(row.iv));
      decipher.setAAD(wrapAad(row.kind, row.id));
      decipher.setAuthTag(Buffer.from(row.tag));
      return Buffer.concat([decipher.update(Buffer.from(row.wrappedDek)), decipher.final()]);
    } catch {
      return null;
    } finally {
      kek.fill(0);
    }
  }

  private assertNotBlocked(key: string): void {
    const entry = this.failures.get(key);
    if (entry && entry.blockedUntil > Date.now()) {
      const seconds = Math.ceil((entry.blockedUntil - Date.now()) / 1000);
      throw new HttpException(
        {
          errorCode: 'vault_rate_limited',
          message: `Zu viele Fehlversuche. Bitte in ${seconds} Sekunden erneut versuchen.`,
          detail: { retryAfterSeconds: seconds },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private registerFailure(key: string): void {
    const entry = this.failures.get(key) ?? { count: 0, blockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= FREE_ATTEMPTS) {
      const wait = Math.min(BASE_WAIT_MS * 2 ** (entry.count - FREE_ATTEMPTS), MAX_WAIT_MS);
      entry.blockedUntil = Date.now() + wait;
      this.logger.warn(`Tresor: ${entry.count} Fehlversuche, gesperrt für ${Math.round(wait / 1000)} s.`);
    }
    this.failures.set(key, entry);
  }
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
