import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Building2,
  Clock3,
  LogOut,
  Mails,
  Menu,
  ReceiptEuro,
  Search,
  Server,
  Settings2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary';
import { ThemeSwitcher } from './ThemeSwitcher';
import { useAuth } from '../context/AuthContext';
import { useProduct } from '../context/ProductContext';
import { fetchNavigationCounters, type NavigationCounters } from '../lib/api';
import { t, useT } from '../i18n';

/** Welcher Zähler an einem Ziel hängt — und in welcher Farbe. */
type CounterKind = 'urgent' | 'open';

interface NavTarget {
  path: string;
  label: string;
  Icon: LucideIcon;
  /** `end` nur bei „/" — sonst wäre „Heute" auf jeder Unterseite aktiv. */
  exact?: boolean;
  /**
   * Pfade, unter denen dieses Ziel ebenfalls aktiv ist.
   *
   * Ohne das verlöre die Leiste beim Öffnen eines Detailschirms ihre
   * Markierung: Wer in einer Organisation steht, ist immer noch „bei den
   * Organisationen" — die Seitenleiste soll sagen, wo man ist, nicht welche
   * Route zufällig gerade gilt.
   */
  alsoUnder?: string[];
  counter?: CounterKind;
}

/**
 * FÜNF ZIELE, plus Einstellungen unten abgesetzt.
 *
 * „INSTANZEN" IST SEIT DEM 12.09.2026 DAZUGEKOMMEN, auf Wunsch: eine Liste
 * aller Instanzen mit Status und Organisation, aus der jede Zeile in den
 * Reiter „Instanz" ihrer Organisation führt. Sie steht direkt unter den
 * Organisationen, weil jede Instanz genau einer gehört — sie ist ein zweiter
 * Blick auf denselben Bestand, kein eigener Bereich. Ohne Zähler: Was an
 * einer Instanz zu tun ist, meldet „Heute".
 *
 * EINWILLIGUNGEN UND SPERRLISTE SIND JETZT REITER UNTER RUNDMAIL. Hier stand
 * bis zum Redesign die Gegenentscheidung, und ihre Begründung war gut: Eine
 * Einwilligung — und erst recht ein Widerspruch — muss zu keiner Organisation
 * gehören. Das bleibt fachlich richtig und ändert sich nicht; es war nur nie
 * ein Argument dafür, dass beides einen eigenen Menüpunkt braucht. Beide
 * gehören zum Postausgang, und dort stehen sie jetzt.
 *
 * ZÄHLER NUR BEI HANDLUNGSBEDARF. Rot für das, was heute ansteht, bernstein
 * für offene Rechnungen. Reine Mengenangaben („94 Organisationen") stehen
 * NICHT in der Leiste: Sie ändern sich ständig, niemand handelt danach, und
 * eine Leiste voller Zahlen macht die zwei wichtigen unsichtbar.
 */
const NAV_TOP: NavTarget[] = [
  { path: '/', label: t('components.appShell.label'), Icon: Clock3, exact: true, counter: 'urgent' },
  {
    path: '/companies',
    label: t('components.appShell.label2'),
    Icon: Building2,
  },
  { path: '/instances', label: t('components.appShell.label3'), Icon: Server },
  { path: '/invoices', label: t('components.appShell.label4'), Icon: ReceiptEuro, counter: 'open' },
  {
    path: '/broadcast',
    label: t('components.appShell.label5'),
    Icon: Mails,
    // Die beiden alten Adressen stehen weiterhin darin, obwohl sie seit
    // Etappe 5 nur noch weiterleiten: Zwischen Aufruf und Weiterleitung
    // rendert die Leiste einmal, und ohne sie flackerte die Markierung.
    // `/broadcast/…` ist über den Präfixvergleich ohnehin abgedeckt.
    alsoUnder: ['/consents', '/newsletter-block'],
  },
];

/** Konto-Ebene, unten abgesetzt. */
const NAV_BOTTOM: NavTarget[] = [
  { path: '/settings', label: t('components.appShell.label6'), Icon: Settings2 },
];

const NAV_LINK_CLASS = (isActive: boolean) =>
  `flex items-center gap-3 rounded-lg px-2.5 py-2 text-[15px] font-medium transition-colors duration-150 ${
    isActive
      ? 'bg-primaer-soft font-semibold text-primaer-softtext'
      : 'text-text hover:bg-primaer-softer'
  }`;

/**
 * Die Zählerpille.
 *
 * BEI NULL GAR NICHTS. Ein roter Kreis mit einer Null ist eine Warnung ohne
 * Anlass — und wer sie einmal ignoriert hat, ignoriert sie beim nächsten Mal
 * auch, wenn eine Drei darin steht.
 */
function CounterPill({ value, kind }: { value: number; kind: CounterKind }) {
  if (value <= 0) return null;
  return (
    <span
      className={`ml-auto grid min-w-[20px] shrink-0 place-items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold ziffern-tabellarisch ${
        kind === 'urgent'
          ? 'bg-gefahr text-gefahr-text'
          : 'bg-bedenken-bg text-bedenken-text'
      }`}
    >
      {value}
    </span>
  );
}

function NavList({
  targets,
  label,
  counter,
  onNavigate,
}: {
  targets: NavTarget[];
  label: string;
  counter: NavigationCounters | null;
  onNavigate?: () => void;
}) {
  const city = useLocation();
  return (
    <nav aria-label={label} className="flex flex-col gap-1">
      {targets.map((target) => {
        /**
         * DER AKTIVE ZUSTAND WIRD HIER BESTIMMT, nicht von `NavLink`.
         *
         * `NavLink` kann `auchUnter` nicht kennen — und es entfernt ein
         * selbst gesetztes `aria-current`, sobald sein eigener Vergleich
         * negativ ausfaellt. Dann waere die Markierung sichtbar (ueber die
         * Klasse) und zugleich unhoerbar. Eine Regel fuer beides ist
         * ehrlicher als zwei, die sich widersprechen koennen.
         */
        const active =
          (target.exact
            ? city.pathname === target.path
            : city.pathname === target.path ||
              city.pathname.startsWith(`${target.path}/`)) ||
          (target.alsoUnder?.some(
            (path) =>
              city.pathname === path || city.pathname.startsWith(`${path}/`),
          ) ??
            false);
        const value =
          target.counter === 'urgent'
            ? counter?.tasksUrgent
            : target.counter === 'open'
              ? counter?.invoicesOpen
              : undefined;
        return (
          <Link
            key={target.path}
            to={target.path}
            onClick={onNavigate}
            // AM LINK, nicht am Symbol: Das Symbol ist `aria-hidden` und
            // damit fuer eine Bildschirmleserin nicht vorhanden. Vor dem
            // Redesign stand die Markierung genau dort.
            aria-current={active ? 'page' : undefined}
            className={NAV_LINK_CLASS(active)}
          >
            <target.Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            {target.label}
            {value !== undefined && target.counter && (
              <CounterPill value={value} kind={target.counter} />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Rahmen der angemeldeten Verwaltung: Kopfleiste, Navigation, Hauptbereich.
 */
export function AppShell() {
  const t = useT();
  const { logout } = useAuth();
  const { productName, logoUrl } = useProduct();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [counter, setCounter] = useState<NavigationCounters | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const city = useLocation();
  const navigate = useNavigate();

  /**
   * Die Zähler sind eine Momentaufnahme, kein Abonnement.
   *
   * Geholt wird beim Betreten und danach bei jedem Wechsel der Seite — dort
   * ist die Wahrscheinlichkeit am grössten, dass sich etwas geändert hat
   * (eine Aufgabe erledigt, eine Rechnung bezahlt). Ein eigener Takt daneben
   * wäre eine Dauerlast für zwei Zahlen.
   */
  const loadCounter = useCallback(() => {
    fetchNavigationCounters()
      .then(setCounter)
      // BEWUSST STILL. Die Zähler sind Beiwerk; ein Fehlerbanner über der
      // ganzen Anwendung, weil eine Pille fehlt, wäre unverhältnismässig.
      // Ohne Wert zeigt die Leiste einfach keine Pille.
      .catch(() => setCounter(null));
  }, []);

  useEffect(() => {
    loadCounter();
  }, [loadCounter, city.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    // Fokus in den Drawer holen (Schließen-Knopf), analog zu Dialog.tsx.
    panelRef.current?.querySelector('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // ⌘K bzw. Strg+K springt ins Suchfeld. `preventDefault`, weil Firefox
  // damit sonst seine eigene Schnellsuche öffnet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-dvh bg-flaeche-2">
      <a
        href="#hauptinhalt"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-primaer focus:px-3 focus:py-2 focus:text-primaer-text"
      >
        {t('components.appShell.text')}</a>

      <div className="flex">
        <aside className="sticky top-0 hidden h-dvh w-[268px] shrink-0 flex-col border-r border-rahmen bg-flaeche lg:flex">
          <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primaer-soft text-base font-semibold text-primaer-softtext"
              aria-hidden="true"
            >
              {logoUrl ? (
                <img src={logoUrl} alt="" className="h-8 w-8 rounded-lg object-contain" />
              ) : (
                productName.charAt(0).toUpperCase()
              )}
            </span>
            <span className="leading-tight">
              <span className="block text-lg font-semibold text-primaer">
                {productName}
              </span>
              <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-still">
                {t('components.appShell.label7')}</span>
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 pt-2">
            <NavList
              targets={NAV_TOP}
              label={t('components.appShell.label8')}
              counter={counter}
            />
          </div>
          <div className="flex flex-col gap-3 p-4">
            <ThemeSwitcher />
            <NavList targets={NAV_BOTTOM} label={t('components.appShell.label9')} counter={counter} />
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex h-[58px] items-center gap-3 border-b border-rahmen bg-flaeche px-4 lg:px-6">
            <button
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-text hover:bg-flaeche-3 lg:hidden"
              aria-label={t('components.appShell.ariaLabel')}
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <span className="text-lg font-semibold text-primaer lg:hidden">
              {productName}
            </span>

            <div className="relative min-w-0 flex-1 lg:max-w-[460px]">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-still"
                aria-hidden="true"
              />
              {/* SIE SUCHT WIRKLICH, und zwar genau das, was in der
                  Beschriftung steht. Das Design nennt hier zusätzlich
                  „Rechnungsnummer" — den Weg dorthin gibt es erst mit der
                  globalen Rechnungsliste (Etappe 4). Ein Platzhalter, der
                  mehr verspricht als das Feld findet, ist schlimmer als ein
                  schmaleres Versprechen: Wer eine Rechnungsnummer eintippt
                  und nichts bekommt, hält die Suche für kaputt. */}
              <input
                ref={searchRef}
                type="search"
                // NICHT „Organisationen durchsuchen": So heisst bereits das
                // Feld AUF der Organisationsseite. Zwei Bedienelemente mit
                // demselben Namen sind für eine Bildschirmleserin nicht
                // unterscheidbar — und sie tun Verschiedenes: dieses hier
                // springt zur Liste, jenes filtert die schon offene.
                aria-label={t('components.appShell.ariaLabel2')}
                placeholder={t('components.appShell.placeholder')}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const value = e.currentTarget.value.trim();
                  navigate(
                    value === ''
                      ? '/companies'
                      : `/companies?search=${encodeURIComponent(value)}`,
                  );
                }}
                className="w-full rounded-lg border border-rahmen-ui bg-flaeche-4 py-2 pl-9 pr-14 text-sm text-text placeholder:text-still"
              />
              <span
                className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-rahmen bg-flaeche px-1.5 py-0.5 text-[11px] font-semibold text-still lg:block"
                aria-hidden="true"
              >
                {t('components.appShell.label10')}</span>
            </div>

            {/* `ml-auto` schiebt den Knopf an den rechten Rand.
                Ohne ihn klebte er am Suchfeld: Das hat zwar `flex-1`, wird auf
                grossen Bildschirmen aber auf 460px gedeckelt (`lg:max-w`) — der
                frei bleibende Raum lag danach rechts vom Knopf statt links
                davon. Auf schmalen Bildschirmen fiel es nicht auf, weil das
                Feld dort die ganze Breite nimmt und `ml-auto` folgenlos ist. */}
            <button
              onClick={() => void logout()}
              aria-label={t('components.appShell.ariaLabel3')}
              title={t('components.appShell.title')}
              className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-rahmen-ui text-leise transition-colors duration-150 hover:bg-flaeche-3 hover:text-text"
            >
              <LogOut className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          </header>

          <main id="hauptinhalt" className="px-4 py-5 lg:px-6 lg:pb-16">
            {/* Das Netz unter allem: Zerlegt eine Seite sich selbst, bleiben
                Kopfzeile und Navigation stehen — es gibt also immer einen Weg
                weg von der kaputten Stelle. Genau der fehlte, als jede
                Organisationsseite ohne Instanz weiß wurde. */}
            <ErrorBoundary area={t('components.appShell.area')} variant="area">
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
      </div>

      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <div className="absolute inset-0 bg-flaeche-2/70 backdrop-blur-[2px]" aria-hidden="true" />
          <aside
            ref={panelRef}
            className="absolute inset-y-0 left-0 flex w-[268px] flex-col border-r border-rahmen bg-flaeche"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 pb-2">
              <span className="px-1 text-2xl font-semibold text-primaer">
                {productName}
              </span>
              <button
                aria-label={t('components.appShell.ariaLabel4')}
                onClick={() => setDrawerOpen(false)}
                className="rounded-lg p-1 text-text hover:bg-flaeche-3"
              >
                <X className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 pt-2">
              <NavList
                targets={NAV_TOP}
                label={t('components.appShell.label8')}
                counter={counter}
                onNavigate={() => setDrawerOpen(false)}
              />
            </div>
            <div className="flex flex-col gap-3 border-t border-rahmen p-4">
              <ThemeSwitcher />
              <NavList
                targets={NAV_BOTTOM}
                label={t('components.appShell.label9')}
                counter={counter}
                onNavigate={() => setDrawerOpen(false)}
              />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
