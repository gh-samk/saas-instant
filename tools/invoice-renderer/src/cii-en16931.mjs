// Erzeugt ZUGFeRD/Factur-X CII-XML nach Profil EN 16931 ("Comfort").
//
// Die Reihenfolge der Elemente ist im XSD als <xs:sequence> festgelegt und
// damit nicht verhandelbar: ein vertauschtes Element ist kein Schoenheits-
// fehler, sondern ein XSD-Fehler. Die Reihenfolge in diesem Modul entspricht
// der Schemareihenfolge und wurde gegen den Mustang-Validator geprueft.

import { centAlsXml, datumAlsCii } from './rechnung.mjs';

/** Maskiert Text fuer XML-Inhalte. Attribute werden hier nie aus Daten gebaut. */
function x(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function datumElement(name, iso) {
  return `<ram:${name}><udt:DateTimeString format="102">${datumAlsCii(iso)}</udt:DateTimeString></ram:${name}>`;
}


/**
 * Freitext-Land -> ISO 3166-1 alpha-2. Wirft bei Unbekanntem, statt zu raten.
 *
 * Gleichlautend mit der Fassung in apps/control. Der Fehler, der beide
 * ausgeloest hat: `Organisation.land` ist Freitext und steht auf
 * "Deutschland"; Mustang wies das Dokument dann zurueck
 * (`Value of 'ram:CountryID' is not allowed`).
 */
const LAENDERCODES = {
  deutschland: 'DE', germany: 'DE',
  'österreich': 'AT', oesterreich: 'AT', austria: 'AT',
  schweiz: 'CH', switzerland: 'CH',
  luxemburg: 'LU', luxembourg: 'LU',
  belgien: 'BE', niederlande: 'NL', frankreich: 'FR', italien: 'IT',
  'dänemark': 'DK', daenemark: 'DK', polen: 'PL', tschechien: 'CZ',
};

export function laendercode(land) {
  const roh = String(land).trim();
  if (/^[A-Za-z]{2}$/.test(roh)) return roh.toUpperCase();
  const treffer = LAENDERCODES[roh.toLowerCase()];
  if (treffer !== undefined) return treffer;
  throw new TypeError(
    `Fuer "${roh}" ist kein Laendercode nach ISO 3166-1 hinterlegt.`,
  );
}

function anschrift(a) {
  return [
    '<ram:PostalTradeAddress>',
    `<ram:PostcodeCode>${x(a.plz)}</ram:PostcodeCode>`,
    a.strasse ? `<ram:LineOne>${x(a.strasse)}</ram:LineOne>` : '',
    `<ram:CityName>${x(a.ort)}</ram:CityName>`,
    // ISO 3166-1 alpha-2, nicht der ausgeschriebene Name -- siehe die
    // gleichnamige Funktion in apps/control/src/invoices/document/. Diese
    // Datei ist eine eigenstaendige Referenz; der Produktivweg liegt dort.
    `<ram:CountryID>${x(laendercode(a.land))}</ram:CountryID>`,
    '</ram:PostalTradeAddress>',
  ].join('');
}

function verkaeufer(a) {
  return [
    '<ram:SellerTradeParty>',
    `<ram:Name>${x(a.name)}</ram:Name>`,
    // BT-33: registerrechtlicher Zusatz nach § 125a HGB.
    a.rechtlicherZusatz ? `<ram:Description>${x(a.rechtlicherZusatz)}</ram:Description>` : '',
    // BT-30: Handelsregisternummer der KG, strukturiert.
    a.registerKennung
      ? `<ram:SpecifiedLegalOrganization><ram:ID>${x(a.registerKennung)}</ram:ID></ram:SpecifiedLegalOrganization>`
      : '',
    a.kontakt
      ? [
          '<ram:DefinedTradeContact>',
          `<ram:PersonName>${x(a.kontakt.name)}</ram:PersonName>`,
          `<ram:TelephoneUniversalCommunication><ram:CompleteNumber>${x(a.kontakt.telefon)}</ram:CompleteNumber></ram:TelephoneUniversalCommunication>`,
          `<ram:EmailURIUniversalCommunication><ram:URIID>${x(a.kontakt.email)}</ram:URIID></ram:EmailURIUniversalCommunication>`,
          '</ram:DefinedTradeContact>',
        ].join('')
      : '',
    anschrift(a.anschrift),
    // BT-34: elektronische Adresse des Verkaeufers. In EN 16931 freiwillig,
    // von Peppol und XRechnung verlangt (PEPPOL-EN16931-R020). schemeID EM
    // steht fuer eine E-Mail-Adresse.
    a.kontakt?.email
      ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(a.kontakt.email)}</ram:URIID></ram:URIUniversalCommunication>`
      : '',
    // BT-31: Umsatzsteuer-Identifikationsnummer, schemeID VA.
    `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(a.ustIdNr)}</ram:ID></ram:SpecifiedTaxRegistration>`,
    '</ram:SellerTradeParty>',
  ].join('');
}

function kaeufer(e) {
  return [
    '<ram:BuyerTradeParty>',
    `<ram:Name>${x(e.name)}</ram:Name>`,
    e.ansprechpartner
      ? `<ram:DefinedTradeContact><ram:PersonName>${x(e.ansprechpartner)}</ram:PersonName>${
          e.email
            ? `<ram:EmailURIUniversalCommunication><ram:URIID>${x(e.email)}</ram:URIID></ram:EmailURIUniversalCommunication>`
            : ''
        }</ram:DefinedTradeContact>`
      : '',
    anschrift(e.anschrift),
    // BT-49: elektronische Adresse der Empfaengerin (PEPPOL-EN16931-R010).
    e.email
      ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${x(e.email)}</ram:URIID></ram:URIUniversalCommunication>`
      : '',
    e.ustIdNr
      ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(e.ustIdNr)}</ram:ID></ram:SpecifiedTaxRegistration>`
      : '',
    '</ram:BuyerTradeParty>',
  ].join('');
}

function zeitraum(z) {
  return [
    '<ram:BillingSpecifiedPeriod>',
    datumElement('StartDateTime', z.von),
    datumElement('EndDateTime', z.bis),
    '</ram:BillingSpecifiedPeriod>',
  ].join('');
}

function posten(p, waehrung) {
  return [
    '<ram:IncludedSupplyChainTradeLineItem>',
    `<ram:AssociatedDocumentLineDocument><ram:LineID>${x(p.zeile)}</ram:LineID></ram:AssociatedDocumentLineDocument>`,
    '<ram:SpecifiedTradeProduct>',
    `<ram:Name>${x(p.bezeichnung)}</ram:Name>`,
    p.beschreibung ? `<ram:Description>${x(p.beschreibung)}</ram:Description>` : '',
    '</ram:SpecifiedTradeProduct>',
    '<ram:SpecifiedLineTradeAgreement>',
    `<ram:NetPriceProductTradePrice><ram:ChargeAmount>${centAlsXml(p.einzelpreisCent)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>`,
    '</ram:SpecifiedLineTradeAgreement>',
    `<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${x(p.einheit)}">${p.menge}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>`,
    '<ram:SpecifiedLineTradeSettlement>',
    '<ram:ApplicableTradeTax>',
    '<ram:TypeCode>VAT</ram:TypeCode>',
    `<ram:CategoryCode>${x(p.steuerkategorie ?? 'S')}</ram:CategoryCode>`,
    `<ram:RateApplicablePercent>${p.steuersatz.toFixed(2)}</ram:RateApplicablePercent>`,
    '</ram:ApplicableTradeTax>',
    p.zeitraum ? zeitraum(p.zeitraum) : '',
    `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${centAlsXml(p.nettoCent)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>`,
    '</ram:SpecifiedLineTradeSettlement>',
    '</ram:IncludedSupplyChainTradeLineItem>',
  ].join('');
}

function steuer(t) {
  return [
    '<ram:ApplicableTradeTax>',
    `<ram:CalculatedAmount>${centAlsXml(t.steuerCent)}</ram:CalculatedAmount>`,
    '<ram:TypeCode>VAT</ram:TypeCode>',
    t.befreiungsgrund ? `<ram:ExemptionReason>${x(t.befreiungsgrund)}</ram:ExemptionReason>` : '',
    `<ram:BasisAmount>${centAlsXml(t.grundlageCent)}</ram:BasisAmount>`,
    `<ram:CategoryCode>${x(t.kategorie)}</ram:CategoryCode>`,
    `<ram:RateApplicablePercent>${t.satz.toFixed(2)}</ram:RateApplicablePercent>`,
    '</ram:ApplicableTradeTax>',
  ].join('');
}

/** @returns {string} vollstaendiges CII-Dokument, Profil EN 16931. */
export function erzeugeCii(r) {
  const w = r.waehrung;
  const teile = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rsm:CrossIndustryInvoice',
    ' xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
    ' xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"',
    ' xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"',
    ' xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',

    '<rsm:ExchangedDocumentContext>',
    '<ram:GuidelineSpecifiedDocumentContextParameter>',
    '<ram:ID>urn:cen.eu:en16931:2017</ram:ID>',
    '</ram:GuidelineSpecifiedDocumentContextParameter>',
    '</rsm:ExchangedDocumentContext>',

    '<rsm:ExchangedDocument>',
    `<ram:ID>${x(r.nummer)}</ram:ID>`,
    '<ram:TypeCode>380</ram:TypeCode>',
    datumElement('IssueDateTime', r.rechnungsdatum),
    r.hinweis ? `<ram:IncludedNote><ram:Content>${x(r.hinweis)}</ram:Content></ram:IncludedNote>` : '',
    // BT-21/BT-22 mit Betreffkennung REG: registerrechtliche Angaben. Der
    // Block steht damit zweimal im Dokument (auch als BT-33). Das ist
    // Absicht: Empfangssysteme werten unterschiedliche Felder aus, und
    // § 125a HGB verlangt die Angabe auf dem Geschaeftsbrief, nicht in einem
    // bestimmten Feld.
    r.aussteller.rechtlicherZusatz
      ? `<ram:IncludedNote><ram:Content>${x(r.aussteller.rechtlicherZusatz)}</ram:Content><ram:SubjectCode>REG</ram:SubjectCode></ram:IncludedNote>`
      : '',
    '</rsm:ExchangedDocument>',

    '<rsm:SupplyChainTradeTransaction>',
    ...r.posten.map((p) => posten(p, w)),

    '<ram:ApplicableHeaderTradeAgreement>',
    r.bestellzeichen ? `<ram:BuyerReference>${x(r.bestellzeichen)}</ram:BuyerReference>` : '',
    verkaeufer(r.aussteller),
    kaeufer(r.empfaenger),
    '</ram:ApplicableHeaderTradeAgreement>',

    '<ram:ApplicableHeaderTradeDelivery>',
    r.lieferdatum
      ? `<ram:ActualDeliverySupplyChainEvent>${datumElement('OccurrenceDateTime', r.lieferdatum)}</ram:ActualDeliverySupplyChainEvent>`
      : '',
    '</ram:ApplicableHeaderTradeDelivery>',

    '<ram:ApplicableHeaderTradeSettlement>',
    `<ram:InvoiceCurrencyCode>${x(w)}</ram:InvoiceCurrencyCode>`,
    '<ram:SpecifiedTradeSettlementPaymentMeans>',
    // 58 = SEPA-Ueberweisung (UNTDID 4461).
    '<ram:TypeCode>58</ram:TypeCode>',
    '<ram:PayeePartyCreditorFinancialAccount>',
    `<ram:IBANID>${x(r.aussteller.bank.iban)}</ram:IBANID>`,
    `<ram:AccountName>${x(r.aussteller.name)}</ram:AccountName>`,
    '</ram:PayeePartyCreditorFinancialAccount>',
    r.aussteller.bank.bic
      ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${x(r.aussteller.bank.bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>`
      : '',
    '</ram:SpecifiedTradeSettlementPaymentMeans>',
    ...r.steueraufteilung.map(steuer),
    r.leistungszeitraum ? zeitraum(r.leistungszeitraum) : '',
    r.zahlungsbedingung
      ? `<ram:SpecifiedTradePaymentTerms><ram:Description>${x(r.zahlungsbedingung)}</ram:Description>${datumElement('DueDateDateTime', r.faelligAm)}</ram:SpecifiedTradePaymentTerms>`
      : '',
    '<ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    `<ram:LineTotalAmount>${centAlsXml(r.summeNettoCent)}</ram:LineTotalAmount>`,
    `<ram:TaxBasisTotalAmount>${centAlsXml(r.summeNettoCent)}</ram:TaxBasisTotalAmount>`,
    `<ram:TaxTotalAmount currencyID="${x(w)}">${centAlsXml(r.summeSteuerCent)}</ram:TaxTotalAmount>`,
    `<ram:GrandTotalAmount>${centAlsXml(r.summeBruttoCent)}</ram:GrandTotalAmount>`,
    `<ram:TotalPrepaidAmount>${centAlsXml(r.vorausgezahltCent)}</ram:TotalPrepaidAmount>`,
    `<ram:DuePayableAmount>${centAlsXml(r.zahlbetragCent)}</ram:DuePayableAmount>`,
    '</ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    '</ram:ApplicableHeaderTradeSettlement>',

    '</rsm:SupplyChainTradeTransaction>',
    '</rsm:CrossIndustryInvoice>',
  ];
  return teile.filter(Boolean).join('\n');
}
