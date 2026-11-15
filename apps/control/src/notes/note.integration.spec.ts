import { toDate } from '@saas-instant/shared';
import { AuditService, AUDIT_ACTION } from '../audit/audit.service';
import { NoteBySystemError } from './note.errors';
import { NoteService } from './note.service';
import { writeSystemNote } from './system-note';
import {
  createCompany,
  newPrefix,
  notesFrom,
  prisma,
  cleanUp,
  disconnect,
} from '../test-support/company-provisioning';

/**
 * Notizen gegen eine ECHTE Datenbank.
 *
 * Die eigentliche Aussage: SYSTEMERZEUGTE NOTIZEN SIND UNANTASTBAR. Sie sind
 * der Verlauf, auf den sich später jede Auskunft stützt; ließe sich der
 * Wortlaut eines Statuswechsels nachträglich ändern, wäre er als Nachweis
 * wertlos.
 */

jest.setTimeout(60_000);

const Prefix = newPrefix('etappe2-note');
const Source = { ip: '203.0.113.8', userAgent: 'Jest-Integration' };
const actor = { userId: null, name: 'sam' };

const audit = new AuditService(prisma);
const service = new NoteService(prisma, audit);

afterAll(async () => {
  await cleanUp(Prefix);
  await disconnect();
});

describe('Notizen anlegen und lesen', () => {
  it('legt eine eigene Notiz mit heutigem Tag an', async () => {
    const company = await createCompany(Prefix);
    const note = await service.create(
      { companyId: company.id, text: 'Telefonat geführt.' },
      actor,
      Source,
    );

    expect(note.bySystem).toBe(false);
    expect(note.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const entries = await prisma.auditLog.findMany({
      where: { objectId: note.id, action: AUDIT_ACTION.noteCreated },
    });
    expect(entries).toHaveLength(1);
  });

  it('übernimmt ein angegebenes Tagesdatum', async () => {
    const company = await createCompany(Prefix);
    const note = await service.create(
      {
        companyId: company.id,
        text: 'Am Vortag telefoniert.',
        date: '2026-08-30',
      },
      actor,
      Source,
    );
    expect(note.date).toBe('2026-08-30');
  });

  it('zeigt den Verlauf mit dem Neuesten zuerst', async () => {
    const company = await createCompany(Prefix);
    await service.create(
      { companyId: company.id, text: 'älter', date: '2026-01-01' },
      actor,
      Source,
    );
    await service.create(
      { companyId: company.id, text: 'neuer', date: '2026-06-01' },
      actor,
      Source,
    );

    const history = await service.history(company.id);
    expect(history.map((n) => n.text)).toEqual(['neuer', 'älter']);
  });

  it('ordnet mehrere Notizen DESSELBEN Tages nach dem Zeitpunkt', async () => {
    // Der Fall, für den `createdAt` überhaupt da ist. Mit der früheren
    // Sortierung nach `id` (einer zufälligen UUID) stimmte die Reihenfolge nur
    // in etwa jedem zweiten Fall — deshalb mehrere Runden: gegen die alte
    // Fassung fällt der Test damit zuverlässig um.
    for (let round = 0; round < 12; round += 1) {
      const company = await createCompany(Prefix);
      await service.create(
        { companyId: company.id, text: 'zuerst', date: '2026-08-31' },
        actor,
        Source,
      );
      await service.create(
        { companyId: company.id, text: 'danach', date: '2026-08-31' },
        actor,
        Source,
      );

      const history = await service.history(company.id);
      expect(history.map((n) => n.text)).toEqual(['danach', 'zuerst']);
    }
  });

  it('lässt das FACHLICHE Datum vor dem Zeitpunkt gelten', async () => {
    // Ein Telefonat vom Vortag wird heute erfasst — es gehört trotzdem unter
    // die Notiz von heute. `createdAt` entscheidet erst innerhalb eines Tages.
    const company = await createCompany(Prefix);
    await service.create(
      { companyId: company.id, text: 'von heute', date: '2026-08-31' },
      actor,
      Source,
    );
    await service.create(
      {
        companyId: company.id,
        text: 'nachgetragen, war gestern',
        date: '2026-08-30',
      },
      actor,
      Source,
    );

    const history = await service.history(company.id);
    expect(history.map((n) => n.text)).toEqual([
      'von heute',
      'nachgetragen, war gestern',
    ]);
  });

  it('ordnet auch zwei Notizen DERSELBEN Millisekunde ([W9])', async () => {
    // Der Fall, den `createdAt` allein nicht loest: zwei Notizen aus EINER
    // Transaktion. Sie werden hier mit identischem Zeitstempel geschrieben —
    // genau so, wie es der oeffentliche Anfrageweg tut.
    const company = await createCompany(Prefix);
    const sameTimestamp = new Date();
    for (let round = 0; round < 12; round += 1) {
      await prisma.$transaction(async (tx) => {
        await tx.note.create({
          data: {
            companyId: company.id,
            date: toDate('2026-08-31'),
            text: `zuerst-${round}`,
            bySystem: true,
            createdAt: sameTimestamp,
          },
        });
        await tx.note.create({
          data: {
            companyId: company.id,
            date: toDate('2026-08-31'),
            text: `danach-${round}`,
            bySystem: false,
            createdAt: sameTimestamp,
          },
        });
      });
    }

    const history = await service.history(company.id);
    // Alle Zeitstempel sind gleich; entschieden hat die laufende Nummer.
    expect(new Set(history.map((n) => n.createdAt)).size).toBe(1);
    for (let round = 0; round < 12; round += 1) {
      const later = history.findIndex((n) => n.text === `danach-${round}`);
      const earlier = history.findIndex((n) => n.text === `zuerst-${round}`);
      expect(later).toBeLessThan(earlier);
    }
  });

  it('gibt Tagesdatum und Zeitstempel getrennt heraus', async () => {
    const company = await createCompany(Prefix);
    const note = await service.create(
      { companyId: company.id, text: 'Telefonat.', date: '2026-08-30' },
      actor,
      Source,
    );

    // Fachliches Datum: reiner Tag. Technischer Zeitstempel: ISO.
    expect(note.date).toBe('2026-08-30');
    expect(note.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(note.createdAt).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  it('meldet eine unbekannte Organisation als 404', async () => {
    await expect(
      service.history('00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ errorCode: 'company_not_found' });
  });
});

describe('Systemerzeugte Notizen', () => {
  it('lassen sich NICHT bearbeiten', async () => {
    const company = await createCompany(Prefix);
    const note = await writeSystemNote(
      prisma,
      company.id,
      'Status gewechselt: Anfrage → Demo, 31.08.2026',
    );

    await expect(
      service.update(note.id, { text: 'umgeschrieben' }, actor, Source),
    ).rejects.toBeInstanceOf(NoteBySystemError);

    const unchanged = await notesFrom(company.id);
    expect(unchanged[0].text).toContain('Status gewechselt');
  });

  it('lassen sich NICHT löschen', async () => {
    const company = await createCompany(Prefix);
    const note = await writeSystemNote(
      prisma,
      company.id,
      'Ansprechpartnerin gewechselt: Anna Berg → Tim Roth, 12.03.2027',
    );

    await expect(
      service.delete(note.id, actor, Source),
    ).rejects.toBeInstanceOf(NoteBySystemError);
    expect(await notesFrom(company.id)).toHaveLength(1);
  });
});

describe('Eigene Notizen', () => {
  it('lassen sich ändern und protokollieren Vorher/Nachher', async () => {
    const company = await createCompany(Prefix);
    const note = await service.create(
      { companyId: company.id, text: 'erste Fassung' },
      actor,
      Source,
    );

    const updated = await service.update(
      note.id,
      { text: 'zweite Fassung' },
      actor,
      Source,
    );
    expect(updated.text).toBe('zweite Fassung');

    const entries = await prisma.auditLog.findMany({
      where: { objectId: note.id, action: AUDIT_ACTION.noteUpdated },
    });
    expect((entries[0].beforeValue as { text: string }).text).toBe(
      'erste Fassung',
    );
  });

  it('lassen sich löschen — von Hand, niemals automatisch (R4)', async () => {
    const company = await createCompany(Prefix);
    const note = await service.create(
      { companyId: company.id, text: 'Tippfehler' },
      actor,
      Source,
    );

    await service.delete(note.id, actor, Source);
    expect(await notesFrom(company.id)).toHaveLength(0);
    const entries = await prisma.auditLog.findMany({
      where: { objectId: note.id, action: AUDIT_ACTION.noteDeleted },
    });
    expect(entries).toHaveLength(1);
  });

  it('meldet eine unbekannte Notiz als 404', async () => {
    await expect(
      service.delete(
        '00000000-0000-4000-8000-000000000000',
        actor,
        Source,
      ),
    ).rejects.toMatchObject({ errorCode: 'note_not_found' });
  });
});
