import { t } from '../i18n';
import type { ApiError } from './api-client';

/**
 * Abbildung der Prüfmeldungen des Servers auf deutsche Feldbezeichnungen.
 *
 * Die `ValidationPipe` des Servers antwortet mit `HTTP_400`, einer Liste von
 * Meldungen in `detail` und der ersten davon als Text. Eigene Meldungen der
 * DTOs sind deutsch und beginnen mit einem Großbuchstaben („Die Bezeichnung
 * des Postens fehlt."). Die Vorgabetexte von class-validator dagegen sind
 * englisch und beginnen mit dem Pfad des Feldes
 * („lines.0.unit must be shorter than or equal to 3 characters"). Nur diese
 * zweite Sorte wird hier zerlegt: Pfad → Bezeichnung („Posten 1, Einheit"),
 * Regel → deutscher Satz. Was sich nicht zuordnen lässt, bekommt einen
 * allgemeinen deutschen Satz — nie den Rohtext. Die Regeln selbst prüft weiter
 * der Server (Regel 2 der Projektkonventionen); hier wird nur übersetzt.
 */

export interface ValidationIssue {
  /** Pfad wie vom Server geliefert, z. B. `lines.0.unit`; `null` bei eigenen deutschen Meldungen. */
  path: string | null;
  /** Letztes Pfadstück, z. B. `unit`. */
  field: string | null;
  /** Null-basierter Index, wenn der Pfad in eine Liste zeigt (`lines.0.…`), sonst `null`. */
  index: number | null;
  /** Bezeichnung für Menschen, z. B. „Posten 1, Einheit". `null` ohne Feldbezug. */
  label: string | null;
  /** Deutscher Satz für das Feld selbst, z. B. „Höchstens 3 Zeichen erlaubt." */
  message: string;
}

/** Regeltexte von class-validator → Wörterbuchschlüssel (und Platzhalter). */
const RULES: { pattern: RegExp; key: string; param?: string }[] = [
  { pattern: /^must be shorter than or equal to (\d+) characters?$/, key: 'common.validation.maxLength', param: 'n' },
  { pattern: /^must be longer than or equal to (\d+) characters?$/, key: 'common.validation.minLength', param: 'n' },
  { pattern: /^(should not be empty|must not be empty)$/, key: 'common.validation.required' },
  { pattern: /^must be an integer number$/, key: 'common.validation.integer' },
  { pattern: /^must be a number/, key: 'common.validation.number' },
  { pattern: /^must not be greater than (-?[\d.]+)$/, key: 'common.validation.max', param: 'n' },
  { pattern: /^must not be less than (-?[\d.]+)$/, key: 'common.validation.min', param: 'n' },
  { pattern: /^must contain at least (\d+) elements?$/, key: 'common.validation.minItems', param: 'n' },
  { pattern: /^must contain no more than (\d+) elements?$/, key: 'common.validation.maxItems', param: 'n' },
  { pattern: /^must be an email$/, key: 'common.validation.email' },
  { pattern: /^must be a valid ISO 8601 date string$/, key: 'common.validation.date' },
  { pattern: /^must be one of the following values/, key: 'common.validation.oneOf' },
];

/** Feldname (letztes Pfadstück) → Wörterbuchschlüssel der Bezeichnung. */
const FIELD_LABELS: Record<string, string> = {
  label: 'common.validation.field.label',
  description: 'common.validation.field.description',
  quantity: 'common.validation.field.quantity',
  unitPriceNetCent: 'common.validation.field.unitPrice',
  taxRate: 'common.validation.field.taxRate',
  unit: 'common.validation.field.unit',
  periodFrom: 'common.validation.field.periodFrom',
  periodUntil: 'common.validation.field.periodUntil',
  priceTierKey: 'common.validation.field.priceTier',
  priceTierLabel: 'common.validation.field.priceTier',
  taxCategory: 'common.validation.field.taxCategory',
  taxExemptionReason: 'common.validation.field.taxExemptionReason',
  invoiceDate: 'common.validation.field.invoiceDate',
  servicePeriodFrom: 'common.validation.field.servicePeriodFrom',
  servicePeriodUntil: 'common.validation.field.servicePeriodUntil',
  dueDate: 'common.validation.field.dueDate',
  introduction: 'common.validation.field.introduction',
  paymentNote: 'common.validation.field.paymentNote',
  internalNote: 'common.validation.field.internalNote',
  lines: 'common.validation.field.lines',
};

const PATH_AND_RULE = /^([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*) (.+)$/;
const UNKNOWN_PROPERTY = /^property (\S+) should not exist$/;

function ruleMessage(rule: string): string {
  for (const { pattern, key, param } of RULES) {
    const match = pattern.exec(rule);
    if (match) return t(key, param ? { [param]: match[1] ?? '' } : undefined);
  }
  return t('common.validation.generic');
}

function parse(entry: string): ValidationIssue {
  const unknown = UNKNOWN_PROPERTY.exec(entry);
  const split = unknown ? null : PATH_AND_RULE.exec(entry);
  // Eigene, deutsche Meldung des DTOs: unverändert übernehmen, ohne Feldbezug.
  if (!unknown && !split) {
    return { path: null, field: null, index: null, label: null, message: entry };
  }
  const path = unknown ? (unknown[1] ?? '') : (split?.[1] ?? '');
  const segments = path.split('.');
  const field = [...segments].reverse().find((s) => !/^\d+$/.test(s)) ?? path;
  const indexSegment = segments.find((s) => /^\d+$/.test(s));
  const index = indexSegment === undefined ? null : Number(indexSegment);
  const fieldKey = FIELD_LABELS[field];
  const fieldName = fieldKey ? t(fieldKey) : t('common.validation.fieldUnknown');
  const label =
    index !== null && segments[0] === 'lines'
      ? t('common.validation.lineLabel', { n: index + 1, field: fieldName })
      : fieldName;
  return {
    path,
    field,
    index,
    label,
    message: unknown ? t('common.validation.notExpected') : ruleMessage(split?.[2] ?? ''),
  };
}

/**
 * Die Prüfmeldungen eines Serverfehlers — leer, wenn der Fehler keine
 * Eingabeprüfung ist (anderer Code, kein `detail`-Array aus Texten).
 */
export function validationIssues(error: unknown): ValidationIssue[] {
  // Strukturell statt `instanceof`: `api-client` importiert dieses Modul, ein
  // Rückimport der Klasse wäre ein Zirkel.
  if (!(error instanceof Error) || error.name !== 'ApiError') return [];
  const apiError = error as ApiError;
  if (apiError.status !== 400 || apiError.error.code !== 'HTTP_400') return [];
  const detail = apiError.error.detail;
  if (!Array.isArray(detail)) return [];
  return detail
    .filter((e): e is string => typeof e === 'string')
    .map(parse);
}

/** Eine Zeile für die Zusammenfassung: „Posten 1, Einheit: Höchstens 3 Zeichen erlaubt." */
export function issueLine(issue: ValidationIssue): string {
  return issue.label === null ? issue.message : `${issue.label}: ${issue.message}`;
}

/**
 * Meldungen, die so nie vor Nutzende gehören: die Stocktexte der Rahmen­bibliothek
 * (englisch, ohne Handlungshinweis) und Vorgabetexte von class-validator.
 * Fachliche Meldungen des Servers sind deutsch und beginnen groß.
 */
const STOCK_TEXTS =
  /^(bad request|internal server error|not found|forbidden( resource)?|unauthorized|conflict|service unavailable|bad gateway|gateway timeout|unprocessable entity|payload too large|method not allowed|too many requests|throttlerexception.*|cannot (get|post|put|patch|delete) .*)$/i;

export function isRawServerText(message: string | undefined): boolean {
  if (message === undefined || message.trim() === '') return true;
  return /^[a-z]/.test(message) || STOCK_TEXTS.test(message.trim());
}
