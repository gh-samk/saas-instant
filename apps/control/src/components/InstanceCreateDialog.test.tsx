import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { InstanceCreateDialog } from './InstanceCreateDialog';

const fetchSubdomainSuggestion = vi.fn();
const checkSubdomain = vi.fn();
vi.mock('../lib/api', () => ({
  fetchSubdomainSuggestion: (...a: unknown[]) => fetchSubdomainSuggestion(...a),
  checkSubdomain: (...a: unknown[]) => checkSubdomain(...a),
  generateInstancePreview: vi.fn(),
  createInstance: vi.fn(),
}));

const TAKEN = { available: false, reason: 'taken' };
const FREE = { available: true };
const WAIT = { timeout: 3000 };

function show() {
  return render(
    <InstanceCreateDialog
      open
      companyId="c1"
      companyName="Muster e. V."
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
}

function field(): HTMLInputElement {
  return screen.getByLabelText(/^Subdomain/) as HTMLInputElement;
}

describe('InstanceCreateDialog: Prüfzustand der Subdomain', () => {
  beforeEach(() => {
    fetchSubdomainSuggestion.mockReset().mockResolvedValue({ subdomain: 'muster' });
    checkSubdomain.mockReset();
  });

  it('kennzeichnet die Subdomain als Pflichtfeld', async () => {
    checkSubdomain.mockResolvedValue(FREE);
    show();
    expect(await screen.findByLabelText('Subdomain *')).toBeRequired();
  });

  it('ersetzt einen vergebenen Vorschlag still durch den ersten freien, ohne Fehlermeldung', async () => {
    checkSubdomain.mockImplementation(async (_c: string, value: string) =>
      value === 'muster' ? TAKEN : FREE,
    );
    show();
    await waitFor(() => expect(field().value).toBe('muster-2'), WAIT);
    expect(await screen.findByText('Verfügbar', undefined, WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/bereits vergeben/)).not.toBeInTheDocument();
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('meldet „vergeben" erst nach Eingabe und bietet den freien Namen an', async () => {
    checkSubdomain.mockImplementation(async (_c: string, value: string) =>
      value === 'verein' ? TAKEN : FREE,
    );
    show();
    await waitFor(() => expect(field().value).toBe('muster'), WAIT);
    fireEvent.change(field(), { target: { value: 'verein' } });
    expect(await screen.findByText('Diese Subdomain ist bereits vergeben.', undefined, WAIT)).toBeInTheDocument();
    const offer = await screen.findByRole('button', { name: 'verein-2' }, WAIT);
    fireEvent.click(offer);
    expect(field().value).toBe('verein-2');
    expect(await screen.findByText('Verfügbar', undefined, WAIT)).toBeInTheDocument();
  });

  it('sagt bei nicht prüfbarer Lage „Prüfung gerade nicht möglich" statt „vergeben"', async () => {
    checkSubdomain.mockResolvedValue({ available: false, reason: 'unverifiable' });
    show();
    expect(await screen.findByText(/Prüfung gerade nicht möglich/, undefined, WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/bereits vergeben/)).not.toBeInTheDocument();
    expect(field()).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    // Wiederholen prüft erneut — und kommt diesmal durch.
    checkSubdomain.mockResolvedValue(FREE);
    fireEvent.click(screen.getByRole('button', { name: 'Erneut prüfen' }));
    expect(await screen.findByText('Verfügbar', undefined, WAIT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeEnabled();
  });

  it('behandelt einen Netzfehler wie „nicht prüfbar", nicht wie „vergeben"', async () => {
    checkSubdomain.mockRejectedValue(new TypeError('Failed to fetch'));
    show();
    expect(await screen.findByText(/Prüfung gerade nicht möglich/, undefined, WAIT)).toBeInTheDocument();
    expect(screen.queryByText(/bereits vergeben/)).not.toBeInTheDocument();
  });
});
