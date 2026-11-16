import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { StickySaveBar } from './StickySaveBar';
import {
  UnsavedChangesProvider,
  stableEqual,
  useDirtyState,
  useUnsavedChanges,
} from '../lib/unsaved-changes';

/** Ein Mini-Formular: ein Feld, gespeichert wird in `saved`. */
function Form({ onSave }: { onSave: (value: string) => void }) {
  const [value, setValue] = useState('alt');
  const { dirty, baseline, isDirty, markSaved } = useDirtyState({ value });
  useUnsavedChanges(isDirty);
  return (
    <form>
      <label>
        Name
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <StickySaveBar
        dirty={dirty}
        onDiscard={() => setValue(baseline.value)}
        onSave={() => {
          onSave(value);
          markSaved();
        }}
        label="Testformular"
      />
    </form>
  );
}

function Page({ onSave = vi.fn() }: { onSave?: (value: string) => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  return (
    <>
      <Form onSave={onSave} />
      <Link to="/weg">Weg</Link>
      <button onClick={() => navigate('/anders')}>Los</button>
      <button onClick={() => setParams({ tab: 'zwei' })}>Reiter zwei</button>
      <output>{`tab=${params.get('tab') ?? ''}`}</output>
    </>
  );
}

function show(onSave?: (value: string) => void) {
  return render(
    <MemoryRouter>
      <UnsavedChangesProvider>
        <Page onSave={onSave} />
      </UnsavedChangesProvider>
    </MemoryRouter>,
  );
}

const edit = () => fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'neu' } });

describe('stableEqual', () => {
  it('vergleicht tief und unabhängig von der Schlüsselreihenfolge', () => {
    expect(stableEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(stableEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(stableEqual([1, 2], [1])).toBe(false);
  });
});

describe('StickySaveBar', () => {
  it('erscheint erst nach einer Änderung', () => {
    show();
    expect(screen.queryByRole('region', { name: 'Testformular' })).toBeNull();
    edit();
    const bar = screen.getByRole('region', { name: 'Testformular' });
    expect(bar).toHaveTextContent('Ungespeicherte Änderungen');
    expect(screen.getByRole('button', { name: 'Verwerfen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeInTheDocument();
  });

  it('verschwindet wieder, wenn der alte Wert zurückgetippt wird', () => {
    show();
    edit();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'alt' } });
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('setzt beim Verwerfen auf den gespeicherten Stand zurück', () => {
    show();
    edit();
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    expect(screen.getByLabelText('Name')).toHaveValue('alt');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('ruft beim Speichern auf, und die Leiste verschwindet', () => {
    const onSave = vi.fn();
    show(onSave);
    edit();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onSave).toHaveBeenCalledWith('neu');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('speichert mit Strg+S, nur bei Änderungen', () => {
    const onSave = vi.fn();
    show(onSave);
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
    edit();
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('zeigt Fehler in der Leiste und sperrt beim Speichern', () => {
    render(
      <StickySaveBar dirty saving error="Nicht gespeichert." onSave={vi.fn()} onDiscard={vi.fn()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Nicht gespeichert.');
    expect(screen.getByRole('button', { name: 'Verwerfen' })).toBeDisabled();
  });

  it('zeigt mit `idle` auch ohne Änderungen den Ersatzinhalt', () => {
    render(
      <StickySaveBar
        dirty={false}
        idle={<button>Zurück</button>}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Zurück' })).toBeInTheDocument();
    expect(screen.queryByText('Ungespeicherte Änderungen')).toBeNull();
  });
});

describe('Warnung beim Verlassen', () => {
  it('fragt bei einem Linkklick mit Änderungen nach; „Bleiben" bleibt', async () => {
    show();
    edit();
    fireEvent.click(screen.getByRole('link', { name: 'Weg' }));
    expect(await screen.findByRole('dialog', { name: 'Änderungen verwerfen?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Bleiben' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('Name')).toHaveValue('neu');
  });

  it('geht mit „Verwerfen und weiter" weiter', async () => {
    show();
    edit();
    fireEvent.click(screen.getByRole('button', { name: 'Los' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verwerfen und weiter' }));
    // Die Testseite hat keine Route; das Formular ist nach dem Wechsel weiter da,
    // der Dialog aber zu.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('fängt auch den Reiterwechsel per Suchparameter ab', async () => {
    show();
    edit();
    fireEvent.click(screen.getByRole('button', { name: 'Reiter zwei' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('tab=')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen und weiter' }));
    await waitFor(() => expect(screen.getByText('tab=zwei')).toBeInTheDocument());
  });

  it('fragt ohne Änderungen nicht nach', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Reiter zwei' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('tab=zwei')).toBeInTheDocument();
  });

  it('fragt nach dem Speichern nicht mehr nach', () => {
    show();
    edit();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reiter zwei' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('warnt beim Schließen des Fensters nur mit Änderungen', () => {
    show();
    const clean = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(clean);
    });
    expect(clean.defaultPrevented).toBe(false);
    edit();
    const dirty = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(dirty);
    });
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe('StickySaveBar: Platzhalter folgt der Leistenhöhe', () => {
  // jsdom kennt weder Layout noch ResizeObserver: Beides wird nachgestellt.
  let barHeight = 141;
  let notify: () => void = () => undefined;
  function mockLayout() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const h = this.getAttribute('role') === 'region' ? barHeight : 0;
      return { height: h, width: 300, top: 0, left: 0, right: 300, bottom: h, x: 0, y: 0, toJSON() {} };
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          notify = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.style.scrollPaddingBottom = '';
    barHeight = 141;
  });

  const placeholder = () => screen.getByRole('region').parentElement as HTMLElement;

  it('reserviert die gemessene Höhe (zweizeilige Leiste) statt eines festen Werts', () => {
    mockLayout();
    render(<StickySaveBar dirty onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(placeholder().style.minHeight).toBe('141px');
    expect(placeholder().className).not.toMatch(/min-h-\[/);
  });

  it('zieht bei geänderter Höhe nach (Fehlermeldung kommt dazu)', () => {
    mockLayout();
    render(<StickySaveBar dirty onSave={vi.fn()} onDiscard={vi.fn()} />);
    barHeight = 189;
    act(() => notify());
    expect(placeholder().style.minHeight).toBe('189px');
    expect(document.documentElement.style.scrollPaddingBottom).toBe('197px');
  });

  it('setzt scroll-padding-bottom am Dokument, solange die Leiste steht, und räumt auf', () => {
    mockLayout();
    const { unmount } = render(<StickySaveBar dirty onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(document.documentElement.style.scrollPaddingBottom).toBe('149px');
    unmount();
    expect(document.documentElement.style.scrollPaddingBottom).toBe('');
  });

  it('behält ohne Messung (jsdom) den Vorgabewert für eine Zeile', () => {
    render(<StickySaveBar dirty onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(placeholder().style.minHeight).toBe('4.5rem');
    expect(document.documentElement.style.scrollPaddingBottom).toBe('');
  });

  it('hält mobil einzeilig: Hinweis nur für Vorleseprogramme, Knöpfe 44 px hoch', () => {
    render(<StickySaveBar dirty onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByText('Ungespeicherte Änderungen').className).toMatch(/\bsr-only\b/);
    for (const name of ['Verwerfen', 'Speichern']) {
      expect(screen.getByRole('button', { name }).className).toMatch(/\bmin-h-11\b/);
    }
  });
});
