import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Dialog } from './Dialog';

/**
 * DER FEHLER, DEN DIESE TESTS FESTHALTEN: Nach jedem Buchstaben in einem
 * Eingabefeld sprang der Cursor auf das Schließen-X.
 *
 * Ursache war `onSchliessen` in der Abhängigkeitsliste der Fokusfalle. Fast
 * alle Aufrufer übergeben dort eine Pfeilfunktion — bei jedem Rendern eine
 * neue Identität. Der Effekt lief also nach jedem Tastendruck erneut und
 * griff nach dem ersten bedienbaren Element.
 *
 * Der Test bildet genau das nach: ein Dialog, dessen `onSchliessen` bei jedem
 * Rendern neu entsteht, und ein Eingabefeld mit eigenem Zustand.
 */
function DialogWithField({ autoFocus = false }: { autoFocus?: boolean }) {
  const [value, setValue] = useState('');
  return (
    <Dialog
      open
      title="Organisation anlegen"
      // BEWUSST instabil — genau das tun 52 der 67 Aufrufstellen.
      onClose={() => undefined}
    >
      <input
        aria-label="Name"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </Dialog>
  );
}

describe('Dialog — Fokus beim Tippen', () => {
  it('lässt den Fokus im Eingabefeld, Buchstabe für Buchstabe', () => {
    render(<DialogWithField />);
    const field = screen.getByLabelText('Name') as HTMLInputElement;
    field.focus();

    for (const character of ['M', 'Mu', 'Mus', 'Must']) {
      fireEvent.change(field, { target: { value: character } });
      expect(document.activeElement).toBe(field);
    }
    expect(field.value).toBe('Must');
  });

  it('reisst den Fokus nicht auf das Schließen-X', () => {
    render(<DialogWithField />);
    const field = screen.getByLabelText('Name');
    const close = screen.getByRole('button', { name: /schlie/i });
    field.focus();

    fireEvent.change(field, { target: { value: 'A' } });

    expect(document.activeElement).not.toBe(close);
    expect(document.activeElement).toBe(field);
  });

  it('respektiert autoFocus im Inhalt, statt das X zu greifen', () => {
    render(<DialogWithField autoFocus />);
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('fokussiert ohne autoFocus das erste bedienbare Element', () => {
    render(
      <Dialog open title="Ohne Feld" onClose={() => undefined}>
        <p>Nur Text</p>
      </Dialog>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /schlie/i }),
    );
  });

  it('Escape ruft die AKTUELLE Schliessen-Funktion, nicht eine veraltete', () => {
    const firstCall: string[] = [];
    function Shell() {
      const [number, setNumber] = useState(0);
      return (
        <Dialog
          open
          title="Test"
          onClose={() => firstCall.push(`stand-${number}`)}
        >
          <button onClick={() => setNumber((z) => z + 1)}>Hochzaehlen</button>
        </Dialog>
      );
    }
    render(<Shell />);

    fireEvent.click(screen.getByRole('button', { name: 'Hochzaehlen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hochzaehlen' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    // Ohne die Ref haette hier der Stand vom ersten Rendern gestanden.
    expect(firstCall).toEqual(['stand-2']);
  });

  it('gibt den Fokus beim Schliessen an das Element davor zurueck', () => {
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Oeffnen</button>
          <Dialog open={open} title="Test" onClose={() => setOpen(false)}>
            <p>Inhalt</p>
          </Dialog>
        </>
      );
    }
    render(<Toggle />);
    const open = screen.getByRole('button', { name: 'Oeffnen' });
    open.focus();
    fireEvent.click(open);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(document.activeElement).toBe(open);
  });

  /**
   * Regressionstest: Mit `autoFocus` im Inhalt merkte sich der Dialog das
   * FELD als „vorher fokussiert" (autoFocus greift vor dem Effekt) und gab
   * den Fokus beim Schliessen an ein entferntes Element — er fiel auf <body>.
   */
  it('gibt den Fokus auch mit autoFocus im Inhalt an den Ausloeser zurueck', () => {
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Oeffnen</button>
          <Dialog open={open} title="Test" onClose={() => setOpen(false)}>
            <textarea aria-label="Text" autoFocus />
          </Dialog>
        </>
      );
    }
    render(<Toggle />);
    const open = screen.getByRole('button', { name: 'Oeffnen' });
    open.focus();
    fireEvent.click(open);
    expect(document.activeElement).toBe(screen.getByLabelText('Text'));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(document.activeElement).toBe(open);
  });

  it('greift nicht ins Leere, wenn der Ausloeser inzwischen verschwunden ist', () => {
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          {!open && <button onClick={() => setOpen(true)}>Oeffnen</button>}
          <button>Bleibt</button>
          <Dialog open={open} title="Test" onClose={() => setOpen(false)}>
            <p>Inhalt</p>
          </Dialog>
        </>
      );
    }
    render(<Toggle />);
    const open = screen.getByRole('button', { name: 'Oeffnen' });
    open.focus();
    fireEvent.click(open);

    expect(() => fireEvent.keyDown(document, { key: 'Escape' })).not.toThrow();
    expect(open.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(open);
  });
});
