import { centAsXml } from '../invoice.amount';
import type { Issuer } from './issuer.config';
import type {
  CiiProfile,
  DocumentRecipient,
  DocumentLine,
  DocumentTaxShare,
  InvoiceDocument,
} from './document.types';

/**
 * CII-XML für ZUGFeRD/Factur-X (Profil EN 16931) UND für XRechnung 3.0.
 *
 * Eine Funktion, zwei Profile (`createCii(r, profile)`):
 *
 * - `EN16931` (Vorgabe): das eingebettete `factur-x.xml` des ZUGFeRD-PDF.
 * - `XRECHNUNG`: dieselben Daten mit dem XRechnung-Kennstring
 *   (`…#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`), der
 *   Geschäftsprozesskennung (BT-23) und den zusätzlichen deutschen Regeln
 *   (BR-DE-*): Käuferreferenz/Leitweg-ID (BT-10), Verkäuferkontakt (BG-6),
 *   elektronische Adressen beider Seiten (BT-34, BT-49).
 *
 * Die Fassung stammt aus `tools/invoice-renderer/src/cii-en16931.mjs`. Der
 * Rechnungsdienst prüft jedes erzeugte PDF selbst nach (veraPDF PDF/A-3b,
 * Mustangproject mit EN-16931-Schematron; siehe
 * `tools/invoice-renderer/README.md`). Die Validierung des XRechnung-Profils
 * gegen den KoSIT-Validator läuft im Echttest (Teil G des Plans), nicht in den
 * Unit-Tests: Diese prüfen Struktur, Pflichtfelder und Reihenfolge.
 *
 * DIE REIHENFOLGE DER ELEMENTE IST NICHT VERHANDELBAR. Sie steht im XSD als
 * `<xs:sequence>`; ein vertauschtes Element ist kein Schönheitsfehler, sondern
 * ein Schemafehler. Wer hier etwas verschiebt, muss die Messung wiederholen.
 */

/** Maskiert Text für XML-Inhalte. Attribute werden nie aus Daten gebaut. */
function x(text: string | number): string {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** `2026-08-31` → `20260831` (CII-Format 102). */
export function dateAsCii(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new TypeError(`Datum muss JJJJ-MM-TT sein, erhielt: ${iso}`);
  }
  return iso.replaceAll('-', '');
}

function dateElement(name: string, iso: string): string {
  return `<ram:${name}><udt:DateTimeString format="102">${dateAsCii(iso)}</udt:DateTimeString></ram:${name}>`;
}

/**
 * Die Ländertabelle für `ram:CountryID` (BT-40 / BT-55).
 *
 * WARUM ES SIE BRAUCHT — der Fehler, der sie ausgelöst hat: `CountryID`
 * verlangt einen Code nach ISO 3166-1 alpha-2. Das Feld `Organisation.land`
 * ist dagegen ein Freitextfeld und steht laut Schema auf „Deutschland".
 * Beim Aussteller fiel das nie auf, weil dort `DE` fest konfiguriert ist —
 * beim EMPFÄNGER stand der ausgeschriebene Name im XML, und Mustang wies das
 * Dokument zurück:
 *
 *   Value of 'ram:CountryID' is not allowed. [ID FX-SCH-A-000036]
 *
 * Damit liess sich zu KEINER Rechnung an eine deutsche Adresse ein Dokument
 * erzeugen. Aufgefallen ist es nicht dem Test, sondern dem Selbstprüfer des
 * Rechnungsdienstes — er hat die Herausgabe verweigert, statt ein ungültiges
 * PDF auszuliefern. Genau dafür ist er da.
 *
 * Die Tabelle bleibt bewusst KLEIN. Sie deckt ab, was vorkommt, und alles
 * andere fällt auf, statt geraten zu werden.
 */
const COUNTRY_CODES: Record<string, string> = {
  deutschland: 'DE',
  germany: 'DE',
  österreich: 'AT',
  oesterreich: 'AT',
  austria: 'AT',
  schweiz: 'CH',
  switzerland: 'CH',
  luxemburg: 'LU',
  luxembourg: 'LU',
  belgien: 'BE',
  niederlande: 'NL',
  frankreich: 'FR',
  italien: 'IT',
  dänemark: 'DK',
  daenemark: 'DK',
  polen: 'PL',
  tschechien: 'CZ',
};

/**
 * Freitext-Land → ISO 3166-1 alpha-2.
 *
 * WIRFT BEI UNBEKANNTEM WERT, und zwar mit Absicht. Die drei Alternativen
 * wären alle schlechter:
 *
 * - Auf `DE` zurückfallen hiesse, einer österreichischen Kundin ein
 *   Land in den Beleg zu schreiben, in dem sie nicht sitzt — still.
 * - Das Element weglassen scheitert an BR-09; die Angabe ist Pflicht.
 * - Den Freitext durchreichen ist genau der Fehler, den diese Funktion behebt.
 *
 * Der Fehler nennt den Wert, an dem es lag. Ohne ihn stünde in der Meldung
 * nur „ungültiges Dokument", und man suchte im Prüfbericht.
 */
export function countryCode(country: string): string {
  const raw = country.trim();
  // Schon ein Code: zwei Buchstaben, egal in welcher Schreibweise.
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();

  const hits = COUNTRY_CODES[raw.toLowerCase()];
  if (hits !== undefined) return hits;

  throw new TypeError(
    `Für „${raw}" ist kein Ländercode nach ISO 3166-1 hinterlegt. ` +
      'Trage im Land der Organisation den Zwei-Buchstaben-Code ein ' +
      '(z. B. DE) oder ergänze die Tabelle in cii-en16931.ts.',
  );
}

function address(a: { street: string; postalCode: string; city: string; country: string }): string {
  return [
    '<ram:PostalTradeAddress>',
    `<ram:PostcodeCode>${x(a.postalCode)}</ram:PostcodeCode>`,
    a.street ? `<ram:LineOne>${x(a.street)}</ram:LineOne>` : '',
    `<ram:CityName>${x(a.city)}</ram:CityName>`,
    // NICHT `a.land`: Das ist der ausgeschriebene Name für das SICHTBARE
    // Dokument. Hier gehört der Code hin.
    `<ram:CountryID>${x(countryCode(a.country))}</ram:CountryID>`,
    '</ram:PostalTradeAddress>',
  ].join('');
}

function seller(a: Issuer): string {
  const c = a.contact;
  const hasContact = c.name.trim() !== '' && (c.phone !== '' || c.email !== '');
  return [
    '<ram:SellerTradeParty>',
    // BT-29: BR-CO-26 verlangt BT-29, BT-30 oder BT-31. Eine nicht
    // eingetragene Einzelunternehmerin ohne USt-IdNr. hat nur die Steuernummer
    // (BT-32): sie dient dann zusätzlich als Verkäuferkennung.
    !a.vatId && !a.registerIdentifier && a.taxNumber
      ? `<ram:ID>${x(a.taxNumber)}</ram:ID>`
      : '',
    `<ram:Name>${x(a.name)}</ram:Name>`,
    // BT-33: Pflichtangaben des Geschäftsbriefs, Zeilen mit " | " verbunden.
    a.legalAddition ? `<ram:Description>${x(a.legalAddition)}</ram:Description>` : '',
    // BT-30: Registernummer (HRA/HRB/GnR/VR), strukturiert — bei Registerformen.
    a.registerIdentifier
      ? `<ram:SpecifiedLegalOrganization><ram:ID>${x(a.registerIdentifier)}</ram:ID></ram:SpecifiedLegalOrganization>`
      : '',
    hasContact
      ? [
          '<ram:DefinedTradeContact>',
          `<ram:PersonName>${x(c.name)}</ram:PersonName>`,
          c.phone
            ? `<ram:TelephoneUniversalCommunication><ram:CompleteNumber>${x(c.phone)}</ram:CompleteNumber></ram:TelephoneUniversalCommunication>`
            : '',
          c.email
            ? `<ram:EmailURIUniversalCommunication><ram:URIID>${x(c.email)}</ram:URIID></ram:EmailURIUniversalCommunication>`
            : '',
          '</ram:DefinedTradeContact>',
        ].join('')
      : '',
    address(a.address),
    // BT-34: elektronische Adresse der Ausstellerin, schemeID EM.
    c.email
      ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(c.email)}</ram:URIID></ram:URIUniversalCommunication>`
      : '',
    // BT-31: Umsatzsteuer-Identifikationsnummer (VA); BT-32: Steuernummer (FC).
    a.vatId
      ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(a.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>`
      : '',
    a.taxNumber
      ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${x(a.taxNumber)}</ram:ID></ram:SpecifiedTaxRegistration>`
      : '',
    '</ram:SellerTradeParty>',
  ].join('');
}

function buyer(e: DocumentRecipient): string {
  // BT-49: elektronische Adresse. Eigene Angabe (Leitweg-ID 0204, E-Mail EM …)
  // vor der Rechnungs-E-Mail.
  const address49 =
    e.electronicAddress ?? (e.email ? { id: e.email, scheme: 'EM' } : undefined);
  return [
    '<ram:BuyerTradeParty>',
    `<ram:Name>${x(e.name)}</ram:Name>`,
    address(e.address),
    address49
      ? `<ram:URIUniversalCommunication><ram:URIID schemeID="${x(address49.scheme)}">${x(address49.id)}</ram:URIID></ram:URIUniversalCommunication>`
      : '',
    // BT-48: USt-IdNr. der Empfängerin, schemeID VA.
    e.vatId
      ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(e.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>`
      : '',
    '</ram:BuyerTradeParty>',
  ].join('');
}

function period(z: { from: string; until: string }): string {
  return [
    '<ram:BillingSpecifiedPeriod>',
    dateElement('StartDateTime', z.from),
    dateElement('EndDateTime', z.until),
    '</ram:BillingSpecifiedPeriod>',
  ].join('');
}

function lines(p: DocumentLine): string {
  return [
    '<ram:IncludedSupplyChainTradeLineItem>',
    `<ram:AssociatedDocumentLineDocument><ram:LineID>${x(p.row)}</ram:LineID></ram:AssociatedDocumentLineDocument>`,
    '<ram:SpecifiedTradeProduct>',
    `<ram:Name>${x(p.label)}</ram:Name>`,
    p.description ? `<ram:Description>${x(p.description)}</ram:Description>` : '',
    '</ram:SpecifiedTradeProduct>',
    '<ram:SpecifiedLineTradeAgreement>',
    `<ram:NetPriceProductTradePrice><ram:ChargeAmount>${centAsXml(p.unitPriceCent)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>`,
    '</ram:SpecifiedLineTradeAgreement>',
    `<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${x(p.unit)}">${p.quantity}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>`,
    '<ram:SpecifiedLineTradeSettlement>',
    '<ram:ApplicableTradeTax>',
    '<ram:TypeCode>VAT</ram:TypeCode>',
    `<ram:CategoryCode>${x(p.taxCategory)}</ram:CategoryCode>`,
    // Kategorie O (nicht steuerbar): kein Satz an der Position (BR-O-05).
    p.taxCategory === 'O'
      ? ''
      : `<ram:RateApplicablePercent>${p.taxRate.toFixed(2)}</ram:RateApplicablePercent>`,
    '</ram:ApplicableTradeTax>',
    p.period ? period(p.period) : '',
    `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${centAsXml(p.netCent)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>`,
    '</ram:SpecifiedLineTradeSettlement>',
    '</ram:IncludedSupplyChainTradeLineItem>',
  ].join('');
}

function tax(t: DocumentTaxShare): string {
  return [
    '<ram:ApplicableTradeTax>',
    `<ram:CalculatedAmount>${centAsXml(t.taxCent)}</ram:CalculatedAmount>`,
    '<ram:TypeCode>VAT</ram:TypeCode>',
    // BT-120: Befreiungsgrund, steht vor dem Basisbetrag.
    t.exemptionReason
      ? `<ram:ExemptionReason>${x(t.exemptionReason)}</ram:ExemptionReason>`
      : '',
    `<ram:BasisAmount>${centAsXml(t.basisCent)}</ram:BasisAmount>`,
    `<ram:CategoryCode>${x(t.category)}</ram:CategoryCode>`,
    t.category === 'O'
      ? ''
      : `<ram:RateApplicablePercent>${t.record.toFixed(2)}</ram:RateApplicablePercent>`,
    '</ram:ApplicableTradeTax>',
  ].join('');
}

/**
 * Der Kennstring des Profils.
 *
 * BEWUSST ALS KONSTANTE UND VOM TEST GEPRÜFT. Der Erkundungsschritt hat genau
 * hier die gefährlichste Fehlerart dieses Umfelds gefunden: Mit einem
 * veralteten Kennstring lehnte der KoSIT-Validator das Dokument pauschal ab
 * (`<rep:noScenarioMatched>`), ohne einen einzigen inhaltlichen Fehler zu
 * nennen. Das sieht aus wie ein Datenproblem und ist ein Tippfehler in einer
 * Zeichenkette.
 */
export const PROFILE_IDENTIFIER = 'urn:cen.eu:en16931:2017';

/** Kennstring von XRechnung 3.0 (CII). */
export const XRECHNUNG_IDENTIFIER =
  'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';

/** BT-23: Geschäftsprozesskennung (Peppol BIS Billing 3.0). */
export const BUSINESS_PROCESS_IDENTIFIER =
  'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

/** Der Kennstring (BT-24) des gewählten Profils. */
export function profileIdentifier(profile: CiiProfile): string {
  return profile === 'XRECHNUNG' ? XRECHNUNG_IDENTIFIER : PROFILE_IDENTIFIER;
}

/**
 * Rechnungsart nach UNTDID 1001.
 *
 * 380 = Handelsrechnung. Eine STORNORECHNUNG bleibt ebenfalls eine 380 mit
 * negativen Beträgen und nicht etwa eine 381 (Gutschrift): Eine Gutschrift
 * im Sinne des UStG ist etwas anderes — dort rechnet der Leistungsempfänger
 * ab. Was hier entsteht, ist eine Rechnungskorrektur der Ausstellerin.
 */
export const TYPE_CODE_INVOICE = '380';

/** Erzeugt das vollständige CII-Dokument. */
export function createCii(
  r: InvoiceDocument,
  profile: CiiProfile = 'EN16931',
): string {
  const w = r.currency;
  const xr = profile === 'XRECHNUNG';
  const debit = r.paymentMeansCode === '59';
  checkDocument(r, profile);
  // BT-10: Leitweg-ID bzw. Käuferreferenz; ohne sie die eigene Rechnungsnummer
  // (BR-DE-15 verlangt für XRechnung irgendeinen Wert).
  const buyerReference =
    r.buyerReference?.trim() || r.orderReference || r.number;
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rsm:CrossIndustryInvoice',
    ' xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
    ' xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"',
    ' xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"',
    ' xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',

    '<rsm:ExchangedDocumentContext>',
    xr
      ? `<ram:BusinessProcessSpecifiedDocumentContextParameter><ram:ID>${BUSINESS_PROCESS_IDENTIFIER}</ram:ID></ram:BusinessProcessSpecifiedDocumentContextParameter>`
      : '',
    '<ram:GuidelineSpecifiedDocumentContextParameter>',
    `<ram:ID>${profileIdentifier(profile)}</ram:ID>`,
    '</ram:GuidelineSpecifiedDocumentContextParameter>',
    '</rsm:ExchangedDocumentContext>',

    '<rsm:ExchangedDocument>',
    `<ram:ID>${x(r.number)}</ram:ID>`,
    `<ram:TypeCode>${TYPE_CODE_INVOICE}</ram:TypeCode>`,
    dateElement('IssueDateTime', r.invoiceDate),
    r.introduction
      ? `<ram:IncludedNote><ram:Content>${x(r.introduction)}</ram:Content></ram:IncludedNote>`
      : '',
    r.hint ? `<ram:IncludedNote><ram:Content>${x(r.hint)}</ram:Content></ram:IncludedNote>` : '',
    r.cancellationNote
      ? `<ram:IncludedNote><ram:Content>${x(r.cancellationNote)}</ram:Content></ram:IncludedNote>`
      : '',
    // BT-21/BT-22 mit Betreffkennung REG. Der Block steht damit zweimal im
    // Dokument (auch als BT-33) — Absicht: Empfangssysteme werten
    // unterschiedliche Felder aus, und § 125a HGB verlangt die Angabe auf dem
    // Geschäftsbrief, nicht in einem bestimmten Feld.
    r.issuer.legalAddition
      ? `<ram:IncludedNote><ram:Content>${x(r.issuer.legalAddition)}</ram:Content><ram:SubjectCode>REG</ram:SubjectCode></ram:IncludedNote>`
      : '',
    '</rsm:ExchangedDocument>',

    '<rsm:SupplyChainTradeTransaction>',
    ...r.lines.map((p) => lines(p)),

    '<ram:ApplicableHeaderTradeAgreement>',
    `<ram:BuyerReference>${x(buyerReference)}</ram:BuyerReference>`,
    seller(r.issuer),
    buyer(r.recipient),
    '</ram:ApplicableHeaderTradeAgreement>',

    '<ram:ApplicableHeaderTradeDelivery>',
    `<ram:ActualDeliverySupplyChainEvent>${dateElement('OccurrenceDateTime', r.deliveryDate)}</ram:ActualDeliverySupplyChainEvent>`,
    '</ram:ApplicableHeaderTradeDelivery>',

    '<ram:ApplicableHeaderTradeSettlement>',
    // BT-90: Gläubiger-ID, nur bei Lastschrift.
    debit && r.directDebit
      ? `<ram:CreditorReferenceID>${x(r.directDebit.creditorId)}</ram:CreditorReferenceID>`
      : '',
    // BT-83: Verwendungszweck — die Rechnungsnummer.
    `<ram:PaymentReference>${x(r.number)}</ram:PaymentReference>`,
    `<ram:InvoiceCurrencyCode>${x(w)}</ram:InvoiceCurrencyCode>`,
    '<ram:SpecifiedTradeSettlementPaymentMeans>',
    // UNTDID 4461: 58 = SEPA-Überweisung, 59 = SEPA-Lastschrift.
    `<ram:TypeCode>${debit ? '59' : '58'}</ram:TypeCode>`,
    // BT-91: Konto der Zahlerin, nur bei Lastschrift und wenn bekannt.
    debit && r.directDebit?.debtorIban
      ? `<ram:PayerPartyDebtorFinancialAccount><ram:IBANID>${x(r.directDebit.debtorIban)}</ram:IBANID></ram:PayerPartyDebtorFinancialAccount>`
      : '',
    // BT-84: Konto der Ausstellerin bei Überweisung (Pflicht bei 58, BR-61).
    debit
      ? ''
      : [
          '<ram:PayeePartyCreditorFinancialAccount>',
          `<ram:IBANID>${x(r.issuer.bank.iban)}</ram:IBANID>`,
          `<ram:AccountName>${x(r.issuer.name)}</ram:AccountName>`,
          '</ram:PayeePartyCreditorFinancialAccount>',
        ].join(''),
    !debit && r.issuer.bank.bic
      ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${x(r.issuer.bank.bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>`
      : '',
    '</ram:SpecifiedTradeSettlementPaymentMeans>',
    ...r.taxBreakdown.map(tax),
    period(r.servicePeriod),
    `<ram:SpecifiedTradePaymentTerms><ram:Description>${x(r.paymentTerm + (r.paymentNote ? ` ${r.paymentNote}` : ''))}</ram:Description>${dateElement('DueDateDateTime', r.dueAt)}${debit && r.directDebit ? `<ram:DirectDebitMandateID>${x(r.directDebit.mandateReference)}</ram:DirectDebitMandateID>` : ''}</ram:SpecifiedTradePaymentTerms>`,
    '<ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    `<ram:LineTotalAmount>${centAsXml(r.sumNetCent)}</ram:LineTotalAmount>`,
    `<ram:TaxBasisTotalAmount>${centAsXml(r.sumNetCent)}</ram:TaxBasisTotalAmount>`,
    `<ram:TaxTotalAmount currencyID="${x(w)}">${centAsXml(r.sumTaxCent)}</ram:TaxTotalAmount>`,
    `<ram:GrandTotalAmount>${centAsXml(r.sumGrossCent)}</ram:GrandTotalAmount>`,
    `<ram:TotalPrepaidAmount>${centAsXml(r.prepaidCent)}</ram:TotalPrepaidAmount>`,
    `<ram:DuePayableAmount>${centAsXml(r.paymentAmountCent)}</ram:DuePayableAmount>`,
    '</ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    '</ram:ApplicableHeaderTradeSettlement>',

    '</rsm:SupplyChainTradeTransaction>',
    '</rsm:CrossIndustryInvoice>',
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * Prüft die Eingabe auf alles, was das gewählte Profil verlangt und das
 * Dokument sonst still ungültig machte. Wirft `TypeError` mit einer Meldung,
 * die das fehlende Feld nennt — derselbe Grundsatz wie bei `countryCode`.
 */
function checkDocument(r: InvoiceDocument, profile: CiiProfile): void {
  const missing: string[] = [];
  const reasonRequired = new Set(['E', 'AE', 'K', 'G', 'O']);
  for (const t of r.taxBreakdown) {
    if (reasonRequired.has(t.category) && !(t.exemptionReason ?? '').trim()) {
      missing.push(`Befreiungsgrund (BT-120) für Steuerkategorie ${t.category}`);
    }
    if (t.category === 'S' && t.record <= 0) {
      missing.push('Steuersatz über 0 für Kategorie S');
    }
  }
  // Steuerschuldnerschaft und innergemeinschaftliche Lieferung brauchen die
  // USt-IdNr. der Empfängerin (BR-AE-02, BR-IC-02).
  const needsBuyerVatId = r.taxBreakdown.some(
    (t) => t.category === 'AE' || t.category === 'K',
  );
  if (needsBuyerVatId && !(r.recipient.vatId ?? '').trim()) {
    missing.push('USt-IdNr. der Empfängerin (BT-48) für Reverse Charge / innergemeinschaftliche Lieferung');
  }
  if (r.paymentMeansCode === '59' && !r.directDebit) {
    missing.push('Mandatsreferenz und Gläubiger-ID (BT-89/BT-90) für Lastschrift');
  }
  if (profile === 'XRECHNUNG') {
    const c = r.issuer.contact;
    if (!c.name?.trim()) missing.push('Ansprechpartner der Ausstellerin (BT-41, BR-DE-5)');
    if (!c.phone?.trim()) missing.push('Telefon der Ausstellerin (BT-42, BR-DE-6)');
    if (!c.email?.trim()) missing.push('E-Mail der Ausstellerin (BT-43, BR-DE-7)');
    if (!r.recipient.electronicAddress && !r.recipient.email) {
      missing.push('Elektronische Adresse der Empfängerin (BT-49)');
    }
    if (r.recipient.buyerType === 'authority' && !(r.buyerReference ?? '').trim()) {
      missing.push('Leitweg-ID der Behörde (BT-10)');
    }
  }
  if (missing.length > 0) {
    throw new TypeError(
      `Das Dokument (${profile}) ist unvollständig: ${missing.join('; ')}.`,
    );
  }
}
