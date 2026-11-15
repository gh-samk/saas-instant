import type { Prisma } from '.prisma/control-client';
import { toDate } from '@saas-instant/shared';
import type {
  CompanyCreateDto,
  CompanyUpdateDto,
} from './dto/company.dto';
import { reviewDateFrom } from './deadlines';

/**
 * Textfelder, die eins zu eins übernommen werden und leer sein dürfen.
 * `name` steht bewusst NICHT dabei: er ist als einziges Feld pflichtig und
 * darf nie auf `null` gesetzt werden.
 */
const TextFields = [
  'legalForm',
  'website',
  'street',
  'houseNumber',
  'postalCode',
  'city',
  'country',
  'billingName',
  'billingStreet',
  'billingHouseNumber',
  'billingPostalCode',
  'billingCity',
  'billingCountry',
  'billingEmail',
  'deputyName',
  'deputyEmail',
  'deputyPhone',
  'deputyRole',
  'priceTier',
  'vatId',
  'buyerReference',
  'electronicAddress',
  'electronicAddressScheme',
  'notes',
] as const;

/** Tagesdaten `YYYY-MM-DD`, die als `@db.Date` gespeichert werden. */
const DateFields = ['pilotDecisionDate', 'instanceStartDate'] as const;

type TextField = (typeof TextFields)[number];
type DateField = (typeof DateFields)[number];

/**
 * Übersetzt die geschickten Stammdaten in Prisma-Daten.
 *
 * DREI ZUSTÄNDE, die auseinandergehalten werden müssen:
 * `undefined` = Feld war nicht dabei, bleibt unangetastet.
 * `null`      = Feld soll geleert werden.
 * Wert        = Feld wird gesetzt.
 *
 * `reviewDueDate` steht nirgends im DTO — er wird hier aus
 * `pilotDecisionDate` GERECHNET, und zwar auch dann, wenn das Beschlussdatum
 * geleert wird (dann fällt der Termin mit weg).
 */
export function masterDataAfterPrisma(
  dto: CompanyUpdateDto,
): Prisma.CompanyUncheckedUpdateInput {
  const data: Prisma.CompanyUncheckedUpdateInput = {};

  if (dto.name !== undefined) data.name = dto.name;

  const raw = dto as Record<string, unknown>;
  for (const field of TextFields) {
    const value = raw[field] as string | null | undefined;
    if (value !== undefined) data[field as TextField] = value;
  }
  for (const field of DateFields) {
    const value = raw[field] as string | null | undefined;
    if (value !== undefined) {
      data[field as DateField] = value === null ? null : toDate(value);
    }
  }

  // `iban`, `sepaMandat*` und `customAmount` fehlen hier absichtlich:
  // Sie laufen ausschliesslich ueber `CompanyService.zahlungsdatenSetzen`
  // hinter dem ZweitfaktorGuard ([W4]).
  if (dto.paymentInterval !== undefined) data.paymentInterval = dto.paymentInterval;
  if (dto.paymentMethod !== undefined) data.paymentMethod = dto.paymentMethod;
  if (dto.buyerType !== undefined) data.buyerType = dto.buyerType;
  if (dto.source !== undefined) data.source = dto.source;
  if (dto.newsletterConsentStatus !== undefined) {
    data.newsletterConsentStatus = dto.newsletterConsentStatus;
  }

  // Abgeleitet, niemals entgegengenommen.
  if (dto.pilotDecisionDate !== undefined) {
    const date = reviewDateFrom(dto.pilotDecisionDate ?? null);
    data.reviewDueDate = date === null ? null : toDate(date);
  }

  return data;
}

/**
 * Wie oben, nur für das Anlegen: Name und Ansprechpartnerin kommen dazu.
 *
 * Die Typumwandlung am Ende ist nötig, weil Prisma für UPDATE zusätzlich
 * Operationsobjekte (`{ set: … }`) zulässt und CREATE das nicht tut. Alle Werte
 * hier sind einfache Werte, keine Operationen — geprüft wurden sie bereits von
 * `masterDataAfterPrisma`.
 */
export function createAfterPrisma(
  dto: CompanyCreateDto,
): Prisma.CompanyUncheckedCreateInput {
  const masterData = masterDataAfterPrisma(dto);
  return {
    ...masterData,
    name: dto.name,
    ...(dto.status !== undefined ? { status: dto.status } : {}),
    contactName: dto.contactName ?? null,
    contactEmail: dto.contactEmail ?? null,
    contactPhone: dto.contactPhone ?? null,
    contactRole: dto.contactRole ?? null,
  } as Prisma.CompanyUncheckedCreateInput;
}
