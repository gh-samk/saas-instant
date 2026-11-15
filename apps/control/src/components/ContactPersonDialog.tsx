import { useEffect, useState } from 'react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { errorText } from '../lib/api-client';
import { changeContactPerson, type Company } from '../lib/api';
import { useT } from '../i18n';

/**
 * Wechsel der Hauptansprechpartnerin — eigene Handlung, eigener Endpunkt.
 *
 * Zwei Gründe, warum das kein Feld im Stammdaten-Formular ist: Der Server
 * weist `ansprechpartnerin*` in PATCH ausdrücklich zurück, weil jeder Wechsel
 * die Notiz „Ansprechpartnerin gewechselt: … → …" im Verlauf erzeugt. Und er
 * ERSETZT den Datensatz: Nicht ausgefüllte Felder werden geleert, damit nicht
 * die Telefonnummer der Vorgängerin am Datensatz der Nachfolgerin stehen
 * bleibt. Genau deshalb steht dieser Hinweis auch im Dialog — sonst wäre die
 * Löschung eine Überraschung.
 */
export function ContactPersonDialog({
  open,
  company,
  onClose,
  onChanged,
}: {
  open: boolean;
  company: Company;
  onClose: () => void;
  onChanged: (company: Company) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [functionValue, setFunction] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Leer starten, nicht mit der bisherigen Person vorbelegt: Es geht um eine
  // ANDERE Person. Vorbelegte Felder würden hier zu halb überschriebenen
  // Datensätzen führen.
  useEffect(() => {
    if (open) {
      setName('');
      setFunction('');
      setEmail('');
      setPhone('');
      setError(null);
    }
  }, [open]);

  function close() {
    if (loading) return;
    onClose();
  }

  async function change() {
    if (name.trim() === '') {
      setError(t('components.contactPersonDialog.text'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const updated = await changeContactPerson(company.id, {
        name: name.trim(),
        ...(email.trim() !== '' ? { email: email.trim() } : {}),
        ...(phone.trim() !== '' ? { phone: phone.trim() } : {}),
        ...(functionValue.trim() !== '' ? { functionValue: functionValue.trim() } : {}),
      });
      onChanged(updated);
    } catch (f) {
      setError(
        errorText(f, t('components.contactPersonDialog.text2')),
      );
    } finally {
      setLoading(false);
    }
  }

  const previous = company.contactName;

  return (
    <Dialog
      open={open}
      title={previous ? t('components.contactPersonDialog.title') : t('components.contactPersonDialog.title2')}
      onClose={close}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={loading}>
            {t('components.contactPersonDialog.button')}</Button>
          <Button
            form="ansprechpartnerin-wechseln"
            type="submit"
            loading={loading}
            disabled={name.trim().length === 0}
          >
            {previous ? t('components.contactPersonDialog.button2') : t('components.contactPersonDialog.button3')}
          </Button>
        </>
      }
    >
      <form
        id="ansprechpartnerin-wechseln"
        onSubmit={(e) => {
          e.preventDefault();
          void change();
        }}
        noValidate
      >
        <p className="mb-4 text-sm text-leise">
          {previous
            ? t('components.contactPersonDialog.text3', { previous: previous })
            : t('components.contactPersonDialog.text4')}
        </p>
        <InputField
          label={t('components.contactPersonDialog.label')}
          name="neue-ansprechpartnerin-name"
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <InputField
          label={t('components.contactPersonDialog.label2')}
          name="neue-ansprechpartnerin-funktion"
          value={functionValue}
          onChange={(e) => setFunction(e.target.value)}
        />
        <InputField
          label={t('components.contactPersonDialog.label3')}
          name="neue-ansprechpartnerin-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <InputField
          label={t('components.contactPersonDialog.label4')}
          name="neue-ansprechpartnerin-telefon"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-gefahr">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
