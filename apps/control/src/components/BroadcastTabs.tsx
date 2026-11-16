import { Link, useLocation } from 'react-router-dom';
import { t, useT } from '../i18n';

/**
 * ===========================================================================
 * DIE REITERLEISTE DES RUNDMAIL-BEREICHS — drei Wege, ein Gegenstand
 * ===========================================================================
 *
 * Vorlagen, Einwilligungen und Sperrliste waren bis zum Redesign drei Seiten
 * an drei nicht verwandten Adressen (`/broadcast`, `/consents`,
 * `/newsletter-block`). Sie gehören zusammen: Wer eine Rundmail schreibt,
 * fragt als Nächstes, wer sie bekommt — und wer sie nicht bekommt.
 *
 * ES SIND LINKS, KEINE KNÖPFE. `FilterChips` sieht genauso aus und wäre der
 * kürzere Weg gewesen, aber seine eigene Beschreibung sagt: „Sie filtert, sie
 * navigiert nicht." Hier wechselt jeder Reiter die Route. Ein Link lässt sich
 * mit der mittleren Maustaste in einen neuen Tab öffnen, ein Knopf nicht, und
 * eine Bildschirmleserin soll „Link, aktuelle Seite" hören statt „Schalter
 * gedrückt".
 *
 * DIE ZAHLEN STEHEN AUF JEDEM REITER, auch auf den nicht gewählten. Sie
 * kommen aus einem eigenen, rein zählenden Endpunkt — die Liste der
 * Einwilligungen zu laden, nur um ihre Länge über der Sperrliste anzuzeigen,
 * wäre ein Datensatz je Zahl.
 *
 * `null` als Zahl heisst „noch nicht geladen" und zeigt nichts. Eine `0` an
 * dieser Stelle wäre eine Aussage, und zwar eine falsche.
 */

export interface BroadcastNumbers {
  templates: number | null;
  confirmed: number | null;
  blocked: number | null;
}

const TABS = [
  { path: '/broadcast', label: t('components.broadcastTabs.label'), field: 'templates' },
  { path: '/broadcast/consents', label: t('components.broadcastTabs.label2'), field: 'confirmed' },
  { path: '/broadcast/blocklist', label: t('components.broadcastTabs.label3'), field: 'blocked' },
] as const;

export function BroadcastTabs({ numbers }: { numbers: BroadcastNumbers }) {
  const t = useT();
  const { pathname } = useLocation();

  return (
    <nav
      aria-label={t('components.broadcastTabs.ariaLabel')}
      className="mb-5 inline-flex flex-wrap gap-1 rounded-[10px] border border-rahmen bg-flaeche-3 p-[3px]"
    >
      {TABS.map((tabs) => {
        // GENAUER VERGLEICH, keine Präfixprüfung: `/broadcast` ist Präfix von
        // `/broadcast/blocklist`, und mit `startsWith` wären zwei Reiter
        // gleichzeitig aktiv. Die Vorlagenseite `/broadcast/:id` gehört
        // inhaltlich zu „Rundmails" — sie zeigt diese Leiste nicht, weil sie
        // eine Ebene tiefer liegt.
        const active = pathname === tabs.path;
        const number = numbers[tabs.field];
        return (
          <Link
            key={tabs.path}
            to={tabs.path}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex min-h-11 items-center rounded-lg px-3 py-1.5 text-sm sm:inline-block sm:min-h-0 font-semibold transition-colors ${
              active
                ? 'bg-flaeche text-text shadow-segment'
                : 'text-leise hover:text-text'
            }`}
          >
            {tabs.label}
            {number !== null && (
              <span className="ml-1.5 ziffern-tabellarisch font-normal text-still">
                {number}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
