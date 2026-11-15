# Rechnungen und Zahlung

Wie saas-instant Rechnungen erzeugt, was beim Festschreiben geschieht und was das
System bei der Zahlung **nicht** tut. Preise und Ausstellerdaten kommen aus dem
Software-Manifest (`billing`, siehe `saas-instant.manifest.example.yaml`) oder aus
Umgebungsvariablen.

> Die Texte auf den Belegen sind in v1 deutsch und auf deutsches Recht
> ausgerichtet (Umsatzsteuer, SEPA). Welche Pflichtangaben für den eigenen
> Rechtsraum und die eigene Rechtsform gelten, klärt der Betreiber mit seiner
> Steuerberatung.

## 1. Lebenslauf einer Rechnung

| Zustand | Bedeutung | Änderbar? |
|---|---|---|
| Entwurf | wird vorbereitet, hat noch keine Nummer | ja, auch löschbar |
| festgeschrieben | Nummer vergeben, Schnappschuss gespeichert | **nein** |
| versendet | per Mail an die Rechnungsadresse gegangen | nein (nur Zahlungsstand) |
| teilweise bezahlt, bezahlt | Zahlungsstand von Hand vermerkt | nur der Zahlungsstand |
| storniert | eine Stornorechnung hebt sie auf | nein |

**Überfällig ist kein gespeicherter Zustand.** Er ergibt sich aus Fälligkeit,
Status und bezahltem Betrag und wird abgeleitet angezeigt. Dazu gibt es eine
Aufgabe „Rechnung überfällig“. Ein nächtlicher Lauf, der Rechnungen anfasst, wäre
ein automatischer Schreibvorgang mit Geldfolge (Regel R5).

### Festschreiben (Regel R2)

Nach dem Festschreiben gibt es **keinen Änderungs- und keinen Löschbefehl** für die
Rechnung, weder in der Oberfläche noch in der API noch in einem Dienst. Ein Test
geht über den Quellbaum und zählt die Dateien, die überhaupt auf Rechnungen
schreiben, und die Schreibaufrufe je Datei. Ein neuer Schreibpfad lässt den Test
rot werden.

- Die **fortlaufende Nummer** (Format `<Jahr>-<laufend>`, z. B. `2026-001`) wird erst beim Festschreiben vergeben, in
  derselben Datenbanktransaktion, mit einer Beratungssperre je Jahr
  (`pg_advisory_xact_lock`). Daraus folgt: keine Doppelnummer **und keine Lücke**.
  Eine Postgres-Sequenz wäre falsch, weil sie bei einem Rollback Lücken
  hinterlässt. Das neue Jahr beginnt von selbst wieder bei 1.
- Empfänger, Adresse, Aussteller, Sitz und (bei Lastschrift) Mandatsreferenz
  stehen als **Schnappschuss** an der Rechnung. Spätere Änderungen an der
  Organisation ändern den Beleg nicht.
- **Plausibilitätsfenster für das Rechnungsdatum:** Das Datum bestimmt den
  Nummernkreis. Ohne Grenze eröffnete ein Tippfehler im Jahr dauerhaft den Kreis
  eines fremden Geschäftsjahres, und festgeschrieben wäre er unlöschbar. Geprüft
  wird beim Entwurf und unmittelbar vor der Nummernvergabe, einstellbar mit
  `CONTROL_INVOICE_DATE_RETROACTIVE_DAYS` (Vorgabe 90) und
  `CONTROL_INVOICE_DATE_AHEAD_DAYS` (Vorgabe 30).
- **Pflichtangaben des Ausstellers**, darunter der Sitz, sind Pflicht. Ohne sie
  lässt sich keine Rechnung festschreiben.

### Stornieren

Storniert wird durch eine **eigene Stornorechnung** mit eigener Nummer. Die
Originalrechnung bleibt bestehen. Die Stornorechnung übernimmt den Schnappschuss
vom Original, damit sie die Rechnung sichtbar aufhebt, auch wenn sich die Adresse
der Organisation inzwischen geändert hat. Eine zweite Stornierung derselben
Rechnung verhindern eine Zeilensperre und ein eindeutiger Datenbankschlüssel.

### Dokument und Versand

- Das XML (EN 16931, CII) entsteht im Backend aus dem Schnappschuss.
- Das **PDF/A-3b mit eingebettetem `factur-x.xml`** erzeugt ein separater
  **Rechnungsdienst** (Dienst `invoice-renderer` im Compose-Stapel, Quelle
  `tools/invoice-renderer`). Die Verwaltung erreicht ihn über `RECHNUNGSDIENST_URL`. Ohne Dienst gibt die Dokumentroute einen
  sichtbaren Fehler (502). Anlegen, Festschreiben, Stornieren und Zahlungen
  vermerken laufen unverändert weiter, das Dokument lässt sich später nachziehen,
  weil es nur aus dem Schnappschuss entsteht. Ein bewusst leer gesetztes
  `RECHNUNGSDIENST_URL=` schaltet die PDF-Erzeugung ab.
- Besteht ein erzeugtes PDF die Prüfung des Dienstes nicht (422), wird **nichts
  gespeichert**. Ein ungültiger Beleg wäre schlimmer als keiner, er sähe aus wie
  einer.
- Das Dokument entsteht in einem zweiten Schritt, nicht im Festschreiben: Die
  Festschreibung hält die Sperre auf dem Nummernkreis, ein HTTP-Aufruf in dieser
  Transaktion hieße, dass niemand sonst festschreiben kann, solange gerendert wird.
- Der **Versand** geht über den Mailversand der Verwaltung als Transaktionsmail:
  erst Dokument holen oder erzeugen, dann verschicken, **erst danach** „versendet“
  vermerken. Scheitert der SMTP-Versand, gilt die Rechnung nicht als zugestellt.
  Die Zahlungserinnerung hängt das Dokument an, geht aber auch ohne Anhang
  hinaus, wenn es sich gerade nicht erzeugen lässt.

## 2. Preise

Reihenfolge: Umgebung (`CONTROL_PRICE_TABLE`, JSON), dann Manifest
(`billing.tiers`), dann neutrale Vorgaben. Stufen richten sich nach der Zahl
aktiver Personen. Je Stufe gibt es Monats-, Halbjahres- und Jahrespreis sowie
einen Einrichtungspreis, alle in ganzen Cent netto.

- **Der Halbjahrespreis ist ein eigener Preis, keine halbe Jahresrate.** Ihn
  auszurechnen statt abzulesen ergäbe einen anderen Betrag als den zugesagten.
- Ist die Preistafel gesetzt und fehlerhaft, **startet die Anwendung nicht**. Eine
  still auf Vorgaben zurückfallende Preistafel schriebe einen anderen Betrag auf
  die Rechnung als vereinbart, und das fiele erst auf, wenn die Kundschaft
  anruft. Genau eine Stufe muss nach oben offen sein, und sie muss die letzte sein.
- Der **Preisvorschlag** im Rechnungsentwurf wird nie ungefragt übernommen (R5).
  Werden Preise an anderer Stelle veröffentlicht (Webseite, Angebot), gehören
  beide Quellen gegeneinander geprüft. Zahlen, die an zwei Orten stehen, laufen
  sonst unbemerkt auseinander.

## 3. Zahlungsart und Zahlungsrhythmus

Rhythmus (monatlich, halbjährlich, jährlich) und Zahlungsart (Lastschrift oder
Überweisung) sind getrennte Felder. Die Regel „**monatlich nur per Lastschrift**“
gilt serverseitig und wird gegen den Zustand *nach* der Änderung geprüft, nicht
gegen den Request allein. Im Formular wird bei „monatlich“ die Lastschrift
mitgesetzt und die Überweisung gar nicht angeboten.

## 4. SEPA-Lastschrift: Das Mandat wird erfasst, der Einzug geschieht im Onlinebanking

Das ist die zentrale Aussage dieses Abschnitts, denn sie begrenzt, was das System
verspricht:

> **saas-instant erfasst das SEPA-Mandat. Den Einzug löst der Betreiber selbst im
> Onlinebanking seiner Bank aus.** Es gibt kein SEPA-XML (`pain.008`), keinen
> Zahlungsdienstleister, keinen Kontozugriff und keinen automatischen
> Zahlungsabgleich. Zahlungen werden von Hand vermerkt.

### Was das System beiträgt

1. **Mandat erfassen.** Die Kontodaten (IBAN, BIC, Kontoinhaber, falls abweichend)
   stehen an der Organisation und sind nur hinter dem zweiten Faktor zu sehen,
   jeder Abruf wird im Audit-Log festgehalten. Über das Aufnahmeformular kann
   die Organisation das Mandat **elektronisch erteilen**. Gespeichert werden der
   **Wortlaut, wie er angezeigt wurde**, der Zeitpunkt und die IP-Adresse. Der
   Wortlaut entsteht auf dem Server und wird nicht aus dem Formular übernommen,
   sonst diktierte der Absender seinen eigenen Nachweis. Verlangt wird die IBAN nur
   bei Lastschrift.
2. **Mandatsreferenz vergeben.** Eindeutig je Gläubiger, fortlaufend je Jahr, mit
   Sperre gegen Nebenläufigkeit. Sie wird als Schnappschuss an der Rechnung
   gespeichert, aber nur, **wenn auch eingezogen wird**. Eine Referenz an einer
   Organisation, die inzwischen überweist, darf keinen Einzug ankündigen, der nicht
   stattfindet.
3. **Vorabankündigung auf der Rechnung.** Wird eingezogen, steht auf der Rechnung
   keine Zahlungsaufforderung, sondern: Der Betrag werde am Fälligkeitstag per
   SEPA-Lastschrift eingezogen, **bitte nicht überweisen**, mit Mandatsreferenz
   und Gläubiger-Identifikationsnummer. „Zahlbar ohne Abzug bis zum …“ neben einem
   laufenden Einzug führt zur Doppelzahlung, und die zurückzuholen macht mehr
   Arbeit als der ganze Vorgang.
4. **Gläubiger-Identifikationsnummer** (`billing.creditorId` im Manifest). Fehlt
   sie, **wirft die Dokumenterzeugung einen Fehler**, der die Einstellung nennt.
   Eine Ankündigung ohne sie ist für die Kundschaft wertlos, eine erfundene
   Kennung wäre falsch. Die Nummer ist kein Geheimnis, wer sie kennt, kann nichts
   abbuchen. Sie vorher bei der Bank beantragen beziehungsweise prüfen.

### Was der Betreiber selbst tut

- Den Einzug im Onlinebanking einreichen (mit Mandatsreferenz, Mandatsdatum,
  Fälligkeit, Sequenztyp und Vorlauffrist nach den Regeln der eigenen Bank).
- Den Zahlungseingang vom Kontoauszug **von Hand vermerken**.
- Die Belege selbst an die Buchhaltung übergeben und die Übertragung vermerken.
  Es gibt keine Schnittstelle zu Buchhaltungsprogrammen.

### Zahlung vermerken

Der Zahlungsstand wird als **kumulierter Betrag** erfasst, nicht als einzelne
Überweisung. Zwei Teilzahlungen ergeben zwei Aufrufe mit steigendem Betrag. Ein
Modell mit Einzelbuchungen bräuchte einen Weg, eine falsch erfasste Buchung
zurückzunehmen, also einen Löschpfad an einem Beleg. Ein kumulierter Stand lässt
sich berichtigen, indem man ihn richtig hinschreibt, und jede Berichtigung steht im
Audit-Log. Der Vorgang fasst nur Zahldatum, bezahlten Betrag und Status an, keine
Beträge, Posten, Nummer oder Schnappschuss.

Zahlungsstand und „an die Buchhaltung übertragen“ stehen **hinter dem zweiten
Faktor**. Wer mit einem erbeuteten Sitzungs-Cookie Forderungen als „bezahlt“
markiert, erzeugt sonst weder Dokument noch Notiz noch Nummer und löscht
Forderungen lautlos aus der Übersicht. Anlegen, Festschreiben und Stornieren
bleiben ohne zweiten Faktor, weil sie sichtbare Spuren hinterlassen (Nummer,
Notiz im Verlauf, Audit-Eintrag).

## 5. Bankdaten und Datenschutz

- IBAN und Mandat stehen **nur in der Datenbank der Verwaltung**, nie im Audit-Log
  und nie in einer E-Mail. Sie verlassen das System nicht (kein
  Zahlungsdienstleister). Die Datenbank gehört verschlüsselt gesichert (siehe
  [backup-and-recovery.md](backup-and-recovery.md)).
- Die IBAN liegt als Klartextfeld in der Datenbank, die Anwendung verschlüsselt sie
  nicht zusätzlich. Wer die Datenbank liest, liest sie. Datenträger- und
  Backup-Verschlüsselung sind deshalb Pflicht.
- Ein öffentliches Anfrageformular nimmt **keine** Bankdaten entgegen. Sie kommen
  erst über den Aufnahmeweg, wenn ein Vertrag besteht und der Link an eine
  bekannte Adresse ging.

## 6. Absender und Zustellbarkeit der Rechnungsmail

Eine nicht angekommene Rechnung fällt auf, ein nicht angekommener Newsletter nicht.
Deshalb gilt für die Absenderadressen:

- `SMTP_FROM`, `MAIL_SENDER_INVOICE`, `MAIL_SENDER_BROADCAST` und
  `MAIL_RETURN_PATH` müssen auf der Domäne `MAIL_DOMAIN` liegen (Manifest:
  `mail.domain`; Vorgabe ist die Domäne von `mail.senderAddress`). **Bei
  `NODE_ENV=production` startet die Anwendung sonst nicht.** Hintergrund: Steht
  DMARC auf `p=quarantine` mit strenger Ausrichtung (`aspf=s`), muss die Domäne des
  Envelope-From exakt die des sichtbaren `From:` sein, sonst landet die Mail im
  Spam.
- **Jede dieser Adressen muss auf dem Postausgang existieren.** Postfix mit
  Absenderbindung lässt ein angemeldetes Konto nur unter eigenen Adressen
  einliefern (`553 5.7.1 … Sender address rejected`). Ohne gesetzte Variablen
  fällt alles auf `SMTP_FROM` zurück, die eine Adresse, die der Postausgang
  annimmt. Wer getrennte Absender will, legt die Postfächer **zuerst** an und
  trägt sie dann ein.
- Ein Rückweg-Postfach (`MAIL_RETURN_PATH`) muss existieren **und gelesen
  werden**, sonst bleiben harte Abweisungen unsichtbar.
- **DKIM** ist der Handgriff, der dem Betreiber bleibt: Schlüsselpaar erzeugen,
  öffentlichen Teil als TXT unter `<selektor>._domainkey.<maildomäne>`
  veröffentlichen, privaten Teil im Postausgang hinterlegen. Erst dann übersteht
  die Ausrichtung auch eine Weiterleitung, bei der SPF immer bricht. Solange DKIM
  fehlt, ist der Rundmailversand nicht zu empfehlen.
- Rechnungen und Anmeldecodes gehen als **Transaktionsmails** über einen eigenen
  Codepfad, getrennt vom werblichen Versand (Regel R3). Eine Abmeldung vom
  Newsletter verhindert keine Rechnung.
- Ein gestörter Postausgang meldet sich **nicht** auf der Anmeldeseite, sondern
  unter `GET /api/health` (`status: "beeintraechtigt"`) und als Aufgabe
  „Postausgang gestört“. `SMTP_TLS_ERZWINGEN=0` ist nur für lokale Entwicklung
  erlaubt, in Produktion startet die Anwendung damit nicht.

## 7. Nicht gebaut

| Was | Warum |
|---|---|
| SEPA-XML (`pain.008`) | Entscheidung: Einzug von Hand im Onlinebanking |
| Zahlungsdienstleister | keine Abhängigkeit, keine IBAN außer Haus |
| Automatischer Zahlungsabgleich | kein Kontozugriff, Zahlungen werden von Hand erfasst |
| Schnittstelle zu Buchhaltungsprogrammen | Belege werden von Hand übergeben, die Übertragung wird vermerkt |
| Sequenztyp (FRST/RCUR) und Vorlauffristen | gehören zum Einreichen der Lastschrift, nicht zum Erfassen des Mandats |
| Löschen oder Ändern festgeschriebener Rechnungen | Regel R2 |
