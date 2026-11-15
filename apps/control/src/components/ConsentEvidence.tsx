import { Card } from '@saas-instant/ui';
import { ConsentStatusBadge } from './ConsentStatusBadge';
import type { Evidence } from '../lib/api';
import { consentDescription } from '../lib/consent-status';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';

/**
 * ===========================================================================
 * DER NACHWEIS — das, was im Streitfall zählt
 * ===========================================================================
 *
 * Gespeichert wird nicht „hat zugestimmt", sondern WOZU zugestimmt wurde. Der
 * Formulartext im Wortlaut ist deshalb der grösste Block auf dieser Karte und
 * nicht eine Fussnote: Ohne ihn ist das Häkchen von damals eine Behauptung.
 *
 * BEIDE ZEITPUNKTE UND BEIDE IP-ADRESSEN STEHEN NEBENEINANDER, und das ist der
 * eigentliche Beweisgang. Die Eintragung kann jeder für eine fremde Adresse
 * auslösen — erst der Klick im Postfach zeigt, dass der Inhaber der Adresse
 * zugestimmt hat. Fehlt die zweite Zeile, fehlt genau dieser Teil, und die
 * Karte sagt das auch aus, statt die Lücke leer zu lassen.
 *
 * DIE TOKEN STEHEN NICHT DARIN, und der Server liefert sie auch nicht. Wer den
 * Abmeldetoken einer fremden Adresse liest, kann sie abmelden. Angezeigt wird
 * nur, DASS es einen gibt — das beantwortet die einzige Frage, die man an
 * dieser Stelle wirklich hat: „Kann sich diese Person überhaupt abmelden?"
 *
 * DATUM OHNE UHRZEIT (Regel 1 der Projektkonventionen). Der Server hält den vollen
 * Zeitstempel fest — er ist der Nachweis, nicht die Anzeige. Wer die Uhrzeit
 * braucht, weil es auf Minuten ankommt, findet sie im Audit-Log.
 */
export function ConsentEvidence({ evidence }: { evidence: Evidence }) {
  const t = useT();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 break-all text-sm font-semibold text-text">
          {evidence.email}
        </p>
        <ConsentStatusBadge status={evidence.status} />
      </div>
      <p className="mt-1 text-sm text-leise">
        {consentDescription(evidence.status)}
      </p>

      {/* Der Wortlaut zuerst und abgesetzt: Er ist der Nachweis, alles andere
          sind die Umstände seiner Entstehung. */}
      <Card className="mt-4 bg-flaeche-2 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-leise">
          {t('components.consentEvidence.text')}</p>
        <p className="mt-1 whitespace-pre-line break-words text-sm text-text">
          {evidence.formText}
        </p>
        <p className="mt-2 text-xs text-leise">
          {t('components.consentEvidence.text2')}</p>
      </Card>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-leise">{t('components.consentEvidence.text3')}</dt>
          <dd className="ziffern-tabellarisch text-sm text-text">
            {evidence.subscribedAt ? formatDate(evidence.subscribedAt) : '—'}
          </dd>
          <dd className="break-all text-xs text-leise">
            {evidence.ipAtSubscription
              ? t('components.consentEvidence.dd', { ipAtSubscription: evidence.ipAtSubscription })
              : t('components.consentEvidence.dd2')}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-leise">{t('components.consentEvidence.text4')}</dt>
          <dd className="ziffern-tabellarisch text-sm text-text">
            {evidence.confirmedAt ? formatDate(evidence.confirmedAt) : '—'}
          </dd>
          <dd className="break-all text-xs text-leise">
            {evidence.confirmedAt === null
              ? t('components.consentEvidence.dd3')
              : evidence.ipAtConfirmation
                ? t('components.consentEvidence.dd4', { ipAtConfirmation: evidence.ipAtConfirmation })
                : t('components.consentEvidence.dd2')}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-leise">{t('components.consentEvidence.text5')}</dt>
          <dd className="ziffern-tabellarisch text-sm text-text">
            {evidence.unsubscribedAt ? formatDate(evidence.unsubscribedAt) : '—'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-leise">{t('components.consentEvidence.text6')}</dt>
          <dd className="ziffern-tabellarisch text-sm text-text">
            {evidence.deactivatedAt ? formatDate(evidence.deactivatedAt) : '—'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-leise">{t('components.consentEvidence.text7')}</dt>
          <dd className="break-words text-sm text-text">
            {evidence.origin ?? t('components.consentEvidence.dd5')}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-leise">{t('components.consentEvidence.text8')}</dt>
          <dd className="text-sm text-text">
            {evidence.unsubscribeTokenPresent
              ? t('components.consentEvidence.dd6')
              : t('components.consentEvidence.dd7')}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-leise">
        {t('components.consentEvidence.text9')}</p>
    </div>
  );
}
