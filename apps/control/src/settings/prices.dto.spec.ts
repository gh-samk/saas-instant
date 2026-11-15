import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PricesUpdateDto } from './dto/prices.dto';

/** Die Eingabeprüfung der Preis-API (Form, nicht Stimmigkeit — die prüft `issues()`). */

const VALID = {
  taxRatePercent: 19,
  paymentTermDays: 14,
  averageDays: 90,
  tiers: [
    { key: 'a', label: 'A', maxPersons: 10, monthlyCent: 1000, halfYearlyCent: 5500, yearlyCent: 11000, setupCent: 0 },
    { key: 'b', label: 'B', maxPersons: null, monthlyCent: 2000, halfYearlyCent: 11000, yearlyCent: 22000, setupCent: 0 },
  ],
};

async function errorsOf(body: unknown): Promise<string[]> {
  const found = await validate(plainToInstance(PricesUpdateDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return found.flatMap((f) => [f.property, ...(f.children ?? []).map((c) => c.property)]);
}

describe('PricesUpdateDto', () => {
  it('nimmt eine stimmige Liste an', async () => {
    expect(await errorsOf(VALID)).toEqual([]);
  });

  it('lehnt Gleitkomma-Beträge, negative Beträge und fremde Felder ab', async () => {
    const tiers = [{ ...VALID.tiers[0]!, monthlyCent: 19.99 }, { ...VALID.tiers[1]!, setupCent: -1 }];
    expect((await errorsOf({ ...VALID, tiers })).length).toBeGreaterThan(0);
    expect((await errorsOf({ ...VALID, extra: 1 })).length).toBeGreaterThan(0);
  });

  it('lehnt Steuersatz außerhalb 0–100, leere Stufenliste und schlechte Schlüssel ab', async () => {
    expect(await errorsOf({ ...VALID, taxRatePercent: 120 })).toContain('taxRatePercent');
    expect(await errorsOf({ ...VALID, tiers: [] })).toContain('tiers');
    const bad = [{ ...VALID.tiers[0]!, key: 'mit leerzeichen' }, VALID.tiers[1]];
    expect((await errorsOf({ ...VALID, tiers: bad })).length).toBeGreaterThan(0);
  });

  it('nimmt den Nachweis des zweiten Faktors mit', async () => {
    expect(await errorsOf({ ...VALID, currentPassword: 'x' })).toEqual([]);
    expect(await errorsOf({ ...VALID, totpCode: '123456' })).toEqual([]);
  });
});
