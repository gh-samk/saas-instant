import React from 'react';
import ReactDOM from 'react-dom/client';
import '@saas-instant/ui/fonts';
import App from './App';
import { configureUiTexts } from '@saas-instant/ui';
import { I18nProvider, t } from './i18n';
import './index.css';
import './print.css';
import { applyTheme, readTheme } from './lib/theme';
import { applyRememberedAccent } from './lib/accent';

// Gespeichertes Farbschema vor dem ersten Rendern setzen (System = kein Attribut).
applyTheme(readTheme());
// Zuletzt bekannte Akzentfarbe sofort setzen, damit nichts von Blau umspringt.
applyRememberedAccent();

// Das Design-System liest seine Texte über die Übersetzung der Anwendung (Namespace `ui`).
configureUiTexts((key, params) => t(key, params));

const root = document.getElementById('root');
if (!root) {
  // Kein Silent Failure: fehlt der Anker, ist das Dokument kaputt — dann soll
  // der Fehler sichtbar sein und nicht in einer leeren Seite verschwinden.
  throw new Error(t('common.browser.error'));
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
