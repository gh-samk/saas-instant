import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Plus, ShieldOff, UserRoundCheck } from 'lucide-react';
import {
  Dialog,
  InputField,
  Card,
  Button,
  EmptyState,
  Skeleton,
  StatusPill,
  Table,
  useToast,
} from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { useAuth } from '../context/AuthContext';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import {
  fetchUser,
  correctUserAddress,
  newAccessLink,
  setUserAccess,
  registerUser,
  type UserRow,
  type SecondFactorEvidence,
} from '../lib/api';
import { formatDate } from '../utils/date';
import { t, useT } from '../i18n';

/**
 * ===========================================================================
 * DIE NUTZERVERWALTUNG — alle können dasselbe
 * ===========================================================================
 *
 * ES GIBT KEINE ROLLEN, und das steht auch auf der Seite. Wer hier eingetragen
 * ist, darf alles: festschreiben, stornieren, sperren, löschen, weitere Konten
 * eintragen. Das ist eine Entscheidung des Auftraggebers und keine Auslassung
 * — ein Betrieb mit zwei Personen braucht keine Rechteverwaltung, sondern
 * Vertrauen und einen Nachweis darüber, wer was getan hat. Den Nachweis gibt
 * es nebenan unter „Sicherheit".
 *
 * WER JEMANDEN EINTRÄGT, GIBT IHM DIESELBEN RECHTE, DIE ER SELBST HAT. Das
 * darf keine Überraschung sein — deshalb steht der Satz im Formular und nicht
 * nur in der Dokumentation.
 *
 * ZWEI REGELN, BEIDE SERVERSEITIG:
 *
 * 1. DAS LETZTE AKTIVE KONTO BLEIBT. Der Knopf ist hier gesperrt; durchgesetzt
 *    wird es in derselben Transaktion wie die Änderung, weil zwei gleichzeitige
 *    Entzüge an einer Prüfung davor vorbeiliefen.
 * 2. ZUGANG ENTZIEHEN HEISST NICHT LÖSCHEN (R4). Es gibt keinen Löschknopf und
 *    auf dem Server keine Route dafür: Ein gelöschtes Konto verlöre die
 *    Zuordnung seiner Audit-Einträge.
 *
 * DER ZUGANGSLINK ERSCHEINT GENAU EINMAL. Gespeichert ist nur sein Hash; es
 * gibt keinen Weg, ihn ein zweites Mal anzuzeigen. Deshalb steht er in einem
 * Dialog, den man ausdrücklich schliesst, und nicht in einer Meldung, die nach
 * vier Sekunden verschwindet.
 */

const PILL: Record<
  UserRow['state'],
  { kind: 'confirmed' | 'attention' | 'neutral'; word: string }
> = {
  active: { kind: 'confirmed', word: t('components.userManagement.word') },
  without_access: { kind: 'attention', word: t('components.userManagement.word2') },
  locked: { kind: 'neutral', word: t('components.userManagement.word3') },
};

export function UserManagement() {
  const t = useT();
  const toast = useToast();
  const { state } = useAuth();
  const totpPossible = state?.totpSetUp ?? false;

  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [link, setLink] = useState<{ link: string; expiresAt: string } | null>(
    null,
  );

  /**
   * WAS BEIM NACHWEIS WIEDERHOLT WERDEN SOLL.
   *
   * Der Zweitfaktordialog kommt erst, wenn der Server mit 401 antwortet — bis
   * dahin weiss die Oberfläche nicht, ob er nötig ist. Der gemerkte Vorgang
   * wird danach mit dem Nachweis erneut geschickt, sonst müsste man das
   * Formular ein zweites Mal ausfüllen.
   */
  const [process, setProcess] = useState<
    | { kind: 'register' }
    | { kind: 'access'; id: string; active: boolean }
    | { kind: 'link'; id: string }
    | { kind: 'address'; id: string }
    | null
  >(null);
  /** Konto, dessen Adresse gerade berichtigt wird — samt Entwurf. */
  const [addressTarget, setAddressTarget] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);
  const evidenceState = useSecondFactorEvidence();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetchUser();
      if (!Array.isArray(response)) {
        setLoadError(t('components.userManagement.text'));
        setRows(null);
        return;
      }
      setRows(response);
    } catch (f) {
      setLoadError(errorText(f, t('components.userManagement.text2')));
      setRows(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Wie viele Konten haben überhaupt noch Zugang? */
  const withAccess = (rows ?? []).filter((z) => z.state !== 'locked').length;

  async function execute(
    was: NonNullable<typeof process>,
    evidence?: SecondFactorEvidence,
  ) {
    setLoading(true);
    setError(null);
    setProcess(was);
    try {
      if (was.kind === 'register') {
        const result = await registerUser(
          { name: name.trim(), email: email.trim() },
          evidence,
        );
        evidenceState.close();
        setRegisterOpen(false);
        setName('');
        setEmail('');
        setLink({ link: result.link, expiresAt: result.expiresAt });
      } else if (was.kind === 'access') {
        await setUserAccess(was.id, was.active, evidence);
        evidenceState.close();
        toast.show(was.active ? t('components.userManagement.text3') : t('components.userManagement.text4'));
      } else if (was.kind === 'address') {
        if (!addressTarget) return;
        await correctUserAddress(was.id, addressTarget.email.trim(), evidence);
        evidenceState.close();
        setAddressTarget(null);
        toast.show(t('components.userManagement.text5'));
      } else {
        const result = await newAccessLink(was.id, evidence);
        evidenceState.close();
        setLink(result);
      }
      await load();
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      setError(errorText(f, t('components.userManagement.text6')));
      // Der Fehler gehört sichtbar an den Ort der Handlung. Steht der
      // Eintragen-Dialog offen, bleibt er offen — sonst wäre die Meldung weg,
      // bevor man sie gelesen hat.
      if (was.kind !== 'register' && was.kind !== 'address') {
        toast.show(t('components.userManagement.text7'));
      }
    } finally {
      setLoading(false);
    }
  }

  const ready =
    name.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  return (
    <>
      <Card className="p-[18px]">
        {/* Der Knopf bleibt oben rechts. `flex-wrap` allein reichte nicht:
            Der Erklärsatz ist lang, und der Knopf rutschte darunter auf die
            linke Seite — an eine Stelle, an der ihn niemand sucht. */}
        <div className="mb-1 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold text-text">{t('components.userManagement.heading')}</h2>
            <p className="mt-1 text-sm text-leise">
              {t('components.userManagement.text8')}{' '}
              <span className="font-medium text-text">
                {t('components.userManagement.label')}</span>{' '}
              {t('components.userManagement.text9')}</p>
          </div>
          <Button className="shrink-0" onClick={() => setRegisterOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('components.userManagement.button')}</Button>
        </div>

        {loadError !== null ? (
          <>
            <p role="alert" className="mb-3 mt-3 text-sm text-gefahr">
              {loadError}
            </p>
            <Button variant="secondary" onClick={() => void load()}>
              {t('components.userManagement.button2')}</Button>
          </>
        ) : rows === null ? (
          <div className="mt-4 flex flex-col gap-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            Icon={UserRoundCheck}
            title={t('components.userManagement.title')}
            notice={t('components.userManagement.notice')}
          />
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-rahmen">
            <Table
              variant="list"
              label={t('components.userManagement.label2')}
              columns={[t('components.userManagement.columns'), t('components.userManagement.columns2'), t('components.userManagement.columns3'), t('components.userManagement.columns4')]}
              columnsWidths={['w-3/12', 'w-4/12', 'w-2/12', 'w-3/12']}
              actionColumn
              minWidth="min-w-[760px]"
            >
              {rows.map((row) => {
                // DAS LETZTE KONTO MIT ZUGANG: gesperrt, mit Begründung im
                // `title`. Durchgesetzt wird es auf dem Server.
                const last = row.state !== 'locked' && withAccess <= 1;
                const reason = row.self
                  ? t('components.userManagement.reason')
                  : last
                    ? t('components.userManagement.reason2')
                    : undefined;

                return (
                  <tr key={row.id}>
                    <td className="px-3 py-2.5 text-sm font-medium text-text">
                      {row.name}
                      {row.self && (
                        <span className="ml-2 text-sm font-normal text-still">
                          {t('components.userManagement.label3')}</span>
                      )}
                    </td>
                    <td className="break-all px-3 py-2.5 text-sm text-leise">
                      {row.email}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusPill kind={PILL[row.state].kind}>
                        {PILL[row.state].word}
                      </StatusPill>
                      {row.state === 'active' &&
                        row.lastLoginAt !== null && (
                          <span className="ziffern-tabellarisch mt-1 block text-sm text-still">
                            {t('components.userManagement.label4')}{formatDate(row.lastLoginAt)}
                          </span>
                        )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {row.state === 'without_access' && (
                          <>
                            {/* [Review B1] Der Link geht nicht per Mail hinaus;
                                ein Tippfehler in der Adresse fiele erst auf,
                                wenn der Anmeldecode ins Leere geht. Solange
                                niemand angemeldet war, darf die Verwaltung
                                sie berichtigen. */}
                            <Button
                              variant="secondary"
                              className="px-3 py-1.5 text-sm"
                              disabled={loading}
                              onClick={() => {
                                setError(null);
                                setAddressTarget({
                                  id: row.id,
                                  name: row.name,
                                  email: row.email,
                                });
                              }}
                            >
                              {t('components.userManagement.button3')}</Button>
                            <Button
                              variant="secondary"
                              className="px-3 py-1.5 text-sm"
                              disabled={loading}
                              onClick={() =>
                                void execute({ kind: 'link', id: row.id })
                              }
                            >
                              <Link2 className="h-4 w-4" aria-hidden="true" />
                              {t('components.userManagement.button4')}</Button>
                          </>
                        )}
                        {!row.self && (
                          <Button
                            variant={
                              row.state === 'locked' ? 'secondary' : 'danger'
                            }
                            className="px-3 py-1.5 text-sm"
                            disabled={loading || last}
                            title={reason}
                            onClick={() =>
                              void execute({
                                kind: 'access',
                                id: row.id,
                                active: row.state === 'locked',
                              })
                            }
                          >
                            <ShieldOff className="h-4 w-4" aria-hidden="true" />
                            {row.state === 'locked'
                              ? t('components.userManagement.button5')
                              : t('components.userManagement.button6')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </div>
        )}
      </Card>

      {/* =============================================== Eintragen */}
      <Dialog
        open={registerOpen}
        title={t('components.userManagement.title2')}
        onClose={() => setRegisterOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRegisterOpen(false)}>
              {t('components.userManagement.button7')}</Button>
            <Button
              loading={loading}
              disabled={!ready}
              onClick={() => void execute({ kind: 'register' })}
            >
              {t('components.userManagement.button8')}</Button>
          </>
        }
      >
        {/* DER SATZ STEHT VOR DEM FORMULAR, nicht darunter. Wer jemanden
            einträgt, gibt ihm dieselben Rechte, die er selbst hat — das darf
            keine Überraschung sein. */}
        <p className="mb-4 text-sm text-leise">
          <span className="font-medium text-text">
            {t('components.userManagement.label5')}</span>{' '}
          {t('components.userManagement.text10')}</p>
        <p className="mb-4 text-sm text-leise">
          {t('components.userManagement.text11')}{' '}
          <span className="font-medium text-text">
            {t('components.userManagement.label6')}</span>
        </p>
        <InputField
          id="nutzer-name"
          label={t('components.userManagement.label7')}
          value={name}
          maxLength={120}
          onChange={(ev) => setName(ev.target.value)}
        />
        <InputField
          id="nutzer-email"
          label={t('components.userManagement.label8')}
          type="email"
          inputMode="email"
          autoComplete="off"
          value={email}
          maxLength={254}
          onChange={(ev) => setEmail(ev.target.value)}
          helperText={t('components.userManagement.helperText')}
        />
        {error !== null && (
          <p role="alert" className="text-sm text-gefahr">
            {error}
          </p>
        )}
      </Dialog>

      <Dialog
        open={addressTarget !== null}
        title={t('components.userManagement.title3')}
        onClose={() => setAddressTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddressTarget(null)}>
              {t('components.userManagement.button7')}</Button>
            <Button
              loading={loading}
              disabled={
                addressTarget === null ||
                !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(addressTarget.email.trim())
              }
              onClick={() =>
                addressTarget && void execute({ kind: 'address', id: addressTarget.id })
              }
            >
              {t('components.userManagement.button9')}</Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-leise">
          {t('components.userManagement.text12')}{' '}
          <span className="font-medium text-text">{addressTarget?.name}</span>{t('components.userManagement.text13')}</p>
        <InputField
          id="nutzer-adresse"
          label={t('components.userManagement.label8')}
          type="email"
          inputMode="email"
          autoComplete="off"
          value={addressTarget?.email ?? ''}
          maxLength={254}
          onChange={(ev) =>
            setAddressTarget((z) => (z ? { ...z, email: ev.target.value } : z))
          }
        />
        {error !== null && (
          <p role="alert" className="text-sm text-gefahr">
            {error}
          </p>
        )}
      </Dialog>

      {/* ============================================ Der Link, EINMAL */}
      <Dialog
        open={link !== null}
        title={t('components.userManagement.title4')}
        onClose={() => setLink(null)}
        footer={
          <Button variant="secondary" onClick={() => setLink(null)}>
            {t('components.userManagement.button10')}</Button>
        }
      >
        <p className="mb-3 text-sm text-leise">
          {t('components.userManagement.text14')}{' '}
          <span className="font-medium text-text">{t('components.userManagement.label9')}</span>{t('components.userManagement.text15')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-lg border border-rahmen bg-flaeche-3 px-3 py-2 text-sm">
            {link?.link}
          </code>
          <Button
            variant="secondary"
            onClick={() => {
              if (link === null) return;
              void navigator.clipboard
                ?.writeText(link.link)
                .then(() => toast.show(t('components.userManagement.text16')))
                .catch(() => toast.show(t('components.userManagement.text17')));
            }}
          >
            <Copy className="h-4 w-4" aria-hidden="true" />
            {t('components.userManagement.button11')}</Button>
        </div>
        {link !== null && (
          <p className="mt-3 text-sm text-leise">
            {t('components.userManagement.text18')}{' '}
            <span className="ziffern-tabellarisch">
              {formatDate(link.expiresAt)}
            </span>
            .
          </p>
        )}
      </Dialog>

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('components.userManagement.title5')}
        declaration={t('components.userManagement.declaration')}
        totpPossible={totpPossible}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => {
          if (process !== null) void execute(process, evidence);
        }}
      />
    </>
  );
}
