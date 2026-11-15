import { useCallback, useEffect, useState } from 'react';
import { Ban, MailX } from 'lucide-react';
import {
  InputField,
  Card,
  Button,
  EmptyState,
  Skeleton,
  StatusPill,
  Table,
} from '@saas-instant/ui';
import { BroadcastTabs } from '../components/BroadcastTabs';
import { useBroadcastNumbers } from '../lib/broadcast-numbers';
import { formatDate } from '../utils/date';
import { SelectField } from '../components/FormFields';
import { SecondFactorEvidenceDialog } from '../components/SecondFactorEvidenceDialog';
import { useAuth } from '../context/AuthContext';
import { useT } from '../i18n';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import {
  fetchBlocklist,
  blockAddress,
  BLOCK_REASON_MAX_LENGTH,
  BLOCK_REASON_MIN_LENGTH,
  type BlockResult,
  type BlockReason,
  type BlockRow,
  type SecondFactorEvidence,
} from '../lib/api';

/**
 * ===========================================================================
 * WIDERSPRUCH VON HAND EINTRAGEN — UND NUR DAS
 * ===========================================================================
 *
 * Art. 21 Abs. 1 DSGVO und § 7 UWG binden die Wirksamkeit eines Widerspruchs
 * an KEINEN Kanal. Wer anruft, auf eine Mail antwortet oder schreibt, hat
 * wirksam widersprochen. Bis zu dieser Seite gab es dafür keinen Weg: Die
 * Sperre führte ausschließlich über einen Token aus einer unserer eigenen
 * Mails, während die Abmeldeseite versprach „Antworte auf eine unserer Mails,
 * wir tragen dich von Hand aus".
 *
 * ES GIBT KEIN GEGENSTÜCK, UND DIE SEITE SAGT DAS AUCH.
 *
 * Der Server kennt keine Entsperr-Route, keinen Parameter „entsperren" und
 * keinen Weg zurück auf `confirmed`. Das ist die wichtigste Eigenschaft und
 * keine Lücke: Wer entsperren könnte, könnte eine Einwilligung erfinden, die
 * es nie gab. Eine Oberfläche, die das verschweigt, macht aus einer bewussten
 * Entscheidung eine Überraschung — deshalb steht der Satz hier dreimal: im
 * Erklärkasten, am Knopf und in der Quittung.
 *
 * SEIT DEM REDESIGN GIBT ES DIE LISTE — und der Satz, der vorher hier stand,
 * ist damit hinfällig. Er lautete: „Ein Verzeichnis aller gesperrten Adressen
 * wäre eine zweite Oberfläche über personenbezogene Daten, für die es hier
 * keinen Auftrag gibt." Den Auftrag gibt es jetzt, und er ist begründet: Ohne
 * die Liste lässt sich die Frage „bekommt diese Adresse noch Post?" nur durch
 * einen Sperrversuch beantworten — also durch eine Handlung, die man nicht
 * rückgängig machen kann.
 *
 * DASS ES PERSONENBEZOGENE DATEN SIND, BLEIBT WAHR. Deshalb steht die Liste
 * hinter der Sitzung, deshalb steht der Anlass an der Einwilligung und nicht
 * im Audit-Log (dort gäbe es keinen Löschweg), und deshalb ist er nach einer
 * Kontaktdatenlöschung leer.
 *
 * WARUM EINE EIGENE SEITE UND KEIN KNOPF AN DER ORGANISATION: Die Adresse
 * muss uns nicht bekannt sein. Der Server legt bei unbekannter Adresse einen
 * reinen Sperreintrag an — sonst schriebe der nächste Import genau die Person
 * wieder an, die gerade widersprochen hat.
 */

/**
 * Die Farbe je Sperrgrund — nach der Regel der Pille: Gleiche Farbe bedeutet
 * überall dasselbe.
 *
 * „Widerspruch" ist bernstein („braucht einen Blick", aber in Ordnung),
 * „Als Spam gemeldet" rot (der Zustand, aus dem es keinen Weg zurück gibt),
 * „Adresse nimmt nichts an" neutral (eine technische Tatsache, keine
 * Entscheidung einer Person).
 */
const PILL_KIND: Record<BlockReason, 'neutral' | 'attention' | 'problem'> = {
  unsubscribed: 'attention',
  hard_bounced: 'neutral',
  spam_reported: 'problem',
};

/** Die Gründe, die von Hand gesetzt werden dürfen — wortgleich mit dem Server. */
const BLOCK_REASONS: BlockReason[] = ['unsubscribed', 'hard_bounced', 'spam_reported'];

/** Grobe Vorprüfung, damit ein Tippfehler nicht erst am Server auffällt. */
function isEmailFormal(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export function NewsletterBlockPage() {
  const t = useT();
  const { state } = useAuth();
  const totpPossible = state?.totpSetUp ?? false;

  const [email, setEmail] = useState('');
  const [reason, setReason] = useState<BlockReason>('unsubscribed');
  const [justification, setJustification] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string>();
  const [result, setResult] = useState<(BlockResult & { email: string }) | null>(
    null,
  );
  const evidenceState = useSecondFactorEvidence();
  const { numbers, update } = useBroadcastNumbers();
  const [list, setList] = useState<BlockRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      const rows = await fetchBlocklist();
      setList(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setListError(errorText(e, t('newsletter.listLoadFailed')));
      setList(null);
    }
  }, [t]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const blockReason = justification.trim();
  const ready =
    isEmailFormal(email.trim()) &&
    blockReason.length >= BLOCK_REASON_MIN_LENGTH;

  /** Kurz- und Langtext je Sperrgrund (Schlüssel als Literale für die Schlüsselprüfung). */
  function reasonShort(value: BlockReason): string {
    if (value === 'unsubscribed') return t('newsletter.reasonShortUnsubscribed');
    if (value === 'hard_bounced') return t('newsletter.reasonShortHardBounced');
    return t('newsletter.reasonShortSpamReported');
  }
  function reasonLong(value: BlockReason): string {
    if (value === 'unsubscribed') return t('newsletter.reasonLongUnsubscribed');
    if (value === 'hard_bounced') return t('newsletter.reasonLongHardBounced');
    return t('newsletter.reasonLongSpamReported');
  }

  async function block(evidence?: SecondFactorEvidence) {
    const address = email.trim();
    if (!isEmailFormal(address)) {
      setEmailError(t('newsletter.emailInvalid'));
      return;
    }
    setEmailError(undefined);
    setLoading(true);
    setError(null);
    try {
      const response = await blockAddress(
        { email: address, reason, justification: blockReason },
        evidence,
      );
      evidenceState.close();
      setResult({ ...response, email: address });
      // Das Formular wird geleert: Die nächste Sperre ist ein neuer Vorgang,
      // und eine stehengebliebene fremde Adresse ist der beste Weg, sie
      // versehentlich ein zweites Mal abzuschicken.
      setEmail('');
      setJustification('');
      setReason('unsubscribed');
      // Liste und Zähler folgen der Handlung sofort. Ohne das stünde die
      // gerade gesperrte Adresse erst nach einem Seitenwechsel darin, und
      // man fragte sich, ob es geklappt hat.
      void loadList();
      update();
    } catch (e) {
      if (evidenceState.handle(e, evidence)) return;
      setError(errorText(e, t('newsletter.blockFailed')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-text">{t('newsletter.title')}</h1>
      <BroadcastTabs numbers={numbers} />

      {/* DER SATZ STEHT ÜBER DEM FORMULAR, nicht darunter und nicht im
          Bestätigungsdialog allein. Eine Handlung, die niemand zurücknehmen
          kann, muss vor dem Tippen zu lesen sein — nicht erst danach. */}
      <Card className="mb-5 flex items-start gap-2.5 border-einwand-rahmen-hell bg-einwand-bg p-3.5">
        <Ban
          className="mt-0.5 h-4 w-4 shrink-0 text-einwand-text"
          aria-hidden="true"
        />
        <p className="text-sm text-einwand-text">
          <span className="font-semibold">{t('newsletter.finalWord')}</span>{' '}
          {t('newsletter.finalText')}
        </p>
      </Card>

      {result !== null && (
        <Card className="mb-5 p-4">
          <p className="text-sm font-semibold text-text">
            {t('newsletter.blockedNotice', { email: result.email })}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-leise">
            <li>
              {result.created
                ? t('newsletter.entryCreated')
                : t('newsletter.entryUpdated')}
            </li>
            <li>
              {result.abortedMails === 0
                ? t('newsletter.cancelledNone')
                : result.abortedMails === 1
                  ? t('newsletter.cancelledOne')
                  : t('newsletter.cancelledMany', { count: result.abortedMails })}
            </li>
            <li>{t('newsletter.noWayBack')}</li>
          </ul>
        </Card>
      )}

      <Card className="mb-5 p-[18px]">
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            void block();
          }}
          noValidate
        >
          {/* EINE UMBRECHENDE ZEILE. Vier gestapelte Felder liessen die
              Tabelle darunter unter den Falz rutschen — und sie ist der
              Grund, aus dem man die Seite meistens aufruft. Bei 375 px
              stapeln sie sich weiterhin. */}
          <fieldset
            disabled={loading}
            className="grid min-w-0 grid-cols-1 gap-x-3 border-0 p-0 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_minmax(0,1.4fr)_auto] md:items-start"
          >
            <InputField
              id="block-email"
              name="block-email"
              label={t('newsletter.emailLabel')}
              type="email"
              autoComplete="off"
              inputMode="email"
              value={email}
              onChange={(ev) => {
                setEmail(ev.target.value);
                setEmailError(undefined);
              }}
              error={emailError}
              helperText={t('newsletter.emailHelper')}
            />

            <SelectField
              id="block-reason"
              label={t('newsletter.reasonLabel')}
              value={reason}
              onChange={(value) => setReason(value as BlockReason)}
              helperText={reasonLong(reason)}
            >
              {BLOCK_REASONS.map((value) => (
                <option key={value} value={value}>
                  {reasonShort(value)}
                </option>
              ))}
            </SelectField>

            <InputField
              id="block-justification"
              label={t('newsletter.justificationLabel', {
                min: BLOCK_REASON_MIN_LENGTH,
              })}
              value={justification}
              maxLength={BLOCK_REASON_MAX_LENGTH}
              onChange={(ev) => setJustification(ev.target.value)}
              placeholder={t('newsletter.justificationPlaceholder')}
              helperText={t('newsletter.justificationHelper')}
            />

            {/* Der Knopf steht in derselben Zeile und bekommt oben denselben
                Abstand wie die Eingaben — sonst klebte er an der
                Beschriftungshöhe der Nachbarn. */}
            <Button
              variant="danger"
              type="submit"
              loading={loading}
              disabled={!ready}
              className="mb-4 md:mt-[26px]"
            >
              <MailX className="h-4 w-4" aria-hidden="true" />
              {t('newsletter.submit')}
            </Button>
          </fieldset>

          {error && (
            <p role="alert" className="text-sm text-gefahr">
              {error}
            </p>
          )}
        </form>
      </Card>

      {/* ================================================== Die Sperrliste */}
      {listError !== null ? (
        <Card className="p-6">
          <p role="alert" className="mb-3 text-sm text-gefahr">
            {listError}
          </p>
          <Button variant="secondary" onClick={() => void loadList()}>
            {t('newsletter.retry')}
          </Button>
        </Card>
      ) : list === null ? (
        <div className="flex flex-col gap-2 rounded-xl border border-rahmen bg-flaeche p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            Icon={Ban}
            title={t('newsletter.emptyTitle')}
            notice={t('newsletter.emptyHint')}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <Table
            variant="list"
            label={t('newsletter.tableCaption')}
            columns={[
              t('newsletter.columnAddress'),
              t('newsletter.columnReason'),
              t('newsletter.columnBlockReason'),
              t('newsletter.columnEntered'),
            ]}
            columnsWidths={['w-4/12', 'w-2/12', 'w-4/12', 'w-2/12']}
            minWidth="min-w-[720px]"
          >
            {list.map((row) => (
              <tr key={row.consentId}>
                <td className="break-all px-3 py-2.5 text-sm font-medium text-text">
                  {row.email}
                </td>
                <td className="px-3 py-2.5">
                  <StatusPill kind={PILL_KIND[row.status]}>
                    {reasonShort(row.status)}
                  </StatusPill>
                </td>
                <td className="px-3 py-2.5 text-sm text-leise">
                  {/* KEIN ERSATZTEXT, sondern die Auskunft, warum nichts
                      dasteht. „—" liesse offen, ob der Anlass fehlt oder
                      niemand einen genannt hat. */}
                  {row.reason ?? (
                    <span className="text-still">{t('newsletter.selfUnsubscribed')}</span>
                  )}
                </td>
                <td className="ziffern-tabellarisch px-3 py-2.5 text-sm text-leise">
                  {row.registeredAt === null ? '—' : formatDate(row.registeredAt)}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('newsletter.proofTitle')}
        declaration={t('newsletter.proofExplanation')}
        totpPossible={totpPossible}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void block(evidence)}
      />
    </div>
  );
}
