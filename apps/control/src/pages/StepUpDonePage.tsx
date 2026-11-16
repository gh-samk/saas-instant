import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuthCard } from '@saas-instant/ui';
import { useProduct } from '../context/ProductContext';
import { announceStepUp } from '../lib/portal-session';
import { useT } from '../i18n';

/**
 * Ziel des Step-up-Fensters. Meldet das Ergebnis an das Fenster mit dem
 * Nachweisdialog und schließt sich. Ohne BroadcastChannel geht es zurück zur
 * Startseite.
 */
export function StepUpDonePage() {
  const t = useT();
  const { productName, showBrand, logoUrl } = useProduct();
  const [params] = useSearchParams();
  const ok = params.get('sso') !== 'failed';

  // Unter React StrictMode (Dev) läuft der Effekt zweimal; gemeldet wird nur einmal.
  const announced = useRef(false);

  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    // Das Ergebnis geht über einen BroadcastChannel: `window.opener` ist nach
    // dem Weg durch das Portal (COOP) nicht mehr da.
    if (announceStepUp(ok)) {
      window.close();
      return;
    }
    if (ok) window.location.replace('/');
  }, [ok]);

  return (
    <AuthCard
      logoUrl={logoUrl}
      title={productName}
      brand={showBrand ? t('auth.brand') : undefined}
      subtitle={ok ? t('sso.stepUpDoneTitle') : t('sso.failedTitle')}
    >
      <p className="text-sm text-leise">
        {ok ? t('sso.stepUpDoneText') : t('sso.stepUpDoneFailed')}
      </p>
    </AuthCard>
  );
}
