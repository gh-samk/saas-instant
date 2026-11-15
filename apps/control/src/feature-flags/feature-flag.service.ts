import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService, AUDIT_ACTION } from '../audit/audit.service';
import type { SessionUser } from '../auth/session.service';
import type { InquirySource } from '../common/inquiry-source';
import { BusinessError } from '../common/errors/business-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  FeatureFlag,
  isFlagKey,
  type FlagKey,
} from './feature-flag.catalog';

export interface FeatureFlagEntry {
  key: FlagKey;
  label: string;
  description: string;
  enabled: boolean;
  defaultValue: boolean;
  /** Technischer Zeitstempel (ISO) der letzten Änderung, `null` = nie umgestellt. */
  changedAt: string | null;
}

/** Was die Instanzen über `GET /api/schalter` sehen — und nichts darüber hinaus. */
export interface PublicFlagState {
  feedback: boolean;
}

export class FeatureFlagUnknownError extends BusinessError {
  constructor() {
    super(
      'feature_flag_unknown',
      'Diesen Funktionsschalter gibt es nicht.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Wie lange die öffentliche Antwort im Speicher bleibt.
 *
 * Jede Instanz fragt höchstens alle paar Minuten, aber nach einem
 * gemeinsamen Ausrollen fragen alle zugleich. 30 Sekunden halten die
 * Datenbank dabei ruhig; ein Umschalten leert den Speicher sofort.
 */
const PUBLIC_CACHE_MS = 30_000;

@Injectable()
export class FeatureFlagService {
  private public: { state: PublicFlagState; until: number } | null =
    null;

  /** Uhr, in Tests austauschbar. */
  now: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async all(): Promise<FeatureFlagEntry[]> {
    const rows = await this.prisma.featureFlag.findMany();
    const afterKey = new Map(rows.map((z) => [z.key, z]));
    return (Object.keys(FeatureFlag) as FlagKey[]).map(
      (key) => {
        const catalog = FeatureFlag[key];
        const row = afterKey.get(key);
        return {
          key,
          label: catalog.label,
          description: catalog.description,
          enabled: row?.enabled ?? catalog.defaultValue,
          defaultValue: catalog.defaultValue,
          changedAt: row ? row.changedAt.toISOString() : null,
        };
      },
    );
  }

  /**
   * Stellt einen Schalter um. Änderung und Audit-Eintrag in EINER
   * Transaktion (R6): Was nicht protokolliert werden konnte, gilt nicht.
   */
  async set(
    key: string,
    enabled: boolean,
    user: Pick<SessionUser, 'id' | 'username'>,
    source: InquirySource,
  ): Promise<FeatureFlagEntry> {
    if (!isFlagKey(key)) {
      throw new FeatureFlagUnknownError();
    }
    const defaultValue = FeatureFlag[key].defaultValue;

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.featureFlag.findUnique({
        where: { key },
      });
      // Steht der Schalter schon so, ändert sich nichts — und dann soll auch
      // kein Nachweis einer Änderung entstehen.
      if ((before?.enabled ?? defaultValue) === enabled) return;
      await tx.featureFlag.upsert({
        where: { key },
        create: { key, enabled, changedById: user.id },
        update: { enabled, changedById: user.id },
      });
      await this.audit.log(
        {
          userId: user.id,
          actor: user.username,
          action: AUDIT_ACTION.featureFlagChanged,
          objectType: 'FeatureFlag',
          objectId: key,
          beforeValue: { enabled: before?.enabled ?? defaultValue },
          afterValue: { enabled },
          ip: source.ip,
          userAgent: source.userAgent,
        },
        tx,
      );
    });

    this.public = null;
    const entry = (await this.all()).find((e) => e.key === key);
    // Kann nicht fehlen: der Schlüssel steht im Katalog.
    return entry!;
  }

  /** Der öffentliche Stand für die Instanzen, kurz zwischengespeichert. */
  async publicState(): Promise<PublicFlagState> {
    const now = this.now();
    if (this.public && this.public.until > now) {
      return this.public.state;
    }
    const all = await this.all();
    const state: PublicFlagState = {
      feedback: all.find((e) => e.key === 'feedback')?.enabled ?? true,
    };
    this.public = { state, until: now + PUBLIC_CACHE_MS };
    return state;
  }
}
