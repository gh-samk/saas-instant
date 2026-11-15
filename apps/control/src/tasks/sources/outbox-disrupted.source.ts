import type { ErrorClass } from '../../mail/mail.service';
import type {
  OutboxSituation,
  OutboxRole,
} from '../../outbox/outbox.types';
import { urgencyFrom } from '../urgency';
import type {
  Task,
  TasksContext,
  TaskSource,
  SourceResult,
} from '../tasks.types';

const Role: Record<OutboxRole, { whose: string; consequence: string; wo: string }> = {
  admin: {
    whose: 'der Verwaltung',
    consequence:
      'Anmeldecodes, Aufnahmelinks, Rechnungen und Rundmails der Verwaltung ' +
      'gehen nicht hinaus.',
    wo: 'SMTP_* der Verwaltung in Coolify',
  },
  instances: {
    whose: 'der Instanzen',
    consequence:
      'Neu angelegte Instanzen bekommen diesen Postausgang mit — Einladungen ' +
      'und „Passwort vergessen" kommen dort nicht an. Bestehende Instanzen ' +
      'tragen eigene SMTP-Werte und sind betroffen, wenn sie dasselbe ' +
      'Postfach nutzen.',
    wo: 'CONTROL_INSTANCE_SMTP_* der Verwaltung in Coolify',
  },
};

/** Was die Klasse bedeutet — in Worten, die zur Behebung führen. */
const Cause: Record<ErrorClass, string> = {
  login:
    'Der Mailserver lehnt die Anmeldung ab: Benutzername oder Passwort ' +
    'stimmen nicht (mehr). Wurde das Passwort des Postfachs geändert?',
  tls:
    'Die verschlüsselte Verbindung zum Mailserver kommt nicht zustande ' +
    '(TLS). Port und Zertifikat des Mailservers prüfen.',
  verbindung:
    'Der Mailserver ist nicht erreichbar. Adresse und Port prüfen — oder ob ' +
    'der Mailserver selbst läuft.',
  absender_abgewiesen:
    'Der Mailserver weist unsere Absenderadresse ab. Das Postfach darf nur ' +
    'unter der eigenen Adresse versenden.',
  // Wird von der Lage nie gemeldet (Empfängerabsagen zählen nicht); der
  // Eintrag steht nur, weil der Typ es verlangt.
  empfaenger_abgewiesen: 'Eine Empfängeradresse wurde abgewiesen.',
  unknown:
    'Der Versand ist mit einem Fehler gescheitert, der sich keiner Ursache ' +
    'zuordnen lässt. Der Wortlaut steht im Log der Verwaltung.',
};

/** Der Tag, an dem die Störung begann — nie später als heute. */
function dayFrom(iso: string, todayDay: string): string {
  const day = iso.slice(0, 10);
  return day < todayDay ? day : todayDay;
}

function taskFrom(situation: OutboxSituation, todayDay: string): Task {
  const role = Role[situation.role];
  const action = {
    kind: 'outbox_check' as const,
    label: 'Jetzt erneut prüfen',
    // Kein Ziel: Die Handlung ist ein Knopf, kein Link (`AufgabenAktion`).
    target: '',
  };

  if (situation.state === 'nicht_eingerichtet') {
    return {
      kind: 'outbox_disrupted',
      dueAt: todayDay,
      urgency: 'high',
      title: 'Den Instanzen fehlt der Postausgang',
      reason:
        'CONTROL_INSTANCE_SMTP_HOST und CONTROL_INSTANCE_SMTP_FROM sind nicht ' +
        'gesetzt, obwohl die Verwaltung Instanzen anlegt. ' +
        role.consequence,
      action,
    };
  }

  const dueAt = dayFrom(situation.disruptedSince ?? `${todayDay}T00:00:00Z`, todayDay);
  const cause = Cause[situation.errorClass ?? 'unknown'];
  const detected =
    situation.detectedBy === 'send'
      ? 'Erkannt beim Versand einer E-Mail.'
      : 'Erkannt bei der regelmäßigen Prüfung des Postausgangs.';
  return {
    kind: 'outbox_disrupted',
    dueAt,
    // Immer „hoch": Der Beginn liegt nie in der Zukunft.
    urgency: urgencyFrom(dueAt, todayDay),
    title: `Der Postausgang ${role.whose} ist gestört`,
    reason:
      `${cause} ${role.consequence} Zu finden unter ${role.wo}. ${detected} ` +
      'Die Aufgabe verschwindet, sobald eine Prüfung oder ein Versand wieder ' +
      'gelingt.',
    action,
  };
}

/**
 * Ein gestörter Postausgang — ohne Organisationsbezug, wie die
 * Aufbewahrungsfrist des Audit-Logs.
 *
 * Die Quelle liest keine Datenbank: Der Stand kommt fertig aus dem
 * `OutboxService` über den Kontext. Deshalb auch keine Grenze — es gibt
 * höchstens zwei Aufgaben.
 */
export const outboxDisrupted: TaskSource = {
  kind: 'outbox_disrupted',

  async collect(context: TasksContext): Promise<SourceResult> {
    const tasks = context.outbox
      .filter((l) => l.state === 'gestoert' || l.state === 'nicht_eingerichtet')
      .map((l) => taskFrom(l, context.todayDay));
    return { tasks, total: tasks.length };
  },
};
