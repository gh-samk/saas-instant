import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  Clock3,
  Wallet,
  ReceiptEuro,
  Search,
  Settings2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { fetchCompanies, fetchCompany, type CompanyShort } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { forgetCompanyId, readRecentCompanyIds } from '../lib/recent-companies';
import { ApiError } from '../lib/api-client';
import { useT } from '../i18n';

/** Wartezeit nach dem letzten Tastenanschlag, bevor gesucht wird. */
const SEARCH_DELAY_MS = 250;
/** Mehr Treffer braucht die Palette nicht: Wer mehr will, nimmt „Alle suchen". */
const MAX_HITS = 5;

type Group = 'search' | 'companies' | 'actions' | 'recent';

interface Entry {
  id: string;
  group: Group;
  label: string;
  hint?: string;
  Icon: LucideIcon;
  run: () => void;
}

/**
 * ===========================================================================
 * DIE KOMMANDOPALETTE (⌘K / Strg+K)
 * ===========================================================================
 *
 * Eine Eingabe, darunter, was man damit tun kann: Organisationen (live),
 * die fünf häufigsten Handgriffe und die zuletzt geöffneten Organisationen.
 * Damit erreicht die Tastatur alle Hauptaufgaben ohne Maus.
 *
 * BEHALTEN IST DAS ALTE VERHALTEN der Kopfzeilensuche: Wer tippt und Enter
 * drückt, landet in `/companies?search=…`. Dieser Eintrag steht deshalb bei
 * Eingabe immer GANZ OBEN und bleibt auch dort, wenn die Treffer nachladen —
 * ein Enter vor der Antwort des Servers darf nie etwas anderes tun als nach
 * der Antwort.
 *
 * BARRIEREFREI: `role="dialog"` mit `aria-modal`, ein Kombinationsfeld
 * (`role="combobox"`) steuert die Liste (`role="listbox"`); der Fokus bleibt
 * immer im Feld, die gewählte Zeile wird über `aria-activedescendant`
 * angesagt. Pfeiltasten wählen, Enter führt aus, Escape schließt und gibt den
 * Fokus an das zurück, was ihn vorher hatte.
 */
export function CommandPalette({
  open,
  onClose,
  onNewCompany,
  onNewInvoice,
}: {
  open: boolean;
  onClose: () => void;
  /** Öffnet den Dialog „Neue Organisation" (liegt in der Kopfleiste). */
  onNewCompany: () => void;
  /** Öffnet die Organisationswahl für eine neue Rechnung. */
  onNewInvoice: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const userId = useAuth().state?.user.id ?? null;
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (index: number) => `${uid}-opt-${index}`;

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<CompanyShort[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Namen der zuletzt geöffneten Organisationen: nur im Speicher dieser Ansicht,
  // beim Öffnen vom Server geholt (gespeichert sind nur die Kennungen).
  const [recent, setRecent] = useState<{ id: string; name: string }[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  // Nur die jüngste Anfrage darf das Ergebnis setzen.
  const latest = useRef(0);

  // Beim Öffnen: Stand zurücksetzen, Fokus merken und ins Feld legen.
  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setActive(0);
    setHits(null);
    setSearching(false);
    setLoadError(false);
    setRecent([]);
    inputRef.current?.focus();
    // Namen nachladen; was der Server nicht (mehr) liefert, fällt aus der Liste.
    let stale = false;
    const ids = readRecentCompanyIds(userId);
    void Promise.all(
      ids.map(async (id) => {
        try {
          const company = await fetchCompany(id);
          return typeof company?.name === 'string' ? { id, name: company.name } : null;
        } catch (error) {
          // 404: die Organisation gibt es nicht mehr. Bei anderen Fehlern
          // (Netz, gesperrter Tresor) bleibt die Kennung gespeichert.
          if (error instanceof ApiError && error.status === 404) forgetCompanyId(userId, id);
          return null;
        }
      }),
    ).then((found) => {
      if (stale) return;
      setRecent(found.filter((c): c is { id: string; name: string } => c !== null));
    });
    return () => {
      stale = true;
      const back = previousFocus.current;
      if (back && document.contains(back)) back.focus();
    };
  }, [open, userId]);

  // Live-Treffer mit Entprellung (dieselbe serverseitige Suche wie die Liste).
  useEffect(() => {
    if (!open) return;
    const text = query.trim();
    if (text === '') {
      latest.current++;
      setHits(null);
      setSearching(false);
      setLoadError(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      const number = ++latest.current;
      try {
        const page = await fetchCompanies({ search: text, perPage: MAX_HITS });
        if (number !== latest.current) return;
        setHits(page.companies);
        setLoadError(false);
      } catch {
        if (number !== latest.current) return;
        setHits([]);
        setLoadError(true);
      } finally {
        if (number === latest.current) setSearching(false);
      }
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  const entries = useMemo<Entry[]>(() => {
    const text = query.trim();
    const needle = text.toLowerCase();
    const list: Entry[] = [];

    if (text !== '') {
      list.push({
        id: 'search',
        group: 'search',
        label: t('palette.searchAll', { query: text }),
        Icon: Search,
        run: () => go(`/companies?search=${encodeURIComponent(text)}`),
      });
      for (const company of hits ?? []) {
        list.push({
          id: `company-${company.id}`,
          group: 'companies',
          label: company.name,
          hint: company.city ?? undefined,
          Icon: Building2,
          run: () => go(`/companies/${company.id}`),
        });
      }
    }

    const actions: Entry[] = [
      {
        id: 'new-company',
        group: 'actions',
        label: t('palette.newCompany'),
        Icon: Building2,
        run: () => {
          onClose();
          onNewCompany();
        },
      },
      {
        id: 'new-invoice',
        group: 'actions',
        label: t('palette.newInvoice'),
        Icon: ReceiptEuro,
        run: () => {
          onClose();
          onNewInvoice();
        },
      },
      {
        id: 'record-payment',
        group: 'actions',
        label: t('palette.recordPayment'),
        hint: t('palette.recordPaymentHint'),
        Icon: Wallet,
        run: () => go('/invoices?state=open'),
      },
      {
        id: 'today',
        group: 'actions',
        label: t('palette.today'),
        Icon: Clock3,
        run: () => go('/'),
      },
      {
        id: 'settings',
        group: 'actions',
        label: t('palette.settings'),
        Icon: Settings2,
        run: () => go('/settings'),
      },
    ];
    list.push(
      ...(needle === ''
        ? actions
        : actions.filter((a) => a.label.toLowerCase().includes(needle))),
    );

    if (text === '') {
      for (const company of recent) {
        list.push({
          id: `recent-${company.id}`,
          group: 'recent',
          label: company.name,
          Icon: Building2,
          run: () => go(`/companies/${company.id}`),
        });
      }
    }
    return list;
    // `go` und die Rückrufe ändern sich je Durchlauf, ohne etwas zu ändern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, hits, recent, t]);

  // Die Auswahl bleibt in Reichweite, wenn die Liste kürzer wird.
  const current = Math.min(active, Math.max(entries.length - 1, 0));

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(current))}`);
    row?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current, entries.length]);

  if (!open) return null;

  const move = (delta: number) => {
    if (entries.length === 0) return;
    setActive((current + delta + entries.length) % entries.length);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(Math.max(entries.length - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        entries[current]?.run();
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case 'Tab':
        // Der Fokus bleibt im Feld: Die Liste wird über Pfeile bedient.
        e.preventDefault();
        inputRef.current?.focus();
        break;
      default:
    }
  };

  const groups: { key: Group; label: string | null }[] = [
    { key: 'search', label: null },
    { key: 'companies', label: t('palette.groupCompanies') },
    { key: 'actions', label: t('palette.groupActions') },
    { key: 'recent', label: t('palette.groupRecent') },
  ];

  const rows: ReactNode[] = [];
  for (const group of groups) {
    const members = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.group === group.key);
    if (members.length === 0) continue;
    const headingId = `${uid}-group-${group.key}`;
    rows.push(
      <div
        key={group.key}
        role="group"
        aria-labelledby={group.label ? headingId : undefined}
        className="py-1"
      >
        {group.label && (
          <p
            id={headingId}
            className="px-4 pb-1 pt-2 text-[13px] font-semibold uppercase tracking-wide text-leise"
          >
            {group.label}
          </p>
        )}
        {members.map(({ entry, index }) => (
          <div
            key={entry.id}
            id={optionId(index)}
            role="option"
            aria-selected={index === current}
            onMouseMove={() => index !== current && setActive(index)}
            onClick={() => entry.run()}
            className={`mx-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm ${
              index === current
                ? 'bg-primaer-soft text-primaer-softtext'
                : 'text-text'
            }`}
          >
            <entry.Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 break-words">{entry.label}</span>
            {entry.hint && (
              <span
                className={`shrink-0 text-[13px] ${
                  index === current ? 'text-primaer-softtext' : 'text-leise'
                }`}
              >
                {entry.hint}
              </span>
            )}
          </div>
        ))}
      </div>,
    );
  }

  const text = query.trim();
  const status =
    loadError && text !== ''
      ? t('palette.loadFailed')
      : searching
        ? t('palette.searching')
        : text !== '' && hits !== null && hits.length === 0
          ? t('palette.none')
          : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-flaeche-2/70 p-4 pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onKeyDown={onKeyDown}
        className="flex max-h-[min(34rem,80dvh)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-rahmen bg-flaeche shadow-karte"
      >
        <div className="relative flex items-center gap-2 border-b border-rahmen p-3">
          <Search
            className="pointer-events-none absolute left-6 h-4 w-4 text-still"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={entries.length > 0 ? optionId(current) : undefined}
            aria-label={t('palette.inputLabel')}
            placeholder={t('palette.placeholder')}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="min-h-11 w-full rounded-lg border border-rahmen-ui bg-flaeche-4 py-2 pl-9 pr-3 text-sm text-text placeholder:text-still"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('palette.close')}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-leise hover:bg-flaeche-3 hover:text-text"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t('palette.listLabel')}
          className="min-h-0 flex-1 overflow-y-auto pb-2"
        >
          {rows}
        </div>
        {status !== null && (
          <p role="status" className="border-t border-rahmen px-4 py-2 text-[13px] text-leise">
            {status}
          </p>
        )}
        <p
          aria-hidden="true"
          className="hidden border-t border-rahmen px-4 py-2 text-[13px] text-leise sm:block"
        >
          {t('palette.hint')}
        </p>
      </div>
    </div>
  );
}
