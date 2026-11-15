import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Prisma } from ".prisma/control-client";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * Demo-Daten für Screenshots der Oberfläche.
 *
 * Alles hier ist ERFUNDEN: Organisationen, Personen, Adressen und Beträge
 * existieren nicht; Mailadressen liegen unter example.com, Subdomains unter
 * demo.example.com, Bankfelder bleiben leer.
 *
 * MARKIERUNG: Jeder Datensatz trägt eine feste ID mit Präfix `demo-`
 * (Rechnungsnummern: `DEMO-…`). Das Skript räumt vor dem Anlegen NUR Zeilen
 * auf, die an diesen festen Organisations-IDs hängen — es ist damit
 * wiederholbar und fasst nichts Echtes an. Es löscht ausschließlich lokale
 * Datenbankzeilen; Coolify und Instanzen werden nie angesprochen (Regel R1).
 *
 * Sicherheitsschranken wie `seed.ts`: Abbruch bei NODE_ENV=production und
 * ohne CONTROL_SEED_ALLOWED=ja. Außerdem muss der Testbenutzer aus
 * `seed.ts` existieren — ohne ihn fehlt die Anmeldung, und die Demo-Daten
 * wären nicht zu sehen.
 *
 * Ausführen:  pnpm --filter @saas-instant/control seed:demo
 */

const TEST_USERNAME = "test";
const TAX_RATE = 19;

type Cents = number;

function abortIfNotAllowed(): void {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "Der Demo-Seed ist ausschließlich für die Entwicklung gedacht. " +
        "NODE_ENV=production — Abbruch, es wurde nichts geschrieben.",
    );
  }
  if (process.env["CONTROL_SEED_ALLOWED"] !== "ja") {
    throw new Error(
      "Der Demo-Seed läuft nur mit CONTROL_SEED_ALLOWED=ja. " +
        "Abbruch, es wurde nichts geschrieben.",
    );
  }
}

/** Mitternacht UTC, `days` Tage von heute aus (negativ = Vergangenheit). */
function day(days: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days),
  );
}

/** Cent-Betrag als Dezimalzeichenkette, ohne Gleitkomma-Rundung. */
function money(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

interface DemoCompany {
  n: number;
  name: string;
  legalForm?: string;
  city: string;
  postalCode: string;
  street: string;
  houseNumber: string;
  contact: string;
  role: string;
  mail: string;
  deputy?: { name: string; role: string; mail: string };
  status: Prisma.CompanyCreateInput["status"];
  interval?: "yearly" | "half_yearly";
  source: "form" | "phone" | "referral" | "event";
  ageDays: number;
  notes?: string[];
}

const COMPANIES: DemoCompany[] = [
  {
    n: 1,
    name: "Demo Bärenwald Naturschule",
    legalForm: "e. V.",
    city: "Musterstadt",
    postalCode: "99999",
    street: "Lindenweg",
    houseNumber: "1",
    contact: "Mira Beispiel",
    role: "Vorstand",
    mail: "mira.beispiel@example.com",
    status: "inquiry",
    source: "form",
    ageDays: 4,
    notes: ["Anfrage über das Formular eingegangen, Rückruf vereinbart."],
  },
  {
    n: 2,
    name: "Demo Blaumeise Kinderladen",
    legalForm: "e. V.",
    city: "Beispielhausen",
    postalCode: "99998",
    street: "Am Bach",
    houseNumber: "12",
    contact: "Jonas Probe",
    role: "Leitung",
    mail: "jonas.probe@example.com",
    status: "inquiry",
    source: "referral",
    ageDays: 9,
  },
  {
    n: 3,
    name: "Demo Wiesenhummel Gemeinschaftsgarten",
    legalForm: "gGmbH",
    city: "Testingen",
    postalCode: "99997",
    street: "Gartenstraße",
    houseNumber: "7a",
    contact: "Lena Muster",
    role: "Geschäftsführung",
    mail: "lena.muster@example.com",
    status: "demo",
    source: "event",
    ageDays: 21,
    notes: ["Demozugang gesendet, Vorführung am Donnerstag."],
  },
  {
    n: 4,
    name: "Demo Kupferkessel Repair-Café",
    legalForm: "e. V.",
    city: "Musterstadt",
    postalCode: "99999",
    street: "Werkstattgasse",
    houseNumber: "3",
    contact: "Tobias Erfunden",
    role: "Schriftführung",
    mail: "tobias.erfunden@example.com",
    deputy: {
      name: "Hanna Platzhalter",
      role: "Kassenwartin",
      mail: "hanna.platzhalter@example.com",
    },
    status: "pilot_approved",
    source: "phone",
    ageDays: 35,
    notes: ["Pilot freigegeben, Aufnahmeformular verschickt."],
  },
  {
    n: 5,
    name: "Demo Tannenzapfen Jugendwerk",
    legalForm: "e. V.",
    city: "Beispielhausen",
    postalCode: "99998",
    street: "Schulplatz",
    houseNumber: "5",
    contact: "Svenja Ausgedacht",
    role: "Vorstand",
    mail: "svenja.ausgedacht@example.com",
    status: "pilot_running",
    source: "form",
    ageDays: 60,
    notes: ["Pilot läuft seit zwei Wochen, erste Rückmeldung positiv."],
  },
  {
    n: 6,
    name: "Demo Silberdistel Nachbarschaftshilfe",
    legalForm: "e. V.",
    city: "Testingen",
    postalCode: "99997",
    street: "Hauptstraße",
    houseNumber: "40",
    contact: "Paul Fiktiv",
    role: "Vorstand",
    mail: "paul.fiktiv@example.com",
    status: "paying",
    interval: "yearly",
    source: "referral",
    ageDays: 200,
    notes: [
      "Jahreszahlung per Überweisung vereinbart.",
      "Ansprechperson wechselt im Frühjahr, Vertretung ist eingetragen.",
    ],
  },
  {
    n: 7,
    name: "Demo Rotkehlchen Stadtteilverein",
    legalForm: "e. V.",
    city: "Musterstadt",
    postalCode: "99999",
    street: "Parkallee",
    houseNumber: "18",
    contact: "Clara Nirgendwo",
    role: "Geschäftsführung",
    mail: "clara.nirgendwo@example.com",
    status: "paying",
    interval: "half_yearly",
    source: "event",
    ageDays: 320,
  },
  {
    n: 8,
    name: "Demo Steinbock Bergwacht-Förderkreis",
    legalForm: "e. V.",
    city: "Beispielhausen",
    postalCode: "99998",
    street: "Talstraße",
    houseNumber: "9",
    contact: "Felix Unbekannt",
    role: "Vorstand",
    mail: "felix.unbekannt@example.com",
    status: "dormant",
    interval: "yearly",
    source: "phone",
    ageDays: 500,
    notes: ["Kündigung zum Jahresende eingegangen, Instanz pausiert."],
  },
];

const companyId = (n: number): string => `demo-company-${n}`;
const instanceId = (n: number): string => `demo-instance-${n}`;
const invoiceId = (n: number): string => `demo-invoice-${n}`;
const noteId = (n: number, i: number): string => `demo-note-${n}-${i}`;
const COMPANY_IDS = COMPANIES.map((c) => companyId(c.n));

interface DemoInstance {
  companyN: number;
  subdomain: string;
  status: "provisioning" | "active" | "stopped";
  ageDays: number;
  /** Grundwert der Kennzahlen; `null` = keine Kennzahlen. */
  basePersons: number | null;
}

const INSTANCES: DemoInstance[] = [
  {
    companyN: 3,
    subdomain: "wiesenhummel",
    status: "provisioning",
    ageDays: 1,
    basePersons: null,
  },
  {
    companyN: 4,
    subdomain: "kupferkessel",
    status: "provisioning",
    ageDays: 2,
    basePersons: null,
  },
  {
    companyN: 5,
    subdomain: "tannenzapfen",
    status: "active",
    ageDays: 40,
    basePersons: 14,
  },
  {
    companyN: 6,
    subdomain: "silberdistel",
    status: "active",
    ageDays: 180,
    basePersons: 38,
  },
  {
    companyN: 7,
    subdomain: "rotkehlchen",
    status: "active",
    ageDays: 300,
    basePersons: 61,
  },
  {
    companyN: 8,
    subdomain: "steinbock",
    status: "stopped",
    ageDays: 480,
    basePersons: null,
  },
];

interface DemoInvoice {
  n: number;
  companyN: number;
  number: string;
  invoiceDay: number;
  dueInDays: number;
  state: "draft" | "open" | "paid";
  /** Posten: Bezeichnung, Menge, Einzelpreis netto in Cent. */
  lines: { label: string; quantity: number; unitNet: Cents }[];
  periodMonths: number;
}

const INVOICES: DemoInvoice[] = [
  {
    n: 1,
    companyN: 6,
    number: "DEMO-0001",
    invoiceDay: -330,
    dueInDays: 14,
    state: "paid",
    periodMonths: 12,
    lines: [{ label: "Nutzung Jahrespaket", quantity: 1, unitNet: 52900 }],
  },
  {
    n: 2,
    companyN: 7,
    number: "DEMO-0002",
    invoiceDay: -200,
    dueInDays: 14,
    state: "paid",
    periodMonths: 6,
    lines: [
      { label: "Nutzung Halbjahrespaket", quantity: 1, unitNet: 28900 },
      { label: "Einrichtung", quantity: 1, unitNet: 15000 },
    ],
  },
  {
    n: 3,
    companyN: 7,
    number: "DEMO-0003",
    invoiceDay: -20,
    dueInDays: 14,
    state: "open",
    periodMonths: 6,
    lines: [{ label: "Nutzung Halbjahrespaket", quantity: 1, unitNet: 28900 }],
  },
  {
    n: 4,
    companyN: 6,
    number: "DEMO-0004",
    invoiceDay: -5,
    dueInDays: 14,
    state: "open",
    periodMonths: 12,
    lines: [
      { label: "Nutzung Jahrespaket", quantity: 1, unitNet: 52900 },
      { label: "Zusätzlicher Speicher", quantity: 2, unitNet: 2500 },
    ],
  },
  {
    n: 5,
    companyN: 8,
    number: "DEMO-0005",
    invoiceDay: -75,
    dueInDays: 14,
    state: "open",
    periodMonths: 12,
    lines: [{ label: "Nutzung Jahrespaket", quantity: 1, unitNet: 52900 }],
  },
  {
    n: 6,
    companyN: 7,
    number: "DEMO-0006",
    invoiceDay: -50,
    dueInDays: 14,
    state: "open",
    periodMonths: 1,
    lines: [{ label: "Zusätzliche Betreuung", quantity: 3, unitNet: 6000 }],
  },
  {
    n: 7,
    companyN: 6,
    number: "DEMO-0007",
    invoiceDay: 0,
    dueInDays: 14,
    state: "draft",
    periodMonths: 12,
    lines: [{ label: "Nutzung Jahrespaket", quantity: 1, unitNet: 52900 }],
  },
];

async function removeOldDemoData(prisma: PrismaService): Promise<void> {
  const where = { companyId: { in: COMPANY_IDS } };
  const instances = await prisma.instance.findMany({
    where,
    select: { id: true },
  });
  const invoices = await prisma.invoice.findMany({
    where,
    select: { id: true },
  });
  // Reihenfolge wegen `onDelete: Restrict`: erst Kinder, dann Eltern. Alles
  // hängt an den festen Demo-Organisations-IDs.
  await prisma.$transaction([
    prisma.metric.deleteMany({
      where: { instanceId: { in: instances.map((i) => i.id) } },
    }),
    prisma.invoiceLine.deleteMany({
      where: { invoiceId: { in: invoices.map((i) => i.id) } },
    }),
    prisma.invoice.deleteMany({
      where: { id: { in: invoices.map((i) => i.id) } },
    }),
    prisma.instance.deleteMany({
      where: { id: { in: instances.map((i) => i.id) } },
    }),
    prisma.note.deleteMany({ where }),
    prisma.company.deleteMany({ where: { id: { in: COMPANY_IDS } } }),
  ]);
}

async function createCompanies(prisma: PrismaService): Promise<void> {
  for (const c of COMPANIES) {
    const statusDay = day(-Math.max(1, Math.floor(c.ageDays / 2)));
    await prisma.company.create({
      data: {
        id: companyId(c.n),
        name: c.name,
        legalForm: c.legalForm ?? null,
        street: c.street,
        houseNumber: c.houseNumber,
        postalCode: c.postalCode,
        city: c.city,
        billingEmail: c.mail,
        contactName: c.contact,
        contactEmail: c.mail,
        contactRole: c.role,
        deputyName: c.deputy?.name ?? null,
        deputyEmail: c.deputy?.mail ?? null,
        deputyRole: c.deputy?.role ?? null,
        status: c.status,
        lastStatusChangeAt: statusDay,
        paymentInterval: c.interval ?? null,
        // Überweisung braucht kein SEPA-Mandat; Bankfelder bleiben leer.
        paymentMethod: c.interval ? "bank_transfer" : null,
        source: c.source,
        createdAt: new Date(day(-c.ageDays).getTime() + 9 * 3600 * 1000),
      },
    });
    for (const [i, text] of (c.notes ?? []).entries()) {
      await prisma.note.create({
        data: {
          id: noteId(c.n, i + 1),
          companyId: companyId(c.n),
          date: day(-(i + 1) * 3),
          text,
        },
      });
    }
  }
}

async function createInstances(prisma: PrismaService): Promise<void> {
  for (const [idx, inst] of INSTANCES.entries()) {
    const id = instanceId(inst.companyN);
    await prisma.instance.create({
      data: {
        id,
        companyId: companyId(inst.companyN),
        subdomain: inst.subdomain,
        status: inst.status,
        createdAt: new Date(day(-inst.ageDays).getTime() + 10 * 3600 * 1000),
        appVersion: inst.status === "provisioning" ? null : "1.4.2",
        setupCompletedAt:
          inst.status === "provisioning" ? null : day(-inst.ageDays + 1),
        lastMetricsFetchAt: inst.status === "active" ? new Date() : null,
        message:
          inst.status === "stopped"
            ? "Demo: Instanz pausiert, Daten bleiben erhalten."
            : null,
      },
    });
    if (inst.status !== "active" || inst.basePersons === null) continue;

    const rows: Prisma.MetricCreateManyInput[] = [];
    for (let back = 29; back >= 0; back--) {
      // Deterministische, leicht schwankende Werte — kein Zufall, damit
      // Screenshots reproduzierbar bleiben.
      const wave = Math.round(3 * Math.sin((back + idx * 5) / 3));
      const growth = Math.floor((29 - back) / 10);
      const weekend = [0, 6].includes(day(-back).getUTCDay());
      rows.push({
        instanceId: id,
        date: day(-back),
        activePersons: Math.max(
          1,
          inst.basePersons + wave + growth - (weekend ? 4 : 0),
        ),
        circles: 3 + (idx % 3) + Math.floor((29 - back) / 15),
        lastEntryAt: day(-(back % 4 === 0 ? 1 : 0) - back),
        lastLoginAt: day(-back),
        appVersion: "1.4.2",
        fetchSuccessful: true,
        databaseState: "erreichbar",
        companyNameMatches: true,
      });
    }
    await prisma.metric.createMany({ data: rows });
  }
}

async function createInvoices(prisma: PrismaService): Promise<void> {
  for (const inv of INVOICES) {
    const company = COMPANIES.find((c) => c.n === inv.companyN);
    if (!company) throw new Error(`Demo-Organisation ${inv.companyN} fehlt.`);

    const lines = inv.lines.map((l) => {
      // Netto = Menge x Einzelpreis in Cent (ganzzahlig); Steuer auf ganze
      // Cent gerundet, Brutto = Netto + Steuer — Summen stimmen exakt.
      const net = l.quantity * l.unitNet;
      const tax = Math.round((net * TAX_RATE) / 100);
      return { ...l, net, tax, gross: net + tax };
    });
    const gross = lines.reduce((sum, l) => sum + l.gross, 0);
    const invoiceDate = day(inv.invoiceDay);
    const dueDate = day(inv.invoiceDay + inv.dueInDays);
    const periodFrom = invoiceDate;
    const periodUntil = day(inv.invoiceDay + inv.periodMonths * 30 - 1);
    const draft = inv.state === "draft";
    const paid = inv.state === "paid";

    await prisma.invoice.create({
      data: {
        id: invoiceId(inv.n),
        companyId: companyId(inv.companyN),
        invoiceNumber: draft ? null : inv.number,
        invoiceDate,
        servicePeriodFrom: periodFrom,
        servicePeriodUntil: periodUntil,
        dueDate,
        status: draft ? "draft" : paid ? "paid" : "sent",
        finalizedAt: draft
          ? null
          : new Date(invoiceDate.getTime() + 8 * 3600 * 1000),
        paymentDate: paid ? day(inv.invoiceDay + 6) : null,
        paidAmount: paid ? money(gross) : null,
        internalNote: "Demo-Datensatz, erfunden.",
        recipientName: company.name,
        recipientAddress: `${company.street} ${company.houseNumber}\n${company.postalCode} ${company.city}`,
        recipientEmail: company.mail,
        issuerCompanyName: "Demo Betreiber GmbH",
        issuerAddress: "Musterweg 1\n99999 Musterstadt",
        issuerSeat: "Musterstadt",
        // Bankangabe bewusst ein offensichtlicher Platzhalter, keine echte IBAN.
        issuerBankDetails: "IBAN: DE00 0000 0000 0000 0000 00 (Demo)",
        lines: {
          create: lines.map((l) => ({
            label: l.label,
            unit: "Stück",
            periodFrom,
            periodUntil,
            quantity: l.quantity.toFixed(3),
            unitPriceNet: money(l.unitNet),
            taxRate: TAX_RATE.toFixed(2),
            netAmount: money(l.net),
            taxAmount: money(l.tax),
            grossAmount: money(l.gross),
          })),
        },
      },
    });
  }
}

async function main(): Promise<void> {
  abortIfNotAllowed();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"],
  });

  try {
    const prisma = app.get(PrismaService);

    const user = await prisma.user.findUnique({
      where: { username: TEST_USERNAME },
      select: { id: true },
    });
    if (!user) {
      throw new Error(
        `Der Testbenutzer „${TEST_USERNAME}" existiert nicht. Zuerst ` +
          "`pnpm --filter @saas-instant/control seed` ausführen, dann erneut versuchen.",
      );
    }

    await removeOldDemoData(prisma);
    await createCompanies(prisma);
    await createInstances(prisma);
    await createInvoices(prisma);

    process.stdout.write(
      [
        "",
        "Demo-Daten angelegt (alles erfunden, nur Entwicklung):",
        `  ${COMPANIES.length} Organisationen, ${INSTANCES.length} Instanzen, ` +
          `${INVOICES.length} Rechnungen (ID-Präfix demo-, Nummern DEMO-…)`,
        "  Erneutes Ausführen ersetzt nur diese Demo-Datensätze.",
        "",
      ].join("\n"),
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nDemo-Seed fehlgeschlagen: ${message}\n\n`);
  process.exitCode = 1;
});
