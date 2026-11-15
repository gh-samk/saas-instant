import { ManifestService } from '../manifest/manifest.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertEnvSlugMatches,
  InstallationService,
} from './installation.service';

interface Row {
  id: string;
  slug: string;
  productName: string;
}

function build(slug: string, name: string, initial?: Row) {
  let row: Row | null = initial ?? null;
  const updates: Partial<Row>[] = [];
  const prisma = {
    installation: {
      createMany: async ({ data }: { data: Row[] }) => {
        if (!row) row = { ...data[0] };
        return { count: 1 };
      },
      findUnique: async () => row,
      update: async ({ data }: { data: Partial<Row> }) => {
        updates.push(data);
        row = { ...row!, ...data };
        return row;
      },
    },
  } as unknown as PrismaService;
  const manifest = { product: { slug, name } } as unknown as ManifestService;
  return {
    service: new InstallationService(prisma, manifest),
    row: () => row,
    updates,
  };
}

describe('InstallationService', () => {
  const before = process.env['SAAS_INSTANT_SLUG'];
  afterEach(() => {
    if (before === undefined) delete process.env['SAAS_INSTANT_SLUG'];
    else process.env['SAAS_INSTANT_SLUG'] = before;
  });

  it('Erststart schreibt Slug und Namen', async () => {
    delete process.env['SAAS_INSTANT_SLUG'];
    const t = build('mein-produkt', 'Mein Produkt');
    await t.service.onApplicationBootstrap();
    expect(t.row()).toEqual({
      id: 'singleton',
      slug: 'mein-produkt',
      productName: 'Mein Produkt',
    });
  });

  it('gleicher Slug startet, Namensänderung wird nachgetragen', async () => {
    const t = build('mein-produkt', 'Neuer Name', {
      id: 'singleton',
      slug: 'mein-produkt',
      productName: 'Alter Name',
    });
    await expect(t.service.bind()).resolves.toBeUndefined();
    expect(t.updates).toEqual([{ productName: 'Neuer Name' }]);
  });

  it('abweichender Slug bricht den Start mit klarer Meldung ab', async () => {
    const t = build('anderes', 'Anderes', {
      id: 'singleton',
      slug: 'mein-produkt',
      productName: 'Mein Produkt',
    });
    await expect(t.service.bind()).rejects.toThrow(
      /an die Software "mein-produkt" gebunden/,
    );
    expect(t.row()!.slug).toBe('mein-produkt');
  });

  it('SAAS_INSTANT_SLUG muss zum Manifest-Slug passen', async () => {
    process.env['SAAS_INSTANT_SLUG'] = 'fremd';
    const t = build('mein-produkt', 'Mein Produkt');
    await expect(t.service.bind()).rejects.toThrow(/SAAS_INSTANT_SLUG/);
    expect(t.row()).toBeNull();
  });

  it('assertEnvSlugMatches: leer oder gleich ist in Ordnung', () => {
    expect(() => assertEnvSlugMatches(undefined, 'a')).not.toThrow();
    expect(() => assertEnvSlugMatches('', 'a')).not.toThrow();
    expect(() => assertEnvSlugMatches('a', 'a')).not.toThrow();
    expect(() => assertEnvSlugMatches('b', 'a')).toThrow();
  });
});
