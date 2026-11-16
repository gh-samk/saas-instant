import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { AuthProvider, useAuth } from './AuthContext';
import { readRecentCompanyIds, rememberCompanyId } from '../lib/recent-companies';

const STATE = {
  user: { id: 'u1', username: 'admin' },
  passwordSet: true,
  passkeyCount: 0,
  totpSetUp: true,
  emailCodeSetUp: false,
  loginCodeEmail: 'a@example.com',
  setUpFactors: ['totp'],
  openRecoveryCodes: 0,
};

function Logout() {
  const { state, logout } = useAuth();
  return (
    <button type="button" onClick={() => void logout()}>
      {state ? 'abmelden' : 'weg'}
    </button>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/auth/csrf')) return new Response(JSON.stringify({ csrfToken: 'x' }), { status: 200 });
      if (String(url).endsWith('/api/auth/me')) return new Response(JSON.stringify(STATE), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('AuthProvider', () => {
  it('Abmelden leert die zuletzt geöffneten Organisationen', async () => {
    rememberCompanyId('u1', 'company-1');
    expect(readRecentCompanyIds('u1')).toEqual(['company-1']);
    render(
      <AuthProvider>
        <Logout />
      </AuthProvider>,
    );
    const button = await screen.findByRole('button', { name: 'abmelden' });
    await act(async () => button.click());
    await waitFor(() => expect(screen.getByRole('button', { name: 'weg' })).toBeInTheDocument());
    expect(readRecentCompanyIds('u1')).toEqual([]);
  });
});
