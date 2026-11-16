import {
  Navigate,
  Route,
  BrowserRouter as Router,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { Spinner, ToastProvider } from '@saas-instant/ui';
import { AppShell } from './components/AppShell';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProductProvider, useProduct } from './context/ProductContext';
import { VaultProvider } from './context/VaultContext';
import { VaultGate } from './components/VaultGate';
import { LoginPage } from './pages/LoginPage';
import { PortalLoginPage } from './pages/PortalLoginPage';
import { NoAccessPage } from './pages/NoAccessPage';
import { StepUpDonePage } from './pages/StepUpDonePage';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage } from './pages/SettingsPage';
import { ConsentsPage } from './pages/ConsentsPage';
import { InstancesPage } from './pages/InstancesPage';
import { FirstSetupPage } from './pages/FirstSetupPage';
import { NewPasswordPage } from './pages/NewPasswordPage';
import { NewsletterBlockPage } from './pages/NewsletterBlockPage';
import { CompanyDetailPage } from './pages/CompanyDetailPage';
import { CompaniesPage } from './pages/CompaniesPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { BroadcastPage } from './pages/BroadcastPage';
import { BroadcastTemplatePage } from './pages/BroadcastTemplatePage';
import { useT } from './i18n';

/** Ganzflächiger Ladezustand, solange der eigene Stand noch unbekannt ist. */
function LoadingScreen() {
  const t = useT();
  return (
    <div className="grid min-h-dvh place-items-center bg-flaeche-2">
      <Spinner text={t('common.app.text')} />
    </div>
  );
}

/** Der erste Abruf ist gescheitert — kein Silent Failure, kein leerer Bildschirm. */
function StartError({ message }: { message: string }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-flaeche-2 px-4">
      <p role="alert" className="max-w-md text-center text-sm text-gefahr">
        {message}
      </p>
    </div>
  );
}

/**
 * Angemeldeter Bereich. Ist die Ersteinrichtung noch nicht abgeschlossen
 * (kein zweiter Faktor hinterlegt), führt der Weg zuerst durch den Wizard.
 */
function ProtectedArea() {
  const { state, loading, error } = useAuth();
  const where = useLocation();
  if (loading) return <LoadingScreen />;
  if (error) return <StartError message={error} />;
  if (!state)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${where.pathname}${where.search}` }}
      />
    );
  // Eine Portal-Sitzung braucht keine lokale Ersteinrichtung: Passwort und
  // zweiter Faktor liegen beim Portal.
  if (state.setUpFactors.length === 0 && state.viaPortal !== true)
    return <Navigate to="/first-setup" replace />;
  return (
    <VaultGate>
      <AppShell />
    </VaultGate>
  );
}

/** Anmeldeseite; wer bereits angemeldet ist, landet direkt im Dashboard. */
function LoginArea() {
  const { state, loading, error } = useAuth();
  const { authMode, configReady } = useProduct();
  const [params] = useSearchParams();
  const where = useLocation();
  if (loading || !configReady) return <LoadingScreen />;
  if (error) return <StartError message={error} />;
  if (state) return <Navigate to="/" replace />;
  // Modus `portal`: ohne Sitzung geht es zum Portal; der Notzugang
  // (`?notfall=1`) zeigt die lokale Anmeldung.
  if (authMode === 'portal' && params.get('notfall') !== '1') {
    const from = (where.state as { from?: unknown } | null)?.from;
    const returnPath =
      typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')
        ? from
        : '/';
    return (
      <PortalLoginPage
        failed={params.get('sso') === 'failed'}
        returnPath={returnPath}
      />
    );
  }
  return <LoginPage />;
}

/** Wizard: erreichbar angemeldet ODER über einen Notfall-Registrierlink. */
function FirstSetupArea() {
  const { loading } = useAuth();
  if (loading) return <LoadingScreen />;
  return <FirstSetupPage />;
}

/**
 * Der alte, organisationsgebundene Rechnungsweg.
 *
 * Er bleibt gültig — Aufgabenziele und Lesezeichen zeigen dorthin —, führt
 * aber auf die kanonische Form. AUSSER bei der Neuanlage: Ein Entwurf, den es
 * noch nicht gibt, hat keine Kennung, auf die man weiterleiten könnte, und
 * die Organisation steht nur hier im Pfad.
 *
 * `replace`, nicht `push`: Sonst führte der Zurück-Knopf auf die alte Adresse
 * und von dort sofort wieder hierher — der Browser käme nicht mehr zurück.
 */
function InvoiceRedirect() {
  const { id = '', invoiceId = '' } = useParams();
  if (invoiceId === 'new') return <InvoiceDetailPage />;
  if (invoiceId === '') return <Navigate to={`/companies/${id}`} replace />;
  return <Navigate to={`/invoices/${invoiceId}`} replace />;
}

export default function App() {
  return (
    <ProductProvider>
    <AuthProvider>
      <VaultProvider>
      <ToastProvider>
        <Router>
          <Routes>
            <Route path="/login" element={<LoginArea />} />
            <Route path="/no-access" element={<NoAccessPage />} />
            <Route path="/step-up-done" element={<StepUpDonePage />} />
            <Route path="/emergency-password" element={<NewPasswordPage />} />
            <Route
              path="/emergency-enrollment"
              element={<FirstSetupArea />}
            />
            <Route path="/first-setup" element={<FirstSetupArea />} />
            <Route element={<ProtectedArea />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/companies" element={<CompaniesPage />} />
              <Route path="/instances" element={<InstancesPage />} />
              <Route
                path="/companies/:id"
                element={<CompanyDetailPage />}
              />
              {/* `:invoiceId` ist entweder eine Kennung oder das Wortzeichen
                  `new`. Die Form ist nicht frei wählbar: Die Aufgabenquelle
                  `rechnung-ueberfaellig` liefert bereits genau diesen Pfad als
                  Ziel ihrer Handlung — und Lesezeichen aus der Zeit davor
                  gibt es auch. Beide landen weiterhin richtig: Die Neuanlage
                  bleibt HIER, alles andere leitet auf `/invoices/:id`. */}
              <Route
                path="/companies/:id/invoices/:invoiceId"
                element={<InvoiceRedirect />}
              />
              {/* Der Redaktionsbereich. `:id` ist die Kennung der Vorlage;
                  ein Wortzeichen wie `new` gibt es hier bewusst nicht — eine
                  Vorlage entsteht im Dialog der Liste, weil der KANAL beim
                  Anlegen fällt und danach nie wieder änderbar ist. */}
              {/* Die globale Rechnungsliste. Sie steht VOR den
                  organisationsgebundenen Rechnungswegen — inhaltlich, nicht
                  technisch: Die Wege bleiben, weil eine Rechnung immer zu
                  einer Organisation gehoert. */}
              <Route path="/invoices" element={<InvoicesPage />} />
              {/* Die kanonische Form. Eine Rechnung ist ein Gegenstand für
                  sich; die Organisation ergibt sich aus ihr. */}
              <Route
                path="/invoices/:invoiceId"
                element={<InvoiceDetailPage />}
              />
              <Route path="/broadcast" element={<BroadcastPage />} />
              {/* DIE BEIDEN FESTEN PFADE VOR DEM PLATZHALTER — der Reihenfolge
                  nach, auch wenn React Router statische Segmente ohnehin
                  höher gewichtet als dynamische. Wer die Liste liest, soll
                  nicht erst die Rangregeln nachschlagen müssen. */}
              <Route
                path="/broadcast/consents"
                element={<ConsentsPage />}
              />
              <Route
                path="/broadcast/blocklist"
                element={<NewsletterBlockPage />}
              />
              <Route path="/broadcast/:id" element={<BroadcastTemplatePage />} />
              {/* DIE ALTEN ADRESSEN — sie leiten weiter statt zu verschwinden.
                  Beide standen in Lesezeichen und in der Fusszeile eigener
                  Mails; ohne Weiterleitung fielen sie auf die Auffangroute,
                  und die schickt STILL auf die Startseite. */}
              <Route
                path="/consents"
                element={<Navigate to="/broadcast/consents" replace />}
              />
              <Route
                path="/newsletter-block"
                element={<Navigate to="/broadcast/blocklist" replace />}
              />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Router>
      </ToastProvider>
      </VaultProvider>
    </AuthProvider>
    </ProductProvider>
  );
}
