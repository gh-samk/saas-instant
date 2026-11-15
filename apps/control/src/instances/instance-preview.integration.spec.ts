import {
  createCompany,
  newPrefix,
  prisma,
  cleanUp,
  disconnect,
} from '../test-support/company-provisioning';
import { PreviewMissingError } from './instance.errors';
import { consumePreview } from './instance.preview';
import { PREVIEW_VALID_MINUTES } from './instance.rules';

/**
 * DAS RENNEN UM DIE PFLICHT-VORSCHAU — ISOLIERT.
 *
 * Warum eine eigene Suite: Beim vollständigen Anlegen fangen zusätzlich zwei
 * Datenbankschlüssel zu (`Instanz.companyId` und `Instanz.subdomain`
 * sind eindeutig). Ein Test über den ganzen Weg wäre deshalb auch dann grün,
 * wenn der Vorschau-Verbrauch NICHT atomar wäre — er prüfte in Wahrheit die
 * Schlüssel und nicht die Vorschau.
 *
 * Diese Suite prüft nur den Verbrauch. Sie fällt gegen die kaputte Fassung
 * (`findFirst` gefolgt von `update`), in der beide Aufrufe durchgehen.
 */

jest.setTimeout(60_000);

const PREFIX = newPrefix('etappe3-vorschau');

async function withPreview(subdomain: string): Promise<string> {
  const company = await createCompany(PREFIX);
  await prisma.instancePreview.create({
    data: {
      companyId: company.id,
      subdomain,
      validUntil: new Date(Date.now() + PREVIEW_VALID_MINUTES * 60_000),
    },
  });
  return company.id;
}

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

describe('consumePreview', () => {
  it('gibt sie beim ersten Mal frei', async () => {
    const companyId = await withPreview('einmal');
    await expect(
      consumePreview(prisma, companyId, 'einmal'),
    ).resolves.toBeTruthy();
  });

  it('weist den zweiten, NACHFOLGENDEN Verbrauch ab', async () => {
    const companyId = await withPreview('nacheinander');
    await consumePreview(prisma, companyId, 'nacheinander');
    await expect(
      consumePreview(prisma, companyId, 'nacheinander'),
    ).rejects.toBeInstanceOf(PreviewMissingError);
  });

  it('lässt bei TWO GLEICHZEITIGEN Aufrufen genau einen durch', async () => {
    const companyId = await withPreview('gleichzeitig');

    const results = await Promise.allSettled([
      consumePreview(prisma, companyId, 'gleichzeitig'),
      consumePreview(prisma, companyId, 'gleichzeitig'),
    ]);

    expect(results.filter((e) => e.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((e) => e.status === 'rejected')).toHaveLength(1);
  });

  /**
   * DER ENTSCHEIDENDE FALL.
   *
   * Bei nur zwei Aufrufen schiebt der Treiber die beiden Runden gelegentlich
   * so ineinander, dass selbst eine kaputte Fassung zufällig richtig
   * antwortet. Bei fünf greift der Zufall nicht mehr: gemessen fällt dieser
   * Fall gegen `findFirst` + `update` zuverlässig um.
   */
  it('lässt auch bei FÜNF gleichzeitigen Aufrufen genau einen durch', async () => {
    const companyId = await withPreview('fuenffach');

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        consumePreview(prisma, companyId, 'fuenffach'),
      ),
    );

    expect(results.filter((e) => e.status === 'fulfilled')).toHaveLength(1);
  });

  it('weist eine abgelaufene Vorschau ab', async () => {
    const company = await createCompany(PREFIX);
    await prisma.instancePreview.create({
      data: {
        companyId: company.id,
        subdomain: 'abgelaufen',
        validUntil: new Date(Date.now() - 1_000),
      },
    });
    await expect(
      consumePreview(prisma, company.id, 'abgelaufen'),
    ).rejects.toBeInstanceOf(PreviewMissingError);
  });
});
