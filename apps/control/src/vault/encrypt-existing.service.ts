/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { BLIND_INDEXES, ENCRYPTED_FIELDS } from '../crypto/encrypted-fields';
import {
  aadFor,
  decryptField,
  isEncryptedBytes,
  isEncryptedText,
  plaintextPolicy,
} from '../crypto/field-crypto';
import { rawClientOf } from '../prisma/field-encryption';
import { PrismaService } from '../prisma/prisma.service';
import { VaultService } from './vault.service';

type Row = Record<string, any>;

interface Target {
  model: string;
  delegate: string;
  /** Nur Zeilen, die noch veränderbar sind (keine festgeschriebenen Rechnungen). */
  where?: Row;
  keepUpdatedAt?: boolean;
}

/**
 * Veränderbare Klartextzeilen, die es laut Plan noch gibt. NICHT dabei:
 * festgeschriebene Rechnungen und ihre Posten (Trigger) sowie AuditLog (append-only).
 */
const TARGETS: Target[] = [
  { model: 'Company', delegate: 'company', keepUpdatedAt: true },
  { model: 'Note', delegate: 'note' },
  { model: 'Invoice', delegate: 'invoice', where: { finalizedAt: null } },
  { model: 'InvoiceLine', delegate: 'invoiceLine', where: { invoice: { finalizedAt: null } } },
  { model: 'MailDelivery', delegate: 'mailDelivery' },
  { model: 'Consent', delegate: 'consent' },
];

const BATCH = 100;

function isPlain(kind: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (kind === 'text') return typeof value === 'string' && !isEncryptedText(value);
  if (kind === 'bytes') return value instanceof Uint8Array && !isEncryptedBytes(value);
  return !isEncryptedText(value);
}

/**
 * EINMAL-LAUF "encrypt-existing": verschlüsselt nach dem Entsperren alle
 * veränderbaren Klartextzeilen. Idempotent (nur Werte ohne Chiffre-Präfix
 * werden angefasst), protokolliert nur Anzahlen.
 */
@Injectable()
export class EncryptExistingService implements OnModuleInit {
  private readonly logger = new Logger(EncryptExistingService.name);
  private running: Promise<Record<string, number>> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: VaultService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    // Synchron im Entsperr-Ereignis: die API bleibt bis zum Ende des Laufs bei
    // 423, damit keine Anfrage eine noch unverschlüsselte Altzeile übersieht.
    this.vault.onEveryUnlock(() => {
      this.vault.hold(
        this.run().catch((error: unknown) =>
          this.logger.error(`encrypt-existing gescheitert: ${String(error)}`),
        ),
      );
    });
  }

  /** Läuft nie doppelt; ein zweiter Aufruf wartet auf den laufenden. */
  run(): Promise<Record<string, number>> {
    this.running ??= this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async execute(): Promise<Record<string, number>> {
    const raw = rawClientOf(this.prisma);
    if (!raw) throw new Error('Kein unerweiterter Client verfügbar.');
    const counts: Record<string, number> = {};
    for (const target of TARGETS) {
      counts[target.model] = await this.encryptTable(raw as any, target);
    }
    // Ab jetzt ist alles Veränderbare verschlüsselt: Klartext in einem
    // verschlüsselten Feld gilt beim Lesen nicht mehr als Altbestand (N2).
    plaintextPolicy.strict = true;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      this.logger.log(`encrypt-existing: ${JSON.stringify(counts)}`);
      await this.audit.log({
        userId: null,
        actor: 'system:encrypt-existing',
        action: AUDIT_ACTION.vaultEncryptExisting,
        objectType: 'Vault',
        afterValue: counts,
      });
    }
    return counts;
  }

  private async encryptTable(raw: any, target: Target): Promise<number> {
    const fields = ENCRYPTED_FIELDS[target.model] ?? {};
    const indexes = BLIND_INDEXES[target.model] ?? [];
    let changed = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows: Row[] = await raw[target.delegate].findMany({
        where: target.where,
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        const data: Row = {};
        for (const [field, kind] of Object.entries(fields)) {
          if (isPlain(kind, row[field])) data[field] = row[field];
        }
        // Blind-Index nachtragen, wenn die Quelle schon verschlüsselt ist.
        for (const spec of indexes) {
          if (row[spec.index] === null && row[spec.source] != null && !(spec.source in data)) {
            data[spec.source] = decryptField(
              row[spec.source] as string,
              aadFor(target.model, spec.source, row.id as string),
            );
          }
        }
        if (Object.keys(data).length === 0) continue;
        if (target.keepUpdatedAt) data.updatedAt = row.updatedAt;
        await (this.prisma as any)[target.delegate].update({
          where: { id: row.id },
          data,
        });
        changed += 1;
      }
      cursor = rows[rows.length - 1].id as string;
      if (rows.length < BATCH) break;
    }
    return changed;
  }
}
