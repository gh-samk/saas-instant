import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { ProductProvider, showsBrand, useProduct } from './ProductContext';

function Show() {
  const p = useProduct();
  return (
    <p data-testid="out">
      {p.productName}|{String(p.bound)}|{String(p.showBrand)}
    </p>
  );
}

function stubConfig(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ohne Speicher
  }
});
afterEach(() => vi.unstubAllGlobals());

describe('ProductProvider', () => {
  it('zeigt "SAAS Verwaltung" ohne Anbindung (kein Untertitel, Name endet auf Verwaltung)', async () => {
    stubConfig({ productName: 'SAAS Verwaltung', logoUrl: null, bound: false });
    render(
      <ProductProvider>
        <Show />
      </ProductProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('out')).toHaveTextContent('SAAS Verwaltung|false|false'),
    );
    expect(document.title).toBe('SAAS Verwaltung');
  });

  it('zeigt den Softwarenamen, sobald bound=true', async () => {
    stubConfig({ productName: 'Mein Produkt', logoUrl: null, bound: true });
    render(
      <ProductProvider>
        <Show />
      </ProductProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('out')).toHaveTextContent('Mein Produkt|true|true'),
    );
    expect(document.title).toBe('Mein Produkt');
  });

  it('ignoriert einen Namen, solange bound=false', async () => {
    stubConfig({ productName: 'Geheim', logoUrl: null, bound: false });
    render(
      <ProductProvider>
        <Show />
      </ProductProvider>,
    );
    await waitFor(() => expect(document.title).toBe('SAAS Verwaltung'));
    expect(screen.getByTestId('out')).toHaveTextContent('SAAS Verwaltung|false');
  });

  it('startet beim erneuten Laden ohne Flackern mit dem gemerkten Softwarenamen', async () => {
    window.localStorage.setItem(
      'product-config',
      JSON.stringify({ productName: 'Mein Produkt', logoUrl: null, bound: true }),
    );
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(
      <ProductProvider>
        <Show />
      </ProductProvider>,
    );
    expect(screen.getByTestId('out')).toHaveTextContent('Mein Produkt|true|true');
  });
});

describe('showsBrand', () => {
  it('entfällt, wenn der Name auf "Verwaltung" endet', () => {
    expect(showsBrand('SAAS Verwaltung')).toBe(false);
    expect(showsBrand('Mein Produkt Verwaltung ')).toBe(false);
    expect(showsBrand('Mein Produkt')).toBe(true);
  });
});

describe('Akzentfarbe und Logo aus /api/public-config', () => {
  function Accent() {
    const p = useProduct();
    return (
      <p data-testid="accent">
        {p.accentColor}|{String(p.hasLogo)}|{p.logoUrl ?? 'kein Logo'}
      </p>
    );
  }
  const styleText = () => document.getElementById('accent-theme')?.textContent ?? null;

  beforeEach(() => document.getElementById('accent-theme')?.remove());
  afterEach(() => document.getElementById('accent-theme')?.remove());

  it('bleibt bei #0369a1 und setzt nichts, solange keine Farbe konfiguriert ist', async () => {
    stubConfig({ productName: 'X', logoUrl: null, bound: true });
    render(
      <ProductProvider>
        <Accent />
      </ProductProvider>,
    );
    await waitFor(() => expect(document.title).toBe('X'));
    expect(screen.getByTestId('accent')).toHaveTextContent('#0369a1|false|kein Logo');
    expect(styleText()).toBeNull();
  });

  it('setzt Hell- und Dunkel-Token der konfigurierten Farbe und merkt sie sich', async () => {
    stubConfig({
      productName: 'X',
      bound: true,
      accentColor: '#b45309',
      accentOnDark: '#f59e0b',
      hasLogo: true,
    });
    render(
      <ProductProvider>
        <Accent />
      </ProductProvider>,
    );
    await waitFor(() => expect(styleText()).not.toBeNull());
    const css = styleText()!;
    expect(css).toContain('html:root { --farbe-primaer: #b45309;');
    expect(css).toContain('html:root[data-theme="dark"]');
    expect(css).toContain('--farbe-primaer-soft:');
    expect(screen.getByTestId('accent')).toHaveTextContent('#b45309|true|/api/public/logo');
    expect(window.localStorage.getItem('saas-instant.accent')).toContain('#b45309');
  });

  it('startet mit der gemerkten Farbe, ohne auf die Antwort zu warten (kein Flackern)', () => {
    window.localStorage.setItem(
      'saas-instant.accent',
      JSON.stringify({ accentColor: '#15803d', accentOnDark: null }),
    );
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(
      <ProductProvider>
        <Accent />
      </ProductProvider>,
    );
    expect(screen.getByTestId('accent')).toHaveTextContent('#15803d|false|kein Logo');
  });

  it('entfernt die Überschreibung, wenn die Konfiguration wieder den Standard meldet', async () => {
    document.head.appendChild(Object.assign(document.createElement('style'), { id: 'accent-theme', textContent: 'html:root{}' }));
    stubConfig({ productName: 'X', bound: true, accentColor: '#0369a1' });
    render(
      <ProductProvider>
        <Accent />
      </ProductProvider>,
    );
    await waitFor(() => expect(styleText()).toBeNull());
  });

  it('ignoriert eine Farbe unter 4,5:1 und eine kaputte Angabe', async () => {
    stubConfig({ productName: 'X', bound: true, accentColor: '#ffff00' });
    render(
      <ProductProvider>
        <Accent />
      </ProductProvider>,
    );
    await waitFor(() => expect(document.title).toBe('X'));
    expect(styleText()).toBeNull();
  });
});
