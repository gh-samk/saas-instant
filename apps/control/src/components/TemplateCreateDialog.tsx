import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { Dialog, InputField, Button } from '@saas-instant/ui';
import { SelectField } from './FormFields';
import {
  draftCarries,
  TemplateFields,
  type TemplateDraft,
} from './TemplateFields';
import { errorText } from '../lib/api-client';
import { CHANNEL_TEXTS } from '../lib/consent-status';
import {
  createTemplate,
  MAIL_CHANNELS,
  TEMPLATE_NAME_MAX_LENGTH,
  type MailChannel,
  type Template,
} from '../lib/api';
import { placeholdersFromInput } from '../utils/placeholders';
import { structureFields as structure } from '../utils/template-structure';
import { useT } from '../i18n';

const EMPTY: TemplateDraft = {
  subject: '',
  contentHtml: '',
  contentText: '',
  placeholdersInput: '',
  eyebrow: '',
  heading: '',
  buttonText: '',
  buttonTarget: '',
};

/**
 * Eine neue Vorlage.
 *
 * DER KANAL LÄSST SICH NUR HIER SETZEN — danach nie wieder. `VorlageAendernDto`
 * enthält ihn nicht, und das ist die Regel und nicht eine Lücke: Wäre er
 * änderbar, liesse sich eine Werbebotschaft nachträglich zur Transaktionsmail
 * erklären und an Leute schicken, die nie eingewilligt haben — R3 wäre über
 * einen Datenbankwert aushebelbar. Deshalb steht am Feld ein Schloss und der
 * Satz dazu, und nicht nur eine stille Auswahl, die später verschwindet.
 *
 * DASSELBE GILT FÜR DEN NAMEN. Er ist die Kennung, unter der die Vorlage im
 * Verlauf der Organisation auftaucht; auch er steht nicht im Änderungs-DTO.
 */
export function TemplateCreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (template: Template) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<MailChannel>('marketing');
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setChannel('marketing');
    setDraft(EMPTY);
    setError(null);
  }, [open]);

  const ready = name.trim() !== '' && draftCarries(draft);

  async function create() {
    setLoading(true);
    setError(null);
    try {
      const template = await createTemplate({
        name: name.trim(),
        channel,
        subject: draft.subject.trim(),
        contentHtml: draft.contentHtml,
        placeholders: placeholdersFromInput(draft.placeholdersInput),
        ...structure(channel, draft),
      });
      onCreated(template);
    } catch (f) {
      setError(errorText(f, t('components.templateCreateDialog.text')));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={t('components.templateCreateDialog.title')}
      size="xl"
      onClose={() => {
        if (!loading) onClose();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {t('components.templateCreateDialog.button')}</Button>
          <Button
            form="vorlage-anlegen-formular"
            type="submit"
            loading={loading}
            disabled={!ready}
          >
            {t('components.templateCreateDialog.button2')}</Button>
        </>
      }
    >
      <form
        id="vorlage-anlegen-formular"
        onSubmit={(ev) => {
          ev.preventDefault();
          void create();
        }}
        noValidate
      >
        <fieldset disabled={loading} className="min-w-0 border-0 p-0">
          <InputField
            id="vorlage-name"
            name="vorlage-name"
            label={t('components.templateCreateDialog.label')}
            autoComplete="off"
            value={name}
            onChange={(ev) =>
              setName(ev.target.value.slice(0, TEMPLATE_NAME_MAX_LENGTH))
            }
            helperText={t('components.templateCreateDialog.helperText')}
          />

          <SelectField
            id="vorlage-kanal"
            label={t('components.templateCreateDialog.label2')}
            value={channel}
            onChange={(value) => setChannel(value as MailChannel)}
            helperText={CHANNEL_TEXTS[channel].long}
          >
            {MAIL_CHANNELS.map((value) => (
              <option key={value} value={value}>
                {CHANNEL_TEXTS[value].label}
              </option>
            ))}
          </SelectField>

          <div className="mb-4 flex items-start gap-3 rounded-lg border border-rahmen bg-flaeche-2 p-3">
            <Lock
              className="mt-0.5 h-4 w-4 shrink-0 text-leise"
              aria-hidden="true"
            />
            <p className="text-sm text-leise">
              {t('components.templateCreateDialog.text2')}</p>
          </div>
        </fieldset>

        <TemplateFields
          draft={draft}
          onChange={setDraft}
          channel={channel}
          blocked={loading}
          idPrefix="vorlage-neu"
        />

        {error && (
          <p role="alert" className="text-sm text-gefahr">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
