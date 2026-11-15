import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManifestService } from '../manifest/manifest.service';
import type { BillingManifest } from '../manifest/sections/billing';
import { PrismaService } from '../prisma/prisma.service';
import { PriceConfigurationInvalidError } from './invoice.errors';
import type { PriceTier, PriceTable } from './pricing.types';

/**
 * Die Preistafel — Reihenfolge: Umgebung (`CONTROL_PREISTAFEL`), dann Manifest
 * (`billing.tiers`), dann neutrale Vorgaben.
 *
 * Dieselbe Bauweise wie `CoolifyConfigService`: Vorgaben im Code, Überschreiben
 * über eine Umgebungsvariable. EIN Unterschied, und der ist wesentlich: Eine
 * unlesbare Coolify-Konfiguration führt zu einem sichtbaren Fehler an der
 * Instanzverwaltung. Eine unlesbare PREISTAFEL würde still auf die Vorgaben
 * zurückfallen — und dann steht auf der Rechnung ein anderer Betrag als
 * vereinbart, ohne dass irgendjemand etwas merkt, bis die Kundin anruft.
 *
 * Deshalb wirft `lies()` bei fehlerhafter Konfiguration, und `onModuleInit`
 * ruft `lies()` einmal beim Start auf: Eine kaputte Preistafel verhindert den
 * Start, statt falsche Rechnungen zu erzeugen.
 */

/**
 * Neutrale Netto-Vorgaben, wenn weder Umgebung noch Manifest Stufen nennen.
 *
 * Der Jahrespreis ist als ELF MONATSRATEN definiert (10 × 11 = 110 usw.),
 * das Halbjahr knapp unter sechs Monatsraten. `pricing.spec.ts` prüft das nach — damit
 * eine spätere Preisänderung nicht versehentlich nur eine der Zahlen anfasst.
 */
export const PRICE_PRESETS: PriceTable = {
  taxRate: 19,
  averageDays: 90,
  paymentDueDays: 14,
  tiers: [
    {
      key: 'stufe1',
      label: 'Stufe 1 (bis 10 aktive Personen)',
      maxPersons: 10,
      monthlyCent: 1_000,
      halfYearlyCent: 5_900,
      yearlyCent: 11_000,
      setupCent: 5_000,
    },
    {
      key: 'stufe2',
      label: 'Stufe 2 (11 bis 30 aktive Personen)',
      maxPersons: 30,
      monthlyCent: 2_000,
      halfYearlyCent: 11_900,
      yearlyCent: 22_000,
      setupCent: 5_000,
    },
    {
      key: 'stufe3',
      label: 'Stufe 3 (ab 31 aktiven Personen)',
      maxPersons: null,
      monthlyCent: 3_000,
      halfYearlyCent: 17_900,
      yearlyCent: 33_000,
      setupCent: 5_000,
    },
  ],
};

/**
 * Preistafel aus dem Manifest-Abschnitt `billing`; `null`, wenn dort keine
 * Stufen stehen. Fehlende Preisfelder einer Stufe werden aus `priceCents`
 * abgeleitet (Halbjahr = 5,5 Monatsraten, Jahr = 11 Monatsraten).
 */
export function priceTableFromManifest(billing: BillingManifest): PriceTable | null {
  if (billing.tiers.length === 0) return null;
  return {
    tiers: billing.tiers.map((t) => {
      const month = t.monthlyCents ?? t.priceCents;
      return {
        key: t.key,
        label: t.label,
        maxPersons: t.maxPersons,
        monthlyCent: month,
        halfYearlyCent: t.halfYearlyCents ?? Math.round(month * 5.5),
        yearlyCent: t.yearlyCents ?? month * 11,
        setupCent: t.setupCents ?? 0,
      };
    }),
    taxRate: billing.taxRatePercent ?? PRICE_PRESETS.taxRate,
    averageDays: billing.averageDays ?? PRICE_PRESETS.averageDays,
    paymentDueDays: billing.paymentTermDays ?? PRICE_PRESETS.paymentDueDays,
  };
}

/** Name der Umgebungsvariablen, die die Vorgaben ersetzt. */
export const PRICE_TABLE_VARIABLE = 'CONTROL_PRICE_TABLE';

/**
 * Prüft eine Preistafel auf die Eigenschaften, ohne die sie falsche Rechnungen
 * erzeugen würde. Gibt die Liste der Beanstandungen zurück; leer heißt: in
 * Ordnung.
 *
 * Bewusst als freie Funktion und nicht als Methode: so lässt sie sich ohne
 * NestJS-Kontext prüfen, und der Test kann jede einzelne Regel einzeln
 * verletzen.
 */
export function issues(table: PriceTable): string[] {
  const error: string[] = [];

  if (!Array.isArray(table.tiers) || table.tiers.length === 0) {
    error.push('Es muss mindestens eine Preisstufe geben.');
    return error;
  }

  const key = new Set<string>();
  table.tiers.forEach((tier, index) => {
    const where = `Stufe ${index + 1}`;
    if (typeof tier.key !== 'string' || tier.key.trim() === '') {
      error.push(`${where}: schluessel fehlt.`);
    } else if (key.has(tier.key)) {
      error.push(`${where}: schluessel „${tier.key}" kommt doppelt vor.`);
    } else {
      key.add(tier.key);
    }
    if (typeof tier.label !== 'string' || tier.label.trim() === '') {
      error.push(`${where}: bezeichnung fehlt.`);
    }
    for (const field of [
      'monthlyCent',
      'halfYearlyCent',
      'yearlyCent',
      'setupCent',
    ] as const) {
      const value = tier[field];
      if (!Number.isInteger(value) || value < 0) {
        error.push(`${where}: ${field} muss eine ganze Zahl in Cent ab 0 sein.`);
      }
    }
    if (
      tier.maxPersons !== null &&
      (!Number.isInteger(tier.maxPersons) || tier.maxPersons < 1)
    ) {
      error.push(`${where}: maxPersons muss null oder eine ganze Zahl ab 1 sein.`);
    }
  });

  // DIE SCHWELLEN MÜSSEN STEIGEN, und die letzte muss offen sein. Sonst gäbe
  // es Personenzahlen, für die keine Stufe zuständig ist — und die Suche
  // fände stillschweigend gar keine oder die falsche.
  const open = table.tiers.filter((s) => s.maxPersons === null);
  if (open.length !== 1) {
    error.push(
      'Genau eine Stufe muss nach oben offen sein (maxPersons = null); ' +
        `gefunden: ${open.length}.`,
    );
  } else if (table.tiers[table.tiers.length - 1]?.maxPersons !== null) {
    error.push('Die nach oben offene Stufe muss die letzte sein.');
  }

  const closed = table.tiers
    .map((s) => s.maxPersons)
    .filter((value): value is number => value !== null);
  for (let i = 1; i < closed.length; i += 1) {
    const previous = closed[i - 1] as number;
    const current = closed[i] as number;
    if (current <= previous) {
      error.push(
        `Die Schwellen müssen streng steigen: ${current} folgt auf ${previous}.`,
      );
    }
  }

  if (!Number.isFinite(table.taxRate) || table.taxRate < 0) {
    error.push('steuersatz muss 0 oder größer sein.');
  }
  if (!Number.isInteger(table.averageDays) || table.averageDays < 1) {
    error.push('averageDays muss eine ganze Zahl ab 1 sein.');
  }
  if (!Number.isInteger(table.paymentDueDays) || table.paymentDueDays < 0) {
    error.push('paymentDueDays muss eine ganze Zahl ab 0 sein.');
  }

  return error;
}

/** Name der Singleton-Zeile in `PriceList`. */
const PRICE_LIST_ID = 'singleton';

/** Eine Stufe samt Archivstand, wie die Verwaltung sie in der DB führt. */
export interface StoredPriceTier extends PriceTier {
  archived: boolean;
}

/** Die Preisliste samt archivierter Stufen — die Sicht der Admin-Seite. */
export interface StoredPriceList extends PriceTable {
  currency: string;
  /** Alle Stufen, auch archivierte, in Anzeigereihenfolge. */
  allTiers: StoredPriceTier[];
  updatedAt: string | null;
}

/**
 * Die Preistafel.
 *
 * QUELLE UND VORRANG: Ist die Datenbank angebunden (`PrismaService`), gilt
 * die Preisliste dort — sie ist die Quelle, die die Betreiberin in der
 * Oberfläche pflegt. Eine LEERE Datenbank wird beim Start EINMAL aus
 * Umgebung → Manifest → Vorgaben befüllt (Reihenfolge wie bisher); danach
 * haben Manifest und Umgebung keinen Einfluss mehr, sonst überschriebe ein
 * Neustart die Eingaben der Betreiberin.
 *
 * `read()` bleibt SYNCHRON: Es liefert den Zwischenspeicher, der beim Start
 * und nach jedem Speichern aus der DB neu gelesen wird. So ändern sich weder
 * die Aufrufer (Rechnung, Aufgaben, Vorschlag) noch deren Tests. Ohne
 * `PrismaService` (reine Unit-Tests) gilt wie früher Umgebung/Manifest/Vorgaben.
 */
@Injectable()
export class PricingConfigService implements OnModuleInit {
  private readonly logger = new Logger(PricingConfigService.name);

  /** Zwischenspeicher der DB-Tafel (nur aktive Stufen); `null` = nicht geladen. */
  private cache: PriceTable | null = null;
  /** Archivierte Stufen, nur für Nachschlagen per Schlüssel. */
  private archived: PriceTier[] = [];

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly manifest?: ManifestService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /**
   * Einmal beim Start lesen (und ggf. die leere DB befüllen). Eine kaputte
   * Preistafel bricht den Start ab — dasselbe Verhalten wie bei einem
   * fehlenden `CONTROL_CONFIG_KEY`.
   */
  onModuleInit(): void | Promise<void> {
    // Mit Datenbank asynchron (befüllen + laden); ohne Datenbank wie bisher
    // SYNCHRON, damit eine kaputte Tafel den Start unmittelbar abbricht.
    if (this.prisma) return this.initFromDatabase();
    const table = this.readFallback();
    if (table === PRICE_PRESETS) {
      this.logger.log(
        `${PRICE_TABLE_VARIABLE} ist nicht gesetzt und das Manifest nennt ` +
          'keine Stufen (billing.tiers) — es gelten die neutralen Vorgaben.',
      );
    } else {
      this.logger.log(
        `Preistafel aus Umgebung/Manifest: ${table.tiers.length} Stufen.`,
      );
    }
  }

  private async initFromDatabase(): Promise<void> {
    const seeded = await this.seedIfEmpty();
    await this.reload();
    this.logger.log(
      seeded
        ? `Preisliste einmalig aus Umgebung/Manifest/Vorgaben in die Datenbank übernommen: ${this.read().tiers.length} Stufen.`
        : `Preisliste aus der Datenbank: ${this.read().tiers.length} Stufen.`,
    );
  }

  /** Die geltende Preistafel (aktive Stufen). Wirft, wenn die Quelle Unsinn enthält. */
  read(): PriceTable {
    return this.cache ?? this.readFallback();
  }

  /** Die Stufe zu einem Schlüssel — auch eine archivierte — oder `null`. */
  tier(key: string | null): PriceTier | null {
    if (key === null) return null;
    return (
      this.read().tiers.find((s) => s.key === key) ??
      this.archived.find((s) => s.key === key) ??
      null
    );
  }

  /** Ist der Schlüssel eine AKTIVE Stufe? */
  isActive(key: string): boolean {
    return this.read().tiers.some((s) => s.key === key);
  }

  /** Liest die Preisliste aus der DB in den Zwischenspeicher. */
  async reload(): Promise<StoredPriceList | null> {
    const stored = await this.readStored();
    if (stored === null) {
      this.cache = null;
      this.archived = [];
      return null;
    }
    const table: PriceTable = {
      tiers: stored.allTiers.filter((s) => !s.archived).map(rowAsTier),
      taxRate: stored.taxRate,
      averageDays: stored.averageDays,
      paymentDueDays: stored.paymentDueDays,
    };
    const defects = issues(table);
    if (defects.length > 0) {
      throw new PriceConfigurationInvalidError(
        defects.map((m) => `Preisliste (Datenbank): ${m}`),
      );
    }
    this.cache = table;
    this.archived = stored.allTiers.filter((s) => s.archived).map(rowAsTier);
    return stored;
  }

  /** Die gespeicherte Preisliste samt archivierter Stufen; `null` = leer. */
  async readStored(): Promise<StoredPriceList | null> {
    if (!this.prisma) return null;
    const list = await this.prisma.priceList.findUnique({
      where: { id: PRICE_LIST_ID },
    });
    if (!list) return null;
    const rows = await this.prisma.priceTier.findMany({
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
    return {
      taxRate: Number(list.taxRatePercent),
      averageDays: list.averageDays,
      paymentDueDays: list.paymentTermDays,
      currency: list.currency,
      updatedAt: list.updatedAt.toISOString(),
      tiers: rows.filter((r) => r.archivedAt === null).map(rowAsTier),
      allTiers: rows.map((r) => ({ ...rowAsTier(r), archived: r.archivedAt !== null })),
    };
  }

  /**
   * Befüllt eine LEERE Datenbank aus Umgebung/Manifest/Vorgaben — genau
   * einmal. Eine zweite Instanz, die gleichzeitig startet, legt nichts doppelt
   * an (`createMany` mit `skipDuplicates`, Singleton per Primärschlüssel).
   */
  async ensureSeeded(): Promise<boolean> {
    return this.seedIfEmpty();
  }

  private async seedIfEmpty(): Promise<boolean> {
    const prisma = this.prisma!;
    const exists = await prisma.priceList.findUnique({
      where: { id: PRICE_LIST_ID },
      select: { id: true },
    });
    if (exists) return false;
    const table = this.readFallback();
    await prisma.$transaction(async (tx) => {
      await tx.priceList.createMany({
        data: [
          {
            id: PRICE_LIST_ID,
            taxRatePercent: table.taxRate,
            paymentTermDays: table.paymentDueDays,
            averageDays: table.averageDays,
            currency: 'EUR',
          },
        ],
        skipDuplicates: true,
      });
      await tx.priceTier.createMany({
        data: table.tiers.map((s, index) => ({
          key: s.key,
          label: s.label,
          maxPersons: s.maxPersons,
          monthlyCent: s.monthlyCent,
          halfYearlyCent: s.halfYearlyCent,
          yearlyCent: s.yearlyCent,
          setupCent: s.setupCent,
          sortOrder: index,
        })),
        skipDuplicates: true,
      });
    });
    return true;
  }

  /** Umgebung → Manifest → Vorgaben (die Quelle VOR der Datenbank). */
  private readFallback(): PriceTable {
    const raw = this.config.get<string>(PRICE_TABLE_VARIABLE)?.trim();
    if (!raw) {
      const fromManifest = this.manifest
        ? priceTableFromManifest(this.manifest.billing)
        : null;
      if (!fromManifest) return PRICE_PRESETS;
      const defects = issues(fromManifest);
      if (defects.length > 0) {
        throw new PriceConfigurationInvalidError(
          defects.map((m) => `billing.tiers: ${m}`),
        );
      }
      return fromManifest;
    }

    let read: unknown;
    try {
      read = JSON.parse(raw);
    } catch (exception) {
      throw new PriceConfigurationInvalidError([
        `${PRICE_TABLE_VARIABLE} ist kein gültiges JSON: ` +
          (exception instanceof Error ? exception.message : String(exception)),
      ]);
    }
    if (typeof read !== 'object' || read === null || Array.isArray(read)) {
      throw new PriceConfigurationInvalidError([
        `${PRICE_TABLE_VARIABLE} muss ein Objekt mit dem Feld „stufen" sein.`,
      ]);
    }

    // Die Felder neben `stufen` sind einzeln überschreibbar. Wer nur die
    // Preise ändern will, muss den Steuersatz nicht mitschreiben.
    const part = read as Partial<PriceTable>;
    const table: PriceTable = {
      tiers: (part.tiers ?? PRICE_PRESETS.tiers) as PriceTier[],
      taxRate: part.taxRate ?? PRICE_PRESETS.taxRate,
      averageDays: part.averageDays ?? PRICE_PRESETS.averageDays,
      paymentDueDays: part.paymentDueDays ?? PRICE_PRESETS.paymentDueDays,
    };

    const defects = issues(table);
    if (defects.length > 0) throw new PriceConfigurationInvalidError(defects);
    return table;
  }
}

function rowAsTier(r: {
  key: string;
  label: string;
  maxPersons: number | null;
  monthlyCent: number;
  halfYearlyCent: number;
  yearlyCent: number;
  setupCent: number;
}): PriceTier {
  return {
    key: r.key,
    label: r.label,
    maxPersons: r.maxPersons,
    monthlyCent: r.monthlyCent,
    halfYearlyCent: r.halfYearlyCent,
    yearlyCent: r.yearlyCent,
    setupCent: r.setupCent,
  };
}
