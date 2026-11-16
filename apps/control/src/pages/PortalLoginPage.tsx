import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AuthCard, Button, Spinner } from '@saas-instant/ui';
import { useProduct } from '../context/ProductContext';
import { ssoStartUrl } from '../lib/portal-session';
import { TEXT_BUTTON } from '../lib/styles';
import { useT } from '../i18n';

interface Props {
  /** Der vorige Durchlauf ist gescheitert: nicht automatisch weiterleiten. */
  failed: boolean;
  /** Pfad, zu dem es nach der Anmeldung zurückgeht. */
  returnPath: string;
}

/**
 * Anmeldeseite im Modus `portal`.
 *
 * Ohne Sitzung geht es automatisch zum Portal. Nach einem gescheiterten
 * Durchlauf (`?sso=failed`) bleibt die Seite stehen — sonst entstünde eine
 * Schleife aus Weiterleitung und Fehler — und bietet den neuen Versuch an.
 * Der kleine Link „Notzugang" führt zur lokalen Anmeldung.
 */
export function PortalLoginPage({ failed, returnPath }: Props) {
  const t = useT();
  const { productName, showBrand, logoUrl } = useProduct();
  const target = ssoStartUrl(returnPath);

  useEffect(() => {
    if (!failed) window.location.replace(target);
  }, [failed, target]);

  return (
    <AuthCard
      logoUrl={logoUrl}
      title={productName}
      brand={showBrand ? t('auth.brand') : undefined}
      subtitle={t('sso.loginSubtitle')}
    >
      {failed ? (
        <div role="alert" className="mb-4 text-sm text-gefahr">
          <p className="font-medium">{t('sso.failedTitle')}</p>
          <p className="mt-1">{t('sso.failedText')}</p>
        </div>
      ) : (
        <div className="mb-4">
          <Spinner text={t('sso.redirecting')} />
        </div>
      )}
      <a href={target} className="block">
        <Button className="w-full justify-center py-3 text-base" tabIndex={-1}>
          {failed ? t('sso.retry') : t('sso.loginButton')}
        </Button>
      </a>
      <p className="mt-4 text-center text-xs">
        <Link to="/login?notfall=1" className={TEXT_BUTTON}>
          {t('sso.emergencyLink')}
        </Link>
      </p>
    </AuthCard>
  );
}
