import { randomUUID } from 'crypto';
import { PrismaClient } from '.prisma/control-client';
import type { CompanyStatus, Prisma } from '.prisma/control-client';
import { toDate } from '@saas-instant/shared';
import type { PrismaService } from '../prisma/prisma.service';
import {
  truncateAuditLog as truncateAuditLogOn,
  truncateInvoices as truncateInvoicesOn,
} from './gobd-cleanup';

/**
 * Gemeinsamer Unterbau der Integrationstests von Etappe 2.
 *
 * Gelaufen wird gegen eine EIGENE Datenbank (`…_integration`), die
 * `scripts/integrationslauf.mjs` aus der `DATABASE_URL` ableitet — niemals
 * gegen die Entwicklungsdatenbank.
 *
 * Jede Suite arbeitet unter einem eigenen Namenspräfix und räumt am Ende genau
 * ihre eigenen Zeilen weg. Ein abgebrochener Lauf hinterlässt damit höchstens
 * Reste, die keiner anderen Suite in die Quere kommen.
 */
export const prisma = new PrismaClient() as unknown as PrismaService;

const truncateAuditLog = () => truncateAuditLogOn(prisma);
const truncateInvoices = () => truncateInvoicesOn(prisma);

/** Ein Präfix, das nur dieser Suite gehört. */
export function newPrefix(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

export interface TestCompany {
  id: string;
  name: string;
}

/** Legt eine Organisation mit sinnvollen Vorgaben an. */
export async function createCompany(
  prefix: string,
  store: Partial<Prisma.CompanyUncheckedCreateInput> = {},
): Promise<TestCompany> {
  const name = `${prefix} ${randomUUID().slice(0, 6)}`;
  return prisma.company.create({
    data: { name, ...store },
    select: { id: true, name: true },
  });
}

/** Tagesdatum als `@db.Date`-Wert. */
export function day(value: string): Date {
  return toDate(value);
}

/**
 * Alle Notizen einer Organisation, das Neueste zuerst — in DERSELBEN
 * Reihenfolge, die `NotizService.verlauf` herstellt. Sonst prüften die Tests
 * eine andere Sortierung als die, die die Oberfläche zu sehen bekommt.
 */
export async function notesFrom(companyId: string) {
  return prisma.note.findMany({
    where: { companyId },
    orderBy: [{ date: 'desc' }, { sequence: 'desc' }],
  });
}

/** Alle Audit-Einträge zu einer Organisation. */
export async function auditFrom(companyId: string, action?: string) {
  return prisma.auditLog.findMany({
    where: { objectId: companyId, ...(action ? { action } : {}) },
    orderBy: { timestamp: 'asc' },
  });
}

export async function statusFrom(id: string): Promise<CompanyStatus> {
  const row = await prisma.company.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  });
  return row.status;
}

/**
 * Räumt alles weg, was unter diesem Präfix angelegt wurde.
 *
 * Reihenfolge ist Pflicht: Notizen hängen mit `onDelete: Restrict` an der
 * Organisation, und das Audit-Log hängt bewusst an gar nichts — es muss
 * deshalb über die Kennungen aufgeräumt werden.
 */
export async function cleanUp(prefix: string): Promise<void> {
  const companies = await prisma.company.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const identifiers = companies.map((o) => o.id);
  if (identifiers.length === 0) return;

  const notes = await prisma.note.findMany({
    where: { companyId: { in: identifiers } },
    select: { id: true },
  });
  // Etappe 3: Instanzen haengen mit `onDelete: Restrict` an der Organisation,
  // Kennzahlen und Sicherungen ebenso an der Instanz. Die Reihenfolge ist
  // deshalb von innen nach aussen.
  const instances = await prisma.instance.findMany({
    where: { companyId: { in: identifiers } },
    select: { id: true },
  });
  const instanceIdentifiers = instances.map((i) => i.id);
  // Etappe 4: Rechnungen haengen mit `onDelete: Restrict` an der Organisation,
  // Posten ebenso an der Rechnung. Die Stornorechnung verweist zusaetzlich auf
  // ihr Original — deshalb erst alle Posten, dann alle Rechnungen, und die
  // Stornorechnungen zuerst.
  const invoices = await prisma.invoice.findMany({
    where: { companyId: { in: identifiers } },
    select: { id: true, cancelledInvoiceId: true },
  });
  const invoiceIdentifiers = invoices.map((r) => r.id);
  await truncateAuditLog();
  if (invoiceIdentifiers.length > 0) {
    // Festgeschriebene Rechnungen lassen sich per DELETE nicht entfernen
    // (GoBD-Trigger); TRUNCATE ... CASCADE umgeht ihn nur hier im Testpfad.
    await truncateInvoices();
  }
  if (instanceIdentifiers.length > 0) {
    await prisma.metric.deleteMany({
      where: { instanceId: { in: instanceIdentifiers } },
    });
    await prisma.backup.deleteMany({
      where: { instanceId: { in: instanceIdentifiers } },
    });
    await prisma.instance.deleteMany({ where: { id: { in: instanceIdentifiers } } });
  }
  await prisma.instancePreview.deleteMany({
    where: { companyId: { in: identifiers } },
  });
  await prisma.note.deleteMany({ where: { companyId: { in: identifiers } } });
  // Etappe 5: MailVersand haengt mit `onDelete: Restrict` an der Organisation
  // UND an der Einwilligung. Erst die Versandzeilen, dann die Einwilligungen,
  // dann die Organisation.
  const consents = await prisma.consent.findMany({
    where: { companyId: { in: identifiers } },
    select: { id: true },
  });
  const consentIdentifiers = consents.map((e) => e.id);
  await prisma.mailDelivery.deleteMany({
    where:
      consentIdentifiers.length > 0
        ? {
            OR: [
              { companyId: { in: identifiers } },
              { consentId: { in: consentIdentifiers } },
            ],
          }
        : { companyId: { in: identifiers } },
  });
  if (consentIdentifiers.length > 0) {
    await truncateAuditLog();
    await prisma.consent.deleteMany({
      where: { id: { in: consentIdentifiers } },
    });
  }
  await prisma.company.deleteMany({ where: { id: { in: identifiers } } });
}

/**
 * Raeumt Einwilligungen und ihre Versandzeilen weg, die an KEINER Organisation
 * haengen — die Suiten von Etappe 5 legen solche an.
 *
 * IMMER MIT PRAEFIX. Ein leerer Praefix traefe die ganze Tabelle; die
 * Adressen der Testeintraege beginnen deshalb mit einer suitenspezifischen
 * Zeichenkette.
 */
export async function cleanUpConsents(
  addressPrefix: string,
): Promise<void> {
  if (addressPrefix.trim() === '') {
    throw new Error('raeumeEinwilligungenAuf verlangt einen Praefix.');
  }
  const rows = await prisma.consent.findMany({
    where: { email: { startsWith: addressPrefix } },
    select: { id: true },
  });
  const identifiers = rows.map((row) => row.id);
  if (identifiers.length === 0) return;
  const deliveries = await prisma.mailDelivery.findMany({
    where: { consentId: { in: identifiers } },
    select: { id: true },
  });
  await truncateAuditLog();
  await prisma.mailDelivery.deleteMany({
    where: { consentId: { in: identifiers } },
  });
  await prisma.consent.deleteMany({ where: { id: { in: identifiers } } });
}

/** Raeumt Vorlagen weg, deren Name mit dem Praefix beginnt. */
export async function cleanUpTemplates(prefix: string): Promise<void> {
  if (prefix.trim() === '') {
    throw new Error('raeumeVorlagenAuf verlangt einen Praefix.');
  }
  const templates = await prisma.mailTemplate.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const identifiers = templates.map((row) => row.id);
  if (identifiers.length === 0) return;
  await prisma.mailDelivery.deleteMany({
    where: { templateId: { in: identifiers } },
  });
  await truncateAuditLog();
  await prisma.mailTemplate.deleteMany({ where: { id: { in: identifiers } } });
}

/**
 * ===========================================================================
 * [W5] WARTE AUF DAS ERGEBNIS, NICHT AUF DIE UHR
 * ===========================================================================
 *
 * Mehrere Dienste starten ihren langen Teil mit `void` im Hintergrund — genau
 * so ist es gewollt, damit die Antwort nicht auf ein Deployment wartet. Tests
 * dagegen brauchen einen Zeitpunkt, an dem sie prüfen dürfen.
 *
 * DAS WAR MIT `setTimeout` GELÖST, und das war die Ursache des flatternden
 * Laufs: elf feste Fristen, gemessener Abstand zum Budget zwischen 14 und
 * 37 ms. Auf einer belasteten Maschine reicht das nicht — und die
 * Fehlermeldung („erwartet aktiv, war wird_erstellt") zeigt dann auf den
 * Dienst statt auf die Wartezeit. Es lag NICHT an der geteilten Datenbank.
 *
 * `warteBis` fragt stattdessen die Bedingung ab, bis sie zutrifft. Ein
 * langsamer Rechner braucht länger, statt falsch zu melden; ein Fehler im
 * Dienst schlägt weiterhin fehl — nur eben mit einer Meldung, die sagt, worauf
 * gewartet wurde.
 */
export async function waitUntil(
  condition: () => Promise<boolean> | boolean,
  description: string,
  deadline = 15_000,
): Promise<void> {
  const ende = Date.now() + deadline;
  let lastError: unknown = null;
  while (Date.now() < ende) {
    try {
      if (await condition()) return;
      lastError = null;
    } catch (exception) {
      // Eine Bedingung darf werfen, solange der erwartete Zustand noch nicht
      // da ist (`findUniqueOrThrow` auf eine Zeile, die gleich entsteht).
      lastError = exception;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(
    `Bedingung „${description}" trat innerhalb von ${deadline} ms nicht ein.` +
      (lastError ? ` Zuletzt: ${String(lastError)}` : ''),
  );
}

/** Trennt die Verbindung am Ende einer Suite. */
export async function disconnect(): Promise<void> {
  await (prisma as unknown as PrismaClient).$disconnect();
}

import type { IntakeSendService } from '../intake/intake-send.service';

/**
 * Ein Versanddoppel fuer Suiten, die mit dem Aufnahmeformular nichts zu tun
 * haben. Es zeichnet auf, statt zu verschicken — und macht damit sichtbar,
 * wenn ein Statuswechsel unerwartet eine Mail ausloest.
 */
export function sendDouble(): IntakeSendService & {
  sent: { companyId: string; automatic: boolean }[];
} {
  const sent: { companyId: string; automatic: boolean }[] = [];
  return {
    sent,
    async send(
      companyId: string,
      _name: string,
      email: string | null,
      _actor: { name: string; userId: string | null },
      automatic: boolean,
    ) {
      sent.push({ companyId, automatic });
      return { sent: true, email: email ?? '' };
    },
  } as unknown as IntakeSendService & {
    sent: { companyId: string; automatic: boolean }[];
  };
}
