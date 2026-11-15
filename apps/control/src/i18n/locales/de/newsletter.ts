/** Namespace `newsletter`: Sperrseite der Rundmail — Widerspruch von Hand eintragen (NewsletterBlockPage). */
export default {
  title: 'Rundmail',
  finalWord: 'Endgültig',
  finalText:
    '— eine Sperre kann niemand aufheben, auch die Betreiberin nicht. Wer wieder Post bekommen möchte, trägt sich selbst über das öffentliche Formular neu ein; nach „Als Spam gemeldet" ist auch das nicht mehr möglich.',
  blockedNotice: '{email} ist gesperrt.',
  entryCreated:
    'Zu dieser Adresse gab es vorher keinen Eintrag — angelegt wurde ein reiner Sperreintrag, kein Einwilligungsnachweis.',
  entryUpdated: 'Der vorhandene Eintrag wurde auf gesperrt gesetzt.',
  cancelledNone: 'Es war keine Mail an diese Adresse eingestellt.',
  cancelledOne: 'Eine bereits eingestellte Mail wurde abgebrochen.',
  cancelledMany: '{count} bereits eingestellte Mails wurden abgebrochen.',
  noWayBack: 'Ein Weg zurück besteht von hier aus nicht.',
  emailLabel: 'E-Mail-Adresse',
  emailHelper: 'Muss uns nicht bekannt sein.',
  emailInvalid: 'Bitte eine gültige E-Mail-Adresse angeben.',
  reasonLabel: 'Grund',
  justificationLabel: 'Anlass · min. {min} Zeichen',
  justificationPlaceholder: 'z. B. telefonisch am 30.08.',
  justificationHelper: 'Woher der Widerspruch kam.',
  submit: 'Sperren',
  blockFailed: 'Die Adresse konnte nicht gesperrt werden.',
  listLoadFailed: 'Die Sperrliste konnte nicht geladen werden.',
  retry: 'Erneut versuchen',
  emptyTitle: 'Keine gesperrten Adressen',
  emptyHint:
    'Hier stehen alle Adressen, die nichts Werbliches mehr bekommen — die selbst abgemeldeten ebenso wie die von Hand eingetragenen.',
  tableCaption: 'Gesperrte Adressen',
  columnAddress: 'Adresse',
  columnReason: 'Grund',
  columnBlockReason: 'Anlass',
  columnEntered: 'Eingetragen',
  selfUnsubscribed: 'Selbst abgemeldet — kein Anlass erfasst',
  reasonShortUnsubscribed: 'Widerspruch der Person',
  reasonLongUnsubscribed:
    'Sie hat auf anderem Weg widersprochen — am Telefon, per Antwortmail oder schriftlich (Art. 21 DSGVO).',
  reasonShortHardBounced: 'Adresse nimmt nichts mehr an',
  reasonLongHardBounced: 'Der Postfachanbieter hat die Zustellung dauerhaft abgewiesen.',
  reasonShortSpamReported: 'Als Spam gemeldet',
  reasonLongSpamReported:
    'Eine Beschwerde über den Postfachanbieter. Endgültig — für diese Adresse gibt es danach auch keine neue Eintragung mehr.',
  proofTitle: 'Adresse sperren',
  proofExplanation:
    'Eine Sperre lässt sich nicht zurücknehmen. Bitte weise dich noch einmal aus.',
} as const;
