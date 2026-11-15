// Erzeugt XRechnung 3.0 als UBL 2.1 Invoice.
//
// Warum ein zweites Format neben CII: XRechnung ist die Auspraegung von
// EN 16931 fuer oeffentliche Auftraggeber in Deutschland. Sie ist strenger als
// EN 16931 (Regeln BR-DE-*), unter anderem sind Pflicht:
//   BR-DE-1  Zahlungsangaben (PaymentMeans)
//   BR-DE-2  Ansprechpartner des Verkaeufers samt Telefon und E-Mail
//   BR-DE-15 Leitweg-ID bzw. Bestellzeichen (BT-10)
//   BR-DE-16 USt-IdNr. oder Steuernummer des Verkaeufers
//   BR-DE-23 bei Zahlungsart 58 muss die IBAN angegeben sein
// Wer sie nicht braucht, verschickt CII. Die Erzeugung kostet hier wenig,
// weil dieselben berechneten Daten zugrunde liegen.
//
// Auch hier gilt: die Elementreihenfolge folgt dem UBL-XSD und ist Pflicht.

import { centAlsXml } from './rechnung.mjs';

function x(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function anschrift(a) {
  return [
    '<cac:PostalAddress>',
    a.strasse ? `<cbc:StreetName>${x(a.strasse)}</cbc:StreetName>` : '',
    `<cbc:CityName>${x(a.ort)}</cbc:CityName>`,
    `<cbc:PostalZone>${x(a.plz)}</cbc:PostalZone>`,
    `<cac:Country><cbc:IdentificationCode>${x(a.land)}</cbc:IdentificationCode></cac:Country>`,
    '</cac:PostalAddress>',
  ].join('');
}

function zeitraum(z) {
  return `<cac:InvoicePeriod><cbc:StartDate>${x(z.von)}</cbc:StartDate><cbc:EndDate>${x(z.bis)}</cbc:EndDate></cac:InvoicePeriod>`;
}

/** @returns {string} vollstaendiges UBL-Dokument, Auspraegung XRechnung 3.0. */
export function erzeugeUbl(r) {
  const w = r.waehrung;
  const a = r.aussteller;
  const e = r.empfaenger;

  const teile = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    // Diese Kennung entscheidet, gegen welches Regelwerk der KoSIT-Validator
    // prueft. Bis XRechnung 2.x lautete sie urn:xoev-de:kosit:standard:...,
    // seit 3.0 urn:xeinkauf.de:kosit:... . Mit der alten Kennung meldet der
    // Validator "noScenarioMatched" und lehnt die Rechnung ab, ohne einen
    // einzigen inhaltlichen Fehler zu nennen.
    '<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>',
    '<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>',
    `<cbc:ID>${x(r.nummer)}</cbc:ID>`,
    `<cbc:IssueDate>${x(r.rechnungsdatum)}</cbc:IssueDate>`,
    `<cbc:DueDate>${x(r.faelligAm)}</cbc:DueDate>`,
    '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>',
    r.hinweis ? `<cbc:Note>${x(r.hinweis)}</cbc:Note>` : '',
    // BT-22 als zweite Notiz: der § 125a HGB-Block. In UBL steht er
    // zusaetzlich strukturiert unter cbc:CompanyLegalForm (BT-33).
    a.rechtlicherZusatz ? `<cbc:Note>${x(a.rechtlicherZusatz)}</cbc:Note>` : '',
    `<cbc:DocumentCurrencyCode>${x(w)}</cbc:DocumentCurrencyCode>`,
    `<cbc:BuyerReference>${x(r.bestellzeichen)}</cbc:BuyerReference>`,
    r.leistungszeitraum ? zeitraum(r.leistungszeitraum) : '',

    '<cac:AccountingSupplierParty><cac:Party>',
    `<cbc:EndpointID schemeID="EM">${x(a.kontakt.email)}</cbc:EndpointID>`,
    `<cac:PartyName><cbc:Name>${x(a.name)}</cbc:Name></cac:PartyName>`,
    anschrift(a.anschrift),
    `<cac:PartyTaxScheme><cbc:CompanyID>${x(a.ustIdNr)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`,
    '<cac:PartyLegalEntity>',
    `<cbc:RegistrationName>${x(a.name)}</cbc:RegistrationName>`,
    // BT-30: Handelsregisternummer der KG.
    a.registerKennung ? `<cbc:CompanyID>${x(a.registerKennung)}</cbc:CompanyID>` : '',
    // BT-33: heisst in UBL "CompanyLegalForm" und ist genau das Feld fuer den
    // registerrechtlichen Zusatz. In UBL passt § 125a HGB damit sauberer als
    // in CII, wo dasselbe Feld nur "Description" heisst.
    a.rechtlicherZusatz ? `<cbc:CompanyLegalForm>${x(a.rechtlicherZusatz)}</cbc:CompanyLegalForm>` : '',
    '</cac:PartyLegalEntity>',
    '<cac:Contact>',
    `<cbc:Name>${x(a.kontakt.name)}</cbc:Name>`,
    `<cbc:Telephone>${x(a.kontakt.telefon)}</cbc:Telephone>`,
    `<cbc:ElectronicMail>${x(a.kontakt.email)}</cbc:ElectronicMail>`,
    '</cac:Contact>',
    '</cac:Party></cac:AccountingSupplierParty>',

    '<cac:AccountingCustomerParty><cac:Party>',
    `<cbc:EndpointID schemeID="EM">${x(e.email)}</cbc:EndpointID>`,
    `<cac:PartyName><cbc:Name>${x(e.name)}</cbc:Name></cac:PartyName>`,
    anschrift(e.anschrift),
    `<cac:PartyLegalEntity><cbc:RegistrationName>${x(e.name)}</cbc:RegistrationName></cac:PartyLegalEntity>`,
    e.ansprechpartner
      ? `<cac:Contact><cbc:Name>${x(e.ansprechpartner)}</cbc:Name>${e.email ? `<cbc:ElectronicMail>${x(e.email)}</cbc:ElectronicMail>` : ''}</cac:Contact>`
      : '',
    '</cac:Party></cac:AccountingCustomerParty>',

    r.lieferdatum
      ? `<cac:Delivery><cbc:ActualDeliveryDate>${x(r.lieferdatum)}</cbc:ActualDeliveryDate></cac:Delivery>`
      : '',

    '<cac:PaymentMeans>',
    '<cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>',
    '<cac:PayeeFinancialAccount>',
    `<cbc:ID>${x(a.bank.iban)}</cbc:ID>`,
    `<cbc:Name>${x(a.name)}</cbc:Name>`,
    a.bank.bic
      ? `<cac:FinancialInstitutionBranch><cbc:ID>${x(a.bank.bic)}</cbc:ID></cac:FinancialInstitutionBranch>`
      : '',
    '</cac:PayeeFinancialAccount>',
    '</cac:PaymentMeans>',

    r.zahlungsbedingung
      ? `<cac:PaymentTerms><cbc:Note>${x(r.zahlungsbedingung)}</cbc:Note></cac:PaymentTerms>`
      : '',

    '<cac:TaxTotal>',
    `<cbc:TaxAmount currencyID="${x(w)}">${centAlsXml(r.summeSteuerCent)}</cbc:TaxAmount>`,
    ...r.steueraufteilung.map((t) =>
      [
        '<cac:TaxSubtotal>',
        `<cbc:TaxableAmount currencyID="${x(w)}">${centAlsXml(t.grundlageCent)}</cbc:TaxableAmount>`,
        `<cbc:TaxAmount currencyID="${x(w)}">${centAlsXml(t.steuerCent)}</cbc:TaxAmount>`,
        '<cac:TaxCategory>',
        `<cbc:ID>${x(t.kategorie)}</cbc:ID>`,
        `<cbc:Percent>${t.satz.toFixed(2)}</cbc:Percent>`,
        t.befreiungsgrund ? `<cbc:TaxExemptionReason>${x(t.befreiungsgrund)}</cbc:TaxExemptionReason>` : '',
        '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>',
        '</cac:TaxCategory>',
        '</cac:TaxSubtotal>',
      ].join(''),
    ),
    '</cac:TaxTotal>',

    '<cac:LegalMonetaryTotal>',
    `<cbc:LineExtensionAmount currencyID="${x(w)}">${centAlsXml(r.summeNettoCent)}</cbc:LineExtensionAmount>`,
    `<cbc:TaxExclusiveAmount currencyID="${x(w)}">${centAlsXml(r.summeNettoCent)}</cbc:TaxExclusiveAmount>`,
    `<cbc:TaxInclusiveAmount currencyID="${x(w)}">${centAlsXml(r.summeBruttoCent)}</cbc:TaxInclusiveAmount>`,
    `<cbc:PrepaidAmount currencyID="${x(w)}">${centAlsXml(r.vorausgezahltCent)}</cbc:PrepaidAmount>`,
    `<cbc:PayableAmount currencyID="${x(w)}">${centAlsXml(r.zahlbetragCent)}</cbc:PayableAmount>`,
    '</cac:LegalMonetaryTotal>',

    ...r.posten.map((p) =>
      [
        '<cac:InvoiceLine>',
        `<cbc:ID>${x(p.zeile)}</cbc:ID>`,
        `<cbc:InvoicedQuantity unitCode="${x(p.einheit)}">${p.menge}</cbc:InvoicedQuantity>`,
        `<cbc:LineExtensionAmount currencyID="${x(w)}">${centAlsXml(p.nettoCent)}</cbc:LineExtensionAmount>`,
        p.zeitraum ? zeitraum(p.zeitraum) : '',
        '<cac:Item>',
        p.beschreibung ? `<cbc:Description>${x(p.beschreibung)}</cbc:Description>` : '',
        `<cbc:Name>${x(p.bezeichnung)}</cbc:Name>`,
        '<cac:ClassifiedTaxCategory>',
        `<cbc:ID>${x(p.steuerkategorie ?? 'S')}</cbc:ID>`,
        `<cbc:Percent>${p.steuersatz.toFixed(2)}</cbc:Percent>`,
        '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>',
        '</cac:ClassifiedTaxCategory>',
        '</cac:Item>',
        `<cac:Price><cbc:PriceAmount currencyID="${x(w)}">${centAlsXml(p.einzelpreisCent)}</cbc:PriceAmount></cac:Price>`,
        '</cac:InvoiceLine>',
      ].join(''),
    ),
    '</ubl:Invoice>',
  ];
  return teile.filter(Boolean).join('\n');
}
