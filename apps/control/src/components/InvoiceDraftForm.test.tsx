import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function show(invoice: Invoice | null = draft('C62'), company: Company = COMPANY) {
  return render(
    <ToastProvider>
      <InvoiceDraftForm
        company={company}
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
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(updateInvoiceDraft).toHaveBeenCalled());
    expect((updateInvoiceDraft.mock.calls[0]?.[1] as { lines: { unit: string }[] }).lines[0]?.unit).toBe('C62');
  });

  it('zeigt einen unbekannten Altwert weiter an und weist ihn vor dem Senden ab, wenn er zu lang ist', async () => {
    show(draft('Container'));
    await openMore();
    const select = screen.getByLabelText('Einheit') as HTMLSelectElement;
    expect(select.value).toBe('Container');
    expect(within(select).getByRole('option', { name: 'Container' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    const unit = await screen.findByLabelText('Einheit');
    await waitFor(() => expect(document.activeElement).toBe(unit));
    expect(screen.getByText('1 Angabe prüfen')).toBeInTheDocument();
  });

  it('zeigt bei einem unbekannten Serverfehler einen deutschen Standardtext statt des Rohtextes', async () => {
    updateInvoiceDraft.mockRejectedValue(new ApiError({ code: 'HTTP_500', message: 'Internal server error' }, 500));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Der Entwurf konnte nicht gespeichert werden.');
    expect(document.body.textContent).not.toMatch(/Internal server error/);
  });
});

describe('InvoiceDraftForm: Hinweis zum Festschreiben', () => {
  it('erklärt das Festschreiben im Satz über der Leiste, nicht per Hilfe-Icon in der Leiste', () => {
    show();
    expect(screen.getByText(/lässt sich nicht mehr ändern oder löschen/)).toBeInTheDocument();
    // Ein Icon-Knopf in der Leiste ließ sie mobil umbrechen.
    expect(screen.queryByRole('tooltip')).toBeNull();
    const bar = screen.getByRole('region', { name: 'Rechnungsentwurf speichern' });
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Abbrechen',
      'Speichern',
      'Festschreiben …',
    ]);
  });
});

describe('InvoiceDraftForm: Leistungszeitraum nur einmal, vorbelegt aus dem Vertrag', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-17T10:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['monthly', '2026-08-01', '2026-08-31', 'monatlich'],
    ['half_yearly', '2026-07-01', '2026-12-31', 'halbjährlich'],
    ['yearly', '2026-01-01', '2026-12-31', 'jährlich'],
  ] as const)('belegt bei %s den Zeitraum vor und nennt die Herkunft', (interval, from, until, word) => {
    show(null, { ...COMPANY, paymentInterval: interval } as Company);
    expect(screen.getByLabelText(/Leistungszeitraum von/)).toHaveValue(from);
    expect(screen.getByLabelText(/Leistungszeitraum bis/)).toHaveValue(until);
    expect(
      screen.getByText(`Vorbelegt aus der Zahlungsweise des Vertrags (${word}).`),
    ).toBeInTheDocument();
  });

  it('belegt ohne Vertrag wie bisher mit dem heutigen Tag vor und nennt keine Herkunft', () => {
    show(null, { ...COMPANY, paymentInterval: null } as Company);
    expect(screen.getByLabelText(/Leistungszeitraum von/)).toHaveValue('2026-08-17');
    expect(screen.getByLabelText(/Leistungszeitraum bis/)).toHaveValue('2026-08-17');
    expect(screen.queryByText(/Vorbelegt aus der Zahlungsweise/)).toBeNull();
  });

  it('zeigt je Posten keinen Zeitraum, solange er nicht abweicht', () => {
    show(null);
    expect(screen.queryByLabelText('Zeitraum von')).toBeNull();
    expect(screen.getByRole('button', { name: /Abweichender Zeitraum/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('klappt den Posten-Zeitraum auf, sendet ihn und verwirft ihn beim Zuklappen', async () => {
    createInvoiceDraft.mockResolvedValue(draft('C62'));
    show(null);
    fireEvent.click(screen.getByRole('button', { name: /Abweichender Zeitraum/ }));
    fireEvent.change(screen.getByLabelText('Zeitraum von'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByLabelText('Zeitraum bis'), { target: { value: '2026-07-31' } });
    // Zuklappen verwirft: Es darf nichts Unsichtbares gespeichert werden.
    fireEvent.click(screen.getByRole('button', { name: /Abweichender Zeitraum/ }));
    expect(screen.queryByLabelText('Zeitraum von')).toBeNull();
    fireEvent.change(screen.getByLabelText('Bezeichnung'), { target: { value: 'Paket' } });
    fireEvent.change(screen.getByLabelText(/Einzelpreis/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Als Entwurf speichern' }));
    await waitFor(() => expect(createInvoiceDraft).toHaveBeenCalled());
    const body = createInvoiceDraft.mock.calls[0]?.[1] as {
      servicePeriodFrom: string;
      lines: { periodFrom?: string }[];
    };
    expect(body.servicePeriodFrom).toBe('2026-08-01');
    expect(body.lines[0]).not.toHaveProperty('periodFrom');
  });

  it('lässt den eigenen Posten-Zeitraum eines bestehenden Entwurfs sichtbar und aufgeklappt', () => {
    const invoice = draft('C62');
    invoice.lines[0] = { ...invoice.lines[0]!, periodFrom: '2026-07-01', periodUntil: '2026-07-31' };
    show(invoice);
    expect(screen.getByLabelText('Zeitraum von')).toHaveValue('2026-07-01');
    expect(screen.getByLabelText('Zeitraum bis')).toHaveValue('2026-07-31');
    expect(screen.getByRole('button', { name: /Abweichender Zeitraum/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('öffnet den Posten-Zeitraum und fokussiert ihn, wenn der Server dort einen Fehler meldet', async () => {
    updateInvoiceDraft.mockRejectedValue(
      validationError(['lines.0.periodFrom must be a valid ISO 8601 date string']),
    );
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    const field = await screen.findByLabelText('Zeitraum von');
    await waitFor(() => expect(document.activeElement).toBe(field));
  });
});

describe('InvoiceDraftForm: Texte und Notiz eingeklappt', () => {
  beforeEach(() => {
    updateInvoiceDraft.mockReset();
  });

  it('startet bei leeren Texten zugeklappt', () => {
    show(null);
    const toggle = screen.getByRole('button', { name: /Texte und Notiz \(optional\)/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Einleitung')).toBeNull();
    expect(screen.queryByLabelText('Zahlungshinweis')).toBeNull();
    expect(screen.queryByLabelText('Notiz')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Einleitung')).toBeInTheDocument();
    expect(screen.getByLabelText('Notiz')).toBeInTheDocument();
  });

  it('startet aufgeklappt, wenn schon ein Text befüllt ist', () => {
    show({ ...draft('C62'), paymentNote: 'Bitte überweisen.' });
    expect(screen.getByRole('button', { name: /Texte und Notiz/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Zahlungshinweis')).toHaveValue('Bitte überweisen.');
  });

  it('nennt zugeklappt, was befüllt ist', () => {
    show({ ...draft('C62'), internalNote: 'Zahlt spät.' });
    fireEvent.click(screen.getByRole('button', { name: /Texte und Notiz/ }));
    expect(screen.getByText('Befüllt: Notiz')).toBeInTheDocument();
  });

  it('öffnet den Abschnitt und fokussiert das Feld, wenn der Server dort einen Fehler meldet', async () => {
    updateInvoiceDraft.mockRejectedValue(
      validationError(['introduction must be shorter than or equal to 2000 characters']),
    );
    show();
    expect(screen.queryByLabelText('Einleitung')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    const field = await screen.findByLabelText('Einleitung');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(screen.getByRole('button', { name: /Texte und Notiz/ })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('InvoiceDraftForm: Speicherleiste', () => {
  beforeEach(() => {
    updateInvoiceDraft.mockReset();
    createInvoiceDraft.mockReset();
  });

  it('zeigt ohne Änderungen Abbrechen, Speichern und Festschreiben, aber keine Warnung', () => {
    show();
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Festschreiben …' })).toBeInTheDocument();
    expect(screen.queryByText('Ungespeicherte Änderungen')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verwerfen' })).toBeNull();
  });

  it('zeigt nach einer Änderung Verwerfen, Speichern und Festschreiben; Verwerfen setzt zurück', () => {
    show();
    const date = screen.getByLabelText(/Rechnungsdatum/);
    const before = (date as HTMLInputElement).value;
    fireEvent.change(date, { target: { value: '2026-09-01' } });
    expect(screen.getByText('Ungespeicherte Änderungen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Festschreiben …' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    expect((screen.getByLabelText(/Rechnungsdatum/) as HTMLInputElement).value).toBe(before);
    expect(screen.queryByText('Ungespeicherte Änderungen')).toBeNull();
  });

  it('hat bei einem neuen Entwurf „Als Entwurf speichern" und kein Festschreiben', () => {
    show(null);
    expect(screen.getByRole('button', { name: 'Als Entwurf speichern' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Festschreiben …' })).toBeNull();
  });
});

describe('InvoiceDraftForm: stabile Posten-IDs', () => {
  it('behält nach „Verwerfen" dieselben Feld-IDs der Posten', () => {
    show();
    const idsBefore = () =>
      [...document.querySelectorAll<HTMLElement>('[id^="posten-"]')].map((e) => e.id);
    const before = idsBefore();
    expect(before.length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/^Bezeichnung/), { target: { value: 'Geändert' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    expect(idsBefore()).toEqual(before);
    // Auch ein zweites Mal: Kein Zähler, der bei jedem Zurücksetzen weiterläuft.
    fireEvent.change(screen.getByLabelText(/^Bezeichnung/), { target: { value: 'Nochmal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    expect(idsBefore()).toEqual(before);
  });

  it('stellt nach Verwerfen auch einen gelöschten Posten unter seinem alten Schlüssel wieder her', () => {
    const two = draft('C62');
    two.lines = [...two.lines, { ...two.lines[0], id: 'p2', label: 'Zweiter Posten' }];
    show(two);
    const before = [...document.querySelectorAll<HTMLElement>('[id^="posten-"]')].map((e) => e.id);
    fireEvent.click(screen.getAllByRole('button', { name: /^Posten 1 entfernen/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    const after = [...document.querySelectorAll<HTMLElement>('[id^="posten-"]')].map((e) => e.id);
    expect(after).toEqual(before);
  });
});
