/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { Prisma } from '.prisma/control-client';
import type { PrismaClient } from '.prisma/control-client';
import {
  BLIND_INDEXES,
  ENCRYPTED_FIELDS,
  type FieldKind,
} from '../crypto/encrypted-fields';
import {
  aadFor,
  blindIndex,
  decryptBytes,
  decryptField,
  decryptJson,
  encryptBytes,
  encryptField,
  encryptJson,
  FieldDecryptError,
  isEncryptedBytes,
  isEncryptedText,
  plaintextPolicy,
} from '../crypto/field-crypto';
import { keyring } from '../crypto/keyring';

/**
 * PRISMA-ERWEITERUNG DER FELDVERSCHLÜSSELUNG
 *
 * Verschlüsselt die Felder aus `ENCRYPTED_FIELDS` bei create/createMany/update/
 * upsert (auch in verschachtelten Schreibzugriffen) und entschlüsselt sie auf
 * allen Lesewegen (auch in `include`/`select`). Werte ohne Präfix (Altdaten)
 * werden unverändert geliefert.
 *
 * GRENZEN, die laut werfen statt still falsch zu laufen:
 *  - `where`/`orderBy`/`cursor`/`distinct`/`by` auf einem verschlüsselten Feld
 *    (Ausnahme: Prüfung auf NULL). Exakte Treffer laufen über die
 *    Blind-Index-Spalten, Volltext und Sortierung im Speicher.
 *  - `updateMany`/verschachteltes `update` auf verschlüsselten Feldern ohne
 *    eindeutige `id` im `where` (die AAD braucht die id).
 *
 * Nachschlagen der id (`update` mit anderem Eindeutigkeitsschlüssel als `id`)
 * läuft über den unerweiterten Client AUSSERHALB einer umschließenden
 * Transaktion.
 */

export class EncryptedFieldQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedFieldQueryError';
  }
}

type Obj = Record<string, any>;

interface ModelMeta {
  name: string;
  relations: Map<string, string>;
  idIsUuid: boolean;
}

const MODELS = new Map<string, ModelMeta>(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name,
    {
      name: m.name,
      relations: new Map(
        m.fields.filter((f) => f.kind === 'object').map((f) => [f.name, f.type]),
      ),
      idIsUuid: m.fields.some(
        (f) =>
          f.isId &&
          typeof f.default === 'object' &&
          f.default !== null &&
          'name' in f.default &&
          f.default.name === 'uuid(4)',
      ),
    },
  ]),
);

/**
 * Modelle, die bei GESPERRTEM Tresor im Klartext geschrieben werden statt zu
 * scheitern. Betrifft nur das Audit-Log: Anmeldung, Sitzung und Zweitfaktor
 * müssen VOR dem Entsperren funktionieren und protokollieren dabei. Das Log ist
 * append-only (Trigger), die Zeilen lassen sich später nicht verschlüsseln;
 * es geht um Anmeldeereignisse von Mitarbeitenden, nicht um Kundendaten.
 */
const PLAIN_WHEN_LOCKED = new Set(['AuditLog']);

const RAW_CLIENTS = new WeakMap<object, PrismaClient>();

/** Der unerweiterte Client hinter einem mit `withFieldEncryption` erzeugten (für den Einmal-Lauf). */
export function rawClientOf(client: object): PrismaClient | undefined {
  return RAW_CLIENTS.get(client);
}

// ---------------------------------------------------------------------------
// Nachsichtiges Lesen (nur auf ausdrücklichen Wunsch des Aufrufers)
// ---------------------------------------------------------------------------

const lenientScope = new AsyncLocalStorage<true>();
const unreadable = new WeakMap<object, string[]>();
const lenientLogger = new Logger('FieldEncryption');

/**
 * Führt `work` im NACHSICHTIGEN Lesemodus aus: ein Feld, das sich nicht
 * entschlüsseln lässt (`FieldDecryptError`), wird `null` und in der Zeile
 * vermerkt (`unreadableFieldsOf`), statt die ganze Abfrage zu kippen.
 *
 * ABWÄGUNG, warum das NICHT der Standard ist: Ein stillschweigendes `null` ist
 * für Anzeigen (Listen, Suchindex) richtig — ein beschädigter Wert soll nicht
 * die ganze Organisationsliste in einen 500 verwandeln. Für alles, was die Zeile
 * danach zurückschreibt, wäre es gefährlich: `update` mit dem gelesenen `null`
 * überschriebe den (beschädigten, aber beweiskräftigen) Chiffretext. Und für
 * Integritätsprüfung, Archiv und Export muss der Fehler sichtbar bleiben. Deshalb
 * schaltet jeder Lesepfad den Modus selbst und ausdrücklich ein.
 *
 * Jeder Fall wird protokolliert (Modell, Feld, id; nie ein Wert).
 */
export function readLenient<T>(work: () => Promise<T>): Promise<T> {
  // `await` im Bereich: Prisma-Abfragen starten erst beim `then`, das muss noch
  // INNERHALB des Bereichs geschehen, sonst ist der Modus beim Entschlüsseln weg.
  return lenientScope.run(true, async () => await work());
}

/** Die Felder dieser Zeile, die im nachsichtigen Modus nicht lesbar waren. */
export function unreadableFieldsOf(row: unknown): readonly string[] {
  return typeof row === 'object' && row !== null ? (unreadable.get(row) ?? []) : [];
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

const hasEncrypted = (model: string): boolean =>
  Object.keys(ENCRYPTED_FIELDS[model] ?? {}).length > 0;

function isJsonNullSentinel(v: unknown): boolean {
  return (
    v === Prisma.JsonNull || v === Prisma.DbNull || v === Prisma.AnyNull
  );
}

// ---------------------------------------------------------------------------
// Filter-Prüfung
// ---------------------------------------------------------------------------

function fail(model: string, field: string, where: string): never {
  const idx = BLIND_INDEXES[model]?.find((b) => b.source === field)?.index;
  throw new EncryptedFieldQueryError(
    `${model}.${field} ist verschlüsselt: ${where} ist nicht möglich. ` +
      (idx
        ? `Für exakte Treffer die Blind-Index-Spalte ${idx} nutzen.`
        : 'Im Speicher über die entschlüsselte Liste filtern bzw. sortieren.'),
  );
}

/** `null`, `{ equals: null }`, `{ not: null }`: NULL ist unverschlüsselt und damit abfragbar. */
function isNullFilter(v: unknown): boolean {
  if (v === null) return true;
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  return (
    keys.length > 0 &&
    keys.every((k) => (k === 'equals' || k === 'not') && v[k] === null)
  );
}

function checkWhere(model: string, where: unknown): void {
  if (!isObj(where)) return;
  const enc = ENCRYPTED_FIELDS[model] ?? {};
  const meta = MODELS.get(model);
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      for (const part of asArray(value)) checkWhere(model, part);
    } else if (enc[key]) {
      if (!isNullFilter(value)) fail(model, key, 'where');
    } else if (meta?.relations.has(key) && isObj(value)) {
      const related = meta.relations.get(key)!;
      const relational = ['some', 'every', 'none', 'is', 'isNot'].filter(
        (k) => k in value,
      );
      if (relational.length > 0) {
        for (const k of relational) checkWhere(related, value[k]);
      } else {
        checkWhere(related, value);
      }
    }
  }
}

function checkOrderBy(model: string, orderBy: unknown): void {
  const enc = ENCRYPTED_FIELDS[model] ?? {};
  const meta = MODELS.get(model);
  for (const item of asArray(orderBy as Obj | Obj[] | undefined)) {
    if (!isObj(item)) continue;
    for (const [key, value] of Object.entries(item)) {
      if (enc[key]) fail(model, key, 'orderBy');
      const related = meta?.relations.get(key);
      if (related && isObj(value)) checkOrderBy(related, value);
    }
  }
}

function checkFieldList(model: string, list: unknown, where: string): void {
  const enc = ENCRYPTED_FIELDS[model] ?? {};
  for (const name of asArray(list as string | string[] | undefined)) {
    if (typeof name === 'string' && enc[name]) fail(model, name, where);
  }
}

function checkArgs(model: string, args: unknown): void {
  if (!isObj(args)) return;
  checkWhere(model, args.where);
  checkOrderBy(model, args.orderBy);
  if (isObj(args.cursor)) checkWhere(model, args.cursor);
  checkFieldList(model, args.distinct, 'distinct');
  checkFieldList(model, args.by, 'groupBy');
  const meta = MODELS.get(model);
  for (const part of [args.select, args.include]) {
    if (!isObj(part)) continue;
    for (const [key, value] of Object.entries(part)) {
      const related = meta?.relations.get(key);
      if (related && isObj(value)) checkArgs(related, value);
    }
  }
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

function encryptValue(
  model: string,
  field: string,
  kind: FieldKind,
  value: unknown,
  id: string,
): unknown {
  if (value === undefined || value === null) return value;
  const aad = aadFor(model, field, id);
  if (kind === 'bytes') {
    if (value instanceof Uint8Array) return encryptBytes(value, aad);
    if (isObj(value) && 'set' in value) {
      return { ...value, set: encryptValue(model, field, kind, value.set, id) };
    }
    return value;
  }
  if (kind === 'json') {
    if (isJsonNullSentinel(value)) return value;
    return encryptJson(value, aad);
  }
  if (typeof value === 'string') return encryptField(value, aad);
  if (isObj(value) && 'set' in value) {
    return { ...value, set: encryptValue(model, field, kind, value.set, id) };
  }
  return value;
}

function plainOf(value: unknown): unknown {
  return isObj(value) && 'set' in value ? value.set : value;
}

/** Verschlüsselt eine Datenzeile; `id` ist die AAD-Kennung dieser Zeile. */
function encryptRow(
  model: string,
  data: Obj,
  id: string | null,
  mode: 'create' | 'update',
): Obj {
  const enc = ENCRYPTED_FIELDS[model] ?? {};
  const meta = MODELS.get(model);
  const out: Obj = { ...data };
  if (PLAIN_WHEN_LOCKED.has(model) && !keyring.unlocked) return out;
  const touched = Object.keys(data).some((k) => enc[k]);
  if (touched && id === null) {
    throw new EncryptedFieldQueryError(
      `${model}: Schreiben verschlüsselter Felder braucht eine eindeutige id im where (z. B. { id }).`,
    );
  }
  for (const [key, value] of Object.entries(data)) {
    const kind = enc[key];
    if (kind) {
      out[key] = encryptValue(model, key, kind, value, id!);
    } else if (meta?.relations.has(key) && isObj(value)) {
      out[key] = encryptNested(meta.relations.get(key)!, value, mode);
    }
  }
  for (const spec of BLIND_INDEXES[model] ?? []) {
    if (spec.source in data) {
      const raw = plainOf(data[spec.source]);
      out[spec.index] =
        typeof raw === 'string' ? blindIndex(raw, spec.label) : null;
    }
  }
  return out;
}

function withId(model: string, data: Obj): Obj {
  if (typeof data.id === 'string' || !hasEncrypted(model)) return data;
  if (!MODELS.get(model)?.idIsUuid) {
    throw new EncryptedFieldQueryError(
      `${model}: id wird nicht per uuid() erzeugt; bitte beim Anlegen eine id angeben.`,
    );
  }
  return { ...data, id: randomUUID() };
}

function encryptCreate(model: string, data: Obj): Obj {
  const row = withId(model, data);
  return encryptRow(model, row, hasEncrypted(model) ? (row.id as string) : null, 'create');
}

function idFromWhere(where: unknown): string | null {
  if (!isObj(where)) return null;
  if (typeof where.id === 'string') return where.id;
  if (isObj(where.id) && typeof where.id.equals === 'string') return where.id.equals;
  return null;
}

function encryptNested(model: string, ops: Obj, mode: 'create' | 'update'): Obj {
  const out: Obj = { ...ops };
  const touchesEncrypted = (data: unknown): boolean =>
    isObj(data) &&
    Object.keys(data).some(
      (k) => ENCRYPTED_FIELDS[model]?.[k] || MODELS.get(model)?.relations.has(k),
    );
  const mapList = <T>(v: T | T[], fn: (x: T) => T): T | T[] =>
    Array.isArray(v) ? v.map(fn) : fn(v);

  if (ops.create) out.create = mapList(ops.create, (d: Obj) => encryptCreate(model, d));
  if (isObj(ops.createMany)) {
    out.createMany = {
      ...ops.createMany,
      data: mapList(ops.createMany.data, (d: Obj) => encryptCreate(model, d)),
    };
  }
  if (ops.connectOrCreate) {
    out.connectOrCreate = mapList(ops.connectOrCreate, (c: Obj) => ({
      ...c,
      create: encryptCreate(model, c.create),
    }));
  }
  if (ops.upsert) {
    out.upsert = mapList(ops.upsert, (u: Obj) => {
      const id = idFromWhere(u.where);
      if (id === null && touchesEncrypted(u.update)) {
        throw new EncryptedFieldQueryError(
          `${model}: verschachteltes upsert braucht { where: { id } }.`,
        );
      }
      return {
        ...u,
        create: encryptCreate(model, u.create),
        update: id === null ? u.update : encryptRow(model, u.update, id, 'update'),
      };
    });
  }
  if (ops.update) {
    out.update = mapList(ops.update, (u: Obj) => {
      const wrapped = isObj(u.data) && ('where' in u || Object.keys(u).length === 1);
      const data: Obj = wrapped ? u.data : u;
      const id = wrapped ? idFromWhere(u.where) : null;
      if (id === null && touchesEncrypted(data)) {
        throw new EncryptedFieldQueryError(
          `${model}: verschachteltes update braucht { where: { id }, data }.`,
        );
      }
      const encrypted = id === null ? data : encryptRow(model, data, id, 'update');
      return wrapped ? { ...u, data: encrypted } : encrypted;
    });
  }
  if (ops.updateMany) {
    for (const u of asArray<Obj>(ops.updateMany)) {
      if (touchesEncrypted(u.data)) {
        throw new EncryptedFieldQueryError(
          `${model}: verschachteltes updateMany auf verschlüsselten Feldern ist nicht möglich.`,
        );
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

interface Plan {
  addedId?: boolean;
  /** `finalizedAt` wurde für die Klartext-Prüfung zusätzlich geladen (Invoice). */
  addedFinalizedAt?: boolean;
  rel: Record<string, Plan>;
}

function prepareSelection(model: string, args: unknown): { args: unknown; plan: Plan } {
  const plan: Plan = { rel: {} };
  if (!isObj(args)) return { args, plan };
  const meta = MODELS.get(model);
  const out: Obj = { ...args };
  const walk = (part: Obj): Obj => {
    const copy: Obj = { ...part };
    for (const [key, value] of Object.entries(copy)) {
      const related = meta?.relations.get(key);
      if (!related || !value) continue;
      if (isObj(value)) {
        const r = prepareSelection(related, value);
        copy[key] = r.args;
        plan.rel[key] = r.plan;
      } else {
        plan.rel[key] = { rel: {} };
      }
    }
    return copy;
  };
  if (isObj(args.select)) {
    const sel = walk(args.select);
    if (hasEncrypted(model) && !sel.id) {
      sel.id = true;
      plan.addedId = true;
    }
    if (model === 'Invoice' && !sel.finalizedAt) {
      sel.finalizedAt = true;
      plan.addedFinalizedAt = true;
    }
    out.select = sel;
  } else if (isObj(args.include)) {
    out.include = walk(args.include);
  }
  return { args: out, plan };
}

/**
 * Darf dieses Feld im Strikt-Modus noch Klartext sein? NUR die dokumentierten
 * Altbereiche, in denen sich Klartext nicht nachträglich verschlüsseln lässt:
 *  - AuditLog: append-only (Trigger); dazu Zeilen, die bei gesperrtem Tresor
 *    geschrieben wurden (Anmeldeereignisse).
 *  - InvoiceLine: Posten festgeschriebener Rechnungen sind per Trigger gesperrt.
 *  - Invoice: nur festgeschriebene Rechnungen (gleicher Grund).
 * Alles andere ist nach dem Einmal-Lauf verschlüsselt; Klartext dort ist ein Befund.
 */
function isLegacyPlaintextAllowed(model: string, row: Obj): boolean {
  if (model === 'AuditLog' || model === 'InvoiceLine') return true;
  if (model === 'Invoice') return row.finalizedAt !== null && row.finalizedAt !== undefined;
  return false;
}

function looksEncrypted(kind: FieldKind, value: unknown): boolean {
  if (kind === 'bytes') return value instanceof Uint8Array && isEncryptedBytes(value);
  return isEncryptedText(value);
}

function decryptRow(model: string, row: Obj, plan: Plan | undefined): Obj {
  const enc = ENCRYPTED_FIELDS[model] ?? {};
  const meta = MODELS.get(model);
  const out: Obj = { ...row };
  for (const [key, value] of Object.entries(row)) {
    const kind = enc[key];
    if (kind) {
      if (value === null || value === undefined) continue;
      if (typeof row.id !== 'string') {
        throw new EncryptedFieldQueryError(
          `${model}.${key}: Entschlüsselung braucht die id der Zeile im Ergebnis.`,
        );
      }
      if (
        plaintextPolicy.strict &&
        !isLegacyPlaintextAllowed(model, row) &&
        !looksEncrypted(kind, value)
      ) {
        // Klartext in einem verschlüsselten Feld nach dem Einmal-Lauf: nicht
        // stillschweigend annehmen (Downgrade per SQL), sondern als Befund melden.
        const error = new FieldDecryptError(model, key, row.id);
        if (!lenientScope.getStore()) throw error;
        out[key] = null;
        unreadable.set(out, [...(unreadable.get(out) ?? []), key]);
        lenientLogger.warn(`${model}.${key} (id ${row.id}) liegt im Klartext vor, als leer geliefert.`);
        continue;
      }
      const aad = aadFor(model, key, row.id);
      try {
        if (kind === 'text') {
          out[key] = typeof value === 'string' ? decryptField(value, aad) : value;
        } else if (kind === 'bytes') {
          out[key] = value instanceof Uint8Array ? decryptBytes(value, aad) : value;
        } else {
          out[key] = decryptJson(value, aad);
        }
      } catch (error) {
        if (!(error instanceof FieldDecryptError) || !lenientScope.getStore()) throw error;
        out[key] = null;
        unreadable.set(out, [...(unreadable.get(out) ?? []), key]);
        lenientLogger.warn(`${model}.${key} (id ${row.id}) nicht lesbar, als leer geliefert.`);
      }
    } else if (meta?.relations.has(key) && value !== null && typeof value === 'object') {
      out[key] = decryptResult(meta.relations.get(key)!, value, plan?.rel[key]);
    }
  }
  if (plan?.addedId) delete out.id;
  if (plan?.addedFinalizedAt) delete out.finalizedAt;
  return out;
}

function decryptResult(model: string, value: unknown, plan?: Plan): unknown {
  if (Array.isArray(value)) return value.map((v) => decryptResult(model, v, plan));
  if (isObj(value)) return decryptRow(model, value, plan);
  return value;
}

// ---------------------------------------------------------------------------
// Erweiterung
// ---------------------------------------------------------------------------

const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createManyAndReturn',
  'update',
  'upsert',
  'delete',
]);

async function lookupId(
  base: PrismaClient,
  model: string,
  where: unknown,
): Promise<string | null> {
  const direct = idFromWhere(where);
  if (direct) return direct;
  const row = await (base as any)[lowerFirst(model)].findUnique({
    where,
    select: { id: true },
  });
  return (row?.id as string | undefined) ?? null;
}

/**
 * Hüllt einen Prisma-Client in die Feldverschlüsselung. Der Rückgabewert hat
 * dieselbe Gestalt wie `base`.
 */
export function withFieldEncryption<T extends PrismaClient>(base: T): T {
  const extended = base.$extends({
    name: 'field-encryption',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          const m = model as string;
          const op = operation as string;
          let a: Obj = (args ?? {}) as Obj;
          const known = MODELS.has(m);
          if (!known) return query(a);

          checkArgs(m, a);

          const enc = ENCRYPTED_FIELDS[m] ?? {};
          if (op === 'create' || op === 'createManyAndReturn') {
            a = {
              ...a,
              data: Array.isArray(a.data)
                ? a.data.map((d: Obj) => encryptCreate(m, d))
                : encryptCreate(m, a.data),
            };
          } else if (op === 'createMany') {
            a = { ...a, data: asArray<Obj>(a.data).map((d) => encryptCreate(m, d)) };
          } else if (op === 'update') {
            const direct = Object.keys(a.data ?? {}).some((k) => enc[k]);
            const id = direct ? await lookupId(base, m, a.where) : null;
            if (!direct || id !== null) {
              a = { ...a, data: encryptRow(m, a.data, id, 'update') };
            }
          } else if (op === 'updateMany') {
            if (Object.keys(a.data ?? {}).some((k) => enc[k])) {
              const id = idFromWhere(a.where);
              if (id === null) {
                throw new EncryptedFieldQueryError(
                  `${m}: updateMany auf verschlüsselten Feldern braucht { where: { id } }.`,
                );
              }
              a = { ...a, data: encryptRow(m, a.data, id, 'update') };
            }
          } else if (op === 'upsert') {
            const id = hasEncrypted(m) ? await lookupId(base, m, a.where) : null;
            a = {
              ...a,
              create: encryptCreate(m, a.create),
              // Ohne gefundene Zeile läuft der Update-Zweig nie; dann bleibt er unberührt.
              update:
                id === null && Object.keys(a.update ?? {}).some((k) => enc[k])
                  ? a.update
                  : encryptRow(m, a.update ?? {}, id, 'update'),
            };
          }

          if (!READ_OPS.has(op)) return query(a);

          const prepared = prepareSelection(m, a);
          const result = await query(prepared.args);
          return decryptResult(m, result, prepared.plan);
        },
      },
    },
  });
  RAW_CLIENTS.set(extended as object, base);
  return extended as unknown as T;
}
