import { houseLinks } from '../mail/layout/provider';
import { setTestBrand } from '../mail/layout/test-brand';
import type { ConfigService } from '@nestjs/config';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { TemplateService } from './template.service';
import { MarketingMailService } from './marketing-mail.service';

beforeAll(() => setTestBrand());

/**
 * ===========================================================================
 * DER REDAKTIONSBEREICH ALS VERTRAUENSGRENZE
 * ===========================================================================
 *
 * Was hier hereinkommt, hat ein Browser geschickt. „Aus einer angemeldeten
 * Sitzung" heisst nicht „geprüft": Ein aus Word oder einer Webseite
 * übernommener Absatz bringt Formatierungen, Verweise und Skripte mit, die
 * niemand absichtlich eingefügt hat, und die Prüfung im Browser lässt sich mit
 * der Entwicklerkonsole in zwei Handgriffen umgehen.
 *
 * Die massgebliche Säuberung findet deshalb HIER statt, bevor irgendetwas in
 * der Datenbank landet. Diese Tests halten das fest — und zwar am Weg über den
 * Dienst, nicht nur an der Säuberungsfunktion selbst: Ein Säuberer, den
 * niemand aufruft, schützt nichts.
 */

const CONFIG = {
  get: (name: string, defaultValue?: string) =>
    ({ CONTROL_MAIL_BASE_URL: 'https://verwaltung.example' })[name] ?? defaultValue,
} as unknown as ConfigService;

const ACTOR = { userId: null, name: 'Test' };
const SOURCE = { ip: null, userAgent: null };
const UNSUBSCRIBE_LINK = 'https://verwaltung.example/api/consent/unsubscribe/abc';

/** Ein Rumpf, der die Mindestlänge sicher überschreitet. */
const LANG = 'Ein ausreichend langer Satz für die Vorlage, damit die Grenze hält.';

/** Nimmt auf, was der Dienst schreiben wollte. */
interface Stored {
  contentText: string;
  contentHtml: string | null;
}

function buildService(present?: Record<string, unknown>): {
  service: TemplateService;
  written: Stored[];
} {
  const written: Stored[] = [];
  const row = (data: Record<string, unknown>) => ({
    id: 'v-1',
    name: 'Testvorlage',
    channel: 'marketing',
    subject: 'Ein Betreff',
    contentText: LANG,
    contentHtml: null,
    placeholders: null,
    active: true,
    createdAt: new Date('2026-08-31T10:00:00Z'),
    updatedAt: new Date('2026-08-31T10:00:00Z'),
    ...present,
    ...data,
  });
  const prisma = {
    mailTemplate: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        written.push({
          contentText: String(data['contentText']),
          contentHtml: (data['contentHtml'] as string | null) ?? null,
        });
        return row(data);
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written.push({
          contentText: String(data['contentText']),
          contentHtml: (data['contentHtml'] as string | null) ?? null,
        });
        return row(data);
      },
      findUnique: async () => row({}),
    },
  } as unknown as PrismaService;
  const audit = { log: async () => undefined } as unknown as AuditService;
  const marketingMail = new MarketingMailService(CONFIG);
  return { service: new TemplateService(prisma, audit, marketingMail), written };
}

describe('Der Server säubert, bevor er speichert', () => {
  it('lässt die fünf erlaubten Auszeichnungen stehen', async () => {
    const { service, written } = buildService();
    await service.create(
      {
        name: 'V',
        channel: 'marketing',
        subject: 'B',
        contentHtml: `<p><strong>Fett</strong> und <em>kursiv</em> und <u>unter</u>.<br>${LANG}</p>`,
      },
      ACTOR,
      SOURCE,
    );
    expect(written[0]!.contentHtml).toContain('<strong>Fett</strong>');
    expect(written[0]!.contentHtml).toContain('<em>kursiv</em>');
    expect(written[0]!.contentHtml).toContain('<u>unter</u>');
    expect(written[0]!.contentHtml).toContain('<br>');
  });

  it('speichert NIEMALS ungesäubertes HTML', async () => {
    const { service, written } = buildService();
    await service.create(
      {
        name: 'V',
        channel: 'marketing',
        subject: 'B',
        contentHtml:
          `<script>alert(1)</script><div style="x" onclick="y">${LANG}</div>` +
          '<a href="https://fremd.example">Angebot</a><img src="x">',
      },
      ACTOR,
      SOURCE,
    );
    const html = written[0]!.contentHtml!;
    expect(html).not.toContain('alert(1)');
    expect(html).not.toMatch(/onclick|style=|<img|<a\s|href/i);
    expect(html).not.toContain('fremd.example');
    // Der TEXT überlebt — nur das Format fällt weg.
    expect(html).toContain(LANG);
    expect(html).toContain('Angebot');
  });

  it('leitet den Textteil selbst ab und nimmt ihn nicht vom Client', async () => {
    // Zwei unabhängig gelieferte Fassungen liefen auseinander — und die
    // Person, die die Vorschau liest, sähe etwas anderes als das, was
    // Postfächer ohne HTML anzeigen.
    const { service, written } = buildService();
    await service.create(
      {
        name: 'V',
        channel: 'marketing',
        subject: 'B',
        contentText: 'Etwas ganz anderes, das der Client behauptet hat.',
        contentHtml: `<p><strong>${LANG}</strong></p>`,
      },
      ACTOR,
      SOURCE,
    );
    expect(written[0]!.contentText).toBe(LANG);
    expect(written[0]!.contentText).not.toContain('behauptet');
  });

  it('lässt den reinen Textweg unverändert bestehen', async () => {
    // Vorlagen ohne Redaktionsfeld ändern sich nicht: kein HTML in der Spalte.
    const { service, written } = buildService();
    await service.create(
      { name: 'V', channel: 'marketing', subject: 'B', contentText: LANG },
      ACTOR,
      SOURCE,
    );
    expect(written[0]!.contentText).toBe(LANG);
    expect(written[0]!.contentHtml).toBeNull();
  });

  it('macht aus einer Textvorlage beim Redigieren keine HTML-Vorlage', async () => {
    // `aendern` ohne Inhaltsfeld darf die bestehende Fassung nicht durch den
    // Säuberer schicken — sonst bekäme eine reine Textvorlage beim Umschalten
    // von `aktiv` plötzlich eine HTML-Spalte, die niemand angelegt hat.
    const { service, written } = buildService();
    await service.change('v-1', { active: false }, ACTOR, SOURCE);
    expect(written[0]!.contentText).toBe(LANG);
    expect(written[0]!.contentHtml).toBeNull();
  });

  it('misst die Länge an der Textfassung, nicht am Markup', async () => {
    const { service } = buildService();
    // 40 000 Zeichen Auszeichnung, drei Wörter Inhalt: kommt durch die
    // DTO-Grenze, hier aber nicht.
    const inflated = `${'<strong></strong>'.repeat(500)}<p>Zu kurz.</p>`;
    await expect(
      service.create(
        { name: 'V', channel: 'marketing', subject: 'B', contentHtml: inflated },
        ACTOR,
        SOURCE,
      ),
    ).rejects.toMatchObject({ errorCode: 'vorlage_inhalt_ungueltig' });
  });

  it('weist eine Vorlage ganz ohne Inhalt ab', async () => {
    const { service } = buildService();
    await expect(
      service.create(
        { name: 'V', channel: 'marketing', subject: 'B' },
        ACTOR,
        SOURCE,
      ),
    ).rejects.toMatchObject({ errorCode: 'vorlage_inhalt_ungueltig' });
  });

  it('prüft die Platzhalter an der Textfassung', async () => {
    // Im HTML könnte `{{name}}` von einer Auszeichnung zerschnitten sein.
    const { service } = buildService();
    await expect(
      service.create(
        {
          name: 'V',
          channel: 'marketing',
          subject: 'B',
          contentHtml: `<p>Hallo {{name}}, ${LANG}</p>`,
        },
        ACTOR,
        SOURCE,
      ),
    ).rejects.toMatchObject({ errorCode: 'unknown_placeholders' });
  });
});

describe('Die Vorschau zeigt das ganze Dokument, nicht nur den Rumpf', () => {
  function serviceWith(channel: 'marketing' | 'transactional') {
    return buildService({
      channel,
      subject: 'Neues von {{organisation}}',
      contentText: `Hallo {{organisation}}, ${LANG}`,
      contentHtml: `<p>Hallo <strong>{{organisation}}</strong>, ${LANG}</p>`,
    }).service;
  }

  it('liefert ein vollständiges HTML-Dokument', async () => {
    const preview = await serviceWith('marketing').preview('v-1');
    expect(preview.html).toMatch(/^<!doctype html>/);
    expect(preview.html.trimEnd()).toMatch(/<\/html>$/);
  });

  it('zeigt bei einer werblichen Vorlage die vollständige Fusszeile', async () => {
    // GENAU DER PUNKT: Vorher lieferte die Vorschau nur den Rumpf, und die
    // Oberfläche konnte die Pflichtangaben nicht zeigen. Eine zweite Fassung
    // davon im Browser liefe der Quelle davon — also liefert der Server sie.
    const preview = await serviceWith('marketing').preview('v-1');
    expect(preview.html).toContain('Abmelden');
    expect(preview.html).toContain('Beispiel GmbH');
    expect(preview.html).toContain('USt-IdNr.');
    expect(preview.text).toContain('Amtsgericht Musterstadt');
  });

  it('zeigt bei einer Transaktionsvorlage KEINE Abmeldefusszeile', async () => {
    const preview = await serviceWith('transactional').preview('v-1');
    // Die Zusicherung ist der fehlende ABMELDETEIL, nicht die fehlende
    // Anbieterkennung: Die steht seit [A.33] unter jeder Mail, auch unter
    // einer Rechnung. Frueher stand hier zusaetzlich
    // `not.toContain('USt-IdNr.')` und `not.toMatch(/<a\s/)` — beides waren
    // Stellvertreter fuer „kein werblicher Zusatz", und beide treffen jetzt
    // die Angabe, die dort hingehoert.
    expect(preview.html.toLowerCase()).not.toContain('abmelde');
    const targets = [...preview.html.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map(
      (hit) => hit[1] ?? '',
    );
    expect(targets.sort()).toEqual(houseLinks().map((l) => l.url).sort());
  });

  it('setzt die Beispielwerte in BEIDE Fassungen ein', async () => {
    const preview = await serviceWith('marketing').preview('v-1');
    expect(preview.html).toContain('Beispielorganisation');
    expect(preview.body).toContain('Beispielorganisation');
    expect(preview.html).not.toContain('{{organisation}}');
    expect(preview.body).not.toContain('{{organisation}}');
  });

  it('escaped einen Beispielwert, statt ihn als Markup einzusetzen', async () => {
    const preview = await serviceWith('marketing').preview('v-1', {
      organisation: '<script>alert(1)</script> & Söhne',
    });
    expect(preview.html).not.toContain('<script>alert(1)</script>');
    expect(preview.html).toContain('&lt;script&gt;');
    expect(preview.html).toContain('&amp; Söhne');
  });

  it('liefert den Textteil zusätzlich zum HTML', async () => {
    const preview = await serviceWith('marketing').preview('v-1');
    expect(preview.text).toContain(LANG);
    expect(preview.text).not.toMatch(/<[a-z]/i);
  });

  it('verschickt nichts', async () => {
    // Die Vorschau baut dieselbe Mail wie der Versand — aber sie gibt sie
    // zurück, statt sie einer Adresse zu übergeben. Es gibt hier kein
    // Empfängerfeld und keinen Weg zu einem.
    const preview = await serviceWith('marketing').preview('v-1');
    expect(Object.keys(preview).sort()).toEqual([
      'body',
      'html',
      'subject',
      'text',
      'used',
    ]);
  });
});

describe('Der Abmeldelink der Vorschau ist erkennbar ein Beispiel', () => {
  it('steht als Beispielwert in der eingesetzten Liste', async () => {
    const { service } = buildService({
      contentText: LANG,
      contentHtml: `<p>${LANG}</p>`,
    });
    const preview = await service.preview('v-1');
    expect(preview.used['abmeldelink']).toContain('token');
    // Und er ist nicht der echte Link einer echten Empfängerin.
    expect(preview.used['abmeldelink']).not.toBe(UNSUBSCRIBE_LINK);
  });
});
