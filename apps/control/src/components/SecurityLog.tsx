import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ScrollText } from 'lucide-react';
import { Card, Button, EmptyState, Skeleton, Table } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import {
  fetchSecurityLog,
  type SecurityEvent,
} from '../lib/api';
import { useT } from '../i18n';

/**
 * ===========================================================================
 * DAS PROTOKOLL SICHERHEITSRELEVANTER EREIGNISSE
 * ===========================================================================
 *
 * R6 verlangt ein Audit-Log, und es gibt eines seit der ersten Etappe. Was
 * fehlte, war der Weg, es anzusehen — man kam nur über `psql` daran. Ein
 * Protokoll, das niemand liest, erfüllt seinen Zweck erst zur Hälfte: Es
 * belegt im Nachhinein, warnt aber nie.
 *
 * ZEITPUNKT MIT UHRZEIT, nicht nur mit Tag. Regel 1 der Projektkonventionen gilt für
 * FACHLICHE Datumsangaben; hier ist die Minute die Aussage. Drei
 * Fehlversuche um 03:14 sind etwas anderes als drei über den Tag verteilte.
 *
 * DIE AKTIONSKENNUNG STEHT NICHT DA. „anmeldung.totp.fehler" ist für die
 * Datenbank; wer um halb elf abends wissen will, ob jemand an seinem Konto
 * war, liest „Zweiter Faktor falsch (Authenticator)". Fehlt ein Klartext,
 * zeigt der Server die Kennung — ein Eintrag ohne Text ist immer noch einer.
 *
 * KEIN LÖSCHEN, KEIN „ALS GELESEN MARKIEREN". Es gibt auf dem Server auch
 * keine Route dafür.
 */

/** Zeitpunkt mit Uhrzeit — hier ist die Minute die Aussage. */
function asTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SecurityLog({ className }: { className?: string }) {
  const t = useT();
  const [rows, setRows] = useState<SecurityEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetchSecurityLog();
      // Die Form wird geprüft, nicht geglaubt: Ein `.map` auf etwas, das
      // keine Liste ist, risse den ganzen Reiter mit.
      if (!Array.isArray(response)) {
        setLoadError(t('components.securityLog.text'));
        setRows(null);
        return;
      }
      setRows(response);
    } catch (f) {
      setLoadError(errorText(f, t('components.securityLog.text2')));
      setRows(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className={`p-[18px] ${className ?? ''}`}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-serif text-[17px] font-bold text-text">
          {t('components.securityLog.heading')}</h2>
        <Button variant="secondary" onClick={() => void load()}>
          {t('components.securityLog.button')}</Button>
      </div>
      <p className="mb-4 text-sm text-leise">
        {t('components.securityLog.text3')}</p>

      {loadError !== null ? (
        <>
          <p role="alert" className="mb-3 text-sm text-gefahr">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            {t('components.securityLog.button2')}</Button>
        </>
      ) : rows === null ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          Icon={ScrollText}
          title={t('components.securityLog.title')}
          notice={t('components.securityLog.notice')}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-rahmen">
          <Table
            variant="list"
            label={t('components.securityLog.label')}
            columns={[t('components.securityLog.columns'), t('components.securityLog.columns2'), t('components.securityLog.columns3'), t('components.securityLog.columns4')]}
            columnsWidths={['w-3/12', 'w-5/12', 'w-2/12', 'w-2/12']}
            minWidth="min-w-[680px]"
          >
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="ziffern-tabellarisch px-3 py-2.5 text-sm text-leise">
                  {asTimestamp(row.timestamp)}
                </td>
                <td className="px-3 py-2.5 text-sm">
                  {/* AUFFÄLLIG HEISST NICHT GEFÄHRLICH. Ein einzelner
                      Tippfehler beim Passwort ist keine Bedrohung — deshalb
                      das ruhige Warnzeichen und keine rote Zeile. Hervorgehoben
                      wird, was man beim Überfliegen zuerst sehen will. */}
                  {row.suspicious ? (
                    <span className="flex items-start gap-1.5 font-medium text-bedenken-text">
                      <AlertTriangle
                        className="mt-0.5 h-4 w-4 shrink-0"
                        aria-hidden="true"
                      />
                      {row.text}
                    </span>
                  ) : (
                    <span className="text-text">{row.text}</span>
                  )}
                </td>
                <td className="break-all px-3 py-2.5 text-sm text-leise">
                  {row.actor}
                </td>
                <td className="ziffern-tabellarisch break-all px-3 py-2.5 text-sm text-leise">
                  {row.ip ?? '—'}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}
