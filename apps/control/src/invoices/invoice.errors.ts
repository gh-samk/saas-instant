import { HttpStatus } from '@nestjs/common';
import { BusinessError } from '../common/errors/business-error';

/** Die Rechnung gibt es nicht. */
export class InvoiceNotFoundError extends BusinessError {
  constructor() {
    super(
      'invoice_not_found',
      'Diese Rechnung gibt es nicht.',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * DER FEHLER, DER R2 TRÄGT.
 *
 * Harte Regel R2, wörtlich: „Nach dem Festschreiben existiert kein
 * Löschbefehl und kein Änderungsbefehl für eine Rechnung — nicht im UI, nicht
 * in der API, nicht in einem Service."
 *
 * Zwei Ebenen setzen das durch, und beide werden gebraucht:
 * 1. ES GIBT KEINEN ENDPUNKT dafür. Ein `PATCH /invoices/:id` existiert nur
 *    für Entwürfe, ein `DELETE` nur für Entwürfe.
 * 2. Und weil auch ein Entwurfs-Endpunkt eine festgeschriebene Kennung
 *    bekommen kann, prüft der Dienst den Zustand noch einmal — hier.
 *
 * Ohne (2) wäre R2 eine Eigenschaft der Routenliste. Mit (2) ist sie eine
 * Eigenschaft des Dienstes.
 */
export class InvoiceIsFinalizedError extends BusinessError {
  constructor(invoiceNumber: string | null) {
    super(
      'invoice_finalized',
      `Rechnung ${invoiceNumber ?? ''} ist festgeschrieben und lässt sich ` +
        'weder ändern noch löschen. Korrekturen laufen ausschließlich über ' +
        'eine Stornorechnung.',
      HttpStatus.CONFLICT,
      { invoiceNumber },
    );
  }
}

/** Die Handlung setzt einen anderen Zustand voraus. */
export class InvoiceStatusMismatchError extends BusinessError {
  constructor(isStatus: string, expected: string) {
    super(
      'invoice_status_mismatch',
      'Die Rechnung ist dafür im falschen Zustand.',
      HttpStatus.CONFLICT,
      { isStatus, expected },
    );
  }
}

/**
 * Es fehlen Pflichtangaben nach § 14 UStG bzw. § 125a HGB.
 *
 * Wird beim FESTSCHREIBEN geworfen, nicht beim Entwurf: Ein Entwurf darf
 * unvollständig sein, ein Beleg nicht. Der Erkundungsschritt nennt den Grund
 * für die frühe Prüfung: „eine Rechnung ohne USt-IdNr. fällt sonst erst beim
 * Finanzamt auf".
 */
export class InvoiceIncompleteError extends BusinessError {
  constructor(missingDetails: string[]) {
    super(
      'invoice_incomplete',
      'Der Rechnung fehlen Pflichtangaben. Sie lässt sich deshalb nicht ' +
        'finalize.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { missingDetails },
    );
  }
}

/** Storniert wird nur, was festgeschrieben ist — und nur einmal. */
export class InvoiceAlreadyCancelledError extends BusinessError {
  constructor(cancellationNumber: string | null) {
    super(
      'invoice_already_cancelled',
      `Diese Rechnung wurde bereits mit ${cancellationNumber ?? 'einer Stornorechnung'} ` +
        'storniert. Eine zweite Stornierung gibt es nicht.',
      HttpStatus.CONFLICT,
      { cancellationNumber },
    );
  }
}

/** Eine Stornorechnung lässt sich nicht ihrerseits stornieren. */
export class CancellationNotCancellableError extends BusinessError {
  constructor() {
    super(
      'cancellation_not_cancellable',
      'Eine Stornorechnung lässt sich nicht stornieren. Wenn der Storno ' +
        'falsch war, wird die Leistung neu berechnet.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Die Preistafel in der Umgebung ist unbrauchbar. */
export class PriceConfigurationInvalidError extends BusinessError {
  constructor(issues: string[]) {
    super(
      'price_table_invalid',
      'Die Preistafel ist fehlerhaft konfiguriert. Es werden keine Beträge ' +
        'berechnet, solange das so ist.',
      HttpStatus.INTERNAL_SERVER_ERROR,
      { issues },
    );
  }
}

/** Der Rechnungsdienst ist nicht konfiguriert. */
export class InvoiceRendererNotConfiguredError extends BusinessError {
  constructor() {
    super(
      'invoice_renderer_not_configured',
      'RECHNUNGSDIENST_URL ist nicht gesetzt — es lässt sich kein PDF ' +
        'erzeugen. Die Rechnung selbst ist davon unberührt und bleibt ' +
        'bestehen.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** Der Rechnungsdienst war nicht erreichbar oder hat nicht geantwortet. */
export class InvoiceRendererNotReachableError extends BusinessError {
  constructor(reason: string) {
    super(
      'invoice_renderer_not_reachable',
      'Der Rechnungsdienst hat nicht geantwortet. Die Rechnung bleibt ' +
        'bestehen; das Dokument lässt sich später nachziehen.',
      HttpStatus.BAD_GATEWAY,
      // FESTER SCHLÜSSEL, keine durchgereichte Meldung — dieselbe Regel wie
      // bei `Kennzahl.fehlerart`: eine rohe Fehlermeldung könnte die interne
      // URL enthalten.
      { reason },
    );
  }
}

/**
 * Der Rechnungsdienst hat das erzeugte Dokument selbst als ungültig erkannt.
 *
 * DAS IST DER WICHTIGSTE FEHLER DIESES MODULS. Der Dienst prüft jedes PDF vor
 * der Herausgabe gegen veraPDF (PDF/A-3b) und Schematron (EN 16931) und
 * antwortet bei einem Mangel mit 422 und dem Prüfbericht — statt mit einem
 * ungültigen PDF. Diese Entscheidung wird hier NICHT aufgeweicht: Ein
 * ungültiger Beleg wird nicht gespeichert und nicht verschickt.
 */
export class InvoiceDocumentInvalidError extends BusinessError {
  constructor(report: string) {
    super(
      'invoice_document_invalid',
      'Der Rechnungsdienst hat das erzeugte Dokument selbst als ungültig ' +
        'erkannt. Es wurde nicht gespeichert.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      // Der Bericht sagt, WELCHE Regel gebrochen wurde — der einzige Weg zur
      // Ursache. Er beschreibt ausschließlich das gerade erzeugte Dokument.
      { report: report.slice(0, 4000) },
    );
  }
}

/** Zu dieser Rechnung liegt (noch) kein Dokument vor. */
export class InvoiceDocumentMissingError extends BusinessError {
  constructor() {
    super(
      'invoice_document_missing',
      'Zu dieser Rechnung liegt kein Dokument vor. Erzeuge es zuerst.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Die gemeldete Zahlung passt nicht zur Rechnung. */
export class PaymentImplausibleError extends BusinessError {
  constructor(message: string, detail?: unknown) {
    super('payment_implausible', message, HttpStatus.BAD_REQUEST, detail);
  }
}

/** Die Rechnung hat keine Empfängeradresse für den Versand. */
export class InvoiceWithoutRecipientAddressError extends BusinessError {
  constructor() {
    super(
      'invoice_without_recipient_address',
      'Zu dieser Rechnung ist keine E-Mail-Adresse hinterlegt. Trage sie an ' +
        'der Organisation nach und schreibe eine neue Rechnung — der ' +
        'Schnappschuss einer festgeschriebenen Rechnung ändert sich nicht.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Ein Beleg soll einen Lastschrifteinzug ankündigen, aber es ist keine
 * Gläubiger-Identifikationsnummer hinterlegt.
 *
 * DAS IST EIN KONFIGURATIONSFEHLER, KEIN EINGABEFEHLER — und er wird trotzdem
 * als fachlicher Fehler geworfen, damit er im einheitlichen Fehlerformat
 * landet und die Meldung sagt, welche Variable fehlt. Ein `500` ohne Code
 * schickte die Betreiberin in die Container-Logs.
 */
export class CreditorIdMissingError extends BusinessError {
  constructor() {
    super(
      'creditor_id_missing',
      'Diese Rechnung soll per Lastschrift eingezogen werden, aber es ist ' +
        'keine Gläubiger-Identifikationsnummer hinterlegt. Ohne sie ist die ' +
        'Vorabankündigung für die Kundin wertlos. Bitte ' +
        'CONTROL_INVOICE_CREDITOR_ID setzen (Beantragung bei der ' +
        'Deutschen Bundesbank).',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
