import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * [K1] Ein Fehler in einer Karte darf nicht die Seite auslöschen.
 *
 * Der eigentliche Befund war nicht der `undefined`-Wert, sondern dass ein
 * einzelner Lesezugriff die ganze Seite weiß machen konnte — Kopfzeile und
 * Navigation eingeschlossen. Diese Tests halten das Netz fest.
 */

/** Eine Komponente, die beim ersten Rendern platzt und danach nicht mehr. */
function Flaky({ platzt }: { platzt: boolean }) {
  if (platzt) throw new Error('absichtlich kaputt');
  return <p>Karteninhalt</p>;
}

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React schreibt zusätzlich selbst auf die Konsole; die Ausgabe würde die
  // Testausgabe sonst unlesbar machen.
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('[K1] Fehlergrenze', () => {
  it('reicht heile Kinder unverändert durch', () => {
    render(
      <ErrorBoundary area="Die Instanz">
        <Flaky platzt={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Karteninhalt')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ersetzt NUR den kaputten Teil und lässt die Geschwister stehen', () => {
    render(
      <div>
        <p>Stammdaten</p>
        <ErrorBoundary area="Die Instanz">
          <Flaky platzt />
        </ErrorBoundary>
        <p>Rechnungen</p>
      </div>,
    );

    // Der Rest der Seite lebt — das ist der Kern des Befunds.
    expect(screen.getByText('Stammdaten')).toBeInTheDocument();
    expect(screen.getByText('Rechnungen')).toBeInTheDocument();
    // Und der ausgefallene Teil ist BENANNT, nicht bloß „etwas ging schief".
    expect(
      screen.getByText('Die Instanz konnte nicht angezeigt werden.'),
    ).toHaveAttribute('role', 'alert');
  });

  it('schluckt den Fehler nicht — er steht in der Konsole', () => {
    render(
      <ErrorBoundary area="Die Instanz">
        <Flaky platzt />
      </ErrorBoundary>,
    );
    expect(
      consoleSpy.mock.calls.some(
        (call) => String(call[0]).includes('[Fehlergrenze]') &&
          String(call[1]).includes('absichtlich kaputt'),
      ),
    ).toBe(true);
  });

  it('baut den Teil auf Knopfdruck neu auf', () => {
    const { rerender } = render(
      <ErrorBoundary area="Die Instanz">
        <Flaky platzt />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Ursache behoben (hier: das Kind platzt nicht mehr), dann neu aufbauen.
    rerender(
      <ErrorBoundary area="Die Instanz">
        <Flaky platzt={false} />
      </ErrorBoundary>,
    );
    // Ohne Klick bleibt die Meldung stehen: Die Grenze rät nicht, wann es
    // wieder geht.
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(screen.getByText('Karteninhalt')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sagt in der Bereichsvariante, dass Navigation und Kopf weiterlaufen', () => {
    render(
      <ErrorBoundary area="Diese Ansicht" variant="area">
        <Flaky platzt />
      </ErrorBoundary>,
    );
    expect(
      screen.getByText(/Kopfzeile und Navigation funktionieren weiter/),
    ).toBeInTheDocument();
  });
});
