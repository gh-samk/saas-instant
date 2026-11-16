import { useState } from 'react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { RequiredLegend, SelectField, fieldLabel } from './FormFields';
import { errorText } from '../lib/api-client';
import { createCompany, type Source, type Company } from '../lib/api';
import { SOURCE_LABEL } from '../lib/company-status';
import { useT } from '../i18n';

const SOURCES: Source[] = ['form', 'phone', 'referral', 'event'];

/**
 * Anlegen einer Organisation — bewusst ein kleiner Dialog, keine Vollseite.
 *
 * EINZIGES PFLICHTFELD IST DER NAME. Er ist der einzige Wert, der bei jedem
 * denkbaren Anfrageweg vorliegt: Ein Telefonanruf ohne E-Mail-Adresse ist eine
 * ganz normale erste Berührung, ein Kontakt ganz ohne Namen dagegen nicht
 * ablegbar — die Liste hätte nichts, woran sie ihn erkennt. Alles Weitere
 * lässt sich auf der Detailseite nachtragen.
 *
 * Einen Status wählt hier niemand: Der Server setzt `anfrage` als Vorgabe des
 * Schemas, und eine Auswahl wäre eine überflüssige Entscheidung im Normalfall.
 */
export function CompanyCreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (company: Company) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [contactName, setContactPersonName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setContactPersonName('');
    setEmail('');
    setPhone('');
    setSource('');
    setError(null);
  }

  function close() {
    if (loading) return;
    reset();
    onClose();
  }

  async function create() {
    if (name.trim() === '') {
      setError(t('components.companyCreateDialog.text'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Leere Felder gar nicht erst mitschicken: Der Server prüft jedes
      // mitgeschickte Feld (eine leere E-Mail wäre eine ungültige E-Mail).
      const created = await createCompany({
        name: name.trim(),
        ...(contactName.trim() !== ''
          ? { contactName: contactName.trim() }
          : {}),
        ...(email.trim() !== '' ? { contactEmail: email.trim() } : {}),
        ...(phone.trim() !== ''
          ? { contactPhone: phone.trim() }
          : {}),
        ...(source !== '' ? { source: source as Source } : {}),
      });
      reset();
      onCreated(created);
    } catch (f) {
      setError(
        errorText(f, t('components.companyCreateDialog.text2')),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={t('components.companyCreateDialog.title')}
      onClose={close}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={loading}>
            {t('components.companyCreateDialog.button')}</Button>
          <Button
            form="organisation-anlegen"
            type="submit"
            loading={loading}
            disabled={name.trim().length === 0}
          >
            {t('components.companyCreateDialog.button2')}</Button>
        </>
      }
    >
      <form
        id="organisation-anlegen"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        noValidate
      >
        <RequiredLegend />
        <InputField
          label={fieldLabel(t('components.companyCreateDialog.label'), 'required')}
          name="organisation-name"
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <InputField
          label={fieldLabel(t('components.companyCreateDialog.label2'), 'optional')}
          name="organisation-ansprechpartnerin"
          value={contactName}
          onChange={(e) => setContactPersonName(e.target.value)}
        />
        <InputField
          label={fieldLabel(t('components.companyCreateDialog.label3'), 'optional')}
          name="organisation-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <InputField
          label={fieldLabel(t('components.companyCreateDialog.label4'), 'optional')}
          name="organisation-telefon"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <SelectField
          label={fieldLabel(t('components.companyCreateDialog.label5'), 'optional')}
          id="organisation-herkunft"
          value={source}
          onChange={setSource}
        >
          <option value="">{t('components.companyCreateDialog.option')}</option>
          {SOURCES.map((h) => (
            <option key={h} value={h}>
              {SOURCE_LABEL[h]}
            </option>
          ))}
        </SelectField>
        {error && (
          <p role="alert" className="mt-3 text-sm text-gefahr">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
