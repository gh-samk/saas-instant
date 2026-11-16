/** Namespace `rundmail`: Vorlagenübersicht und Vorlagenseite der Rundmail (BroadcastPage, BroadcastTemplatePage). */
export default {
  // Übersicht
  title: 'Rundmail',
  createTemplate: 'Vorlage anlegen',
  retry: 'Erneut versuchen',
  loadFailed: 'Die Vorlagen konnten nicht geladen werden.',
  unexpectedShape: 'Die Vorlagenliste kam in einer unerwarteten Form.',
  emptyTitle: 'Noch keine Vorlagen',
  emptyHint:
    'Eine Vorlage ist der Wortlaut, der später hinausgeht — Betreff, Text und die Platzhalter, die der Versand füllt.',
  tableCaption: 'Vorlagen',
  columnTemplate: 'Vorlage',
  columnChannel: 'Kanal',
  columnRecipients: 'Empfänger',
  columnChanged: 'Geändert',
  columnActions: 'Aktionen',
  inactive: 'Stillgelegt',
  channelMarketing: 'Werblich',
  channelTransactional: 'Transaktion',
  perProcess: 'je Vorgang',
  previewLabel: 'Vorschau von „{name}" ansehen',
  sendMore: 'Senden …',
  send: 'Senden',
  sendDisabledTitle: 'Wird automatisch je Vorgang versendet',
  createdToast: 'Vorlage angelegt.',

  // Vorlagenseite
  templateLoadFailed: 'Die Vorlage konnte nicht geladen werden.',
  previewLoadFailed: 'Die Vorschau konnte nicht geladen werden.',
  saveFailed: 'Die Vorlage konnte nicht gespeichert werden.',
  savedToast: 'Vorlage gespeichert.',
  toggleFailed: 'Der Zustand konnte nicht geändert werden.',
  activeAgainToast: 'Vorlage ist wieder aktiv.',
  deactivatedToast: 'Vorlage stillgelegt.',
  backToList: 'Zurück zur Vorlagenliste',
  channelDescriptionMarketing:
    'Neuigkeiten und Funktionsankündigungen. Geht ausschliesslich an Adressen mit bestätigter Einwilligung, trägt in jeder Mail den personalisierten Abmeldelink und die Anbieterkennung und wird einzeln mit Abstand verschickt.',
  channelDescriptionTransactional:
    'Rechnungen, Zahlungserinnerungen, Anmeldecodes, Bestätigungsmails. Braucht keine Einwilligung und trägt keinen Abmeldelink. Diese Vorlagen lassen sich hier redigieren, aber nicht als Rundmail verschicken: Der Versandweg der Redaktion nimmt ausschliesslich werbliche Vorlagen an.',
  createdOn: 'Angelegt am ',
  lastEditedOn: ', zuletzt redigiert am ',
  fixedNote: '. Name und Kanal lassen sich nicht mehr ändern.',
  areaForm: 'Das Vorlagenformular',
  wording: 'Wortlaut',
  active: 'Aktiv',
  switchLabel: 'Vorlage aktiv',
  inactiveNote:
    'Eine stillgelegte Vorlage lässt sich weiter redigieren, aber weder testen noch verschicken. Sie wird nicht gelöscht — es gibt keinen Weg, eine Vorlage zu löschen, und das ist Absicht: Sie belegt, mit welchem Wortlaut angeschrieben wurde.',
  saveChanges: 'Änderungen speichern',
  areaPreview: 'Die Vorschau',
  preview: 'Vorschau',
  rebuild: 'Neu aufbauen',
  previewNote:
    'So sieht die Mail im Postfach aus — mit erkennbaren Beispielwerten statt echter Daten. Die Vorschau zeigt den GESPEICHERTEN Stand; ungespeicherte Änderungen stehen noch nicht darin.',
  previewBuilding: 'Vorschau wird aufgebaut …',
  areaTestSend: 'Der Testversand',
  areaRecipients: 'Die Empfängerauswahl',
  areaSend: 'Der Versand',
  areaRun: 'Der Versandlauf',
  sendHeading: 'Versenden',
  sendNote:
    'Damit wird die Rundmail für alle Adressen mit bestätigter Einwilligung in die Warteschlange gestellt. Verschickt wird sie danach einzeln, mit einer eigenen Prüfung je Adresse. Zurückholen lässt sich eine hinausgegangene Mail nicht.',
  sendButton: 'Rundmail versenden …',
  inactiveHint:
    'Diese Vorlage ist stillgelegt. Schalte sie oben wieder aktiv, wenn sie hinausgehen soll.',
  enqueuedOne: 'Eine Mail aus „{name}" steht in der Warteschlange.',
  enqueuedMany: '{count} Mails aus „{name}" stehen in der Warteschlange.',
  enqueuedNote:
    'Hinausgegangen ist damit noch nichts. Der Versandlauf unten arbeitet sie ab — von selbst jede Minute, oder auf Knopfdruck sofort. Der Balken dort zeigt, wie weit er gekommen ist.',
  enqueuedToast: 'Rundmail eingestellt.',
  noSendTitle: 'Kein Versandweg',
  noSendText:
    'Diese Vorlage gehört zum Transaktionskanal. Solche Mails verschickt die Anwendung selbst, wenn ihr Anlass eintritt — eine Rechnung, eine Zahlungserinnerung, ein Anmeldecode. Von Hand lässt sich hier nichts auslösen, und es gibt auch keinen Empfängerkreis dafür.',
  noSendButtonBefore: 'Ein Versandknopf stünde hier nur, um mit',
  noSendButtonAfter:
    'zu scheitern: Der Versandweg der Redaktion nimmt ausschliesslich werbliche Vorlagen an. Wer eine Rundmail schreiben will, legt eine Vorlage im werblichen Kanal an — umwidmen lässt sich diese hier nicht.',
} as const;
