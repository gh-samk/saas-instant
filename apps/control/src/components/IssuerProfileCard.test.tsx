import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { emptyIssuerProfile, validateIssuerProfile, type IssuerProfile, type LegalForm } from '@saas-instant/shared';
import { ToastProvider } from '@saas-instant/ui';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import type { IssuerSettings } from '../lib/api';
import { LEGAL_FORM_ORDER, requiredPaths } from '../lib/issuer-fields';
import { IssuerProfileCard } from './IssuerProfileCard';

expect.extend(matchers);

const fetchIssuer = vi.fn();
const saveIssuer = vi.fn();
const uploadIssuerLogo = vi.fn();
const deleteIssuerLogo = vi.fn();
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchIssuer: (...a: unknown[]) => fetchIssuer(...a),
  saveIssuer: (...a: unknown[]) => saveIssuer(...a),
  uploadIssuerLogo: (...a: unknown[]) => uploadIssuerLogo(...a),
  deleteIssuerLogo: (...a: unknown[]) => deleteIssuerLogo(...a),
}));

function settings(profile: IssuerProfile, extra: Partial<IssuerSettings> = {}): IssuerSettings {
  return {
    profile,
    accentColor: '#0369a1',
    logo: null,
    missing: validateIssuerProfile(profile).map((i) => ({ field: i.field, label: i.label, code: i.code })),
    ...extra,
  };
}

async function renderCard(profile = emptyIssuerProfile('einzelunternehmen'), extra: Partial<IssuerSettings> = {}) {
  fetchIssuer.mockResolvedValue(settings(profile, extra));
  const view = render(
    <ToastProvider>
      <IssuerProfileCard />
    </ToastProvider>,
  );
  await screen.findByText('Firmendaten');
  return view;
}

/** Alle als Pflicht markierten Felder (ohne die Alternative USt-IdNr./Steuernummer). */
function requiredFieldsOnScreen(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-field][data-required="true"]')]
    .map((el) => el.getAttribute('data-field')!)
    .sort();
}

/** Minimaler Ersatz für user-event (im Projekt nicht installiert). */
const userEvent = {
  setup: () => ({
    click: async (el: Element) => void fireEvent.click(el),
    clear: async (el: Element) => void fireEvent.change(el, { target: { value: '' } }),
    type: async (el: Element, text: string) =>
      void fireEvent.change(el, { target: { value: (el as HTMLInputElement).value + text } }),
  }),
};

beforeEach(() => {
  fetchIssuer.mockReset();
  saveIssuer.mockReset();
  uploadIssuerLogo.mockReset();
  deleteIssuerLogo.mockReset();
});

describe('Formularfelder je Rechtsform', () => {
  for (const form of LEGAL_FORM_ORDER) {
    for (const registered of [false, true]) {
      if (registered && form !== 'einzelunternehmen' && form !== 'gbr') continue;
      it(`${form}${registered ? ' (eingetragen)' : ''}: genau die Pflichtfelder der Tabelle`, async () => {
        const profile = { ...emptyIssuerProfile(form as LegalForm), registered };
        const { container } = await renderCard(profile);
        expect(requiredFieldsOnScreen(container)).toEqual(requiredPaths(profile).sort());
        // Alle Beschriftungen sind übersetzt (kein roher Schlüssel sichtbar).
        expect(container.textContent).not.toMatch(/firma\.[a-zA-Z_]+/);
      });
    }
  }

  it('GmbH & Co. KG hat einen eigenen Abschnitt für die Komplementär-GmbH', async () => {
    await renderCard(emptyIssuerProfile('gmbh_co_kg'));
    const section = screen.getByRole('region', {
      name: 'Persönlich haftende Gesellschafterin (Komplementär-GmbH)',
    });
    expect(within(section).getByLabelText(/Firma der Komplementärin/)).toBeInTheDocument();
    expect(within(section).getByRole('group', { name: /Geschäftsführer/ })).toBeInTheDocument();
  });

  it('Einzelunternehmen und GbR zeigen den Schalter „im Register eingetragen", andere nicht', async () => {
    const { unmount } = await renderCard(emptyIssuerProfile('einzelunternehmen'));
    expect(screen.getByRole('switch', { name: /e\.K\./ })).toBeInTheDocument();
    unmount();
    const gbr = await renderCard(emptyIssuerProfile('gbr'));
    expect(screen.getByRole('switch', { name: /eGbR/ })).toBeInTheDocument();
    gbr.unmount();
    await renderCard(emptyIssuerProfile('gmbh'));
    expect(screen.queryByRole('switch', { name: /Register eingetragen/ })).toBeNull();
  });

  it('Einzelunternehmen zeigt Registerfelder erst nach dem Schalter', async () => {
    const user = userEvent.setup();
    const { container } = await renderCard(emptyIssuerProfile('einzelunternehmen'));
    expect(container.querySelector('[data-field="registerCourt"]')).toBeNull();
    await user.click(screen.getByRole('switch', { name: /e\.K\./ }));
    expect(container.querySelector('[data-field="registerCourt"]')).not.toBeNull();
    expect(container.querySelector('[data-field="registerNumber"]')).toHaveAttribute('data-required', 'true');
  });

  it('der Wechsel der Rechtsform tauscht die Felder', async () => {
    const user = userEvent.setup();
    const { container } = await renderCard(emptyIssuerProfile('einzelunternehmen'));
    expect(container.querySelector('[data-field="ownerName"]')).not.toBeNull();
    await user.click(screen.getByRole('radio', { name: 'GmbH' }));
    expect(container.querySelector('[data-field="ownerName"]')).toBeNull();
    expect(container.querySelector('[data-field="managingPersons"]')).toHaveAttribute('data-required', 'true');
  });

  it('bietet acht Rechtsformen mit Kurzbeschreibung', async () => {
    await renderCard();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(8);
    for (const r of radios) expect(r).toHaveAccessibleDescription(/.+/);
  });
});

describe('Listenfelder', () => {
  it('fügt Geschäftsführer hinzu und entfernt sie wieder', async () => {
    const user = userEvent.setup();
    await renderCard(emptyIssuerProfile('gmbh'));
    const group = screen.getByRole('group', { name: /Geschäftsführer/ });
    expect(within(group).getAllByRole('textbox')).toHaveLength(1);
    await user.click(within(group).getByRole('button', { name: 'Geschäftsführer hinzufügen' }));
    expect(within(group).getAllByRole('textbox')).toHaveLength(2);
    await user.type(within(group).getByRole('textbox', { name: 'Geschäftsführer 2' }), 'Erika Mustermann');
    await user.click(within(group).getByRole('button', { name: 'Geschäftsführer 2 entfernen' }));
    expect(within(group).getAllByRole('textbox')).toHaveLength(1);
    expect(within(group).getByRole('button', { name: 'Geschäftsführer 1 entfernen' })).toBeDisabled();
  });
});

describe('Vollständigkeitsanzeige', () => {
  it('nennt die Zahl fehlender Angaben und springt per Klick zum Feld', async () => {
    const user = userEvent.setup();
    await renderCard(emptyIssuerProfile('gmbh'));
    const box = screen.getByTestId('issuer-incomplete');
    const count = validateIssuerProfile({ ...emptyIssuerProfile('gmbh') }).length;
    expect(within(box).getByRole('heading')).toHaveTextContent(`${count} Pflichtangaben fehlen`);
    expect(box).toHaveTextContent(/erst festgeschrieben werden/);
    await user.click(within(box).getByRole('button', { name: 'Postleitzahl' }));
    expect(screen.getByLabelText(/Postleitzahl/)).toHaveFocus();
  });

  it('wechselt auf „vollständig", sobald alles ausgefüllt ist', async () => {
    const user = userEvent.setup();
    const profile: IssuerProfile = {
      ...emptyIssuerProfile('einzelunternehmen'),
      name: 'Erika Mustermann',
      ownerName: 'Erika Mustermann',
      street: 'Musterstraße 1',
      postalCode: '99999',
      city: 'Musterstadt',
      iban: 'DE89370400440532013000',
      vatId: '',
      taxNumber: '12/345/67890',
    };
    await renderCard(profile);
    expect(screen.getByTestId('issuer-complete')).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/^Steuernummer/));
    expect(screen.getByTestId('issuer-incomplete')).toHaveTextContent('1 Pflichtangabe fehlt');
    expect(screen.getByRole('button', { name: 'USt-IdNr. oder Steuernummer' })).toBeInTheDocument();
  });

  it('meldet ein ungültiges Format am Feld (aria-describedby, aria-invalid)', async () => {
    const user = userEvent.setup();
    await renderCard(emptyIssuerProfile('einzelunternehmen'));
    const iban = screen.getByLabelText(/^IBAN/);
    await user.type(iban, 'DE00');
    expect(iban).toHaveAttribute('aria-invalid', 'true');
    const described = iban.getAttribute('aria-describedby')!.split(' ');
    const texts = described.map((id) => document.getElementById(id)?.textContent ?? '');
    expect(texts.join(' ')).toMatch(/IBAN ist ungültig/);
  });

  it('zeigt nach dem Speichern die fehlenden Angaben, die der Server meldet', async () => {
    const user = userEvent.setup();
    const result = settings({ ...emptyIssuerProfile('gmbh'), name: 'Beispiel GmbH' });
    saveIssuer.mockResolvedValue(result);
    await renderCard(emptyIssuerProfile('gmbh'));
    await user.type(screen.getByLabelText(/^Firma \/ Name/), 'Beispiel GmbH');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(saveIssuer).toHaveBeenCalledTimes(1));
    expect(saveIssuer.mock.calls[0]![0].profile.name).toBe('Beispiel GmbH');
    expect(saveIssuer.mock.calls[0]![0].accentColor).toBe('#0369a1');
    await waitFor(() =>
      expect(screen.getByTestId('issuer-status')).toHaveTextContent(
        `Gespeichert. Für Rechnungen fehlen noch ${result.missing.length} Pflichtangaben.`,
      ),
    );
    // Danach erscheinen auch die „fehlt"-Hinweise an den Feldern.
    expect(screen.getAllByText('Diese Angabe ist nötig.').length).toBeGreaterThan(0);
  });
});

describe('Logo', () => {
  function fileInput(): HTMLInputElement {
    return document.getElementById('firma-logo-datei') as HTMLInputElement;
  }

  it('lehnt falsche Typen und zu große Dateien im Client ab, ohne hochzuladen', async () => {
    await renderCard();
    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'logo.svg', { type: 'image/svg+xml' })] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Nur PNG oder JPEG');
    const big = new File([new Uint8Array(512 * 1024 + 1)], 'gross.png', { type: 'image/png' });
    fireEvent.change(fileInput(), { target: { files: [big] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('größer als 512 KB'));
    expect(uploadIssuerLogo).not.toHaveBeenCalled();
  });

  it('lädt ein gültiges Logo hoch und zeigt die Vorschau auf hellem und dunklem Grund', async () => {
    uploadIssuerLogo.mockResolvedValue(null);
    await renderCard();
    fetchIssuer.mockResolvedValue(
      settings(emptyIssuerProfile('einzelunternehmen'), {
        logo: { hasLogo: true, mime: 'image/png', sha256: 'abc123' },
      }),
    );
    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(uploadIssuerLogo).toHaveBeenCalledTimes(1));
    const images = await screen.findAllByAltText('Vorschau des Logos');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('src', '/api/public/logo?v=abc123');
    expect(screen.getByText('Auf hellem Grund')).toBeInTheDocument();
    expect(screen.getByText('Auf dunklem Grund')).toBeInTheDocument();
  });

  it('entfernt das Logo', async () => {
    const user = userEvent.setup();
    deleteIssuerLogo.mockResolvedValue(null);
    await renderCard(emptyIssuerProfile('einzelunternehmen'), {
      logo: { hasLogo: true, mime: 'image/png', sha256: 'abc' },
    });
    fetchIssuer.mockResolvedValue(settings(emptyIssuerProfile('einzelunternehmen')));
    await user.click(screen.getByRole('button', { name: 'Logo entfernen' }));
    await waitFor(() => expect(deleteIssuerLogo).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByAltText('Vorschau des Logos')).toBeNull());
    expect(screen.getByText('Noch kein Logo hinterlegt.')).toBeInTheDocument();
  });
});

describe('Akzentfarbe', () => {
  it('sperrt das Speichern unter 4,5:1 und warnt mit dem Kontrastwert', async () => {
    const user = userEvent.setup();
    await renderCard();
    const hex = screen.getByLabelText('Farbwert (Hex)');
    await user.clear(hex);
    await user.type(hex, '#ffff00');
    expect(screen.getByText(/Zu hell: Kontrast 1,07:1 auf Weiß/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    expect(hex).toHaveAttribute('aria-invalid', 'true');
  });

  it('meldet ein ungültiges Format', async () => {
    const user = userEvent.setup();
    await renderCard();
    const hex = screen.getByLabelText('Farbwert (Hex)');
    await user.clear(hex);
    await user.type(hex, '#12');
    expect(screen.getByText(/Format #RRGGBB/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
  });

  it('erlaubt eine ausreichend dunkle Farbe, zeigt Vorschau und speichert sie', async () => {
    const user = userEvent.setup();
    saveIssuer.mockResolvedValue(settings(emptyIssuerProfile('einzelunternehmen'), { accentColor: '#b45309' }));
    await renderCard();
    const hex = screen.getByLabelText('Farbwert (Hex)');
    await user.clear(hex);
    await user.type(hex, '#b45309');
    expect(screen.getByText(/Das genügt/)).toBeInTheDocument();
    expect(screen.getByTestId('accent-preview-button')).toHaveStyle({ backgroundColor: '#b45309' });
    expect(screen.getByTestId('accent-preview-chip')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(saveIssuer).toHaveBeenCalled());
    expect(saveIssuer.mock.calls[0]![0].accentColor).toBe('#b45309');
  });

  it('ergänzt die fehlende Raute', async () => {
    const user = userEvent.setup();
    await renderCard();
    const hex = screen.getByLabelText('Farbwert (Hex)');
    await user.clear(hex);
    await user.type(hex, 'b45309');
    expect(hex).toHaveValue('#b45309');
  });
});

describe('Barrierefreiheit', () => {
  it('hat keine axe-Verstöße (GmbH & Co. KG)', async () => {
    const { container } = await renderCard(emptyIssuerProfile('gmbh_co_kg'));
    expect(await axe(container)).toHaveNoViolations();
  });
});
