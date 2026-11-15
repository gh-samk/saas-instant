import { useEffect, useState } from 'react';
import { Select, Dialog, Button } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import {
  changeCompanyStatus,
  addNote,
  type IntakeLinkSend,
  type CompanyStatus,
} from '../lib/api';
import { COMPANY_STATUS, STATUS_ORDER } from '../lib/company-status';
import { useT } from '../i18n';

/**
 * Statuswechsel als eigene Handlung.
 *
 * Im Backend ist es ein eigener Endpunkt (`POST …/status`) und ausdrücklich
 * kein Feld von PATCH: Jeder Wechsel schreibt eine systemerzeugte Notiz und
 * einen Audit-Eintrag. Wäre er als gewöhnliches Feld änderbar, ließe sich
 * diese Nachweispflicht umgehen.
 *
 * KEINE EINSCHRÄNKUNG, welcher Status von welchem aus erreichbar ist — weder
 * Schema noch Auftrag definieren eine Zustandsmaschine, und eine zu erfinden
 * hieße, eine Geschäftsregel zu unterstellen, die nirgends steht. Nur der
 * Wechsel auf denselben Status ist gesperrt; er wäre keiner (der Server
 * antwortet darauf mit `409 status_unveraendert`).
 *
 * DER GRUND WIRD ALS EIGENE NOTIZ GESCHRIEBEN. Der Endpunkt nimmt kein
 * Begründungsfeld entgegen — der Wortlaut der Systemnotiz wird serverseitig
 * festgelegt und ist Nachweis, kein Kommentarfeld. Der eingetippte Grund
 * landet deshalb als selbst erfasste Notiz direkt daneben im Verlauf: genau
 * das, was das Feld verspricht, und nachträglich korrigierbar.
 */
export function StatusChangeDialog({
  open,
  companyId,
  currentStatus,
  onClose,
  onChanged,
}: {
  open: boolean;
  companyId: string;
  currentStatus: CompanyStatus;
  onClose: () => void;
  /**
   * `versand` ist das Ergebnis des automatischen Aufnahmelink-Versands —
   * `null`, wenn bei diesem Wechsel nichts zu versenden war. Die Seite macht
   * daraus EINEN Hinweis, keinen Dauerzustand.
   */
  onChanged: (
    notice: string | null,
    send: IntakeLinkSend | null,
  ) => void;
}) {
  const t = useT();
  const [newStatus, setNewStatus] = useState<CompanyStatus>(currentStatus);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Beim Öffnen auf den tatsächlichen Stand zurückfallen — sonst stünde nach
  // einem abgebrochenen Versuch die alte Auswahl noch da.
  useEffect(() => {
    if (open) {
      setNewStatus(currentStatus);
      setReason('');
      setError(null);
    }
  }, [open, currentStatus]);

  function close() {
    if (loading) return;
    onClose();
  }

  async function change() {
    setLoading(true);
    setError(null);
    try {
      const changed = await changeCompanyStatus(
        companyId,
        newStatus,
      );
      let notice: string | null = null;
      if (reason.trim() !== '') {
        try {
          await addNote(companyId, reason.trim());
        } catch {
          // Der Status ist gewechselt — das darf jetzt nicht als
          // Gesamtfehlschlag erscheinen. Gemeldet wird trotzdem, sonst fehlte
          // die Begründung stillschweigend im Verlauf.
          notice =
            t('components.statusChangeDialog.text');
        }
      }
      onChanged(notice, changed.intakeLink);
    } catch (f) {
      setError(errorText(f, t('components.statusChangeDialog.text2')));
    } finally {
      setLoading(false);
    }
  }

  const ended = newStatus === 'ended';

  return (
    <Dialog
      open={open}
      title={t('components.statusChangeDialog.title')}
      onClose={close}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={loading}>
            {t('components.statusChangeDialog.button')}</Button>
          <Button
            form="statuswechsel"
            type="submit"
            variant={ended ? 'danger' : 'primary'}
            loading={loading}
            disabled={newStatus === currentStatus}
          >
            {ended ? t('components.statusChangeDialog.button2') : t('components.statusChangeDialog.button3')}
          </Button>
        </>
      }
    >
      <form
        id="statuswechsel"
        onSubmit={(e) => {
          e.preventDefault();
          void change();
        }}
        noValidate
      >
        <p className="mb-3 text-sm text-leise">
          {t('components.statusChangeDialog.text3')}{COMPANY_STATUS[currentStatus].label}
        </p>
        <label
          htmlFor="neuer-status"
          className="mb-1 block text-sm font-medium text-text"
        >
          {t('components.statusChangeDialog.label')}</label>
        <Select
          id="neuer-status"
          value={newStatus}
          onChange={(e) => setNewStatus(e.target.value as CompanyStatus)}
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {COMPANY_STATUS[s].label}
            </option>
          ))}
        </Select>

        <label
          htmlFor="status-grund"
          className="mb-1 mt-4 block text-sm font-medium text-text"
        >
          {t('components.statusChangeDialog.label2')}</label>
        <textarea
          id="status-grund"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('components.statusChangeDialog.placeholder')}
          className="w-full rounded-lg border border-rahmen-ui bg-flaeche px-3 py-2 text-sm text-text placeholder:text-still focus:border-primaer"
        />

        {ended && (
          <p className="mt-3 text-sm text-leise">
            {t('components.statusChangeDialog.text4')}</p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-gefahr">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
