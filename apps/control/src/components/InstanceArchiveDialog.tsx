import { useEffect, useState } from 'react';
import { Dialog, Button } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import { instanceHost } from '../lib/instance-address';
import { archiveInstance, type InstanceDetail } from '../lib/api';
import { useT } from '../i18n';

/**
 * Archivieren — kein Löschen, und der Dialog sagt genau das.
 *
 * Der Titel ist eine Aussage, keine Frage: Ein „Wirklich löschen?"-Ton wäre
 * hier falsch, weil nichts gelöscht wird. Der Text trennt deshalb in zwei
 * benannte Blöcke — was passiert und was ausdrücklich NICHT passiert. Icons
 * dafür (grüner Haken / rotes Kreuz) gibt es bewusst nicht: Sie bedeuten in
 * dieser Anwendung an anderer Stelle etwas anderes, und ein einmaliger
 * Bestätigungsbildschirm braucht sie nicht, um gelesen zu werden.
 *
 * ES WIRD KEINE SICHERUNG AUSGELÖST — der Vorgang NENNT den Sicherungsstand.
 * Eine frühere Fassung des Backends rief dafür einen Coolify-Endpunkt, den es
 * in dieser Betriebsform nicht gibt; er ist entfernt. Geblieben ist, was
 * `sicherungsstand()` in `instanz-aufbau.service.ts` schreibt: das Datum der
 * letzten gemeldeten Sicherung, und wenn sie fehlt oder zu alt ist, eine
 * ausdrückliche Handlungsaufforderung in `meldung`.
 *
 * Der Dialog sagt das VORHER. Eine Zusage im Bestätigungstext, die der Vorgang
 * nicht einlöst, ist die teuerste Sorte Ungenauigkeit: Sie wird genau in dem
 * Moment geglaubt, in dem man sich auf sie verlässt.
 */
export function InstanceArchiveDialog({
  open,
  companyId,
  companyName,
  subdomain,
  onClose,
  onArchived,
}: {
  open: boolean;
  companyId: string;
  companyName: string;
  subdomain: string;
  onClose: () => void;
  onArchived: (instance: InstanceDetail) => void;
}) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  function close() {
    if (loading) return;
    onClose();
  }

  async function archive() {
    setLoading(true);
    setError(null);
    try {
      onArchived(await archiveInstance(companyId));
    } catch (f) {
      setError(errorText(f, t('components.instanceArchiveDialog.text')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={t('components.instanceArchiveDialog.title')}
      size="sm"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close} disabled={loading}>
            {t('components.instanceArchiveDialog.button')}</Button>
          {/* Rot, weil die Instanz für die Organisation sofort unerreichbar
              wird — aber OHNE abgetipptes Bestätigungswort: Das wäre
              unangemessene Reibung für eine Handlung, die ausdrücklich kein
              Löschen ist. */}
          <Button variant="danger" type="button" loading={loading} onClick={() => void archive()}>
            {t('components.instanceArchiveDialog.button2')}</Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-leise">
        {t('components.instanceArchiveDialog.text2')}<span className="font-medium text-text">{companyName}</span> —{' '}
        <span className="font-mono break-all">{instanceHost(subdomain)}</span>
      </p>

      <div className="mb-3">
        <p className="mb-1.5 text-sm font-semibold text-text">{t('components.instanceArchiveDialog.text3')}</p>
        <ul className="list-inside list-disc space-y-1 text-sm text-text">
          <li>
            {t('components.instanceArchiveDialog.item')}{companyName} {t('components.instanceArchiveDialog.item2')}</li>
          <li>{t('components.instanceArchiveDialog.item3')}</li>
          <li>
            {t('components.instanceArchiveDialog.item4')}</li>
          <li>
            {t('components.instanceArchiveDialog.item5')}</li>
        </ul>
      </div>

      <div className="mb-3">
        <p className="mb-1.5 text-sm font-semibold text-text">
          {t('components.instanceArchiveDialog.text4')}</p>
        <ul className="list-inside list-disc space-y-1 text-sm text-text">
          <li>
            {t('components.instanceArchiveDialog.item6')}</li>
          <li>
            {t('components.instanceArchiveDialog.item7')}</li>
        </ul>
      </div>

      {/* Kein Versprechen, das der Vorgang nicht hält. */}
      <div className="rounded-lg border border-bedenken-rahmen bg-bedenken-bg px-3 py-2">
        <p className="text-sm text-bedenken-text">
          {t('components.instanceArchiveDialog.text5')}</p>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-gefahr">
          {error}
        </p>
      )}
    </Dialog>
  );
}
