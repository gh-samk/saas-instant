import { InputField } from '@saas-instant/ui';
import { WordingField } from './WordingField';
import {
  STANDARD_PLACEHOLDERS,
  TEMPLATE_SUBJECT_MAX_LENGTH,
  TEMPLATE_HTML_MAX_LENGTH,
  TEMPLATE_CONTENT_MAX_LENGTH,
  TEMPLATE_CONTENT_MIN_LENGTH,
  type MailChannel,
} from '../lib/api';
import {
  placeholdersFromInput,
  unknownPlaceholders,
} from '../utils/placeholders';
import { t, useT } from '../i18n';

/** Der bearbeitbare Teil einer Vorlage — überall gleich. */
export interface TemplateDraft {
  subject: string;
  /**
   * Die vier Strukturfelder der Werbemail.
   *
   * IM ENTWURF SIND SIE ZEICHENKETTEN, NIE `null` — ein Formularfeld hat
   * immer einen Wert. Beim Speichern macht der Server aus einem leeren Text
   * wieder `null`; die Unterscheidung „nicht geschickt" gegen „leer
   * geschickt" trifft der Aufrufer, nicht dieses Formular.
   */
  eyebrow: string;
  heading: string;
  buttonText: string;
  buttonTarget: string;
  /**
   * Der formatierte Rumpf — das, was verschickt wird.
   *
   * Er ist die massgebliche Fassung: Schickt die Oberflaeche ihn mit, leitet
   * der Server den Textteil daraus ab.
   */
  contentHtml: string;
  /**
   * Die daraus abgeleitete Textfassung — NUR FUER DIE ANZEIGE.
   *
   * Laengengrenze und Platzhalterhinweis sollen beim Tippen stimmen und nicht
   * erst beim Speichern. Verschickt wird sie nicht; der Server leitet seine
   * eigene ab, damit die beiden Fassungen nicht auseinanderlaufen koennen.
   */
  contentText: string;
  /** Die Rohfassung des Platzhalterfeldes, so wie sie getippt wurde. */
  placeholdersInput: string;
}

/**
 * Die Namen, die im Text vorkommen dürfen: die beiden Standardplatzhalter plus
 * die selbstdeklarierten aus dem Feld.
 */
export function allowedPlaceholders(draft: TemplateDraft): string[] {
  return [
    ...STANDARD_PLACEHOLDERS,
    ...placeholdersFromInput(draft.placeholdersInput),
  ];
}

/** Platzhalter, die im Entwurf stehen, aber nirgends erklärt sind. */
export function openNames(draft: TemplateDraft): string[] {
  const allowed = allowedPlaceholders(draft);
  return [
    ...new Set([
      ...unknownPlaceholders(draft.subject, allowed),
      ...unknownPlaceholders(draft.contentText, allowed),
      // AUCH IM MARKUP. `{{organi<strong>sation}}` sieht in der Textfassung
      // heil aus und wird im HTML-Teil trotzdem nicht ersetzt — dann truege
      // die eine Fassung einen Namen und die andere geschweifte Klammern.
      // Der Server prueft beide; hier faellt es schon beim Tippen auf.
      ...unknownPlaceholders(draft.contentHtml, allowed),
    ]),
  ];
}

/** Trägt der Entwurf? Dieselben Grenzen, die auch das DTO zieht. */
export function draftCarries(draft: TemplateDraft): boolean {
  return (
    draft.subject.trim() !== '' &&
    draft.contentText.trim().length >= TEMPLATE_CONTENT_MIN_LENGTH &&
    openNames(draft).length === 0
  );
}

/**
 * Betreff, Inhalt und Platzhalterliste — die drei Felder, die sich an einer
 * Vorlage ändern lassen.
 *
 * DER INHALT IST FORMATIERBAR. Hier stand einmal, es gebe kein HTML-Feld,
 * weil das Backend nur `inhaltText` kannte — ein Feld, dessen Inhalt niemand
 * verschickt, wäre schlimmer als die Auslassung gewesen. Diese Voraussetzung
 * gilt nicht mehr: Der Server nimmt `inhaltHtml` entgegen, säubert es und
 * leitet den Textteil selbst ab. Deshalb jetzt ein Redaktionsfeld mit genau
 * den drei Auszeichnungen, die der Säuberer durchlässt — nicht mehr, damit
 * kein Knopf etwas verspricht, das beim Versand verschwindet.
 *
 * DIE PLATZHALTER STEHEN ERKLÄRT DA, nicht nur als Regel. Wer `{{name}}`
 * tippt, ohne `name` zu deklarieren, sieht das sofort — und nicht erst, wenn
 * der Server das Speichern ablehnt. Massgeblich bleibt trotzdem der Server:
 * Weicht diese Fassung ab, steht seine Meldung im Fehlerfeld.
 */
/**
 * Was am Knopf nicht stimmt — oder `undefined`.
 *
 * Zwei Fälle, und beide sind still gefährlich: eine halbe Angabe (der Rahmen
 * lässt den Knopf dann weg) und ein Ziel ohne `https://` (der Server weist
 * die Vorlage ab, aber erst beim Speichern).
 */
export function buttonObjection(draft: {
  buttonText: string;
  buttonTarget: string;
}): string | undefined {
  const text = draft.buttonText.trim();
  const target = draft.buttonTarget.trim();
  if (text === '' && target === '') return undefined;
  if (text === '') return t('components.templateFields.text');
  if (target === '') return t('components.templateFields.text2');
  if (!/^https?:\/\/\S+$/i.test(target)) {
    return t('components.templateFields.text3');
  }
  return undefined;
}

export function TemplateFields({
  draft,
  onChange,
  channel,
  blocked,
  idPrefix,
}: {
  draft: TemplateDraft;
  onChange: (draft: TemplateDraft) => void;
  channel: MailChannel;
  blocked: boolean;
  /** Damit die Feld-IDs eindeutig bleiben, wenn zwei Formulare offen sind. */
  idPrefix: string;
}) {
  const t = useT();
  const open = openNames(draft);
  const allowed = allowedPlaceholders(draft);
  const tooShort =
    draft.contentText.trim() !== '' &&
    draft.contentText.trim().length < TEMPLATE_CONTENT_MIN_LENGTH;

  // DER KNOPF BRAUCHT BEIDES, und die Meldung steht am ZIEL — dort tippt man
  // zuletzt. Ein halb ausgefüllter Knopf entfiele beim Rahmen geräuschlos;
  // hier zu schweigen hiesse, eine Eingabe zu verschlucken.
  const buttonError = buttonObjection(draft);

  return (
    <fieldset disabled={blocked} className="min-w-0 border-0 p-0">
      <InputField
        id={`${idPrefix}-betreff`}
        name={`${idPrefix}-betreff`}
        label={t('components.templateFields.label')}
        autoComplete="off"
        value={draft.subject}
        onChange={(ev) =>
          onChange({
            ...draft,
            subject: ev.target.value.slice(0, TEMPLATE_SUBJECT_MAX_LENGTH),
          })
        }
        helperText={t('components.templateFields.helperText')}
      />

      {/* ===================================================================
          DIE STRUKTURFELDER — nur beim werblichen Kanal.
          ===================================================================
          Der Transaktionsrahmen kennt weder Vorüberschrift noch Knopf; sie
          dort anzubieten hiesse, Felder zu zeigen, die nirgends ankommen.
          Eine Transaktionsvorlage ist eine Nachricht zu einem Vorgang, keine
          gestaltete Mail. */}
      {channel === 'marketing' && (
        <>
          <InputField
            id={`${idPrefix}-vorueberschrift`}
            name={`${idPrefix}-vorueberschrift`}
            label={t('components.templateFields.label2')}
            autoComplete="off"
            maxLength={80}
            value={draft.eyebrow}
            onChange={(ev) =>
              onChange({ ...draft, eyebrow: ev.target.value })
            }
            helperText={t('components.templateFields.helperText2')}
          />

          <InputField
            id={`${idPrefix}-ueberschrift`}
            name={`${idPrefix}-ueberschrift`}
            label={t('components.templateFields.label3')}
            autoComplete="off"
            maxLength={200}
            value={draft.heading}
            onChange={(ev) =>
              onChange({ ...draft, heading: ev.target.value })
            }
            helperText={t('components.templateFields.helperText3')}
          />
        </>
      )}

      <WordingField
        id={`${idPrefix}-inhalt`}
        label={t('components.templateFields.label4')}
        html={draft.contentHtml}
        onChange={({ html, text }) =>
          onChange({
            ...draft,
            contentHtml: html.slice(0, TEMPLATE_HTML_MAX_LENGTH),
            contentText: text.slice(0, TEMPLATE_CONTENT_MAX_LENGTH),
          })
        }
        helperText={
          channel === 'marketing'
            ? t('components.templateFields.helperText4', { TEMPLATE_CONTENT_MIN_LENGTH: TEMPLATE_CONTENT_MIN_LENGTH })
            : t('components.templateFields.helperText5', { TEMPLATE_CONTENT_MIN_LENGTH: TEMPLATE_CONTENT_MIN_LENGTH })
        }
      />
      {tooShort && (
        <p className="-mt-3 mb-4 text-sm text-gefahr">
          {t('components.templateFields.text4', { TEMPLATE_CONTENT_MIN_LENGTH: TEMPLATE_CONTENT_MIN_LENGTH })}
        </p>
      )}

      {channel === 'marketing' && (
        <div className="mb-4 grid gap-x-3 sm:grid-cols-2">
          <InputField
            id={`${idPrefix}-knopftext`}
            name={`${idPrefix}-knopftext`}
            label={t('components.templateFields.label5')}
            autoComplete="off"
            maxLength={60}
            value={draft.buttonText}
            onChange={(ev) =>
              onChange({ ...draft, buttonText: ev.target.value })
            }
            helperText={t('components.templateFields.helperText6')}
          />
          <InputField
            id={`${idPrefix}-knopfziel`}
            name={`${idPrefix}-knopfziel`}
            label={t('components.templateFields.label6')}
            type="url"
            autoComplete="off"
            maxLength={500}
            placeholder="https://…"
            value={draft.buttonTarget}
            onChange={(ev) =>
              onChange({ ...draft, buttonTarget: ev.target.value })
            }
            error={buttonError}
            helperText={t('components.templateFields.helperText7')}
          />
        </div>
      )}

      <InputField
        id={`${idPrefix}-platzhalter`}
        name={`${idPrefix}-platzhalter`}
        label={t('components.templateFields.label7')}
        autoComplete="off"
        placeholder={t('components.templateFields.placeholder')}
        value={draft.placeholdersInput}
        onChange={(ev) =>
          onChange({ ...draft, placeholdersInput: ev.target.value })
        }
        helperText={t('components.templateFields.helperText8')}
      />

      <div className="mb-4 rounded-lg border border-rahmen bg-flaeche-2 p-3">
        <p className="text-sm font-semibold text-text">
          {t('components.templateFields.text5')}</p>
        <p className="mt-1 text-sm text-leise">
          {t('components.templateFields.text6')}{' '}
          <span className="font-mono text-xs">{'{{organisation}}'}</span> {t('components.templateFields.text7')}</p>
        <p className="mt-2 text-sm text-leise">
          {t('components.templateFields.text8')}</p>
        <ul className="mt-1 list-inside list-disc text-sm text-leise">
          <li>
            <span className="font-mono text-xs">{'{{organisation}}'}</span> {t('components.templateFields.item')}</li>
          <li>
            <span className="font-mono text-xs">{'{{abmeldelink}}'}</span> {t('components.templateFields.item2')}</li>
        </ul>
        <p className="mt-2 text-sm text-leise">
          {t('components.templateFields.text9')}<span className="font-mono text-xs">{'{{name}}'}</span>{t('components.templateFields.text10')}</p>
        {allowed.length > 0 && (
          <p className="mt-2 text-sm text-leise">
            {t('components.templateFields.text11', { value: allowed.map((name) => `{{${name}}}`).join(', ') })}
          </p>
        )}
      </div>

      {open.length > 0 && (
        <p role="alert" className="mb-4 text-sm text-gefahr">
          {t('components.templateFields.text12', { value: open
            .map((name) => `{{${name}}}`)
            .join(', ') })}
        </p>
      )}
    </fieldset>
  );
}
