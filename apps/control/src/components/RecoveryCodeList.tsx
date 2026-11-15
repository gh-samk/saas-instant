import { AlertTriangle, Copy, Printer } from 'lucide-react';
import { today } from '@saas-instant/shared';
import { Button } from '@saas-instant/ui';
import { useProduct } from '../context/ProductContext';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';

interface Props {
  /** Genau acht Einträge. */
  codes: string[];
  confirmed: boolean;
  onConfirmedChange: (value: boolean) => void;
  /** Ruft window.print(). */
  onPrint: () => void;
  /** Kopiert alle Codes, zeilenweise. */
  onCopy: () => Promise<void> | void;
}

/**
 * Die einmalig sichtbaren Wiederherstellungscodes: Warnhinweis, druckbares
 * Codeblatt, Drucken/Kopieren und die Bestätigung.
 *
 * Wird an zwei Stellen unverändert wiederverwendet — im Ersteinrichtungs-
 * Wizard und beim Neu-Erzeugen auf der Einstellungsseite.
 */
export function RecoveryCodeList({
  codes,
  confirmed,
  onConfirmedChange,
  onPrint,
  onCopy,
}: Props) {
  const t = useT();
  const { productName } = useProduct();
  return (
    <div>
      <div className="print:hidden mb-4 flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-gefahr"
          aria-hidden="true"
        />
        <p className="text-sm text-text">
          {t('components.recoveryCodeList.text')}{' '}
          <span className="font-semibold">{t('components.recoveryCodeList.label')}</span> {t('components.recoveryCodeList.text2')}</p>
      </div>

      <div className="druckbereich">
        <div className="hidden print:block mb-6">
          <p className="text-lg font-semibold">
            {productName} {t('components.recoveryCodeList.text3')}</p>
          <p className="text-sm">
            {t('components.recoveryCodeList.text4')}{formatDate(today())} {t('components.recoveryCodeList.text5')}</p>
        </div>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 print:grid-cols-2 print:gap-3">
          {codes.map((code) => (
            <li
              key={code}
              className="rounded-lg border border-rahmen bg-flaeche-2 px-3 py-2 text-center font-mono text-sm tracking-wide text-text print:border print:border-black print:bg-white print:text-black"
            >
              {code}
            </li>
          ))}
        </ul>
      </div>

      <div className="print:hidden">
        {/* flex-wrap: auf 375 px stehen „Codes drucken" und „Codes kopieren"
            sonst nebeneinander und quetschen ihren Text. */}
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="secondary" onClick={onPrint}>
            <Printer className="h-4 w-4" aria-hidden="true" /> {t('components.recoveryCodeList.button')}</Button>
          <Button variant="secondary" onClick={() => void onCopy()}>
            <Copy className="h-4 w-4" aria-hidden="true" /> {t('components.recoveryCodeList.button2')}</Button>
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm text-text">
          <input
            type="checkbox"
            required
            checked={confirmed}
            onChange={(e) => onConfirmedChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-rahmen text-primaer focus:outline-none"
          />
          {t('components.recoveryCodeList.label2')}</label>
      </div>
    </div>
  );
}
