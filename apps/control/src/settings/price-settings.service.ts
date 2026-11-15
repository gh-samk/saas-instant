import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService, AUDIT_ACTION } from '../audit/audit.service';
import type { SessionUser } from '../auth/session.service';
import { BusinessError } from '../common/errors/business-error';
import type { InquirySource } from '../common/inquiry-source';
import { issues, PricingConfigService } from '../invoices/pricing.config';
import type { StoredPriceList } from '../invoices/pricing.config';
import { PrismaService } from '../prisma/prisma.service';
import type { PricesUpdateDto } from './dto/prices.dto';

/** Die Preisliste, wie die Oberfläche sie liest. */
export interface PricesResponse {
  taxRatePercent: number;
  paymentTermDays: number;
  averageDays: number;
  currency: string;
  tiers: {
    key: string;
    label: string;
    maxPersons: number | null;
    monthlyCent: number;
    halfYearlyCent: number;
    yearlyCent: number;
    setupCent: number;
    archived: boolean;
  }[];
  updatedAt: string | null;
}

/** Die Preisliste ist unbrauchbar — mit allen Beanstandungen. */
export class PricesInvalidError extends BusinessError {
  constructor(problems: string[]) {
    super(
      'prices_invalid',
      'Die Preisliste ist nicht stimmig und wurde nicht gespeichert.',
      HttpStatus.BAD_REQUEST,
      { issues: problems },
    );
  }
}

/** Was im Audit-Log steht: Zahlen und Schlüssel, nichts Geheimes. */
function summary(p: PricesResponse): Record<string, unknown> {
  return {
    taxRatePercent: p.taxRatePercent,
    paymentTermDays: p.paymentTermDays,
    averageDays: p.averageDays,
    currency: p.currency,
    tiers: p.tiers.map((s) => ({
      key: s.key,
      label: s.label,
      maxPersons: s.maxPersons,
      monthlyCent: s.monthlyCent,
      halfYearlyCent: s.halfYearlyCent,
      yearlyCent: s.yearlyCent,
      setupCent: s.setupCent,
      archived: s.archived,
    })),
  };
}

function asResponse(stored: StoredPriceList): PricesResponse {
  return {
    taxRatePercent: stored.taxRate,
    paymentTermDays: stored.paymentDueDays,
    averageDays: stored.averageDays,
    currency: stored.currency,
    tiers: stored.allTiers.map((s) => ({
      key: s.key,
      label: s.label,
      maxPersons: s.maxPersons,
      monthlyCent: s.monthlyCent,
      halfYearlyCent: s.halfYearlyCent,
      yearlyCent: s.yearlyCent,
      setupCent: s.setupCent,
      archived: s.archived,
    })),
    updatedAt: stored.updatedAt,
  };
}

/**
 * Preise als Admin.
 *
 * Gültigkeit beim Speichern ist dieselbe wie beim Lesen: `issues()` aus
 * `pricing.config.ts` prüft die AKTIVEN Stufen (steigende Schwellen, genau
 * eine offene letzte Stufe, ganze Cent). Änderung und Audit-Eintrag stehen in
 * EINER Transaktion (R6) — was nicht protokolliert werden konnte, gilt nicht.
 */
@Injectable()
export class PriceSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingConfigService,
  ) {}

  async get(): Promise<PricesResponse> {
    let stored = await this.pricing.readStored();
    if (stored === null) {
      await this.pricing.ensureSeeded();
      stored = await this.pricing.reload();
    }
    return asResponse(stored!);
  }

  async update(
    dto: PricesUpdateDto,
    user: Pick<SessionUser, 'id' | 'username'>,
    source: InquirySource,
  ): Promise<PricesResponse> {
    const tiers = dto.tiers.map((s, index) => ({
      key: s.key,
      label: s.label.trim(),
      maxPersons: s.maxPersons ?? null,
      monthlyCent: s.monthlyCent,
      halfYearlyCent: s.halfYearlyCent,
      yearlyCent: s.yearlyCent,
      setupCent: s.setupCent,
      archived: s.archived === true,
      sortOrder: index,
    }));

    const problems: string[] = [];
    const seen = new Set<string>();
    for (const s of tiers) {
      if (seen.has(s.key)) problems.push(`Der Schlüssel „${s.key}" kommt doppelt vor.`);
      seen.add(s.key);
    }
    problems.push(
      ...issues({
        tiers: tiers.filter((s) => !s.archived),
        taxRate: dto.taxRatePercent,
        averageDays: dto.averageDays,
        paymentDueDays: dto.paymentTermDays,
      }),
    );
    if (problems.length > 0) throw new PricesInvalidError(problems);

    await this.pricing.ensureSeeded();

    await this.prisma.$transaction(async (tx) => {
      const before = await this.pricing.readStored();
      const beforeResponse = before ? asResponse(before) : null;
      const existing = await tx.priceTier.findMany();
      const existingAfterKey = new Map(existing.map((r) => [r.key, r]));
      const now = new Date();

      await tx.priceList.update({
        where: { id: 'singleton' },
        data: {
          taxRatePercent: dto.taxRatePercent,
          paymentTermDays: dto.paymentTermDays,
          averageDays: dto.averageDays,
          currency: dto.currency ?? 'EUR',
          updatedBy: user.id,
        },
      });

      for (const s of tiers) {
        const row = existingAfterKey.get(s.key);
        const archivedAt = s.archived ? (row?.archivedAt ?? now) : null;
        const data = {
          label: s.label,
          maxPersons: s.maxPersons,
          monthlyCent: s.monthlyCent,
          halfYearlyCent: s.halfYearlyCent,
          yearlyCent: s.yearlyCent,
          setupCent: s.setupCent,
          sortOrder: s.sortOrder,
          archivedAt,
        };
        if (row) {
          await tx.priceTier.update({ where: { key: s.key }, data });
        } else {
          await tx.priceTier.create({ data: { key: s.key, ...data } });
        }
      }
      // Fehlt eine bekannte Stufe in der Eingabe, wird sie ARCHIVIERT — nie gelöscht.
      let trailing = tiers.length;
      for (const row of existing) {
        if (seen.has(row.key)) continue;
        await tx.priceTier.update({
          where: { key: row.key },
          data: { archivedAt: row.archivedAt ?? now, sortOrder: trailing++ },
        });
      }

      const afterRows = await tx.priceTier.findMany({
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      });
      const afterList = await tx.priceList.findUniqueOrThrow({
        where: { id: 'singleton' },
      });
      const afterResponse: PricesResponse = {
        taxRatePercent: Number(afterList.taxRatePercent),
        paymentTermDays: afterList.paymentTermDays,
        averageDays: afterList.averageDays,
        currency: afterList.currency,
        updatedAt: afterList.updatedAt.toISOString(),
        tiers: afterRows.map((r) => ({
          key: r.key,
          label: r.label,
          maxPersons: r.maxPersons,
          monthlyCent: r.monthlyCent,
          halfYearlyCent: r.halfYearlyCent,
          yearlyCent: r.yearlyCent,
          setupCent: r.setupCent,
          archived: r.archivedAt !== null,
        })),
      };

      await this.audit.log(
        {
          userId: user.id,
          actor: user.username,
          action: AUDIT_ACTION.priceUpdated,
          objectType: 'PriceList',
          objectId: 'singleton',
          beforeValue: beforeResponse ? summary(beforeResponse) : null,
          afterValue: summary(afterResponse),
          ip: source.ip,
          userAgent: source.userAgent,
        },
        tx,
      );
    });

    const stored = await this.pricing.reload();
    return asResponse(stored!);
  }
}
