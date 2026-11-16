import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import {
  datePlusDays,
  emptyIssuerProfile,
  validateIssuerProfile,
  type IssuerProfile,
  type LegalForm,
} from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { WITHOUT_SECOND_FACTOR } from '../common/decorators/without-second-factor.decorator';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { IssuerConfigService } from '../invoices/document/issuer.config';
import type { InvoiceRenderer } from '../invoices/document/invoice-renderer.client';
import { InvoiceDocumentService } from '../invoices/document.service';
import {
  InvoiceIssuerIncompleteError,
  InvoiceIssuerPlaceholderError,
} from '../invoices/invoice.errors';
import { InvoiceService } from '../invoices/invoice.service';
import { PricingConfigService } from '../invoices/pricing.config';
import {
  cleanUp,
  createCompany,
  disconnect,
  newPrefix,
  prisma,
} from '../test-support/company-provisioning';
import { truncateAuditLog } from '../test-support/gobd-cleanup';
import {
  IssuerSettingsController,
  PublicLogoController,
  readBody,
} from './issuer.controller';
import {
  AccentColorInvalidError,
  IssuerProfileService,
  LogoInvalidError,
  LOGO_MAX_BYTES,
} from './issuer-profile.service';

/**
 * Firmendaten (Aussteller) gegen eine ECHTE Datenbank: Befüllung aus dem
 * Startwert, Speichern auch unvollständig, Logo, Audit — und das Festschreiben
 * je Rechtsform mit Pflichtfeldliste (`issuer_incomplete`).
 */

jest.setTimeout(120_000);

const PREFIX = newPrefix('firmendaten');
const SOURCE = { ip: '203.0.113.7', userAgent: 'Jest-Integration' };
const YEAR = 2096;
const INVOICE_DATE = `${YEAR}-03-01`;
const actor = { userId: null, name: 'sam' };
let user = { id: '', username: PREFIX };

const env = (values: Record<string, string>) =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService;
const DATES = {
  CONTROL_INVOICE_DATE_RETROACTIVE_DAYS: '40000',
  CONTROL_INVOICE_DATE_AHEAD_DAYS: '40000',
};
const audit = new AuditService(prisma);
const prices = new PricingConfigService(env({}));

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('rest-of-image'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif')]);

function services(startup: Record<string, string> = {}) {
  const profile = new IssuerProfileService(prisma, audit, env(startup));
  const issuer = new IssuerConfigService(env(startup), undefined, profile);
  const invoices = new InvoiceService(prisma, audit, prices, issuer, env(DATES));
  return { profile, issuer, invoices };
}

const BASE = {
  street: 'Musterstraße 1',
  postalCode: '99999',
  city: 'Musterstadt',
  iban: 'DE89370400440532013000',
  vatId: 'DE136695976',
};
const REGISTER = { seat: 'Musterstadt', registerCourt: 'Amtsgericht Musterstadt' };

/** Je Rechtsform ein vollständiges Profil. */
const COMPLETE: Record<LegalForm, Partial<IssuerProfile>> = {
  einzelunternehmen: { name: 'Erika Mustermann', ownerName: 'Erika Mustermann' },
  gbr: { name: 'Mustermann und Beispiel GbR', partners: ['Erika Mustermann'] },
  ohg: { name: 'Muster OHG', ...REGISTER, registerNumber: 'HRA 1234' },
  gmbh: {
    name: 'Muster GmbH',
    ...REGISTER,
    registerNumber: 'HRB 1234',
    managingPersons: ['Erika Mustermann'],
  },
  ug: {
    name: 'Muster UG (haftungsbeschränkt)',
    ...REGISTER,
    registerNumber: 'HRB 1234',
    managingPersons: ['Erika Mustermann'],
  },
  gmbh_co_kg: {
    name: 'Muster GmbH & Co. KG',
    ...REGISTER,
    registerNumber: 'HRA 1234',
    generalPartner: {
      name: 'Muster Verwaltungs GmbH',
      seat: 'Musterstadt',
      registerCourt: 'Amtsgericht Musterstadt',
      registerNumber: 'HRB 4321',
      managingDirectors: ['Erika Mustermann'],
    },
  },
  eg: {
    name: 'Muster eG',
    ...REGISTER,
    registerNumber: 'GnR 1234',
    managingPersons: ['Erika Mustermann'],
  },
  ev: {
    name: 'Muster e.V.',
    ...REGISTER,
    registerNumber: 'VR 1234',
    managingPersons: ['Erika Mustermann'],
  },
};

const complete = (form: LegalForm): IssuerProfile => ({
  ...emptyIssuerProfile(form),
  ...BASE,
  ...COMPLETE[form],
});

async function draft(svc: InvoiceService, label: string) {
  const created = await createCompany(PREFIX, {
    street: 'Ziegelgasse',
    houseNumber: '14',
    postalCode: '99423',
    city: 'Weimar',
    country: 'DE',
    contactEmail: `${label}@example.com`,
  });
  const invoice = await svc.draftCreate(
    created.id,
    {
      invoiceDate: INVOICE_DATE,
      servicePeriodFrom: INVOICE_DATE,
      servicePeriodUntil: datePlusDays(INVOICE_DATE, 364),
      lines: [{ label: 'Jahresbeitrag', quantity: 1, unitPriceNetCent: 38_500, taxRate: 19 }],
    },
    actor,
    SOURCE,
  );
  return invoice.id;
}

async function clearIssuer(): Promise<void> {
  await prisma.issuerProfile.deleteMany();
  await truncateAuditLog(prisma);
}

beforeAll(async () => {
  const account = await prisma.user.create({
    data: { name: 'Firmendaten-Test', username: PREFIX, email: `${PREFIX}@example.com` },
  });
  user = { id: account.id, username: PREFIX };
});

beforeEach(clearIssuer);

afterAll(async () => {
  await clearIssuer();
  await cleanUp(PREFIX);
  await prisma.user.deleteMany({ where: { username: PREFIX } });
  await disconnect();
});

describe('Befüllung aus Manifest/Umgebung', () => {
  it('legt beim ersten Zugriff ein Profil aus den Startwerten an und ändert es danach nie', async () => {
    const first = services({
      CONTROL_INVOICE_ISSUER: 'Testhaus GmbH & Co. KG',
      CONTROL_INVOICE_GENERAL_PARTNER: 'Testhaus Verwaltungs GmbH',
      CONTROL_INVOICE_MANAGING_DIRECTOR: 'Erika Beispiel',
      CONTROL_INVOICE_IBAN: 'DE89370400440532013000',
    });
    const a = await first.profile.get();
    expect(a.profile.legalForm).toBe('gmbh_co_kg');
    expect(a.profile.name).toBe('Testhaus GmbH & Co. KG');
    expect(a.profile.generalPartner.name).toBe('Testhaus Verwaltungs GmbH');
    expect(a.profile.generalPartner.managingDirectors).toEqual(['Erika Beispiel']);

    const second = services({ CONTROL_INVOICE_ISSUER: 'Ganz Anders GmbH' });
    expect((await second.profile.get()).profile.name).toBe('Testhaus GmbH & Co. KG');
    expect(await prisma.issuerProfile.count()).toBe(1);
  });

  it('bildet die Rechtsform ab: sole_proprietor, association, company ohne Komplementärin', async () => {
    const cases: Array<[string, LegalForm]> = [
      ['sole_proprietor', 'einzelunternehmen'],
      ['association', 'ev'],
    ];
    for (const [input, expected] of cases) {
      await clearIssuer();
      const s = services({
        CONTROL_INVOICE_LEGAL_FORM: input,
        CONTROL_INVOICE_GENERAL_PARTNER: '',
      });
      expect((await s.profile.get()).profile.legalForm).toBe(expected);
    }
  });

  it('der Platzhalter-Aussteller lässt sich nie festschreiben, verbraucht keine Nummer', async () => {
    const s = services();
    const id = await draft(s.invoices, 'platzhalter');
    await expect(s.invoices.finalize(id, actor, SOURCE)).rejects.toBeInstanceOf(
      InvoiceIssuerPlaceholderError,
    );
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.invoiceNumber).toBeNull();
  });
});

describe('Settings-API (Dienst und Controller)', () => {
  it('liegt hinter Sitzung und zweitem Faktor; nur Lesen ist davon befreit', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, IssuerSettingsController) as unknown[];
    // Dazwischen der RoleGuard: staff wird abgewiesen, ohne vorher nach einem Nachweis gefragt zu werden.
    expect(guards).toEqual([SessionGuard, RoleGuard, SecondFactorGuard]);
    const proto = IssuerSettingsController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(WITHOUT_SECOND_FACTOR, proto['get']!)).toBeTruthy();
    for (const method of ['update', 'uploadLogo', 'deleteLogo']) {
      expect(Reflect.getMetadata(WITHOUT_SECOND_FACTOR, proto[method]!)).toBeUndefined();
    }
    // Das öffentliche Logo hängt an keinem Guard.
    expect(Reflect.getMetadata(GUARDS_METADATA, PublicLogoController)).toBeUndefined();
  });

  it('speichert auch ein unvollständiges Profil und nennt die fehlenden Felder', async () => {
    const { profile } = services();
    const draftProfile = { ...emptyIssuerProfile('gmbh'), name: 'Muster GmbH' };
    const response = await profile.update(draftProfile, null, user, SOURCE);
    expect(response.profile.name).toBe('Muster GmbH');
    const fields = response.missing.map((m) => m.field);
    expect(fields).toEqual(
      expect.arrayContaining(['street', 'iban', 'seat', 'registerNumber', 'managingPersons']),
    );
    expect(response.missing.every((m) => m.label && m.code)).toBe(true);
    // Und GET liefert dasselbe.
    expect((await profile.getResponse()).missing).toEqual(response.missing);
  });

  it('prüft die Akzentfarbe mit Grund: Format und Kontrast; liefert accentOnDark', async () => {
    const { profile } = services();
    const p = complete('gmbh');
    await expect(profile.update(p, 'rot', user, SOURCE)).rejects.toMatchObject({
      errorCode: 'accent_color_invalid',
      errorDetail: { reason: 'format' },
    });
    await expect(profile.update(p, '#ffff00', user, SOURCE)).rejects.toBeInstanceOf(
      AccentColorInvalidError,
    );
    await expect(profile.update(p, '#ffff00', user, SOURCE)).rejects.toMatchObject({
      errorDetail: { reason: 'contrast' },
    });
    const ok = await profile.update(p, '#0369A1', user, SOURCE);
    expect(ok.accentColor).toBe('#0369a1');
    expect(ok.accentOnDark).toMatch(/^#[0-9a-f]{6}$/);
    const branding = await profile.branding();
    expect(branding).toMatchObject({ accentColor: '#0369a1', hasLogo: false });
    const cleared = await profile.update(p, null, user, SOURCE);
    expect(cleared.accentColor).toBeNull();
    expect(cleared.accentOnDark).toBeNull();
  });

  it('protokolliert issuer.updated ohne Inhalte großer Felder', async () => {
    const { profile } = services();
    await profile.update(complete('gmbh'), '#0369a1', user, SOURCE);
    await profile.setLogo(PNG, 'image/png', user, SOURCE);
    const rows = await prisma.auditLog.findMany({
      where: { action: AUDIT_ACTION.issuerUpdated },
      orderBy: { timestamp: 'asc' },
    });
    expect(rows.length).toBe(2);
    const text = JSON.stringify(rows.map((r) => [r.beforeValue, r.afterValue]));
    expect(rows[0]!.userId).toBe(user.id);
    expect(text).not.toContain('Musterstraße');
    expect(text).not.toContain('DE89370400440532013000');
    expect(text).not.toContain(PNG.toString('base64'));
    expect(text).toContain('image/png');
  });

  it('Logo: gültiges PNG/JPEG wird mit SHA-256 gespeichert, Löschen entfernt es', async () => {
    const { profile } = services();
    const set = await profile.setLogo(PNG, 'image/png', user, SOURCE);
    expect(set.logo).toMatchObject({
      hasLogo: true,
      mime: 'image/png',
      sizeBytes: PNG.length,
    });
    const { createHash } = await import('node:crypto');
    expect(set.logo.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
    const swapped = await profile.setLogo(JPEG, 'image/jpeg', user, SOURCE);
    expect(swapped.logo.mime).toBe('image/jpeg');
    expect((await profile.currentIssuer()).logoDataUri).toBe(
      `data:image/jpeg;base64,${JPEG.toString('base64')}`,
    );
    const removed = await profile.deleteLogo(user, SOURCE);
    expect(removed.logo).toEqual({ hasLogo: false, mime: null, sha256: null, sizeBytes: null });
    expect(await profile.logoFile()).toBeNull();
  });

  it('Logo: ungültige Uploads werden abgewiesen und nichts gespeichert', async () => {
    const { profile } = services();
    const bad: Array<[Buffer, string | undefined, string, number]> = [
      [Buffer.from('GIF89a....'), 'image/gif', 'type', 415],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'type', 415],
      [Buffer.from('MZ-programm'), 'image/png', 'type', 415],
      [PNG, 'image/jpeg', 'mismatch', 415],
      [Buffer.alloc(0), 'image/png', 'empty', 415],
      [Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES)]), 'image/png', 'too_large', 413],
    ];
    for (const [data, mime, reason, status] of bad) {
      const error = (await profile
        .setLogo(data, mime, user, SOURCE)
        .catch((e: unknown) => e)) as LogoInvalidError;
      expect(error).toBeInstanceOf(LogoInvalidError);
      expect(error.errorDetail).toEqual({ reason });
      expect(error.getStatus()).toBe(status);
    }
    expect((await profile.get()).logo.hasLogo).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION.issuerUpdated } })).toBe(0);
  });

  it('readBody bricht über der Grenze ab', async () => {
    const big = Readable.from([Buffer.alloc(LOGO_MAX_BYTES + 10)]) as unknown as Request;
    await expect(readBody(big, LOGO_MAX_BYTES)).rejects.toBeInstanceOf(LogoInvalidError);
    const small = Readable.from([PNG]) as unknown as Request;
    expect((await readBody(small, LOGO_MAX_BYTES)).equals(PNG)).toBe(true);
  });

  it('GET /public/logo: Content-Type, ETag, Cache, nosniff, 304 und 404', async () => {
    const { profile } = services();
    const controller = new PublicLogoController(profile);
    const reply = () => {
      const headers: Record<string, string> = {};
      let status = 0;
      let body: unknown;
      const res = {
        setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
        status: (s: number) => {
          status = s;
          return res;
        },
        json: (b: unknown) => {
          body = b;
        },
        end: (b?: unknown) => {
          body = b;
        },
      } as unknown as Response;
      return { res, get: () => ({ headers, status, body }) };
    };
    const none = reply();
    await controller.logo({ headers: {} } as Request, none.res);
    expect(none.get().status).toBe(404);

    const set = await profile.setLogo(PNG, 'image/png', user, SOURCE);
    const ok = reply();
    await controller.logo({ headers: {} } as Request, ok.res);
    expect(ok.get().status).toBe(200);
    expect(ok.get().headers['content-type']).toBe('image/png');
    expect(ok.get().headers['x-content-type-options']).toBe('nosniff');
    expect(ok.get().headers['etag']).toBe(`"${set.logo.sha256}"`);
    expect(ok.get().headers['cache-control']).toContain('max-age');
    expect((ok.get().body as Buffer).equals(PNG)).toBe(true);

    const cached = reply();
    await controller.logo(
      { headers: { 'if-none-match': `"${set.logo.sha256}"` } } as unknown as Request,
      cached.res,
    );
    expect(cached.get().status).toBe(304);
  });
});

describe('Festschreiben je Rechtsform', () => {
  const FORMS = Object.keys(COMPLETE) as LegalForm[];

  it.each(FORMS)(
    '%s: scheitert mit unvollständigem Profil und nennt jedes fehlende Feld, gelingt mit vollständigem',
    async (form) => {
      const s = services();
      const id = await draft(s.invoices, `form-${form}`);

      // Nur Name gesetzt (kein Platzhalter): fast alles fehlt.
      const sparse = { ...emptyIssuerProfile(form), name: `Beispielfirma ${form}` };
      await s.profile.update(sparse, null, user, SOURCE);
      const expected = validateIssuerProfile(sparse).map((i) => i.field);
      expect(expected.length).toBeGreaterThan(2);

      const error = (await s.invoices
        .finalize(id, actor, SOURCE)
        .catch((e: unknown) => e)) as InvoiceIssuerIncompleteError;
      expect(error).toBeInstanceOf(InvoiceIssuerIncompleteError);
      expect(error.errorCode).toBe('issuer_incomplete');
      expect(error.getStatus()).toBe(422);
      const detail = error.errorDetail as {
        issues: { field: string; label: string; code: string }[];
      };
      expect(detail.issues.map((i) => i.field)).toEqual(expected);
      expect(detail.issues.every((i) => i.label !== '' && i.code !== '')).toBe(true);
      const still = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      expect(still.status).toBe('draft');
      expect(still.invoiceNumber).toBeNull();

      const full = complete(form);
      expect(validateIssuerProfile(full)).toEqual([]);
      await s.profile.update(full, null, user, SOURCE);
      const done = await s.invoices.finalize(id, actor, SOURCE);
      expect(done.status).toBe('finalized');
      const stored = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      expect(stored.issuerCompanyName).toBe(full.name);
    },
  );

  it('die GmbH & Co. KG braucht die Komplementärin zusätzlich', async () => {
    const s = services();
    const id = await draft(s.invoices, 'kg-ohne-gmbh');
    const p = { ...complete('gmbh_co_kg'), generalPartner: emptyIssuerProfile().generalPartner };
    await s.profile.update(p, null, user, SOURCE);
    const error = (await s.invoices
      .finalize(id, actor, SOURCE)
      .catch((e: unknown) => e)) as InvoiceIssuerIncompleteError;
    expect(
      (error.errorDetail as { issues: { field: string }[] }).issues.map((i) => i.field),
    ).toEqual(
      expect.arrayContaining([
        'generalPartner.name',
        'generalPartner.seat',
        'generalPartner.registerCourt',
        'generalPartner.registerNumber',
        'generalPartner.managingDirectors',
      ]),
    );
  });

  it('das Dokument trägt Blöcke, Logo und Akzentfarbe; BT-33 ist legalLines mit " | "', async () => {
    const s = services();
    const full = complete('gmbh_co_kg');
    await s.profile.update(full, '#0f5132', user, SOURCE);
    await s.profile.setLogo(PNG, 'image/png', user, SOURCE);
    const id = await draft(s.invoices, 'dokument');
    await s.invoices.finalize(id, actor, SOURCE);

    const calls: { html: string; xml: string }[] = [];
    const renderer: InvoiceRenderer = {
      isConfigured: () => true,
      create: async (html, xml) => {
        calls.push({ html, xml });
        return Buffer.from('%PDF-1.7 Schein', 'utf8');
      },
    };
    const documents = new InvoiceDocumentService(prisma, audit, s.issuer, renderer);
    await documents.getOrCreate(id, actor, SOURCE);
    const { html, xml } = calls[0]!;
    expect(html).toContain(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(html).toContain('--acc:#0f5132');
    expect(html).toContain('Persönlich haftende Gesellschafterin:');
    expect(html).toContain('USt-IdNr. DE136695976');
    expect(xml).toMatch(/<ram:Description>Amtsgericht Musterstadt, HRA 1234 \| .*USt-IdNr\. DE136695976<\/ram:Description>/);
    expect(xml).toContain('<ram:ID>HRA 1234</ram:ID>');
  });
});
