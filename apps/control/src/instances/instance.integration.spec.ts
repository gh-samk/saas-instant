import { ConfigService } from '@nestjs/config';
import { datePlusDays, today, toDate } from '@saas-instant/shared';
import { AuditService } from '../audit/audit.service';
import { CoolifyConfigService } from '../coolify/coolify.config';
import { CryptoService } from '../crypto/crypto.service';
import { CoolifyProvisioner } from '../coolify/coolify.provisioner';
import { CoolifyMock } from '../test-support/coolify-mock';
import {
  createCompany,
  newPrefix,
  prisma,
  cleanUp,
  waitUntil,
  disconnect,
} from '../test-support/company-provisioning';
import { InstanceProvisioningService } from './instance-provisioning.service';
import {
  InstanceExistsAlreadyError,
  SubdomainTakenError,
  DiscardNotPossibleError,
  PreviewMissingError,
} from './instance.errors';
import { InstanceService } from './instance.service';

/**
 * Instanzen gegen eine ECHTE Postgres-Datenbank.
 *
 * DER KERN SIND DIE RENNEN. Mit einer In-Memory-Attrappe wären sie nicht zu
 * führen: JavaScript ist einfädig, dort entsteht kein Rennen — genau auf
 * diesem Weg ist in Etappe 1 [K1] durch 172 grüne Tests gerutscht.
 *
 * Geprüft werden drei Schranken, und jede fällt gegen ihre kaputte Fassung:
 * 1. Die Pflicht-Vorschau wird ATOMAR verbraucht. Zwei gleichzeitige
 *    Anlege-Anfragen: genau eine legt an.
 * 2. `Instanz.subdomain` ist eindeutig. Zwei Organisationen, dieselbe
 *    Subdomain, gleichzeitig: genau eine gewinnt.
 * 3. Archivieren ist ein BEDINGTER Schreibvorgang. Zwei gleichzeitige
 *    Klicks: genau ein Coolify-Aufruf.
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   pnpm --filter @saas-instant/control test:integration
 */

jest.setTimeout(60_000);

const PREFIX = newPrefix('etappe3-instanz');
const SOURCE = { ip: '203.0.113.9', userAgent: 'Jest-Integration' };
const ACTOR = { userId: null, name: 'sam' };

const audit = new AuditService(prisma);
const crypto = new CryptoService({
  get: () => 'test-schluessel-mindestens-32-zeichen-lang-x',
} as never);
const config = new ConfigService({
  COOLIFY_TOKEN: 'attrappe-token-mindestens-32-zeichen-lang',
  CONTROL_INSTANCE_BASE_DOMAIN: 'example.com',
  // Der geteilte Postausgang der Kundeninstanzen. Ohne ihn lehnt die
  // Verwaltung das Anlegen seit dem 11.09.2026 ab.
  CONTROL_INSTANCE_SMTP_HOST: 'mail.example.com',
  CONTROL_INSTANCE_SMTP_USER: 'noreply@example.com',
  CONTROL_INSTANCE_SMTP_PASS: 'attrappe-passwort',
  CONTROL_INSTANCE_SMTP_FROM: 'Mein Produkt <noreply@example.com>',
});
const coolifyConfig = new CoolifyConfigService(config);

/** Baut einen Dienst mit frischer Attrappe — je Fall eine eigene. */
function build(): { service: InstanceService; coolify: CoolifyMock } {
  const coolify = new CoolifyMock();
  const provisioning = new InstanceProvisioningService(
    prisma,
    audit,
    coolifyConfig,
    new CoolifyProvisioner(coolify, async () => undefined),
    // Nicht warten und nicht ins Netz greifen: geprüft wird der Ablauf, nicht
    // die Uhr und nicht ein Hostname, den es nicht gibt.
    async () => undefined,
    async () => true,
  );
  const service = new InstanceService(prisma, audit, crypto, coolifyConfig, provisioning, new CoolifyProvisioner(coolify, async () => undefined));
  return { service, coolify };
}

/** Legt Organisation und bestätigte Vorschau an — der reguläre Weg. */
async function withPreview(subdomain: string) {
  const { service, coolify } = build();
  const company = await createCompany(PREFIX);
  await service.createPreview(company.id, subdomain, ACTOR, SOURCE);
  return { service, coolify, company };
}

/**
 * [W5] Nebenbefund: Ein ABGEBROCHENER Lauf hinterlässt Organisationen, und die
 * Subdomains dieser Suite sind fest. Der nächste Lauf fand sie dann als
 * „bereits vergeben" vor — ein Abbruch vergiftete die Datei dauerhaft.
 *
 * `cleanUp` räumt nur das eigene Präfix samt Zufallsanteil. Hier wird
 * deshalb der BASISNAME der Suite geräumt: Er trifft alle früheren Läufe
 * genau dieser Datei und nichts sonst.
 */
beforeAll(async () => {
  await cleanUp('etappe3-instanz');
});

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

describe('Pflicht-Vorschau — serverseitig erzwungen', () => {
  it('weist das Anlegen OHNE Vorschau ab', async () => {
    const { service } = build();
    const company = await createCompany(PREFIX);

    await expect(
      service.create(company.id, 'ohne-vorschau-1', ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(PreviewMissingError);

    const instance = await prisma.instance.findUnique({
      where: { companyId: company.id },
    });
    expect(instance).toBeNull();
  });

  it('weist eine Vorschau für eine ANDERE Subdomain ab', async () => {
    const { service, company } = await withPreview('vorschau-a');

    await expect(
      service.create(company.id, 'vorschau-b', ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(PreviewMissingError);
  });

  it('weist eine ABGELAUFENE Vorschau ab', async () => {
    const { service, company } = await withPreview('vorschau-alt');
    await prisma.instancePreview.updateMany({
      where: { companyId: company.id },
      data: { validUntil: new Date(Date.now() - 1000) },
    });

    await expect(
      service.create(company.id, 'vorschau-alt', ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(PreviewMissingError);
  });

  it('lässt sie GENAU EINMAL verbrauchen', async () => {
    const { service, company } = await withPreview('vorschau-einmal');
    await service.create(company.id, 'vorschau-einmal', ACTOR, SOURCE);

    // Zweiter Versuch: die Instanz besteht bereits — die Vorschau ist ohnehin
    // verbraucht, aber die frühere Schranke greift zuerst.
    await expect(
      service.create(company.id, 'vorschau-einmal', ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(InstanceExistsAlreadyError);
  });
});

describe('Rennen — zwei gleichzeitige Anfragen', () => {
  it('legt bei zwei GLEICHZEITIGEN Anlege-Anfragen genau eine Instanz an', async () => {
    const { service, company } = await withPreview('rennen-anlegen');

    const results = await Promise.allSettled([
      service.create(company.id, 'rennen-anlegen', ACTOR, SOURCE),
      service.create(company.id, 'rennen-anlegen', ACTOR, SOURCE),
    ]);

    const succeeded = results.filter((e) => e.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);

    const instances = await prisma.instance.findMany({
      where: { companyId: company.id },
    });
    expect(instances).toHaveLength(1);
  });

  it('vergibt dieselbe Subdomain auch bei zwei Organisationen nur einmal', async () => {
    const { service: a } = build();
    const { service: b } = build();
    const one = await createCompany(PREFIX);
    const two = await createCompany(PREFIX);
    await a.createPreview(one.id, 'rennen-subdomain', ACTOR, SOURCE);
    await b.createPreview(two.id, 'rennen-subdomain', ACTOR, SOURCE);

    const results = await Promise.allSettled([
      a.create(one.id, 'rennen-subdomain', ACTOR, SOURCE),
      b.create(two.id, 'rennen-subdomain', ACTOR, SOURCE),
    ]);

    expect(results.filter((e) => e.status === 'fulfilled')).toHaveLength(1);
    const instances = await prisma.instance.findMany({
      where: { subdomain: 'rennen-subdomain' },
    });
    expect(instances).toHaveLength(1);
  });

  it('stoppt bei zwei GLEICHZEITIGEN Archivierungen nur einmal in Coolify', async () => {
    const { service, coolify, company } = await withPreview('rennen-archiv');
    await service.create(company.id, 'rennen-archiv', ACTOR, SOURCE);
    const instance = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    await prisma.instance.update({
      where: { id: instance.id },
      data: { status: 'active', coolifyApplicationId: 'attrappe-app-1' },
    });
    coolify.stopped.length = 0;

    const results = await Promise.allSettled([
      service.archive(company.id, ACTOR, SOURCE),
      service.archive(company.id, ACTOR, SOURCE),
    ]);

    expect(results.filter((e) => e.status === 'fulfilled')).toHaveLength(1);
    // [W5]: Der Hintergrundlauf läuft mit `void`. Gewartet wird auf sein
    // ERGEBNIS, nicht auf die Uhr.
    await waitUntil(
      () => coolify.stopped.length === 1,
      'genau ein Stopp-Aufruf gegen Coolify',
    );
    expect(coolify.stopped).toHaveLength(1);
  });
});

describe('Subdomain — geprüft, bevor irgendetwas passiert', () => {
  it('meldet eine bereits im CRM vergebene Subdomain als vergeben', async () => {
    const { service, company } = await withPreview('belegt-im-crm');
    await service.create(company.id, 'belegt-im-crm', ACTOR, SOURCE);

    const { service: second } = build();
    expect(await second.checkSubdomain('belegt-im-crm')).toEqual({
      available: false,
      reason: 'taken',
    });
  });

  it('meldet eine nur in Coolify vorhandene Subdomain als vergeben', async () => {
    const { service, coolify } = build();
    coolify.setUp('instanz-nur-coolify', 'nur-coolify.example.com');

    expect(await service.checkSubdomain('nur-coolify')).toEqual({
      available: false,
      reason: 'taken',
    });
  });

  it('hält eine Subdomain für vergeben, wenn Coolify nicht antwortet', async () => {
    // EIN AUSFALL DARF NICHT „FREI" HEISSEN. Sonst führte er genau dann zum
    // Überschreiben, wenn ohnehin niemand hinsieht.
    const { service, coolify } = build();
    coolify.failsAt = 'applications';

    // Nicht „vergeben", sondern „nicht prüfbar": die Oberfläche meldet beides
    // verschieden, gesperrt bleibt die Subdomain in beiden Fällen.
    expect(await service.checkSubdomain('unbekannt-bei-ausfall')).toEqual({
      available: false,
      reason: 'unverifiable',
    });
  });

  it('lehnt das Anlegen ab, wenn die Subdomain zwischen Vorschau und Bestätigung vergeben wird', async () => {
    const { service, coolify, company } = await withPreview('dazwischen');
    // Zwischen Vorschau und Bestätigung taucht in Coolify dieselbe Domäne auf.
    coolify.setUp('instanz-dazwischen', 'dazwischen.example.com');

    await expect(
      service.create(company.id, 'dazwischen', ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(SubdomainTakenError);

    expect(
      await prisma.instance.findUnique({ where: { companyId: company.id } }),
    ).toBeNull();
  });
});

describe('Anlegen — was danach in der Datenbank steht', () => {
  it('legt den Kennzahlen-Token ausschliesslich VERSCHLÜSSELT ab', async () => {
    const { service, coolify, company } = await withPreview('token-test');
    await service.create(company.id, 'token-test', ACTOR, SOURCE);
    // [W5] AUF DAS RICHTIGE ERGEBNIS WARTEN, NICHT AUF DAS ERSTBESTE.
    //
    // Hier stand eine Bedingung auf `metricsTokenEncrypted !== null`.
    // Die trifft aber schon zu, sobald `create` zurückkehrt: Den
    // verschlüsselten Token schreibt `create` selbst, im selben `create` wie
    // die Zeile. Gewartet wurde damit auf NICHTS — die Schleife war beim
    // ersten Durchgang fertig.
    //
    // Geprüft wird danach aber der KLARTEXT in der Attrappe, und den setzt
    // erst der Hintergrundlauf, wenn er `createApplication` erreicht. Zwischen
    // beidem lag keine Absprache; wer zuerst ankam, entschied der Zufall. Auf
    // einer ausgelasteten Maschine kam der Test zuerst an und meldete
    // „Received: undefined" — genau der sporadische Fehlschlag im vollen
    // Lauf. Reproduziert am 07.09.2026: einmal in zwölf Läufen dieser Datei
    // unter Volllast, isoliert und ohne Last nie.
    //
    // `coolifyApplicationId` ist die Bedingung, die wirklich gemeint war: Diese
    // Spalte schreibt der Aufbau unmittelbar NACH `createApplication`. Steht
    // sie, ist die Umgebung in der Attrappe gesetzt.
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).coolifyApplicationId !== null,
      'der Aufbau hat die Anwendung in Coolify angelegt',
    );

    const instance = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    const stored = instance.metricsTokenEncrypted;
    expect(stored).not.toBeNull();
    // Form `iv.tag.ciphertext`, jeweils base64 — nicht der Klartext.
    expect((stored as string).split('.')).toHaveLength(3);

    // Die Kennung kommt aus der DATENBANK, nicht aus einer festen
    // Zeichenkette: Damit belegt der Test zugleich, dass die Zeile und die
    // Anwendung in Coolify dieselbe meinen.
    const plaintext = coolify.environment.get(instance.coolifyApplicationId as string)?.[
      'METRICS_TOKEN'
    ];
    expect(plaintext).toBeTruthy();
    expect(stored).not.toContain(plaintext as string);
    expect(crypto.decrypt(stored as string)).toBe(plaintext);
  });

  it('schreibt den Token NICHT ins Audit-Log', async () => {
    const { service, company } = await withPreview('audit-token');
    await service.create(company.id, 'audit-token', ACTOR, SOURCE);
    // ERST WENN DER AUFBAU DURCH IST, liegen ALLE Audit-Zeilen dieses Wegs
    // vor. Ohne das Warten las der Test nur die Zeile, die `create` selbst
    // schreibt: Ein Token in `instanz.bereit` wäre ihm entgangen, und ob er
    // die Zeile sah, entschied die Tagesform der Maschine.
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'active',
      'der Aufbau im Hintergrund ist durch',
    );
    const instance = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    const plaintext = crypto.decrypt(
      instance.metricsTokenEncrypted as string,
    );

    const entries = await prisma.auditLog.findMany({
      where: { objectId: instance.id },
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(plaintext);
  });

  it('führt den Aufbau bis `aktiv` und meldet den Zwischenstand', async () => {
    const { service, coolify, company } = await withPreview('aufbau-gut');
    await service.create(company.id, 'aufbau-gut', ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'active',
      'Instanz erreicht den Status aktiv',
    );

    const instance = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    expect(instance.status).toBe('active');
    expect(instance.message).toBeNull();
    expect(coolify.calls).toContain('createApplication');
    expect(coolify.calls).toContain('setDomain');
    expect(coolify.calls).toContain('startDeploy');
  });

  it('macht ein gescheitertes Deployment SICHTBAR statt still (E3-12)', async () => {
    const { service, coolify, company } = await withPreview('aufbau-kaputt');
    coolify.failsAt = 'setDomain';

    await service.create(company.id, 'aufbau-kaputt', ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).message?.startsWith('Fehlgeschlagen') === true,
      // NICHT nur „irgendeine Meldung": Der Aufbau setzt schon während des
      // Laufs Zwischenstände („Anwendung wird in Coolify angelegt …"). Auf die
      // zu warten hiesse, mitten im Lauf zu prüfen — dieselbe Wackelei wie
      // vorher, nur ohne Uhr.
      'der gescheiterte Aufbau ist ENDGÜLTIG vermerkt',
    );

    const instance = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    expect(instance.status).toBe('provisioning');
    expect(instance.message).toContain('Fehlgeschlagen');
    expect(instance.message).toContain('nichts gelöscht');

    const errorRows = await prisma.auditLog.findMany({
      where: { objectId: instance.id, action: 'instance.provisioning.failure' },
    });
    expect(errorRows).toHaveLength(1);
  });
});

describe('Archivieren — stoppen, sichern, nichts löschen', () => {
  it('stoppt, löst eine Sicherung aus und setzt den Status', async () => {
    const { service, coolify, company } = await withPreview('archiv-gut');
    await service.create(company.id, 'archiv-gut', ACTOR, SOURCE);
    // [W5] ERST DEN HINTERGRUNDLAUF ABWARTEN, dann von Hand nachstellen.
    //
    // `create` startet den Aufbau mit `void`. Wer sofort `status: 'aktiv'`
    // schreibt und archiviert, bekommt ein Rennen: Der Aufbau schreibt danach
    // seinen eigenen Endzustand und überschreibt `archiviert` wieder. Die
    // feste Wartezeit von vorher hat das die meiste Zeit zugedeckt — genau so
    // sieht ein flatternder Test aus.
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'active',
      'der Aufbau im Hintergrund ist durch',
    );
    const created = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    await prisma.instance.update({
      where: { id: created.id },
      data: { status: 'active', coolifyApplicationId: 'attrappe-app-1' },
    });
    await prisma.backup.create({
      data: {
        instanceId: created.id,
        date: toDate(today()),
        sizeBytes: BigInt(2_400_000_000),
      },
    });

    await service.archive(company.id, ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'archived' &&
        (await prisma.note.count({
          where: { companyId: company.id, bySystem: true },
        })) > 0,
      'Instanz ist archiviert UND der Verlaufseintrag steht',
    );

    const after = await prisma.instance.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(after.status).toBe('archived');
    expect(after.archivedAt).not.toBeNull();
    expect(coolify.stopped).toEqual(['attrappe-app-1']);
    // Der Sicherungsstand wird GENANNT, nicht behauptet ([W2]).
    expect(after.message).toContain('Letzte Sicherung');

    // Der Verlauf ist die Stelle, an der jemand Wochen später nachsieht.
    const notes = await prisma.note.findMany({
      where: { companyId: company.id, bySystem: true },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('archiviert');
    expect(notes[0].text).toContain('nichts gelöscht');
  });

  it('warnt im Verlauf, wenn es gar keine Sicherung gibt ([W2])', async () => {
    // Die Archivierung LÖST KEINE Sicherung aus — sie sagt, wie der Stand ist.
    // Eine archivierte Instanz meldet sich nicht mehr über die
    // Dashboard-Aufgabe, deshalb muss die Warnung hier stehen.
    const { service, company } = await withPreview('archiv-ohne-sicherung');
    await service.create(company.id, 'archiv-ohne-sicherung', ACTOR, SOURCE);
    // [W5] ERST DEN HINTERGRUNDLAUF ABWARTEN, dann von Hand nachstellen.
    //
    // `create` startet den Aufbau mit `void`. Wer sofort `status: 'aktiv'`
    // schreibt und archiviert, bekommt ein Rennen: Der Aufbau schreibt danach
    // seinen eigenen Endzustand und überschreibt `archiviert` wieder. Die
    // feste Wartezeit von vorher hat das die meiste Zeit zugedeckt — genau so
    // sieht ein flatternder Test aus.
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'active',
      'der Aufbau im Hintergrund ist durch',
    );
    const created = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    await prisma.instance.update({
      where: { id: created.id },
      data: { status: 'active', coolifyApplicationId: 'attrappe-app-1' },
    });

    await service.archive(company.id, ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'archived' &&
        (await prisma.note.count({
          where: { companyId: company.id, bySystem: true },
        })) > 0,
      'Instanz ist archiviert UND der Verlaufseintrag steht',
    );

    const notes = await prisma.note.findMany({
      where: { companyId: company.id, bySystem: true },
    });
    expect(notes[0].text).toContain('ACHTUNG');
    expect(notes[0].text).toContain('nie eine Sicherung');
    expect(notes[0].text).toContain('nichts gelöscht');
  });

  it('warnt im Verlauf, wenn die letzte Sicherung zu alt ist', async () => {
    const { service, company } = await withPreview('archiv-alte-sicherung');
    await service.create(company.id, 'archiv-alte-sicherung', ACTOR, SOURCE);
    // [W5] ERST DEN HINTERGRUNDLAUF ABWARTEN, dann von Hand nachstellen.
    //
    // `create` startet den Aufbau mit `void`. Wer sofort `status: 'aktiv'`
    // schreibt und archiviert, bekommt ein Rennen: Der Aufbau schreibt danach
    // seinen eigenen Endzustand und überschreibt `archiviert` wieder. Die
    // feste Wartezeit von vorher hat das die meiste Zeit zugedeckt — genau so
    // sieht ein flatternder Test aus.
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'active',
      'der Aufbau im Hintergrund ist durch',
    );
    const created = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    await prisma.instance.update({
      where: { id: created.id },
      data: { status: 'active', coolifyApplicationId: 'attrappe-app-1' },
    });
    await prisma.backup.create({
      data: {
        instanceId: created.id,
        date: toDate(datePlusDays(today(), -30)),
        sizeBytes: BigInt(1),
      },
    });

    await service.archive(company.id, ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'archived' &&
        (await prisma.note.count({
          where: { companyId: company.id, bySystem: true },
        })) > 0,
      'Instanz ist archiviert UND der Verlaufseintrag steht',
    );

    const notes = await prisma.note.findMany({
      where: { companyId: company.id, bySystem: true },
    });
    expect(notes[0].text).toContain('ACHTUNG');
    expect(notes[0].text).toContain('nicht mehr aktuell');
  });

  it('behält Instanz, Kennzahlen und Sicherungen — es wird nichts gelöscht (R1/R4)', async () => {
    const { service, company } = await withPreview('archiv-bleibt');
    await service.create(company.id, 'archiv-bleibt', ACTOR, SOURCE);
    // [W5] ERST DEN HINTERGRUNDLAUF ABWARTEN, dann von Hand nachstellen.
    //
    // `create` startet den Aufbau mit `void`. Wer sofort `status: 'aktiv'`
    // schreibt und archiviert, bekommt ein Rennen: Der Aufbau schreibt danach
    // seinen eigenen Endzustand und überschreibt `archiviert` wieder. Die
    // feste Wartezeit von vorher hat das die meiste Zeit zugedeckt — genau so
    // sieht ein flatternder Test aus.
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'active',
      'der Aufbau im Hintergrund ist durch',
    );
    const created = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    await prisma.instance.update({
      where: { id: created.id },
      data: { status: 'active', coolifyApplicationId: 'attrappe-app-1' },
    });
    await prisma.metric.create({
      data: {
        instanceId: created.id,
        date: new Date('2026-08-01T00:00:00.000Z'),
        activePersons: 12,
        circles: 3,
      },
    });
    await prisma.backup.create({
      data: {
        instanceId: created.id,
        date: new Date('2026-08-30T00:00:00.000Z'),
        sizeBytes: BigInt(2_400_000_000),
      },
    });

    await service.archive(company.id, ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'archived' &&
        (await prisma.note.count({
          where: { companyId: company.id, bySystem: true },
        })) > 0,
      'Instanz ist archiviert UND der Verlaufseintrag steht',
    );

    expect(
      await prisma.instance.findUnique({ where: { id: created.id } }),
    ).not.toBeNull();
    expect(await prisma.metric.count({ where: { instanceId: created.id } })).toBe(1);
    expect(await prisma.backup.count({ where: { instanceId: created.id } })).toBe(1);
  });
});

describe('Verwerfen — der Weg aus der Sackgasse ([W4])', () => {
  /** Legt eine Instanz an, deren Aufbau scheitert, BEVOR Coolify etwas anlegt. */
  async function failed(subdomain: string) {
    const { service, coolify, company } = await withPreview(subdomain);
    coolify.failsAt = 'createApplication';
    await service.create(company.id, subdomain, ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).message?.startsWith('Fehlgeschlagen') === true,
      // NICHT nur „irgendeine Meldung": Der Aufbau setzt schon während des
      // Laufs Zwischenstände („Anwendung wird in Coolify angelegt …"). Auf die
      // zu warten hiesse, mitten im Lauf zu prüfen — dieselbe Wackelei wie
      // vorher, nur ohne Uhr.
      'der gescheiterte Aufbau ist ENDGÜLTIG vermerkt',
    );
    return { service, coolify, company };
  }

  it('lässt eine gescheiterte Erstellung verwerfen und danach neu anlegen', async () => {
    const { service, company } = await failed('verwerfen-neu');

    const stuck = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    expect(stuck.status).toBe('provisioning');
    expect(stuck.coolifyApplicationId).toBeNull();

    // OHNE Verwerfen ist hier Schluss: `Instanz.companyId` ist unique.
    await expect(
      service.create(company.id, 'verwerfen-neu-2', ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(InstanceExistsAlreadyError);

    await service.discardCreation(company.id, ACTOR, SOURCE);
    expect(
      await prisma.instance.findUnique({ where: { companyId: company.id } }),
    ).toBeNull();

    // Und jetzt geht es wieder — über die reguläre Pflicht-Vorschau.
    await service.createPreview(company.id, 'verwerfen-neu-2', ACTOR, SOURCE);
    const fresh = await service.create(company.id, 'verwerfen-neu-2', ACTOR, SOURCE);
    expect(fresh.subdomain).toBe('verwerfen-neu-2');
  });

  it('hinterlässt Audit-Eintrag und Systemnotiz — der Nachweis überlebt', async () => {
    const { service, company } = await failed('verwerfen-nachweis');
    const instance = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });

    await service.discardCreation(company.id, ACTOR, SOURCE);

    const entries = await prisma.auditLog.findMany({
      where: { objectId: instance.id, action: 'instance.creation.discarded' },
    });
    expect(entries).toHaveLength(1);

    const notes = await prisma.note.findMany({
      where: { companyId: company.id, bySystem: true },
    });
    expect(notes.some((n) => n.text.includes('verworfen'))).toBe(true);
    expect(notes.some((n) => n.text.includes('In Coolify war nichts entstanden'))).toBe(
      true,
    );
  });

  it('VERWEIGERT das Verwerfen, sobald in Coolify etwas steht', async () => {
    // Sonst entstünde eine Waise, die danach nur noch der Abgleich fände.
    const { service, company } = await withPreview('verwerfen-mit-app');
    await service.create(company.id, 'verwerfen-mit-app', ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'active',
      'Instanz erreicht den Status aktiv',
    );
    const instance = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    await prisma.instance.update({
      where: { id: instance.id },
      data: { status: 'provisioning', coolifyApplicationId: 'attrappe-app-1' },
    });

    await expect(
      service.discardCreation(company.id, ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(DiscardNotPossibleError);

    expect(
      await prisma.instance.findUnique({ where: { companyId: company.id } }),
    ).not.toBeNull();
  });

  it('VERWEIGERT das Verwerfen einer laufenden Instanz', async () => {
    const { service, company } = await withPreview('verwerfen-aktiv');
    await service.create(company.id, 'verwerfen-aktiv', ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'active',
      'Instanz erreicht den Status aktiv',
    );

    await expect(
      service.discardCreation(company.id, ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(DiscardNotPossibleError);
  });

  it('VERWEIGERT das Verwerfen, wenn schon Kennzahlen daran hängen', async () => {
    const { service, company } = await failed('verwerfen-mit-kennzahl');
    const instance = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    await prisma.metric.create({
      data: { instanceId: instance.id, date: toDate(today()), activePersons: 1, circles: 1 },
    });

    await expect(
      service.discardCreation(company.id, ACTOR, SOURCE),
    ).rejects.toBeInstanceOf(DiscardNotPossibleError);
  });

  it('verwirft bei zwei GLEICHZEITIGEN Aufrufen nur einmal', async () => {
    const { service, company } = await failed('verwerfen-rennen');

    const results = await Promise.allSettled([
      service.discardCreation(company.id, ACTOR, SOURCE),
      service.discardCreation(company.id, ACTOR, SOURCE),
    ]);

    expect(results.filter((e) => e.status === 'fulfilled')).toHaveLength(1);
  });
});

/**
 * ===========================================================================
 * DIE COMPOSE-DATEI LIEST DAS ERSTE AUSROLLEN — nicht Coolifys Warteschlange
 * ===========================================================================
 *
 * Coolify weist jede Domäne ab, solange es die Compose-Datei nicht gelesen
 * hat. Nach dem Anlegen über die API reiht es das Lesen nur EIN
 * (`LoadComposeFile::dispatch`), und die Warteschlange brauchte am 11.09.2026
 * gut vier Minuten. Der Aufbau wartete zwei und scheiterte. Synchron liest
 * die Datei nur der Deploy-Job — deshalb rollt der Aufbau zuerst ohne Domäne
 * aus.
 *
 * Die Attrappe lässt die Warteschlange hier NIE liefern (ihre Vorgabe). Jeder
 * Fall beweist damit, dass der Aufbau nicht mehr auf sie angewiesen ist.
 */
describe('Der Aufbau liest die Compose-Datei durch ein erstes Ausrollen', () => {
  async function untilEnd(companyId: string) {
    await waitUntil(
      async () => {
        const i = await prisma.instance.findUniqueOrThrow({ where: { companyId } });
        return i.status === 'active' || i.message?.startsWith('Fehlgeschlagen') === true;
      },
      'der Aufbau ist ENDGÜLTIG durch — fertig oder gescheitert',
    );
    return prisma.instance.findUniqueOrThrow({ where: { companyId } });
  }

  it('rollt zweimal aus: erst ohne Domäne, dann mit — und wartet nie auf die Warteschlange', async () => {
    const { service, coolify, company } = await withPreview('compose-deploy');
    await service.create(company.id, 'compose-deploy', ACTOR, SOURCE);

    const end = await untilEnd(company.id);
    expect(end.status).toBe('active');

    const first = coolify.calls.indexOf('startDeploy');
    const domain = coolify.calls.indexOf('setDomain');
    const second = coolify.calls.lastIndexOf('startDeploy');
    expect(coolify.calls.filter((a) => a === 'startDeploy')).toHaveLength(2);
    // Die Reihenfolge ist der ganze Punkt.
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(domain);
    expect(domain).toBeLessThan(second);
  });

  it('scheitert SICHTBAR, wenn selbst das Ausrollen die Datei nicht liest — und setzt keine Domäne', async () => {
    const { service, coolify, company } = await withPreview('compose-nie');
    coolify.composeWhenDeploy = false;
    await service.create(company.id, 'compose-nie', ACTOR, SOURCE);

    const end = await untilEnd(company.id);
    expect(end.status).toBe('provisioning');
    expect(end.message).toContain('Compose-Datei');
    expect(end.message).toContain('instance-compose-nie');
    // Die Domäne wurde versucht, aber nie angenommen.
    expect(coolify.applicationsList.every((a) => a.domains.length === 0)).toBe(true);
    expect(coolify.calls.filter((a) => a === 'startDeploy')).toHaveLength(1);
  });
});

/**
 * ===========================================================================
 * „VON HAND AUFRÄUMEN" MUSS AUCH WIRKLICH WEITERFÜHREN
 * ===========================================================================
 *
 * Gemessen am 11.09.2026: Nach einem Fehlschlag MIT angelegter Anwendung
 * verlangte die Meldung, sie in Coolify von Hand zu löschen. Danach ging es
 * trotzdem nicht weiter — `discardCreation` sah nur auf
 * `coolifyApplicationId !== null`, und die Kennung blieb in der Zeile stehen.
 * Die Anweisung führte in eine zweite Sackgasse.
 */
describe('Verwerfen nach dem Aufräumen in Coolify', () => {
  /** Legt eine Instanz an, deren Aufbau NACH dem Anlegen in Coolify scheitert. */
  async function halfCreated(subdomain: string) {
    const { service, coolify, company } = await withPreview(subdomain);
    coolify.failsAt = 'setDomain';
    await service.create(company.id, subdomain, ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).message?.startsWith('Fehlgeschlagen') === true,
      'der halbe Aufbau ist ENDGÜLTIG vermerkt',
    );
    coolify.failsAt = null;
    const instance = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    expect(instance.coolifyApplicationId).not.toBeNull();
    return { service, coolify, company, uuid: instance.coolifyApplicationId! };
  }

  it('verweigert, solange die Anwendung in Coolify noch steht', async () => {
    const { service, company } = await halfCreated('halb-steht');
    await expect(
      service.discardCreation(company.id, ACTOR, SOURCE),
    ).rejects.toThrow(/instance-halb-steht/);
    expect(
      await prisma.instance.findUnique({ where: { companyId: company.id } }),
    ).not.toBeNull();
  });

  it('lässt verwerfen, sobald Coolify die Anwendung nicht mehr kennt — und danach neu anlegen', async () => {
    const { service, coolify, company, uuid } = await halfCreated('halb-weg');
    coolify.removeManually(uuid);

    await service.discardCreation(company.id, ACTOR, SOURCE);
    expect(
      await prisma.instance.findUnique({ where: { companyId: company.id } }),
    ).toBeNull();

    const notes = await prisma.note.findMany({
      where: { companyId: company.id, bySystem: true },
    });
    // Die Notiz sagt, was WIRKLICH war — nicht „nichts entstanden".
    expect(notes.some((n) => n.text.includes('von Hand entfernt'))).toBe(true);
    expect(notes.some((n) => n.text.includes('In Coolify war nichts entstanden'))).toBe(false);

    await service.createPreview(company.id, 'halb-weg-2', ACTOR, SOURCE);
    const fresh = await service.create(company.id, 'halb-weg-2', ACTOR, SOURCE);
    expect(fresh.subdomain).toBe('halb-weg-2');
  });

  it('hält einen Coolify-AUSFALL nicht für „entfernt"', async () => {
    // Sonst würde ein nicht erreichbares Coolify zur Freigabe, und die Zeile
    // verschwände neben einer laufenden Anwendung ([K2]).
    const { service, coolify, company } = await halfCreated('halb-ausfall');
    coolify.failsAt = 'getApplication';

    await expect(
      service.discardCreation(company.id, ACTOR, SOURCE),
    ).rejects.toThrow(/nicht erreichbar/);
    expect(
      await prisma.instance.findUnique({ where: { companyId: company.id } }),
    ).not.toBeNull();
  });
});

/**
 * ===========================================================================
 * DER GETEILTE POSTAUSGANG (gemessen am 11.09.2026)
 * ===========================================================================
 *
 * Die Kunden-Compose verlangt `SMTP_HOST` mit `${SMTP_HOST:?…}`, und Coolify
 * macht bei dieser Form die Meldung zum Wert. Die Verwaltung setzte ihn nicht:
 * `instanz-kunde` hatte als Mailserver einen deutschen Satz.
 */
describe('Jede neue Instanz bekommt den geteilten Postausgang', () => {
  it('gibt SMTP_HOST, SMTP_FROM und die Zugangsdaten mit', async () => {
    const { service, coolify, company } = await withPreview('mit-versand');
    await service.create(company.id, 'mit-versand', ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'active',
      'Instanz erreicht den Status aktiv',
    );
    const instance = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    const environment = coolify.environment.get(instance.coolifyApplicationId as string) ?? {};
    expect(environment['SMTP_HOST']).toBe('mail.example.com');
    expect(environment['SMTP_FROM']).toBe('Mein Produkt <noreply@example.com>');
    expect(environment['SMTP_USER']).toBe('noreply@example.com');
    expect(environment['SMTP_PASS']).toBe('attrappe-passwort');
    // Nirgends ein Satz statt eines Werts.
    expect(Object.values(environment).some((w) => w.includes('muss gesetzt sein'))).toBe(false);
  });

  it('lehnt schon die VORSCHAU ab, wenn die Versanddaten fehlen', async () => {
    const withoutSend = new CoolifyConfigService(
      new ConfigService({
        COOLIFY_TOKEN: 'attrappe-token-mindestens-32-zeichen-lang',
        CONTROL_INSTANCE_BASE_DOMAIN: 'example.com',
      }),
    );
    const coolify = new CoolifyMock();
    const provisioning = new InstanceProvisioningService(
      prisma,
      audit,
      withoutSend,
      new CoolifyProvisioner(coolify, async () => undefined),
      async () => undefined,
      async () => true,
    );
    const service = new InstanceService(prisma, audit, crypto, withoutSend, provisioning, new CoolifyProvisioner(coolify, async () => undefined));
    const company = await createCompany(PREFIX);

    await expect(
      service.createPreview(company.id, 'ohne-versand', ACTOR, SOURCE),
    ).rejects.toThrow(/Versanddaten/);
    // Weder eine Zeile noch etwas in Coolify.
    expect(
      await prisma.instance.findUnique({ where: { companyId: company.id } }),
    ).toBeNull();
    expect(coolify.calls).not.toContain('createApplication');
  });
});

/**
 * ===========================================================================
 * DIE ZWEI LETZTEN SACKGASSEN (gefunden am 11.09.2026, vor dem ersten echten
 * Anlegen aus der Verwaltung)
 * ===========================================================================
 *
 * 1. Ein gescheitertes DEPLOYMENT meldete sich ohne „Fehlgeschlagen:" — die
 *    Karte zeigte „läuft im Hintergrund weiter" und keinen Ausweg.
 * 2. Gab der Health-Check nach 180 s auf (meist: Zertifikat noch unterwegs),
 *    lief die Instanz, blieb aber für immer auf `wird_erstellt`. Nur der
 *    Aufbau setzt `aktiv`; Verwerfen ging nicht, weil in Coolify etwas stand.
 */
describe('Jeder Ausgang des Aufbaus hat einen Weg nach vorn', () => {
  /** Ein Dienst, dessen Health-Check der Test umschalten kann. */
  function buildWithHealth(healthy: { now: boolean }) {
    const coolify = new CoolifyMock();
    const provisioning = new InstanceProvisioningService(
      prisma,
      audit,
      coolifyConfig,
      new CoolifyProvisioner(coolify, async () => undefined),
      async () => undefined,
      async () => healthy.now,
    );
    const service = new InstanceService(prisma, audit, crypto, coolifyConfig, provisioning, new CoolifyProvisioner(coolify, async () => undefined));
    return { service, coolify };
  }

  async function message(companyId: string) {
    return (await prisma.instance.findUniqueOrThrow({ where: { companyId } })).message;
  }

  it('meldet ein gescheitertes Deployment mit „Fehlgeschlagen:" — sonst fehlte der Ausweg', async () => {
    const { service, coolify, company } = await withPreview('deploy-kaputt');
    coolify.deployments.set('attrappe-deploy-attrappe-app-1', 'failed');
    await service.create(company.id, 'deploy-kaputt', ACTOR, SOURCE);
    await waitUntil(
      async () => (await message(company.id))?.startsWith('Fehlgeschlagen') === true,
      'das gescheiterte Deployment ist vermerkt',
    );
    expect(await message(company.id)).toContain('Deployment endete');
    expect(await message(company.id)).toContain('instance-deploy-kaputt');
  });

  it('lässt eine späte Instanz auf „ausstehend" — und „Erneut prüfen" macht sie aktiv', async () => {
    const healthy = { now: false };
    const { service } = buildWithHealth(healthy);
    const company = await createCompany(PREFIX);
    await service.createPreview(company.id, 'spaet-erreichbar', ACTOR, SOURCE);
    await service.create(company.id, 'spaet-erreichbar', ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (await message(company.id))?.startsWith('Erreichbarkeit ausstehend') === true,
      'der Health-Check hat aufgegeben',
    );
    // KEIN Fehlschlag: Die Instanz läuft ja.
    expect(await message(company.id)).not.toContain('Fehlgeschlagen');

    // Noch nicht erreichbar: Es bleibt, wie es ist.
    expect(await service.checkReachability(company.id, ACTOR)).toEqual({
      reachable: false,
    });
    expect(
      (await prisma.instance.findUniqueOrThrow({ where: { companyId: company.id } }))
        .status,
    ).toBe('provisioning');

    // Jetzt antwortet sie.
    healthy.now = true;
    expect(await service.checkReachability(company.id, ACTOR)).toEqual({
      reachable: true,
    });
    const after = await prisma.instance.findUniqueOrThrow({
      where: { companyId: company.id },
    });
    expect(after.status).toBe('active');
    expect(after.message).toBeNull();
    // Der Nachweis nennt, wer es angestossen hat.
    const ready = await prisma.auditLog.findMany({
      where: { objectId: after.id, action: 'instance.ready' },
    });
    expect(ready.map((b) => b.actor)).toContain('sam');
  });

  it('verweigert „Erneut prüfen" nach einem echten Fehlschlag', async () => {
    const { service, coolify, company } = await withPreview('pruefen-falsch');
    coolify.failsAt = 'setDomain';
    await service.create(company.id, 'pruefen-falsch', ACTOR, SOURCE);
    await waitUntil(
      async () => (await message(company.id))?.startsWith('Fehlgeschlagen') === true,
      'der Fehlschlag ist vermerkt',
    );
    await expect(service.checkReachability(company.id, ACTOR)).rejects.toThrow(
      /Erneut prüfen/,
    );
  });
});

/**
 * Das Token der Verwaltung sieht `docker_compose_raw` nicht — Coolify lässt
 * das sensible Feld ohne `read:sensitive` ganz weg (gemessen am 12.09.2026).
 * Ob Coolify so weit ist, beantwortet deshalb das Setzen der Domäne selbst.
 */
describe('Das Setzen der Domäne wartet, statt nachzusehen', () => {
  it('versucht es erneut, solange Coolify „without docker_compose_raw" meldet', async () => {
    const { service, coolify, company } = await withPreview('domaene-geduld');
    coolify.domainRefusals = 2;
    await service.create(company.id, 'domaene-geduld', ACTOR, SOURCE);
    await waitUntil(
      async () =>
        (
          await prisma.instance.findUniqueOrThrow({
            where: { companyId: company.id },
          })
        ).status === 'active',
      'Instanz erreicht den Status aktiv',
    );
    expect(coolify.calls.filter((a) => a === 'setDomain')).toHaveLength(3);
  });
});

