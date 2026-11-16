import { useEffect, useRef, useState } from 'react';
import { Building2, Search } from 'lucide-react';
import { Button, Dialog, Skeleton } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import { fetchCompanies, type CompanyShort } from '../lib/api';
import { useT } from '../i18n';

/** Wartezeit nach dem letzten Tastenanschlag, bevor gesucht wird. */
const SEARCH_DELAY_MS = 250;
/** Mehr Treffer braucht die Wahl nicht: Wer seine Organisation nicht sieht, tippt weiter. */
const MAX_RESULTS = 8;

/**
 * „Für welche Organisation?" — kleiner Dialog mit Suche.
 *
 * Eine Rechnung braucht eine Organisation, und die Liste aller Rechnungen
 * kennt keinen Kontext, aus dem sie sich ergäbe. Statt auf die
 * Organisationsliste umzuleiten (Seitenwechsel, dort wieder suchen, dort
 * wieder in den Reiter), wird hier gewählt und der Aufrufer springt weiter.
 *
 * DIE SUCHE IST DIE DER ORGANISATIONSLISTE (`fetchCompanies`, serverseitig):
 * Mit einigen hundert Organisationen taugt eine geladene Gesamtliste nicht,
 * und eine zweite Suchlogik im Frontend liefe mit der Zeit auseinander. Ohne
 * Eingabe erscheinen die ersten Treffer in der Reihenfolge der Liste.
 */
export function CompanyPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (company: CompanyShort) => void;
}) {
  const t = useT();
  const [input, setInput] = useState('');
  const [results, setResults] = useState<CompanyShort[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Nur die jüngste Anfrage darf das Ergebnis setzen: Eine langsame ältere
  // Antwort überschriebe sonst die Treffer der aktuellen Eingabe.
  const latest = useRef(0);

  useEffect(() => {
    if (!open) return;
    setInput('');
    setResults(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const identifier = window.setTimeout(
      async () => {
        const number = ++latest.current;
        setError(null);
        try {
          const page = await fetchCompanies({
            search: input,
            perPage: MAX_RESULTS,
          });
          if (number === latest.current) setResults(page.companies);
        } catch (f) {
          if (number === latest.current) {
            setResults([]);
            setError(errorText(f, t('rechnungen.pickerLoadFailed')));
          }
        }
      },
      input === '' ? 0 : SEARCH_DELAY_MS,
    );
    return () => window.clearTimeout(identifier);
    // `t` ist je Sprache stabil und gehört nicht in die Abhängigkeiten, sonst
    // liefe die Suche bei jedem Durchlauf neu.
  }, [open, input]);

  return (
    <Dialog
      open={open}
      title={t('rechnungen.pickerTitle')}
      size="sm"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t('rechnungen.pickerCancel')}
        </Button>
      }
    >
      <div className="relative mb-3">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-still"
          aria-hidden="true"
        />
        <input
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          aria-label={t('rechnungen.pickerSearch')}
          placeholder={t('rechnungen.pickerSearch')}
          autoFocus
          className="w-full rounded-lg border border-rahmen-ui bg-flaeche py-2 pl-9 pr-3 text-text placeholder:text-still focus:border-primaer"
        />
      </div>

      {error !== null && (
        <p role="alert" className="mb-2 text-sm text-gefahr">
          {error}
        </p>
      )}

      {results === null ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : results.length === 0 ? (
        error === null && (
          <p className="text-sm text-leise">{t('rechnungen.pickerNone')}</p>
        )
      ) : (
        <ul aria-label={t('rechnungen.pickerResults')} className="flex flex-col">
          {results.map((company) => (
            <li key={company.id}>
              <button
                type="button"
                onClick={() => onPick(company)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-flaeche-3 focus-visible:bg-flaeche-3"
              >
                <Building2
                  className="h-4 w-4 shrink-0 text-leise"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block break-words text-sm font-medium text-text">
                    {company.name}
                  </span>
                  {company.city && (
                    <span className="block text-sm text-leise">
                      {company.city}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
