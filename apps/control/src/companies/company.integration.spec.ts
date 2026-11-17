import { today, toDate } from '@saas-instant/shared';
import { AuditService, AUDIT_ACTION, REMOVED } from '../audit/audit.service';
import { StatusUnchangedError } from './company.errors';
import {
  NAME_AFTER_DELETION,
  CompanyService,
} from './company.service';
import {
  auditFrom,
  createCompany,
  newPrefix,
  notesFrom,
  prisma,
  cleanUp,
  statusFrom,
  disconnect,
  sendDouble,
} from '../test-support/company-provisioning';
import { truncateAuditLog } from '../test-support/gobd-cleanup';

/**
 * Organisationen gegen eine ECHTE Postgres-Datenbank.
 *
 * Der Kern ist der letzte Fall: zwei GLEICHZEITIGE Statuswechsel. Mit einer
 * In-Memory-Attrappe wäre er nicht zu führen — JavaScript ist einfädig, dort
 * entsteht kein Rennen. In Etappe 1 ist genau auf diesem Weg [K1] durch 172
 * grüne Tests gerutscht.
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   pnpm --filter @saas-instant/control test:integration
 */

jest.setTimeout(60_000);

const Prefix = newPrefix('etappe2-org');
const Source = { ip: '203.0.113.7', userAgent: 'Jest-Integration' };

const audit = new AuditService(prisma);
const service = new CompanyService(prisma, audit, sendDouble());

/**
 * Akteur ohne Konto: Der Fremdschlüssel auf `Benutzer` verlangt sonst ein
 * angelegtes Konto, und für diese Prüfungen ist der Klartextname die
 * eigentliche Aussage.
 */
const actor = { userId: null, name: 'sam' };

afterAll(async () => {
  await cleanUp(Prefix);
  await disconnect();
});

describe('Anlegen und Bearbeiten', () => {
  it('schreibt beim Bearbeiten nur die geänderten Felder ins Audit-Log', async () => {
    const created = await service.create(
      { name: `${Prefix} Audit`, city: 'Kassel' },
      actor,
      Source,
    );
    await service.update(created.id, { city: 'Marburg' }, actor, Source);

    const entries = await auditFrom(
      created.id,
      AUDIT_ACTION.companyUpdated,
    );
    expect(entries).toHaveLength(1);
    // WELCHES Feld sich geändert hat, steht im Nachweis (R6) — der Wert nicht:
    // ein Ort ist eine personenbezogene Angabe, und das Audit-Log hat keinen
    // Löschweg ([W4]).
    expect(entries[0].beforeValue).toEqual({ city: REMOVED });
    expect(entries[0].afterValue).toEqual({ city: REMOVED });
    expect(entries[0].ip).toBe(Source.ip);
  });

  it('speichert und liefert die Angaben für die E-Rechnung (Käuferart, USt-IdNr., Leitweg-ID, Adresse)', async () => {
    const created = await service.create(
      { name: `${Prefix} E-Rechnung` },
      actor,
      Source,
    );
    // Vorgabe: Unternehmen, ohne Kennungen.
    expect(created.buyerType).toBe('business');
    expect(created.vatId).toBeNull();

    const updated = await service.update(
      created.id,
      {
        buyerType: 'authority',
        vatId: 'DE811111111',
        buyerReference: '991-12345-67',
        electronicAddress: '991-12345-67',
        electronicAddressScheme: '0204',
      },
      actor,
      Source,
    );
    expect(updated).toMatchObject({
      buyerType: 'authority',
      vatId: 'DE811111111',
      buyerReference: '991-12345-67',
      electronicAddress: '991-12345-67',
      electronicAddressScheme: '0204',
    });

    // Leeren geht (null), Weglassen lässt unangetastet.
    const cleared = await service.update(
      created.id,
      { buyerReference: null as unknown as undefined },
      actor,
      Source,
    );
    expect(cleared.buyerReference).toBeNull();
    expect(cleared.vatId).toBe('DE811111111');
    expect(cleared.buyerType).toBe('authority');
  });

  it('gibt Geldbeträge als Zeichenkette heraus, nicht als Gleitkommazahl', async () => {
    const created = await service.create(
      { name: `${Prefix} Betrag` },
      actor,
      Source,
    );
    await service.paymentDetailsSet(
      created.id,
      { customAmount: 1234.5 },
      actor,
      Source,
    );

    const paymentDetails = await service.paymentDetails(
      created.id,
      actor,
      Source,
    );
    expect(paymentDetails.customAmount).toBe('1234.50');
  });
});

describe('Liste', () => {
  it('filtert nach Status und sucht in Name, Ansprechpartnerin, Mail und Ort', async () => {
    const identifier = `${Prefix}-suche`;
    const hit = await service.create(
      {
        name: `${identifier} Solawi Wiesenhof`,
        city: 'Marburg',
        contactName: 'Anna Berg',
        contactEmail: `anna.${identifier}@example.com`,
        status: 'trial',
      },
      actor,
      Source,
    );
    await service.create(
      { name: `${identifier} Andere`, status: 'paying' },
      actor,
      Source,
    );

    const afterName = await service.list({ search: 'wiesenhof' });
    expect(afterName.companies.map((o) => o.id)).toContain(hit.id);

    const afterCity = await service.list({ search: 'MARBURG' });
    expect(afterCity.companies.map((o) => o.id)).toContain(hit.id);

    const afterPerson = await service.list({ search: 'anna berg' });
    expect(afterPerson.companies.map((o) => o.id)).toContain(hit.id);

    const afterMail = await service.list({ search: `anna.${identifier}` });
    expect(afterMail.companies.map((o) => o.id)).toContain(hit.id);

    const onlyPaying = await service.list({
      status: ['paying'],
      search: identifier,
    });
    expect(onlyPaying.companies.map((o) => o.id)).not.toContain(hit.id);
    expect(onlyPaying.total).toBe(1);
  });

  it('findet nach einer Änderung sofort (Cache wird ungültig) und sortiert nach Name', async () => {
    const identifier = newPrefix('cache');
    const b = await service.create({ name: `${identifier} Bravo`, city: 'Fulda' }, actor, Source);
    const a = await service.create({ name: `${identifier} Alpha`, city: 'Fulda' }, actor, Source);

    const before = await service.list({ search: identifier });
    expect(before.companies.map((o) => o.id)).toEqual([a.id, b.id]);

    expect((await service.list({ search: 'Kassel' })).companies.map((o) => o.id)).not.toContain(b.id);
    await service.update(b.id, { city: 'Kassel' }, actor, Source);
    const after = await service.list({ search: 'kassel' });
    expect(after.companies.map((o) => o.id)).toContain(b.id);

    // Seitenweise nach der Suche: Gesamtzahl bleibt, die Seite ist begrenzt.
    const page = await service.list({ search: identifier, perPage: 1, page: 2 });
    expect(page.total).toBe(2);
    expect(page.companies.map((o) => o.id)).toEqual([b.id]);
  });

  it('legt Name, Ort und Kontakt verschlüsselt ab (Rohabfrage zeigt das Präfix)', async () => {
    const identifier = newPrefix('roh');
    const created = await service.create(
      { name: `${identifier} Geheim`, city: 'Weimar', contactEmail: `x.${identifier}@example.com` },
      actor,
      Source,
    );
    const rows = await prisma.$queryRaw<{ name: string; city: string; contactEmail: string; idx: string | null }[]>`
      SELECT "name", "city", "contactEmail", "contactEmailIdx" AS idx FROM "Company" WHERE "id" = ${created.id}`;
    expect(rows[0].name.startsWith('enc:v1:')).toBe(true);
    expect(rows[0].city.startsWith('enc:v1:')).toBe(true);
    expect(rows[0].contactEmail.startsWith('enc:v1:')).toBe(true);
    expect(rows[0].idx).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].name).not.toContain('Geheim');
  });

  it('filtert auf MEHRERE Status zugleich', async () => {
    const identifier = newPrefix('mehrstatus');
    const trial = await service.create(
      { name: `${identifier} Test`, status: 'trial' },
      actor,
      Source,
    );
    const exempt = await service.create(
      { name: `${identifier} Befreit`, status: 'exempt' },
      actor,
      Source,
    );
    await service.create(
      { name: `${identifier} Zahlend`, status: 'paying' },
      actor,
      Source,
    );

    const both = await service.list({
      status: ['trial', 'exempt'],
      search: identifier,
    });

    expect(both.total).toBe(2);
    expect(both.companies.map((o) => o.id).sort()).toEqual(
      [trial.id, exempt.id].sort(),
    );
  });

  it('zaehlt die Chips OHNE den Statusfilter — sonst zeigten alle anderen eine Null', async () => {
    const identifier = newPrefix('chipzahl');
    await service.create({ name: `${identifier} A`, status: 'inquiry' }, actor, Source);
    await service.create({ name: `${identifier} B`, status: 'inquiry' }, actor, Source);
    await service.create({ name: `${identifier} C`, status: 'paying' }, actor, Source);

    const filtered = await service.list({ status: ['inquiry'], search: identifier });

    // Die Liste zeigt nur die zwei Anfragen …
    expect(filtered.total).toBe(2);
    // … aber die Chips wissen weiterhin von der dritten.
    expect(filtered.countPerStatus.inquiry).toBe(2);
    expect(filtered.countPerStatus.paying).toBe(1);
  });
});

describe('Statuswechsel', () => {
  it('schreibt Notiz und Audit-Eintrag mit Vorher/Nachher', async () => {
    const company = await createCompany(Prefix, { status: 'inquiry' });

    await service.statusChange(company.id, 'trial', actor, Source);

    expect(await statusFrom(company.id)).toBe('trial');
    const notes = await notesFrom(company.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].bySystem).toBe(true);
    expect(notes[0].text).toMatch(/^Status gewechselt: Anfrage → Testphase, \d{2}\.\d{2}\.\d{4}$/);

    const entries = await auditFrom(
      company.id,
      AUDIT_ACTION.companyStatusChanged,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].beforeValue).toEqual({ status: 'inquiry' });
    expect(
      (entries[0].afterValue as { status: string }).status,
    ).toBe('trial');
  });

  it('weist den Wechsel auf denselben Status ab', async () => {
    const company = await createCompany(Prefix, { status: 'trial' });

    await expect(
      service.statusChange(company.id, 'trial', actor, Source),
    ).rejects.toBeInstanceOf(StatusUnchangedError);
    expect(await notesFrom(company.id)).toHaveLength(0);
  });

  it('setzt letzterStatuswechselAm auf heute', async () => {
    const company = await createCompany(Prefix, { status: 'inquiry' });
    await service.statusChange(company.id, 'trial', actor, Source);

    const row = await prisma.company.findUniqueOrThrow({
      where: { id: company.id },
      select: { lastStatusChangeAt: true },
    });
    expect(row.lastStatusChangeAt).not.toBeNull();
  });

  it('wechselt bei ZWEI GLEICHZEITIGEN Anfragen genau EINMAL', async () => {
    // Der eigentliche Grund für diesen Lauf: „lesen, prüfen, schreiben" ohne
    // Bedingung ließe beide durch — mit zwei Systemnotizen und zwei
    // Audit-Einträgen für einen einzigen fachlichen Vorgang.
    //
    // MEHRERE RUNDEN, weil ein Rennen nicht in jedem Lauf entsteht: Gegen die
    // absichtlich kaputte Fassung (Lesen und Schreiben getrennt) fällt der
    // Test damit zuverlässig um, gegen die richtige nie.
    for (let round = 0; round < 5; round += 1) {
      const company = await createCompany(Prefix, {
        status: 'inquiry',
      });

      const results = await Promise.allSettled([
        service.statusChange(company.id, 'trial', actor, Source),
        service.statusChange(company.id, 'trial', actor, Source),
      ]);

      expect(results.filter((e) => e.status === 'fulfilled')).toHaveLength(1);
      expect(await notesFrom(company.id)).toHaveLength(1);
      expect(
        await auditFrom(
          company.id,
          AUDIT_ACTION.companyStatusChanged,
        ),
      ).toHaveLength(1);
    }
  });

  it('lässt bei ZWEI VERSCHIEDENEN Zielen nur einen Wechsel zu', async () => {
    for (let round = 0; round < 5; round += 1) {
      const company = await createCompany(Prefix, {
        status: 'inquiry',
      });

      const results = await Promise.allSettled([
        service.statusChange(company.id, 'trial', actor, Source),
        service.statusChange(company.id, 'ended', actor, Source),
      ]);

      expect(results.filter((e) => e.status === 'fulfilled')).toHaveLength(1);
      expect(await notesFrom(company.id)).toHaveLength(1);
    }
  });
});

describe('Aufnahmelink beim Wechsel auf Testphase', () => {
  it('geht genau einmal hinaus — auch bei Hin und Her', async () => {
    const send = sendDouble();
    const withSend = new CompanyService(prisma, audit, send);
    const company = await createCompany(Prefix, {
      status: 'inquiry',
      contactEmail: 'link@example.com',
    });

    await withSend.statusChange(company.id, 'trial', actor, Source);
    await withSend.statusChange(company.id, 'paying', actor, Source);
    await withSend.statusChange(company.id, 'trial', actor, Source);

    expect(send.sent).toEqual([{ companyId: company.id, automatic: true }]);
    const row = await prisma.company.findUniqueOrThrow({
      where: { id: company.id },
      select: { intakeLinkSentAt: true },
    });
    expect(row.intakeLinkSentAt).not.toBeNull();
  });

  it('geht bei anderen Zielstatus nicht hinaus', async () => {
    const send = sendDouble();
    const withSend = new CompanyService(prisma, audit, send);
    const company = await createCompany(Prefix, {
      status: 'inquiry',
      contactEmail: 'link2@example.com',
    });

    await withSend.statusChange(company.id, 'exempt', actor, Source);

    expect(send.sent).toHaveLength(0);
  });
});

describe('Wechsel der Ansprechpartnerin', () => {
  it('ersetzt den Datensatz und schreibt die Notiz im vorgegebenen Wortlaut', async () => {
    const company = await createCompany(Prefix, {
      contactName: 'Anna Berg',
      contactEmail: 'anna@example.com',
      contactPhone: '0561 123',
      contactRole: 'Vorstand',
    });

    const after = await service.contactPersonChange(
      company.id,
      { name: 'Tim Roth' },
      actor,
      Source,
    );

    // ERSETZT, nicht ergänzt: die Angaben der Vorgängerin bleiben nicht stehen.
    expect(after.contactName).toBe('Tim Roth');
    expect(after.contactEmail).toBeNull();
    expect(after.contactPhone).toBeNull();
    expect(after.contactRole).toBeNull();

    const notes = await notesFrom(company.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toMatch(
      /^Ansprechpartnerin gewechselt: Anna Berg → Tim Roth, \d{2}\.\d{2}\.\d{4}$/,
    );
    expect(notes[0].bySystem).toBe(true);
  });

  it('protokolliert Vorher und Nachher (R6)', async () => {
    const company = await createCompany(Prefix, {
      contactName: 'Anna Berg',
    });
    await service.contactPersonChange(
      company.id,
      { name: 'Tim Roth', email: 'tim@example.com' },
      actor,
      Source,
    );

    const entries = await auditFrom(
      company.id,
      AUDIT_ACTION.companyContactPersonChanged,
    );
    expect(entries).toHaveLength(1);
    // Die FELDER stehen im Nachweis, die Namen nicht: Sie würden sonst jede
    // spätere Kontaktdatenlöschung überleben ([W4]).
    expect(
      Object.keys(entries[0].beforeValue as Record<string, unknown>).sort(),
    ).toEqual([
      'contactEmail',
      'contactName',
      'contactPhone',
      'contactRole',
    ]);
    expect(
      (entries[0].beforeValue as { contactName: string })
        .contactName,
    ).toBe(REMOVED);
    expect(
      (entries[0].afterValue as { contactEmail: string })
        .contactEmail,
    ).toBe(REMOVED);
  });
});

describe('Gemeinsamer Verlauf am selben Tag', () => {
  it('stellt Statuswechsel und Wechsel der Ansprechpartnerin richtig herum dar', async () => {
    // GENAU DER FALL, für den `Notiz.erstelltAm` ergänzt wurde: zwei
    // systemerzeugte Notizen desselben Tages. Vorher entschied darüber eine
    // zufällige UUID — die zweite Änderung stand mit gleicher
    // Wahrscheinlichkeit über wie unter der ersten. Mehrere Runden, damit der
    // Test die alte Sortierung zuverlässig fängt.
    for (let round = 0; round < 12; round += 1) {
      const company = await createCompany(Prefix, {
        status: 'inquiry',
        contactName: 'Anna Berg',
      });

      await service.statusChange(company.id, 'trial', actor, Source);
      await service.contactPersonChange(
        company.id,
        { name: 'Tim Roth' },
        actor,
        Source,
      );

      const notes = await notesFrom(company.id);
      expect(notes.map((n) => n.text.split(':')[0])).toEqual([
        'Ansprechpartnerin gewechselt',
        'Status gewechselt',
      ]);
      // Beide am selben fachlichen Tag — getrennt hat sie nur der Zeitstempel.
      expect(notes[0].date.getTime()).toBe(notes[1].date.getTime());
      expect(notes[0].createdAt.getTime()).toBeGreaterThanOrEqual(
        notes[1].createdAt.getTime(),
      );
    }
  });
});

describe('[W4] Kontaktdaten löschen', () => {
  /** Eine Organisation mit allem, was eine Person bezeichnet. */
  async function withContactData() {
    const created = await service.create(
      {
        name: `${Prefix} Loeschung`,
        city: 'Kassel',
        street: 'Hauptstraße',
        houseNumber: '1',
        postalCode: '34117',
        website: 'https://beispiel.test',
        notes: 'Interne Bemerkung mit Namen.',
        contactName: 'Anna Berg',
        contactEmail: 'anna@example.com',
        contactPhone: '0561 123',
      },
      actor,
      Source,
    );
    await service.paymentDetailsSet(
      created.id,
      { iban: 'DE02120300000000202051', sepaMandateReference: 'M-1' },
      actor,
      Source,
    );
    await service.contactPersonChange(
      created.id,
      { name: 'Tim Roth' },
      actor,
      Source,
    );
    await prisma.note.create({
      data: {
        companyId: created.id,
        date: toDate(today()),
        text: 'Telefonat mit Tim Roth, 0561 123.',
        bySystem: false,
      },
    });
    return created;
  }

  it('räumt alle Kontaktfelder und ersetzt den Namen', async () => {
    const created = await withContactData();

    const result = await service.contactDataDelete(
      created.id,
      created.name,
      actor,
      Source,
    );

    const after = await service.detail(created.id);
    expect(after.contactName).toBeNull();
    expect(after.contactEmail).toBeNull();
    expect(after.contactPhone).toBeNull();
    expect(after.city).toBeNull();
    expect(after.street).toBeNull();
    expect(after.website).toBeNull();
    expect(after.notes).toBeNull();
    expect(after.paymentDetailsStored).toBe(false);
    expect(after.name).toContain(NAME_AFTER_DELETION);
    // `contactEmail` war schon vorher leer: der Wechsel der
    // Ansprechpartnerin ERSETZT den Datensatz. Gemeldet wird nur, was
    // tatsächlich geräumt wurde.
    expect(result.cleanedUpFields).toContain('contactName');
    expect(result.cleanedUpFields).toContain('iban');
    expect(result.cleanedUpFields).toContain('notes');
  });

  it('entfernt die Kontaktzeilen aus den Notizen — auch aus den systemerzeugten', async () => {
    const created = await withContactData();
    await service.contactDataDelete(
      created.id,
      created.name,
      actor,
      Source,
    );

    const notes = await notesFrom(created.id);
    const allTexts = notes.map((n) => n.text).join('\n');
    // Die Namen standen in einer Systemnotiz, die sich nicht löschen lässt —
    // deshalb wird sie umgeschrieben.
    expect(allTexts).not.toContain('Anna Berg');
    expect(allTexts).not.toContain('Tim Roth');
    expect(allTexts).not.toContain('0561 123');
    // Der Vorgang selbst bleibt sichtbar.
    expect(allTexts).toContain('Kontaktdaten gelöscht');
  });

  it('schreibt NUR die Feldnamen ins Audit-Log, niemals die Werte', async () => {
    // Sonst überlebten die Daten die Löschung im Nachweis, der keinen
    // Löschweg hat.
    const created = await withContactData();
    await service.contactDataDelete(
      created.id,
      created.name,
      actor,
      Source,
    );

    // Auch die Einträge, die VOR der Löschung entstanden sind, dürfen die
    // Daten nicht mehr hergeben — sonst hätte die Löschung nichts bewirkt.
    const entries = await auditFrom(created.id);
    const everything = JSON.stringify(entries);
    expect(everything).not.toContain('anna@example.com');
    expect(everything).not.toContain('Anna Berg');
    expect(everything).not.toContain('Tim Roth');
    expect(everything).not.toContain('DE02120300000000202051');
    expect(everything).not.toContain('Interne Bemerkung');
    expect(everything).not.toContain('Kassel');

    const deletion = entries.filter(
      (e) => e.action === AUDIT_ACTION.companyContactDataDeleted,
    );
    expect(deletion).toHaveLength(1);
    expect(
      (deletion[0].beforeValue as { cleanedUpFields: string[] }).cleanedUpFields,
    ).toContain('contactName');
  });

  it('verlangt den Namen als Bestätigung', async () => {
    const created = await withContactData();

    await expect(
      service.contactDataDelete(created.id, 'irgendwas', actor, Source),
    ).rejects.toMatchObject({ errorCode: 'confirmation_matches_not' });

    // Nichts angefasst.
    const unchanged = await service.detail(created.id);
    expect(unchanged.contactName).toBe('Tim Roth');
  });
});

describe('[W4] Zahlungsdaten', () => {
  it('stehen NICHT in der gewöhnlichen Detailansicht', async () => {
    const created = await service.create(
      { name: `${Prefix} Bank` },
      actor,
      Source,
    );
    await service.paymentDetailsSet(
      created.id,
      { iban: 'DE02120300000000202051' },
      actor,
      Source,
    );

    const detail = await service.detail(created.id);
    expect(JSON.stringify(detail)).not.toContain('DE02120300000000202051');
    expect(detail.paymentDetailsStored).toBe(true);
  });

  it('halten den LESENDEN Zugriff im Nachweis fest', async () => {
    const created = await service.create(
      { name: `${Prefix} Bankzugriff` },
      actor,
      Source,
    );
    await service.paymentDetails(created.id, actor, Source);

    const read = await auditFrom(
      created.id,
      AUDIT_ACTION.companyPaymentDetailsRead,
    );
    expect(read).toHaveLength(1);
  });

  it('schreiben die IBAN nicht ins Audit-Log ([W3])', async () => {
    const created = await service.create(
      { name: `${Prefix} Bankaudit` },
      actor,
      Source,
    );
    await service.paymentDetailsSet(
      created.id,
      { iban: 'DE02120300000000202051', sepaMandateReference: 'M-77' },
      actor,
      Source,
    );

    const entries = await auditFrom(created.id);
    const everything = JSON.stringify(entries);
    expect(everything).not.toContain('DE02120300000000202051');
    expect(everything).not.toContain('M-77');
    // Die TATSACHE der Änderung steht drin — das ist, was R6 verlangt.
    expect(everything).toContain('iban');
  });
});

describe('Nicht vorhandene Organisation', () => {
  it('meldet 404 statt 500', async () => {
    await expect(
      service.detail('00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ errorCode: 'company_not_found' });
  });

  it('meldet 404 auch beim Bearbeiten', async () => {
    await expect(
      service.update(
        '00000000-0000-4000-8000-000000000000',
        { city: 'Kassel' },
        actor,
        Source,
      ),
    ).rejects.toMatchObject({ errorCode: 'company_not_found' });
  });
});

/**
 * ==========================================================================
 * DIE ORGANISATION GANZ ENTFERNEN
 * ==========================================================================
 *
 * Der einzige Weg im System, auf dem ein Stammdatensatz verschwindet. Was ihn
 * trägt, ist die Vorbedingung — deshalb prüfen diese Fälle vor allem, WORAN
 * er scheitert, und erst danach, dass er im erlaubten Fall wirklich alles
 * mitnimmt.
 */
describe('Organisation vollständig löschen', () => {
  /**
   * WAS DIESE SUITE SELBST AUFRÄUMEN MUSS.
   *
   * `cleanUp` findet Zeilen über den Namen der Organisation — und die ist
   * hier hinterher weg. Zwei Dinge überleben sie mit Absicht und blieben
   * sonst als Bodensatz in der Prüfdatenbank liegen: der Audit-Eintrag und
   * der abgekoppelte Sperreintrag.
   */
  const createdIds: string[] = [];

  afterAll(async () => {
    if (createdIds.length === 0) return;
    // Das AuditLog ist append-only (GoBD-Trigger): `deleteMany` ist dort
    // verboten, nur der Testpfad darf es per TRUNCATE leeren.
    await truncateAuditLog(prisma);
    // E-Mail ist verschlüsselt: im Speicher auswählen, dann per id löschen.
    const orphans = await prisma.consent.findMany({
      where: { companyId: null },
      select: { id: true, email: true },
    });
    await prisma.consent.deleteMany({
      where: {
        id: {
          in: orphans
            .filter((c) => c.email.includes('@loeschprobe.test'))
            .map((c) => c.id),
        },
      },
    });
  });

  /** Der Normalfall, den es aufzuräumen gilt: Anfrage plus Demo-Nutzung. */
  async function afterInquiryAndDemo(label: string) {
    const created = await createCompany(Prefix, {
      name: `${Prefix} ${label}`,
      contactName: 'Anna Berg',
      contactEmail: 'anna@example.com',
    });
    await prisma.note.create({
      data: {
        companyId: created.id,
        date: toDate(today()),
        text: 'Demo am Telefon gezeigt.',
        bySystem: false,
      },
    });
    await prisma.instancePreview.create({
      data: {
        companyId: created.id,
        subdomain: `probe-${label}`.toLowerCase(),
        validUntil: new Date(Date.now() + 900_000),
      },
    });
    // GENAU DIE ZEILE, DIE DER ÖFFENTLICHE ANFRAGEWEG ANLEGT. Behandelte man
    // sie als Hindernis, wäre keine einzige über das Formular eingegangene
    // Organisation je löschbar — der Fall, für den es diesen Weg gibt.
    await prisma.mailDelivery.create({
      data: {
        companyId: created.id,
        recipientAddress: 'anna@example.com',
        channel: 'transactional',
        subject: 'Ihre Anfrage bei Example Product',
        contentSnapshot: 'Vielen Dank für Ihre Anfrage.',
        sentAt: new Date(),
        deliveryStatus: 'sent',
      },
    });
    createdIds.push(created.id);
    return created;
  }

  it('nimmt Notizen, Vorschauen und Transaktionsmails mit', async () => {
    const created = await afterInquiryAndDemo('Vollloeschung');

    const result = await service.completeDelete(
      created.id,
      created.name,
      actor,
      Source,
    );

    expect(result.deletedPreviews).toBe(1);
    expect(result.deletedSendRows).toBe(1);
    expect(result.deletedNotes).toBe(1);

    expect(
      await prisma.company.findUnique({ where: { id: created.id } }),
    ).toBeNull();
    expect(
      await prisma.note.count({ where: { companyId: created.id } }),
    ).toBe(0);
    expect(
      await prisma.instancePreview.count({
        where: { companyId: created.id },
      }),
    ).toBe(0);
    expect(
      await prisma.mailDelivery.count({ where: { companyId: created.id } }),
    ).toBe(0);
  });

  it('verlangt den Namen als Bestätigung und lässt sonst alles stehen', async () => {
    const created = await afterInquiryAndDemo('Bestaetigung');

    await expect(
      service.completeDelete(created.id, 'irgendwas', actor, Source),
    ).rejects.toMatchObject({ errorCode: 'confirmation_matches_not' });

    expect(
      await prisma.company.findUnique({ where: { id: created.id } }),
    ).not.toBeNull();
  });

  it('verweigert die Löschung, wenn eine Instanz existiert (R1)', async () => {
    const created = await afterInquiryAndDemo('MitInstanz');
    await prisma.instance.create({
      data: {
        companyId: created.id,
        subdomain: `${Prefix}-instanz`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        status: 'archived',
      },
    });

    await expect(
      service.completeDelete(created.id, created.name, actor, Source),
    ).rejects.toMatchObject({
      errorCode: 'company_not_deletable',
      errorDetail: { blockers: ['instance'] },
    });

    // Auch die ARCHIVIERTE Instanz zählt: nach R1 verschwindet keine.
    expect(
      await prisma.company.findUnique({ where: { id: created.id } }),
    ).not.toBeNull();
  });

  it('verweigert die Löschung, wenn eine Rechnung existiert — auch als Entwurf (R2)', async () => {
    const created = await afterInquiryAndDemo('MitRechnung');
    await prisma.invoice.create({
      data: {
        companyId: created.id,
        invoiceDate: toDate(today()),
        servicePeriodFrom: toDate(today()),
        servicePeriodUntil: toDate(today()),
        dueDate: toDate(today()),
        status: 'draft',
        recipientName: created.name,
        recipientAddress: 'Ziegelgasse 14, 99423 Weimar',
        issuerCompanyName: 'Example Company GmbH & Co KG',
        issuerAddress: 'Musterweg 1, 34117 Kassel',
      },
    });

    await expect(
      service.completeDelete(created.id, created.name, actor, Source),
    ).rejects.toMatchObject({
      errorCode: 'company_not_deletable',
      errorDetail: { blockers: ['invoices'] },
    });
  });

  it('verweigert die Löschung, wenn eine WERBLICHE Mail hinausging (R3)', async () => {
    const created = await afterInquiryAndDemo('MitRundmail');
    await prisma.mailDelivery.create({
      data: {
        companyId: created.id,
        recipientAddress: 'anna@example.com',
        channel: 'marketing',
        subject: 'Neues aus dem Logbuch',
        contentSnapshot: 'Rundbrief.',
        sentAt: new Date(),
        deliveryStatus: 'sent',
      },
    });

    await expect(
      service.completeDelete(created.id, created.name, actor, Source),
    ).rejects.toMatchObject({
      errorCode: 'company_not_deletable',
      errorDetail: { blockers: ['marketingMails'] },
    });
  });

  it('nennt ALLE Hindernisse auf einmal, nicht nur das erste', async () => {
    // Wer drei Anläufe braucht, um zu erfahren, was im Weg steht, hört nach
    // dem zweiten auf.
    const created = await afterInquiryAndDemo('DreiHindernisse');
    await prisma.instance.create({
      data: {
        companyId: created.id,
        subdomain: `${Prefix}-drei`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        status: 'active',
      },
    });
    await prisma.invoice.create({
      data: {
        companyId: created.id,
        invoiceDate: toDate(today()),
        servicePeriodFrom: toDate(today()),
        servicePeriodUntil: toDate(today()),
        dueDate: toDate(today()),
        status: 'draft',
        recipientName: created.name,
        recipientAddress: 'Ziegelgasse 14, 99423 Weimar',
        issuerCompanyName: 'Example Company GmbH & Co KG',
        issuerAddress: 'Musterweg 1, 34117 Kassel',
      },
    });
    await prisma.mailDelivery.create({
      data: {
        companyId: created.id,
        recipientAddress: 'anna@example.com',
        channel: 'marketing',
        subject: 'Rundbrief',
        contentSnapshot: 'Text.',
        deliveryStatus: 'sent',
      },
    });

    await expect(
      service.completeDelete(created.id, created.name, actor, Source),
    ).rejects.toMatchObject({
      errorDetail: { blockers: ['instance', 'invoices', 'marketingMails'] },
    });
  });

  it('koppelt einen Sperreintrag ab, statt ihn mitzulöschen (R3)', async () => {
    // Eine Abmeldung, die mit der Testorganisation verschwindet, wäre beim
    // nächsten Import wieder im Verteiler — der Widerspruch liefe leer.
    const created = await afterInquiryAndDemo('MitSperre');
    const blocked = await prisma.consent.create({
      data: {
        companyId: created.id,
        email: `sperre-${created.id}@loeschprobe.test`,
        status: 'unsubscribed',
        formText: 'Ich möchte den Rundbrief erhalten.',
        blockReason: 'Hat am Telefon widersprochen.',
      },
    });
    const open = await prisma.consent.create({
      data: {
        companyId: created.id,
        email: `offen-${created.id}@loeschprobe.test`,
        status: 'unconfirmed',
        formText: 'Ich möchte den Rundbrief erhalten.',
      },
    });

    const result = await service.completeDelete(
      created.id,
      created.name,
      actor,
      Source,
    );

    expect(result.detachedBlockEntries).toBe(1);
    expect(result.deletedConsents).toBe(1);

    const remained = await prisma.consent.findUnique({
      where: { id: blocked.id },
    });
    expect(remained).not.toBeNull();
    expect(remained?.companyId).toBeNull();
    expect(remained?.status).toBe('unsubscribed');
    // Die Adresse trägt die Sperre und bleibt. Der Freitext über die Person
    // geht mit.
    expect(remained?.email).toContain('@loeschprobe.test');
    expect(remained?.blockReason).toBeNull();

    expect(
      await prisma.consent.findUnique({ where: { id: open.id } }),
    ).toBeNull();
  });

  it('hinterlässt einen Audit-Eintrag — ohne den Namen zu bewahren (R6)', async () => {
    // DIESER FALL HAT EINEN ENTWURFSFEHLER GEFANGEN. Zuerst stand der Name
    // im Eintrag, mit der Begründung, sonst sei das Protokoll wertlos. Er kam
    // als «entfernt» zurück: `name` steht auf `VERBOTENE_FELDNAMEN`. Die
    // Schwärzung hat recht — ein Nachweis ohne Löschweg, der die gelöschten
    // Angaben behält, macht die Löschung zunichte. Der Test prüft jetzt
    // beides: dass der Vorgang belegt ist UND dass er nichts konserviert.
    const created = await afterInquiryAndDemo('AuditSpur');
    await service.completeDelete(
      created.id,
      created.name,
      actor,
      Source,
    );

    const entries = await auditFrom(created.id);
    const deletion = entries.filter(
      (e) => e.action === AUDIT_ACTION.companyDeleted,
    );
    expect(deletion).toHaveLength(1);
    expect(deletion[0].actor).toBe(actor.name);

    // Der Vorgang ist nachvollziehbar …
    expect(deletion[0].afterValue).toMatchObject({
      deletedPreviews: 1,
      deletedSendRows: 1,
    });
    // … und KEIN Eintrag zu dieser Organisation gibt den Namen oder die
    // Adresse noch her — auch die, die vor der Löschung entstanden sind.
    const everything = JSON.stringify(entries);
    expect(everything).not.toContain(created.name);
    expect(everything).not.toContain('Anna Berg');
    expect(everything).not.toContain('anna@example.com');
  });
});
