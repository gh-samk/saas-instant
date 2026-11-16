import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { loadManifest, manifestPresets, checkManifest } from './manifest.loader';
import { ManifestError } from './manifest.types';
import { ManifestService } from './manifest.service';
import { PublicConfigController } from './public-config.controller';
import { isBound, PRODUCT_PRESET } from './sections/product';

const EXAMPLE = join(__dirname, '..', '..', '..', '..', 'saas-instant.manifest.example.yaml');

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('Manifest laden', () => {
  it('liefert neutrale Vorgaben, wenn die Datei fehlt', () => {
    const e = loadManifest('/nicht/vorhanden.yaml');
    expect(e.loadedFrom).toBeNull();
    expect(e.manifest.product.name).toBe('SAAS Verwaltung');
    expect(e.manifest.mail.senderName).toBe('SAAS Verwaltung');
    expect(e.manifest.provisioning.instanceDomainBase).toBe('example.com');
    expect(e.manifest.ui.logoUrl).toBeNull();
  });

  it('lädt das Beispielmanifest vollständig und gültig', () => {
    const e = loadManifest(EXAMPLE);
    expect(e.loadedFrom).toBe(EXAMPLE);
    expect(e.manifest.billing.tiers).toHaveLength(2);
    expect(e.manifest.provisioning.instanceEnv['INSTANCE_MODE']).toBe('production');
    expect(e.manifest.mail.senderAddress).toBe('noreply@example.com');
  });

  it('liest JSON', () => {
    const p = tempFile('m.json', JSON.stringify({ product: { name: 'X', slug: 'x' } }));
    expect(loadManifest(p).manifest.product).toEqual({ name: 'X', slug: 'x' });
  });

  it('ergänzt fehlende Abschnitte mit Vorgaben', () => {
    // Geändert: Ein Name ohne Slug ist seit der Bindung ein Manifestfehler (eigener Test unten).
    const p = tempFile('m.yaml', 'product:\n  name: Nur Name\n  slug: nur-name\n');
    const m = loadManifest(p).manifest;
    expect(m.product.name).toBe('Nur Name');
    expect(m.product.slug).toBe('nur-name');
    expect(m.billing.tiers).toEqual([]);
    // Eine Namensquelle: Mail-Absender folgt dem Produktnamen, solange er nicht überschrieben ist.
    expect(m.mail.senderName).toBe('Nur Name');
  });

  it('product.name ohne product.slug ist ein Manifestfehler', () => {
    const p = tempFile('m.yaml', 'product:\n  name: Nur Name\n');
    expect(() => loadManifest(p)).toThrow(/product\.slug/);
  });

  it('mail.senderName überschreibt den Produktnamen', () => {
    const m = checkManifest({
      product: { name: 'X', slug: 'x' },
      mail: { senderName: 'Eigener' },
    });
    expect(m.mail.senderName).toBe('Eigener');
  });

  it('meldet kaputtes YAML mit Dateiname', () => {
    const p = tempFile('m.yaml', 'product: [unclosed');
    expect(() => loadManifest(p)).toThrow(ManifestError);
  });
});

describe('Manifest validieren', () => {
  function errorFrom(raw: unknown): string[] {
    try {
      checkManifest(raw);
    } catch (e) {
      return (e as ManifestError).error;
    }
    return [];
  }

  it('Vorgaben sind selbst gültig', () => {
    expect(() => manifestPresets()).not.toThrow();
  });

  it('sammelt mehrere Fehler mit Pfad', () => {
    const f = errorFrom({
      product: { slug: 'Ungültig Slug' },
      mail: { senderAddress: 'keine-adresse' },
      billing: { taxRatePercent: -1, tiers: [{ label: 'x' }, { key: 'a', priceCents: -1 }] },
      provisioning: { subdomainPattern: 'fest.example.com', metricsPath: 'metrics' },
      ui: { logoUrl: 'logo.png' },
      unknown: {},
    });
    const text = f.join('\n');
    expect(text).toContain('product.slug');
    expect(text).toContain('mail.senderAddress');
    expect(text).toContain('billing.taxRatePercent');
    expect(text).toContain('billing.tiers[0].key');
    expect(text).toContain('billing.tiers[1].priceCents');
    expect(text).toContain('{slug}');
    expect(text).toContain('provisioning.metricsPath');
    expect(text).toContain('ui.logoUrl');
    expect(text).toContain('unknown: unbekannter Abschnitt');
  });

  it('lehnt doppelte Stufenschlüssel und falsche Typen ab', () => {
    const f = errorFrom({
      billing: { tiers: [{ key: 'a' }, { key: 'a' }] },
      mail: 5,
      provisioning: { instanceEnv: { A: { x: 1 } } },
    });
    expect(f.join('\n')).toContain('kommt doppelt vor');
    expect(f.join('\n')).toContain('mail: muss ein Objekt sein');
    expect(f.join('\n')).toContain('provisioning.instanceEnv.A');
  });

  it('lehnt eine Nicht-Objekt-Wurzel ab', () => {
    expect(errorFrom(['a'])[0]).toContain('Wurzel');
  });
});

describe('ManifestService + GET /api/public-config', () => {
  const before = process.env['MANIFEST_PATH'];
  afterEach(() => {
    if (before === undefined) delete process.env['MANIFEST_PATH'];
    else process.env['MANIFEST_PATH'] = before;
  });

  async function build(): Promise<{ s: ManifestService; c: PublicConfigController }> {
    const m = await Test.createTestingModule({
      controllers: [PublicConfigController],
      providers: [ManifestService],
    }).compile();
    return { s: m.get(ManifestService), c: m.get(PublicConfigController) };
  }

  it('nutzt MANIFEST_PATH', async () => {
    process.env['MANIFEST_PATH'] = EXAMPLE;
    const { s } = await build();
    expect(s.loadedFrom).toBe(EXAMPLE);
    expect(s.product.slug).toBe('mein-produkt');
  });

  it('fällt ohne Datei auf Vorgaben zurück', async () => {
    process.env['MANIFEST_PATH'] = '/nicht/da.yaml';
    const { s } = await build();
    expect(s.loadedFrom).toBeNull();
    expect(s.ui.productName).toBeNull();
    expect(s.displayName).toBe('SAAS Verwaltung');
    expect(s.bound).toBe(false);
  });

  it('public-config ohne Anbindung: Preset-Name, bound=false', async () => {
    process.env['MANIFEST_PATH'] = '/nicht/da.yaml';
    const { c } = await build();
    expect(await c.read()).toEqual({
      productName: 'SAAS Verwaltung',
      logoUrl: null,
      bound: false,
      accentColor: null,
      accentOnDark: null,
      hasLogo: false,
      authMode: 'single',
    });
  });

  it('public-config mit Anbindung: Softwarename, bound=true', async () => {
    const p = tempFile('m.yaml', 'product:\n  name: Beispielprodukt\n  slug: beispielprodukt\n');
    process.env['MANIFEST_PATH'] = p;
    const { c } = await build();
    expect(await c.read()).toMatchObject({ productName: 'Beispielprodukt', bound: true });
  });

  it.each(['Mein Produkt', 'SAAS Verwaltung', '   '])(
    'Platzhaltername %j gilt nicht als angebunden',
    (name) => {
      expect(isBound({ ...PRODUCT_PRESET, name, slug: 'x' })).toBe(false);
    },
  );

  it('Beispielmanifest mit dem Platzhalter „Mein Produkt": bound=false', async () => {
    const p = tempFile('m.yaml', 'product:\n  name: Mein Produkt\n  slug: mein-produkt\n');
    process.env['MANIFEST_PATH'] = p;
    const { c } = await build();
    expect(await c.read()).toMatchObject({ productName: 'SAAS Verwaltung', bound: false });
  });

  it('ui.productName ist nur ein Override und wirkt erst nach der Anbindung', async () => {
    const unbound = tempFile('a.yaml', 'ui:\n  productName: Override\n');
    process.env['MANIFEST_PATH'] = unbound;
    expect((await (await build()).c.read()).productName).toBe('SAAS Verwaltung');
    const bound = tempFile(
      'b.yaml',
      'product:\n  name: Beispielprodukt\n  slug: beispielprodukt\nui:\n  productName: Override\n',
    );
    process.env['MANIFEST_PATH'] = bound;
    expect((await (await build()).c.read()).productName).toBe('Override');
  });

  it('öffentlicher Endpunkt liefert nur den UI-Teil', async () => {
    process.env['MANIFEST_PATH'] = EXAMPLE;
    const { c } = await build();
    const response = await c.read();
    expect(Object.keys(response).sort()).toEqual(['accentColor', 'accentOnDark', 'authMode', 'bound', 'hasLogo', 'logoUrl', 'productName']);
    expect(JSON.stringify(response)).not.toContain('billing@example.com');
  });

  it('ist im Controller-Metadatum unter public-config registriert, ohne Guard-Abhängigkeit', () => {
    expect(Reflect.getMetadata('path', PublicConfigController)).toBe('public-config');
  });
});
