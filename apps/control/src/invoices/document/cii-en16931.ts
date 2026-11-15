import { centAsXml } from '../invoice.amount';
import type { Issuer } from './issuer.config';
import type {
  DocumentRecipient,
  DocumentLine,
  DocumentTaxShare,
  InvoiceDocument,
} from './document.types';

/**
 * ZUGFeRD/Factur-X als CII-XML, Profil EN 16931 („Comfort").
 *
 * Übernommen aus `tools/invoice-renderer/src/cii-en16931.mjs`. Die
 * Fassung dort ist gegen drei Prüfer abgenommen: veraPDF 1.30.2 (PDF/A-3b,
 * `isCompliant=true`), Mustangproject 2.17.0 (`<summary status="valid"/>` für
 * PDF und XML) und den KoSIT-Validator 1.6.3 mit XRechnung-3.0.2-Konfiguration
 * (`ACCEPTABLE`). Wörtliche Ausgaben: `tools/invoice-renderer/LIESMICH.md`,
 * Abschnitt 4.
 *
 * DIE REIHENFOLGE DER ELEMENTE IST NICHT VERHANDELBAR. Sie steht im XSD als
 * `<xs:sequence>`; ein vertauschtes Element ist kein Schönheitsfehler, sondern
 * ein Schemafehler. Wer hier etwas verschiebt, muss die Messung des
 * Erkundungsschritts wiederholen.
 *
 * PROFIL EN 16931, NICHT XRECHNUNG. Für den Versand an eine private
 * Empfängerin ist das genau richtig. Die zwei verbliebenen Meldungen des
 * Mustang-Validators (Geschäftsprozesskennung, Kennstring) sind `notice`,
 * keine `error`, und stammen aus dem XRechnung-Regelwerk — es greift nur, wenn
 * das Dokument beansprucht, XRechnung zu sein. Wer an einen öffentlichen
 * Auftraggeber liefert, braucht zusätzlich Leitweg-ID und
 * Geschäftsprozesskennung; das ist ausdrücklich nicht Teil dieser Etappe.
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
  return [
    '<ram:SellerTradeParty>',
    `<ram:Name>${x(a.name)}</ram:Name>`,
    // BT-33: registerrechtlicher Zusatz nach § 125a HGB.
    a.legalAddition ? `<ram:Description>${x(a.legalAddition)}</ram:Description>` : '',
    // BT-30: Handelsregisternummer der KG, strukturiert.
    a.registerIdentifier
      ? `<ram:SpecifiedLegalOrganization><ram:ID>${x(a.registerIdentifier)}</ram:ID></ram:SpecifiedLegalOrganization>`
      : '',
    '<ram:DefinedTradeContact>',
    `<ram:PersonName>${x(a.contact.name)}</ram:PersonName>`,
    `<ram:TelephoneUniversalCommunication><ram:CompleteNumber>${x(a.contact.phone)}</ram:CompleteNumber></ram:TelephoneUniversalCommunication>`,
    `<ram:EmailURIUniversalCommunication><ram:URIID>${x(a.contact.email)}</ram:URIID></ram:EmailURIUniversalCommunication>`,
    '</ram:DefinedTradeContact>',
    address(a.address),
    // BT-34: elektronische Adresse der Ausstellerin, schemeID EM.
    `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(a.contact.email)}</ram:URIID></ram:URIUniversalCommunication>`,
    // BT-31: Umsatzsteuer-Identifikationsnummer, schemeID VA.
    `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(a.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>`,
    '</ram:SellerTradeParty>',
  ].join('');
}

function buyer(e: DocumentRecipient): string {
  return [
    '<ram:BuyerTradeParty>',
    `<ram:Name>${x(e.name)}</ram:Name>`,
    address(e.address),
    // BT-49: elektronische Adresse der Empfängerin.
    e.email
      ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(e.email)}</ram:URIID></ram:URIUniversalCommunication>`
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
    `<ram:RateApplicablePercent>${p.taxRate.toFixed(2)}</ram:RateApplicablePercent>`,
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
    `<ram:BasisAmount>${centAsXml(t.basisCent)}</ram:BasisAmount>`,
    `<ram:CategoryCode>${x(t.category)}</ram:CategoryCode>`,
    `<ram:RateApplicablePercent>${t.record.toFixed(2)}</ram:RateApplicablePercent>`,
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
export function createCii(r: InvoiceDocument): string {
  const w = r.currency;
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rsm:CrossIndustryInvoice',
    ' xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
    ' xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"',
    ' xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"',
    ' xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',

    '<rsm:ExchangedDocumentContext>',
    '<ram:GuidelineSpecifiedDocumentContextParameter>',
    `<ram:ID>${PROFILE_IDENTIFIER}</ram:ID>`,
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
    r.orderReference ? `<ram:BuyerReference>${x(r.orderReference)}</ram:BuyerReference>` : '',
    seller(r.issuer),
    buyer(r.recipient),
    '</ram:ApplicableHeaderTradeAgreement>',

    '<ram:ApplicableHeaderTradeDelivery>',
    `<ram:ActualDeliverySupplyChainEvent>${dateElement('OccurrenceDateTime', r.deliveryDate)}</ram:ActualDeliverySupplyChainEvent>`,
    '</ram:ApplicableHeaderTradeDelivery>',

    '<ram:ApplicableHeaderTradeSettlement>',
    `<ram:InvoiceCurrencyCode>${x(w)}</ram:InvoiceCurrencyCode>`,
    '<ram:SpecifiedTradeSettlementPaymentMeans>',
    // 58 = SEPA-Überweisung (UNTDID 4461). Kein Lastschriftcode: Es gibt in
    // diesem System weder SEPA-XML noch Zahlungsabgleich.
    '<ram:TypeCode>58</ram:TypeCode>',
    '<ram:PayeePartyCreditorFinancialAccount>',
    `<ram:IBANID>${x(r.issuer.bank.iban)}</ram:IBANID>`,
    `<ram:AccountName>${x(r.issuer.name)}</ram:AccountName>`,
    '</ram:PayeePartyCreditorFinancialAccount>',
    r.issuer.bank.bic
      ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${x(r.issuer.bank.bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>`
      : '',
    '</ram:SpecifiedTradeSettlementPaymentMeans>',
    ...r.taxBreakdown.map(tax),
    period(r.servicePeriod),
    `<ram:SpecifiedTradePaymentTerms><ram:Description>${x(r.paymentTerm + (r.paymentNote ? ` ${r.paymentNote}` : ''))}</ram:Description>${dateElement('DueDateDateTime', r.dueAt)}</ram:SpecifiedTradePaymentTerms>`,
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
