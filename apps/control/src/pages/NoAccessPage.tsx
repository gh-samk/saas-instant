import { Link } from 'react-router-dom';
import { AuthCard } from '@saas-instant/ui';
import { useProduct } from '../context/ProductContext';
import { TEXT_BUTTON } from '../lib/styles';
import { useT } from '../i18n';

/**
 * „Kein Zugriff auf diese Verwaltung": Das Portal kennt das Konto, es hat hier
 * aber keine Rolle. Der Server hat dafür weder ein Konto angelegt noch eine
 * Sitzung ausgestellt.
 */
export function NoAccessPage() {
  const t = useT();
  const { productName, showBrand, logoUrl } = useProduct();
  return (
    <AuthCard
      logoUrl={logoUrl}
      title={productName}
      brand={showBrand ? t('auth.brand') : undefined}
      subtitle={t('sso.noAccessTitle')}
    >
      <p role="alert" className="text-sm text-leise">
        {t('sso.noAccessText')}
      </p>
      <p className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link to="/login?sso=failed" className={TEXT_BUTTON}>
          {t('sso.noAccessRetry')}
        </Link>
        <Link to="/login?notfall=1" className={TEXT_BUTTON}>
          {t('sso.emergencyLink')}
        </Link>
      </p>
    </AuthCard>
  );
}
