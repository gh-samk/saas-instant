import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button, DateField, Dialog, useToast } from '@saas-instant/ui';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import { downloadGobdExport, type SecondFactorEvidence } from '../lib/api';
import { useT } from '../i18n';

function today(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * Export für die Betriebsprüfung (GoBD Z3): Zeitraum wählen, ZIP laden.
 *
 * Zweiter Faktor wie bei den anderen sensiblen Aktionen: erst ohne Nachweis
 * versuchen; verlangt der Server ihn, fragt der Nachweis-Dialog nach.
 */
export function GobdExportDialog({
  open,
  totpPossible,
  onClose,
}: {
  open: boolean;
  totpPossible: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const evidenceState = useSecondFactorEvidence();
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(today());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rangeValid = from !== '' && to !== '' && from <= to;

  async function run(evidence?: SecondFactorEvidence) {
    setLoading(true);
    setError(null);
    try {
      const { blob, fileName } = await downloadGobdExport({ from, to }, evidence);
      const reference = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = reference;
      anchor.download = fileName ?? `gobd-export-${from}_${to}.zip`;
      anchor.click();
      URL.revokeObjectURL(reference);
      evidenceState.close();
      toast.show(t('gobd.exportDone'));
      onClose();
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      setError(errorText(f, t('gobd.exportFailed')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        title={t('gobd.exportTitle')}
        size="sm"
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('gobd.exportCancel')}
            </Button>
            <Button
              loading={loading}
              disabled={!rangeValid}
              onClick={() => void run()}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {t('gobd.exportStart')}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-text">{t('gobd.exportIntro')}</p>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <DateField
            id="gobd-from"
            label={t('gobd.exportFrom')}
            value={from}
            onChange={setFrom}
            required
          />
          <DateField
            id="gobd-to"
            label={t('gobd.exportTo')}
            value={to}
            onChange={setTo}
            required
          />
        </div>
        {!rangeValid && (
          <p role="alert" className="mb-2 text-sm text-gefahr">
            {t('gobd.exportRangeInvalid')}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="mb-2 text-sm text-gefahr">
            {error}
          </p>
        )}
        <p className="text-sm text-leise">{t('gobd.exportDisclaimer')}</p>
      </Dialog>

      {/* Als Letztes im Baum: liegt über dem Export-Dialog. */}
      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('gobd.exportEvidenceTitle')}
        declaration={t('gobd.exportEvidenceDeclaration')}
        totpPossible={totpPossible}
        loading={loading}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void run(evidence)}
      />
    </>
  );
}
