import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { BackupKeyGuard } from '../instances/backup-key.guard';
import {
  InvoiceArchiveService,
  type InvoiceArchivePage,
} from './invoice-archive.service';

/**
 * `GET /api/internal/invoice-archive?after=<Cursor>` — entschlüsselte
 * Rechnungsdokumente für den Sicherungs-Agent.
 *
 * Abgesichert wie `/api/internal/backup-plan`: Schlüssel im Header
 * (`x-backup-key`, `BackupKeyGuard`; ohne gesetzten Schlüssel gibt es die
 * Route nicht: 404). Bei gesperrter Verwaltung antwortet die Tresor-Sperre
 * (`VaultLockGuard`, global) mit 423 `vault_locked`, bevor dieser Code läuft.
 */
@Controller('internal/invoice-archive')
@UseGuards(BackupKeyGuard)
export class InternalInvoiceArchiveController {
  constructor(private readonly archive: InvoiceArchiveService) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async get(@Query('after') after?: string): Promise<InvoiceArchivePage> {
    const cursor = typeof after === 'string' && after !== '' ? after : undefined;
    return this.archive.page(cursor);
  }
}
