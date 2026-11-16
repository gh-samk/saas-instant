import { Fragment } from 'react';
import { AlertTriangle, Copy, Download, Printer } from 'lucide-react';
import { today } from '@saas-instant/shared';
import { Button, useToast } from '@saas-instant/ui';
import { useProduct } from '../context/ProductContext';
import { downloadTextFile, recoveryKeyFileText } from '../lib/vault';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';

interface Props {
  recoveryKey: string;
  confirmed: boolean;
  onConfirmedChange: (value: boolean) => void;
}

/**
 * Der einmalig sichtbare Wiederherstellungsschlüssel: Warnung, Schlüssel,
 * Kopieren, als TXT speichern, Drucken und das Pflicht-Häkchen „sicher
 * verwahrt". Gemeinsam genutzt von der Einrichtung und vom Neu-Erzeugen.
 */
export function RecoveryKeyPanel({ recoveryKey, confirmed, onConfirmedChange }: Props) {
  const t = useT();
  const toast = useToast();
  const { productName } = useProduct();
  const date = formatDate(today());

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      toast.show(t('vault.keyCopied'));
    } catch {
      toast.show(t('vault.keyCopyFailed'));
    }
  }

  return (
    <div>
      <div className="print:hidden mb-4 flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-gefahr" aria-hidden="true" />
        <p className="text-sm text-text">{t('vault.keyWarning')}</p>
      </div>

      <div className="druckbereich">
        <div className="hidden print:block mb-6">
          <p className="text-lg font-semibold">
            {t('vault.keyPrintHeading', { product: productName })}
          </p>
          <p className="text-sm">{t('vault.keyPrintDate', { date })}</p>
        </div>
        <p
          aria-label={t('vault.recoveryKeyLabel')}
          className="select-all rounded-lg border border-rahmen bg-flaeche-2 px-4 py-3 text-center font-mono text-base tracking-wide text-text print:border-black print:bg-white print:text-black"
        >
          {/* Jede Gruppe ist eine nicht trennbare Einheit; umbrochen wird nur
              zwischen den Gruppen (der Bindestrich bleibt am Gruppenende). */}
          {recoveryKey.split('-').map((group, index, all) => (
            <Fragment key={index}>
              <span className="inline-block whitespace-nowrap">
                {index < all.length - 1 ? `${group}-` : group}
              </span>
              {index < all.length - 1 && <wbr />}
            </Fragment>
          ))}
        </p>
      </div>

      <div className="print:hidden">
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => void copy()}>
            <Copy className="h-4 w-4" aria-hidden="true" /> {t('vault.keyCopy')}
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              downloadTextFile(
                t('vault.keyFileName'),
                recoveryKeyFileText(recoveryKey, productName, date),
              )
            }
          >
            <Download className="h-4 w-4" aria-hidden="true" /> {t('vault.keyDownload')}
          </Button>
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden="true" /> {t('vault.keyPrint')}
          </Button>
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => onConfirmedChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-rahmen-ui text-primaer"
          />
          {t('vault.keyConfirm')}
        </label>
      </div>
    </div>
  );
}
