import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { PasskeyButton } from './PasskeyButton';

const baseValues = {
  label: 'Mit Passkey anmelden',
  loadingLabel: 'Warte auf Passkey …',
  onClick: () => undefined,
};

describe('PasskeySchaltflaeche', () => {
  it('zeigt im Ruhezustand das Label', () => {
    render(<PasskeyButton state="idle" {...baseValues} />);
    expect(
      screen.getByRole('button', { name: /Mit Passkey anmelden/ }),
    ).toBeInTheDocument();
  });

  it('meldet einen Fehler hörbar und lässt den Knopf bedienbar', () => {
    const onClick = vi.fn();
    render(
      <PasskeyButton
        state="error"
        {...baseValues}
        onClick={onClick}
        errorText="Der Passkey konnte nicht bestätigt werden."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Der Passkey konnte nicht bestätigt werden.',
    );
    expect(
      screen.getByRole('button', { name: /Mit Passkey anmelden/ }),
    ).toBeEnabled();
  });

  it('ersetzt den Knopf im Erfolgsfall durch die Bestätigung', () => {
    render(
      <PasskeyButton
        state="success"
        {...baseValues}
        successLabel="Passkey erfolgreich erstellt"
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Passkey erfolgreich erstellt')).toBeInTheDocument();
  });
});
