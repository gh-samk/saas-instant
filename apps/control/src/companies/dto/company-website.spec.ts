import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompanyMasterDataDto } from './company.dto';

describe('CompanyMasterDataDto.website (F11)', () => {
  const errors = async (website: unknown) =>
    validate(plainToInstance(CompanyMasterDataDto, { website }));

  it('weist javascript:/data:-Adressen ab', async () => {
    expect((await errors('javascript:alert(1)')).length).toBe(1);
    expect((await errors('data:text/html,x')).length).toBe(1);
  });

  it('nimmt http(s) und leer an', async () => {
    expect(await errors('https://example.org')).toEqual([]);
    expect(await errors('')).toEqual([]);
  });
});
