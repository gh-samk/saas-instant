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
