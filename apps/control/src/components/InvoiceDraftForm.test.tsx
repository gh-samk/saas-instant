import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@saas-instant/ui';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { ApiError } from '../lib/api-client';
import type { Company, Invoice } from '../lib/api';
import { InvoiceDraftForm } from './InvoiceDraftForm';

const updateInvoiceDraft = vi.fn();
const createInvoiceDraft = vi.fn();
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  updateInvoiceDraft: (...a: unknown[]) => updateInvoiceDraft(...a),
  createInvoiceDraft: (...a: unknown[]) => createInvoiceDraft(...a),
  deleteInvoiceDraft: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload: vi.fn().mockResolvedValue(undefined), state: { totpSetUp: false } }),
}));

const COMPANY = { id: 'c1', name: 'Solawi Rheintal', paymentInterval: 'monthly' } as unknown as Company;

function draft(unit: string | null): Invoice {
  return {
    id: 'r1',
    companyId: 'c1',
    companyName: 'Solawi Rheintal',
    introduction: null,
    paymentNote: null,
    internalNote: null,
    invoiceNumber: null,
    status: 'draft',
    paymentState: 'draft',
    invoiceDate: '2026-08-31',
    servicePeriodFrom: '2026-08-01',
    servicePeriodUntil: '2026-08-31',
    dueDate: '2026-09-14',
    lines: [
      {
        id: 'p1', label: 'Standardpaket', description: null, unit,
        periodFrom: null, periodUntil: null, quantity: '1.000', unitPriceNet: '490.00',
        taxRate: '19.00', netAmount: '490.00', taxAmount: '93.10', grossAmount: '583.10',
      },
    ],
  } as unknown as Invoice;
}

function show(invoice: Invoice | null = draft('C62')) {
  return render(
    <ToastProvider>
      <InvoiceDraftForm
        company={COMPANY}
        invoice={invoice}
        totpPossible={false}
        suggestion={null}
        suggestionError={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        onDeleted={vi.fn()}
        onFinalized={vi.fn()}
      />
    </ToastProvider>,
  );
}

function validationError(messages: string[]): ApiError {
  return new ApiError({ code: 'HTTP_400', message: messages[0] ?? '', detail: messages }, 400);
}

async function openMore() {
  fireEvent.click(screen.getByRole('button', { name: /Weitere Angaben/ }));
}

describe('InvoiceDraftForm: Einheit als Auswahl', () => {
  beforeEach(() => {
    updateInvoiceDraft.mockReset();
    createInvoiceDraft.mockReset();
  });

  it('bietet Stück, Monat, Jahr und Pauschale an', async () => {
    show();
    await openMore();
    const select = screen.getByLabelText('Einheit') as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map((o) => [o.textContent, (o as HTMLOptionElement).value])).toEqual([
      ['Stück', 'C62'],
      ['Monat', 'MON'],
      ['Jahr', 'ANN'],
      ['Pauschale', 'LS'],
    ]);
  });

  it('bildet frei getippte Altwerte („Stück") auf den Code ab, statt sie als zu lange Einheit zu schicken', async () => {
    updateInvoiceDraft.mockResolvedValue(draft('C62'));
    show(draft('Stück'));
    await openMore();
    expect((screen.getByLabelText('Einheit') as HTMLSelectElement).value).toBe('C62');
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    await waitFor(() => expect(updateInvoiceDraft).toHaveBeenCalled());
    expect((updateInvoiceDraft.mock.calls[0]?.[1] as { lines: { unit: string }[] }).lines[0]?.unit).toBe('C62');
  });

  it('zeigt einen unbekannten Altwert weiter an und weist ihn vor dem Senden ab, wenn er zu lang ist', async () => {
    show(draft('Container'));
    await openMore();
    const select = screen.getByLabelText('Einheit') as HTMLSelectElement;
    expect(select.value).toBe('Container');
    expect(within(select).getByRole('option', { name: 'Container' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByText('Wähle eine Einheit aus der Liste.')).toBeInTheDocument();
    expect(updateInvoiceDraft).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(select);
  });
});

describe('InvoiceDraftForm: Prüfmeldungen des Servers', () => {
  beforeEach(() => {
    updateInvoiceDraft.mockReset();
  });

  it('setzt die Meldung ans Feld, fokussiert es und fasst oben zusammen — auf Deutsch', async () => {
    updateInvoiceDraft.mockRejectedValue(
      validationError([
        'lines.0.unit must be shorter than or equal to 3 characters',
        'lines.0.quantity must be a number conforming to the specified constraints',
        'dueDate must be a valid ISO 8601 date string',
      ]),
    );
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));

    const summary = await screen.findByText('3 Angaben prüfen');
    const box = summary.parentElement as HTMLElement;
    expect(box).toHaveAttribute('role', 'alert');
    expect(within(box).getByText('Posten 1, Einheit: Höchstens 3 Zeichen erlaubt.')).toBeInTheDocument();
    expect(within(box).getByText('Posten 1, Menge: Bitte gib eine Zahl ein.')).toBeInTheDocument();
    expect(within(box).getByText('Fälligkeit: Bitte gib ein gültiges Datum ein.')).toBeInTheDocument();
    // Kein Rohtext irgendwo.
    expect(document.body.textContent).not.toMatch(/must be|shorter than/);

    // Die Einheit liegt hinter „Weitere Angaben": sie klappt auf, trägt die Meldung und hat den Fokus.
    // Fokus aufs erste Feld in Lesereihenfolge: die Menge (Rang vor der Einheit).
    const quantity = screen.getByLabelText('Menge');
    expect(quantity).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(document.activeElement).toBe(quantity));
    const unit = screen.getByLabelText('Einheit');
    expect(unit).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByText('Höchstens 3 Zeichen erlaubt.').length).toBeGreaterThan(0);
  });

  it('klappt „Weitere Angaben" auf und fokussiert die Einheit, wenn nur sie fehlerhaft ist', async () => {
    updateInvoiceDraft.mockRejectedValue(
      validationError(['lines.0.unit must be shorter than or equal to 3 characters']),
    );
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    const unit = await screen.findByLabelText('Einheit');
    await waitFor(() => expect(document.activeElement).toBe(unit));
    expect(screen.getByText('1 Angabe prüfen')).toBeInTheDocument();
  });

  it('zeigt bei einem unbekannten Serverfehler einen deutschen Standardtext statt des Rohtextes', async () => {
    updateInvoiceDraft.mockRejectedValue(new ApiError({ code: 'HTTP_500', message: 'Internal server error' }, 500));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Der Entwurf konnte nicht gespeichert werden.');
    expect(document.body.textContent).not.toMatch(/Internal server error/);
  });
});

describe('InvoiceDraftForm: Hilfetext zum Festschreiben', () => {
  it('hängt einen per Tastatur erreichbaren Hilfetext an „Festschreiben …"', () => {
    show();
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Danach nicht mehr änderbar, nur noch per Storno.');
    const trigger = document.querySelector(`[aria-describedby="${tooltip.id}"]`) as HTMLElement;
    expect(trigger).not.toBeNull();
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveAttribute('type', 'button');
    expect(trigger).toHaveAccessibleName('Hilfe zu diesem Feld');
  });
});
