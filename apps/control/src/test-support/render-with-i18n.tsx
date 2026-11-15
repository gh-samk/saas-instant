import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '../i18n';

/** Rendert mit dem i18n-Provider (Sprache `de`), wie `browser.tsx` es in der Anwendung tut. */
export function renderWithI18n(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return render(ui, {
    wrapper: ({ children }) => <I18nProvider locale="de">{children}</I18nProvider>,
    ...options,
  });
}
