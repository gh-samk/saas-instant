import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** Klappt „Logo und Farbe" auf (der Abschnitt ist optional und startet zu). */
function openBranding() {
  fireEvent.click(screen.getByRole('button', { name: /Logo und Farbe/ }));
}

/** Tippt einen Wert ein und verlässt das Feld (löst die Inline-Prüfung aus). */
function typeAndBlur(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
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
    const { container } = await renderCard(emptyIssuerProfile('einzelunternehmen'));
    expect(container.querySelector('[data-field="ownerName"]')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Rechtsform'), { target: { value: 'gmbh' } });
    expect(container.querySelector('[data-field="ownerName"]')).toBeNull();
    expect(container.querySelector('[data-field="managingPersons"]')).toHaveAttribute('data-required', 'true');
  });

  it('bietet die acht Rechtsformen als Auswahlliste mit Erklärtext darunter', async () => {
    await renderCard();
    const select = screen.getByRole('combobox', { name: 'Rechtsform' });
    expect(within(select).getAllByRole('option')).toHaveLength(8);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByText(/Inhaberin oder Inhaber handelt im eigenen Namen/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'eg' } });
    expect(screen.getByText(/Genossenschaft mit Vorstand/)).toBeInTheDocument();
  });
});

describe('Abschnitte und Zeilen', () => {
  it('Pflichtabschnitte stehen offen, Kontakt und Logo/Farbe eingeklappt', async () => {
    await renderCard(emptyIssuerProfile('gmbh'));
    for (const name of [/^Anschrift$/, /^Handelsregister und Geschäftsführung$/, /^Bankverbindung$/, /^Steuer$/]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    const contact = screen.getByRole('button', { name: /Kontakt/ });
    expect(contact).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Telefon')).toBeNull();
    expect(screen.getByRole('button', { name: /Logo und Farbe/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('zeigt eine Statuszeile und klappt per Klick auf und zu', async () => {
    const profile = { ...emptyIssuerProfile('gmbh'), phone: '0123 456', email: 'a@example.org' };
    await renderCard(profile);
    expect(screen.getByTestId('section-status-contact')).toHaveTextContent('2 von 3 ausgefüllt');
    expect(screen.getByTestId('section-status-branding')).toHaveTextContent('0 von 2 ausgefüllt');
    const contact = screen.getByRole('button', { name: /Kontakt/ });
    fireEvent.click(contact);
    expect(contact).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Telefon')).toHaveValue('0123 456');
    fireEvent.click(contact);
    expect(screen.queryByLabelText('Telefon')).toBeNull();
  });

  it('klappt „Logo und Farbe" bei einer ungültigen Akzentfarbe von selbst auf', async () => {
    await renderCard(emptyIssuerProfile('gmbh'), { accentColor: '#ffff00' });
    expect(screen.getByRole('button', { name: /Logo und Farbe/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Zu hell/)).toBeInTheDocument();
  });

  it('die Steuer ist kein optionaler Abschnitt (USt-IdNr. oder Steuernummer ist Pflicht)', async () => {
    await renderCard(emptyIssuerProfile('einzelunternehmen'));
    expect(screen.queryByRole('button', { name: /^Steuer/ })).toBeNull();
    expect(screen.getByLabelText(/^Steuernummer/)).toBeInTheDocument();
  });

  it('stellt Kurzfelder in Zeilen zusammen', async () => {
    await renderCard(emptyIssuerProfile('gmbh'));
    const sameRow = (a: RegExp, b: RegExp) =>
      expect(screen.getByLabelText(a).closest('.grid')).toBe(screen.getByLabelText(b).closest('.grid'));
    sameRow(/^Sitz/, /^Registergericht/);
    sameRow(/^Registergericht/, /^Registernummer/);
    sameRow(/^IBAN/, /^BIC/);
    sameRow(/^Postleitzahl/, /^Ort/);
    expect(screen.getByLabelText(/^Firma \/ Name/).closest('.grid')).not.toBe(
      screen.getByLabelText(/^Sitz/).closest('.grid'),
    );
    // Mobil untereinander: die Spalten gelten erst ab `sm`.
    expect(screen.getByLabelText(/^IBAN/).closest('.grid')!.className).toMatch(/\bsm:grid-cols-2\b/);
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
    expect(within(box).getByRole('heading')).toHaveTextContent(`Noch ${count} Pflichtangaben offen`);
    expect(within(box).getByRole('progressbar')).toHaveAttribute('aria-valuenow');
    expect(box).toHaveTextContent(/erst festgeschrieben werden/);
    await user.click(within(box).getByRole('button', { name: 'Postleitzahl' }));
    expect(screen.getByLabelText(/Postleitzahl/)).toHaveFocus();
  });

  it('springt mit „Zum ersten offenen Feld" an die erste offene Stelle der Seite', async () => {
    const user = userEvent.setup();
    await renderCard(emptyIssuerProfile('gmbh'));
    await user.click(screen.getByRole('button', { name: 'Zum ersten offenen Feld' }));
    expect(screen.getByLabelText(/^Firma \/ Name/)).toHaveFocus();
  });

  it('haftet kompakt oben, damit die Anzeige beim Scrollen sichtbar bleibt', async () => {
    await renderCard(emptyIssuerProfile('gmbh'));
    expect(screen.getByTestId('issuer-incomplete').className).toMatch(/\bsticky\b/);
  });

  describe('haftend', () => {
    // jsdom hat keinen IntersectionObserver: Der Marker wird nachgestellt.
    let report: (entry: { isIntersecting: boolean; top: number }) => void = () => undefined;
    beforeEach(() => {
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: (entries: unknown[]) => void) {
            report = ({ isIntersecting, top }) =>
              cb([{ isIntersecting, boundingClientRect: { top } }]);
          }
          observe() {}
          disconnect() {}
        },
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it('verdichtet sich auf eine Zeile, sobald der Marker unter der Kopfleiste verschwindet', async () => {
      await renderCard(emptyIssuerProfile('gmbh'));
      const box = screen.getByTestId('issuer-incomplete');
      // In Ruhe: volle Anzeige mit aufklappbarer Liste.
      expect(box).not.toHaveAttribute('data-stuck');
      expect(screen.getByText('Alle offenen Angaben anzeigen')).toBeInTheDocument();
      act(() => report({ isIntersecting: false, top: -40 }));
      expect(box).toHaveAttribute('data-stuck', 'true');
      expect(within(box).getByRole('heading')).toHaveTextContent(/^Noch \d+ offen$/);
      expect(screen.queryByText('Alle offenen Angaben anzeigen')).toBeNull();
      // Status und Sprung bleiben bedienbar.
      expect(within(box).getByRole('progressbar')).toBeInTheDocument();
      expect(within(box).getByRole('button', { name: 'Zum ersten offenen Feld' })).toBeInTheDocument();
      // Zurück nach oben: wieder die volle Anzeige.
      act(() => report({ isIntersecting: true, top: 200 }));
      expect(box).not.toHaveAttribute('data-stuck');
      expect(screen.getByText('Alle offenen Angaben anzeigen')).toBeInTheDocument();
    });

    it('verdichtet nicht, wenn der Marker nur noch unter dem Fenster liegt', async () => {
      await renderCard(emptyIssuerProfile('gmbh'));
      act(() => report({ isIntersecting: false, top: 5000 }));
      expect(screen.getByTestId('issuer-incomplete')).not.toHaveAttribute('data-stuck');
    });
  });

  it('gibt dem Sprung-Knopf und der Liste mobil 44 px Trefferfläche', async () => {
    await renderCard(emptyIssuerProfile('gmbh'));
    expect(screen.getByRole('button', { name: 'Zum ersten offenen Feld' }).className).toMatch(/\bmin-h-11\b/);
    expect(screen.getByText('Alle offenen Angaben anzeigen').className).toMatch(/\bmin-h-11\b/);
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
    expect(screen.getByTestId('issuer-complete')).toHaveTextContent('Pflichtangaben vollständig');
    expect(screen.queryByRole('button', { name: 'Zum ersten offenen Feld' })).toBeNull();
    await user.clear(screen.getByLabelText(/^Steuernummer/));
    expect(screen.getByTestId('issuer-incomplete')).toHaveTextContent('Noch 1 Pflichtangabe offen');
    expect(screen.getByRole('button', { name: 'USt-IdNr. oder Steuernummer' })).toBeInTheDocument();
  });

  it('meldet ein ungültiges Format am Feld (aria-describedby, aria-invalid)', async () => {
    const user = userEvent.setup();
    await renderCard(emptyIssuerProfile('einzelunternehmen'));
    const iban = screen.getByLabelText(/^IBAN/);
    await user.type(iban, 'DE00');
    // Erst nach dem Verlassen des Feldes.
    expect(iban).not.toHaveAttribute('aria-invalid');
    fireEvent.blur(iban);
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

describe('Prüfung beim Verlassen des Feldes', () => {
  it('meldet eine IBAN mit falscher Prüfsumme erst beim Verlassen', async () => {
    await renderCard(emptyIssuerProfile('einzelunternehmen'));
    const iban = screen.getByLabelText(/^IBAN/);
    fireEvent.change(iban, { target: { value: 'DE89 3704 0044 0532 0130 01' } });
    expect(screen.queryByText('Diese IBAN ist ungültig.')).toBeNull();
    fireEvent.blur(iban);
    expect(screen.getByText('Diese IBAN ist ungültig.')).toBeInTheDocument();
    typeAndBlur(iban, 'DE89 3704 0044 0532 0130 00');
    expect(screen.queryByText('Diese IBAN ist ungültig.')).toBeNull();
    expect(iban).not.toHaveAttribute('aria-invalid');
  });

  it('prüft die USt-IdNr.: DE mit neun Ziffern, andere Länder grob', async () => {
    await renderCard(emptyIssuerProfile('einzelunternehmen'));
    const vat = screen.getByLabelText(/^USt-IdNr\./);
    typeAndBlur(vat, 'DE12345');
    expect(vat).toHaveAttribute('aria-invalid', 'true');
    typeAndBlur(vat, 'DE123456789');
    expect(vat).not.toHaveAttribute('aria-invalid');
    typeAndBlur(vat, 'ATU12345678');
    expect(vat).not.toHaveAttribute('aria-invalid');
    typeAndBlur(vat, '12345');
    expect(vat).toHaveAttribute('aria-invalid', 'true');
  });

  it('prüft das Präfix der Registernummer passend zur Rechtsform', async () => {
    await renderCard(emptyIssuerProfile('gmbh'));
    const nr = screen.getByLabelText(/^Registernummer/);
    typeAndBlur(nr, 'HRA 12345');
    expect(screen.getByText('Die Nummer beginnt mit HRB, z. B. HRB 12345.')).toBeInTheDocument();
    typeAndBlur(nr, 'HRB 12345');
    expect(screen.queryByText(/Die Nummer beginnt mit/)).toBeNull();
  });
});

describe('Speicherleiste', () => {
  it('erscheint erst bei Änderungen und verwirft sie wieder', async () => {
    await renderCard(emptyIssuerProfile('gmbh'));
    expect(screen.queryByRole('region', { name: 'Firmendaten speichern' })).toBeNull();
    const name = screen.getByLabelText(/^Firma \/ Name/);
    fireEvent.change(name, { target: { value: 'Beispiel GmbH' } });
    const bar = screen.getByRole('region', { name: 'Firmendaten speichern' });
    expect(bar).toHaveTextContent('Ungespeicherte Änderungen');
    fireEvent.click(within(bar).getByRole('button', { name: 'Verwerfen' }));
    expect(screen.getByLabelText(/^Firma \/ Name/)).toHaveValue('');
    expect(screen.queryByRole('region', { name: 'Firmendaten speichern' })).toBeNull();
    expect(saveIssuer).not.toHaveBeenCalled();
  });

  it('speichert und blendet sich danach aus', async () => {
    const result = settings({ ...emptyIssuerProfile('gmbh'), name: 'Beispiel GmbH' });
    saveIssuer.mockResolvedValue(result);
    await renderCard(emptyIssuerProfile('gmbh'));
    fireEvent.change(screen.getByLabelText(/^Firma \/ Name/), { target: { value: 'Beispiel GmbH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(saveIssuer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Firmendaten speichern' })).toBeNull());
  });

  it('zeigt einen Speicherfehler in der Leiste', async () => {
    saveIssuer.mockRejectedValue(new Error('boom'));
    await renderCard(emptyIssuerProfile('gmbh'));
    fireEvent.change(screen.getByLabelText(/^Firma \/ Name/), { target: { value: 'X GmbH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    const bar = await screen.findByRole('region', { name: 'Firmendaten speichern' });
    await waitFor(() => expect(within(bar).getByRole('alert')).toBeInTheDocument());
  });

  it('das Logo gehört nicht zum Änderungsstand (wird sofort gespeichert)', async () => {
    uploadIssuerLogo.mockResolvedValue(null);
    await renderCard();
    openBranding();
    fetchIssuer.mockResolvedValue(
      settings(emptyIssuerProfile('einzelunternehmen'), {
        logo: { hasLogo: true, mime: 'image/png', sha256: 'abc123' },
      }),
    );
    fireEvent.change(document.getElementById('firma-logo-datei')!, {
      target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] },
    });
    await screen.findAllByAltText('Vorschau des Logos');
    expect(screen.queryByRole('region', { name: 'Firmendaten speichern' })).toBeNull();
  });
});

describe('Logo', () => {
  function fileInput(): HTMLInputElement {
    return document.getElementById('firma-logo-datei') as HTMLInputElement;
  }

  it('lehnt falsche Typen und zu große Dateien im Client ab, ohne hochzuladen', async () => {
    await renderCard();
    openBranding();
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
    openBranding();
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
    openBranding();
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
    openBranding();
    const hex = screen.getByLabelText('Farbwert (Hex)');
    await user.clear(hex);
    await user.type(hex, '#ffff00');
    expect(screen.getByText(/Zu hell: Kontrast 1,07:1 auf Weiß/)).toBeInTheDocument();
    // Die Leiste nennt den Grund, gespeichert wird nicht.
    const bar = screen.getByRole('region', { name: 'Firmendaten speichern' });
    expect(within(bar).getByRole('alert')).toHaveTextContent(/Akzentfarbe muss gültig sein/);
    fireEvent.click(within(bar).getByRole('button', { name: 'Speichern' }));
    expect(saveIssuer).not.toHaveBeenCalled();
    expect(hex).toHaveAttribute('aria-invalid', 'true');
  });

  it('meldet ein ungültiges Format', async () => {
    const user = userEvent.setup();
    await renderCard();
    openBranding();
    const hex = screen.getByLabelText('Farbwert (Hex)');
    await user.clear(hex);
    await user.type(hex, '#12');
    expect(screen.getByText(/Format #RRGGBB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(saveIssuer).not.toHaveBeenCalled();
  });

  it('erlaubt eine ausreichend dunkle Farbe, zeigt Vorschau und speichert sie', async () => {
    const user = userEvent.setup();
    saveIssuer.mockResolvedValue(settings(emptyIssuerProfile('einzelunternehmen'), { accentColor: '#b45309' }));
    await renderCard();
    openBranding();
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
    openBranding();
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
