import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { CompanyCreateDialog } from './CompanyCreateDialog';

vi.mock('../lib/api', () => ({ createCompany: vi.fn() }));

describe('CompanyCreateDialog: Pflicht und Freiwilliges', () => {
  it('kennzeichnet nur den Namen als Pflicht, alle übrigen Felder als optional', () => {
    render(<CompanyCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText('Name der Organisation *')).toBeRequired();
    for (const label of [
      'Name der Ansprechpartnerin (optional)',
      'E-Mail (optional)',
      'Telefon (optional)',
      'Herkunft (optional)',
    ]) {
      expect(screen.getByLabelText(label)).not.toBeRequired();
    }
    expect(screen.getByText(/^\* Pflichtfeld/)).toBeInTheDocument();
  });

  it('sperrt „Anlegen", bis der Name da ist', () => {
    render(<CompanyCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Anlegen' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name der Organisation *'), { target: { value: 'Muster e. V.' } });
    expect(button).toBeEnabled();
  });
});
