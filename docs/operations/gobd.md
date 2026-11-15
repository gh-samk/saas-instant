# GoBD: technische Umsetzung und Vorlage für die Verfahrensdokumentation

Dieses Dokument tut zwei Dinge: Es beschreibt, **was die Software technisch
zusichert** (Abschnitte 2 bis 10), und es bietet eine **Vorlage**, aus der der
Betreiber seine eigene Verfahrensdokumentation macht (Abschnitt 12).

**Keine Rechtsberatung.** Ob ein Verfahren den Grundsätzen zur ordnungsmäßigen
Führung und Aufbewahrung von Büchern, Aufzeichnungen und Unterlagen in
elektronischer Form (GoBD) genügt, entscheidet nicht die Software, sondern das
gesamte Verfahren des Betreibers samt Organisation, Kontrollen und Dokumentation.
Die Software liefert dafür Bausteine. Die Verfahrensdokumentation, die Aufbewahrungsfristen
und die Herausgabe an Prüfer klärt der Betreiber **mit seiner Steuerberatung**.
Aussagen unten wie „unveränderlich“ gelten für den Weg über die Anwendung und die
Datenbank-Trigger, nicht gegen jemanden mit Verwalterrechten auf dem Datenbankserver
(Abschnitt 10).

Wo eine Aussage eine Datei nennt, ist sie dort nachlesbar. Die Tests, die sie
festhalten, stehen daneben.

## 1. Zweck und Geltungsbereich

Geregelt wird der Weg einer **Ausgangsrechnung** von der Erzeugung bis zum Archiv:
Entwurf, Festschreiben mit lückenloser Nummer, Erzeugen der Dokumente (PDF mit
eingebetteter strukturierter Rechnung, XML, XRechnung), Versand, Zahlungsvermerk,
Storno, Aufbewahrung, Datensicherung und Zugriff für Prüfer.

Nicht geregelt: die Buchhaltung selbst (die Verwaltung führt keine Bücher; sie
vermerkt nur, dass eine Rechnung an die Buchhaltung übertragen wurde), Eingangsrechnungen,
Belege außerhalb der Rechnungen sowie alles, was auf dem Server des Betreibers
außerhalb der Anwendung geschieht.

## 2. Rollen

| Rolle | Rechte an Rechnungen | Quelle |
|---|---|---|
| `owner`, `administrator` | alle Funktionen der Verwaltung, darunter Entwurf, Festschreiben, Versand, Zahlungsvermerk, Storno, GoBD-Export | `apps/control/src/invoices/gobd-export.controller.ts` (Export nur für diese beiden Rollen) |
| Betreiber des Servers | Zugriff auf Container, Datenbank und Sicherungsspeicher; liegt **außerhalb** der Anwendung und ihrer Protokollierung | Abschnitt 10 |
| Steuerberatung | kein Zugang zur Verwaltung; erhält Exporte | Abschnitt 8 |

Die Anmeldung verlangt einen zweiten Faktor; unumkehrbare oder lautlose Vorgänge
(Zahlungsvermerk, Export) verlangen zusätzlich einen frischen Nachweis
([security-model.md](security-model.md), Abschnitt 2). Der Betreiber legt fest,
wer ein Konto bekommt, und hält das in seiner eigenen Verfahrensdokumentation fest
(Abschnitt 12, Punkt „Organisation“).

## 3. Ablauf: Erzeugung, Festschreiben, Dokument, Versand, Archiv

1. **Entwurf.** Ein Entwurf hat keine Rechnungsnummer und ist änderbar und löschbar
   (`invoice.draft.created`, `invoice.draft.updated`, `invoice.draft.deleted` im
   Audit-Log). Das Löschen eines Entwurfs ist die einzige Löschung einer Rechnung,
   und sie trifft nur Zeilen ohne `finalizedAt`.
2. **Festschreiben** (`InvoiceService`, Audit `invoice.finalized`). In **einer
   Transaktion** werden vergeben: die Rechnungsnummer (Abschnitt 6), der
   Nachweiszeitpunkt `finalizedAt` und das Ende der Aufbewahrungsfrist `retentionUntil`
   (Abschnitt 7). Die Empfänger- und Ausstellerangaben werden als **Schnappschuss**
   in die Rechnung geschrieben, damit spätere Änderungen an der Organisation den Beleg
   nicht berühren. Ab hier gelten die Datenbank-Trigger aus Abschnitt 4.
3. **Dokumente erzeugen** (`InvoiceDocumentService`). Aus dem Schnappschuss entstehen
   höchstens je einmal: das strukturierte XML (CII nach EN 16931), das PDF/A-3b mit
   eingebettetem `factur-x.xml` (Profil EN 16931, gerendert vom Dienst
   `invoice-renderer`) und auf Anforderung die XRechnung als reine XML-Datei. Jedes
   Dokument wird mit seiner **SHA-256-Prüfsumme** gespeichert (`pdfSha256`,
   `xmlSha256`, `xrechnungSha256`). **Wichtig für die Verfahrensbeschreibung:**
   Die Dokumente werden nicht im Moment des Festschreibens erzeugt, sondern beim
   **ersten Abruf oder Versand** (Grund: Das Festschreiben hält eine Sperre auf dem
   Nummernkreis und darf nicht auf einen Netzaufruf warten, siehe Kopfkommentar von
   `document.service.ts`). Eine festgeschriebene Rechnung kann also kurz ohne Dokument
   sein. Der Inhalt steht dennoch fest, weil er ausschließlich aus dem unveränderlichen
   Schnappschuss entsteht. Wer die Dokumente sofort braucht, ruft sie einmal ab.
   Ist ein erzeugtes Dokument ungültig, steht das im Audit-Log
   (`invoice.document.invalid`).
4. **Auslieferung.** Gespeicherte Dokumente werden nur noch ausgeliefert, **nie neu
   erzeugt**. Jeder Abruf wird protokolliert (`invoice.document_downloaded`, mit
   Format).
5. **Versand** per Mail (`SendService`, Audit `invoice.sent`, bei Fehlschlag
   `invoice.send.failed`). Der Wortlaut der versendeten Mail liegt als Nachweis vor,
   der Anhang ist das gespeicherte PDF. Zahlungserinnerungen: `invoice.payment_reminder`.
6. **Zahlung und Übertragung.** Zahlungseingang und Übertragung an die Buchhaltung
   werden vermerkt (`invoice.payment.noted`, `invoice.transfer.noted`). Das sind die
   einzigen Felder, die sich nach dem Festschreiben noch ändern (Abschnitt 4).
7. **Storno** (Abschnitt 6).
8. **Archiv.** Die Rechnung bleibt dauerhaft in der Datenbank der Verwaltung
   (kein Löschpfad), und zusätzlich geht ein getrenntes, verschlüsseltes
   Rechnungsarchiv an das Sicherungsziel (Abschnitt 9).

## 4. Unveränderbarkeit auf Datenbankebene

Die Sperre sitzt **in der Datenbank**, nicht im Anwendungscode. Auch ein fehlerhafter
Codepfad oder ein manueller SQL-Befehl einer Anwendungsrolle scheitert mit
`integrity_constraint_violation`. Die Trigger stehen im handgeschriebenen Teil
der Baseline-Migration (`apps/control/prisma/migrations/*_baseline/migration.sql`,
Abschnitt „GoBD-SCHUTZ AUF DATENBANKEBENE“).

| Trigger | Wirkung |
|---|---|
| `Invoice_gobd_no_delete` | Eine Rechnung mit `finalizedAt` lässt sich nicht löschen. |
| `InvoiceLine_gobd_no_delete`, `InvoiceLine_gobd_no_update` | Posten einer festgeschriebenen Rechnung lassen sich weder ändern noch löschen. |
| `Invoice_gobd_guard_update` | Nach dem Festschreiben ist jede Änderung an der Rechnung verboten, **außer** an der Allowlist unten. |
| `AuditLog_append_only` | `UPDATE` und `DELETE` auf das Audit-Log sind verboten. Einzige Ausnahme: `userId` darf von einem Wert auf `NULL` gesetzt werden, wenn ein Benutzerkonto gelöscht wird (Fremdschlüssel `ON DELETE SET NULL`); der Akteur steht weiterhin im Klartext in `actor`. |

**Allowlist der Felder, die sich nach dem Festschreiben ändern dürfen:**

| Gruppe | Felder | Regel |
|---|---|---|
| Folgefelder | `status`, `paymentDate`, `paidAmount`, `transferStatus` | frei änderbar (Zahlungsstand, Übertragungsvermerk, Statuswechsel zu versendet/bezahlt/storniert) |
| Dokumentspalten | `pdfContent`, `xmlContent`, `xrechnungContent`, `pdfSha256`, `xmlSha256`, `xrechnungSha256`, `documentGeneratedAt` | **set-once**: nur von `NULL` auf einen Wert; ein gesetzter Wert lässt sich nie wieder ändern |

Alles andere (Beträge, Datum, Empfänger- und Ausstellerschnappschuss, Nummer,
`finalizedAt`, `retentionUntil`, Texte) ist nach dem Festschreiben gesperrt. Die
Prüfung vergleicht dazu die gesamte Zeile als JSON ohne die Allowlist, daher ist auch
eine später hinzugefügte Spalte automatisch geschützt, bis jemand sie bewusst in die
Allowlist aufnimmt.

**Tests:** `invoices/invoice-immutable.spec.ts` (Quellbaum: kein Lösch- und kein
Änderungsbefehl), `invoices/gobd.integration.spec.ts` (versucht `UPDATE` und `DELETE`
per rohem SQL gegen eine echte Datenbank und erwartet das Scheitern),
`invoices/invoice.integration.spec.ts`. Aufräumen in Tests läuft über
`src/test-support/gobd-cleanup.ts`.

## 5. Prüfsummen und Integritätslauf

Die in Abschnitt 3 genannten Prüfsummen werden beim Erzeugen gespeichert. Die
Prüflogik (`invoices/integrity.ts`, `integrity.service.ts`) vergleicht die
gespeicherten Bytes mit der Prüfsumme und kennt fünf Zustände:

| Zustand | Bedeutung |
|---|---|
| `ok` | Bytes und Prüfsumme passen. |
| `absent` | Das Dokument wurde noch nicht erzeugt. Kein Befund. |
| `mismatch` | Die Bytes ergeben eine andere Prüfsumme (verändert). |
| `missing_content` | Prüfsumme vorhanden, Bytes fehlen (entfernt). |
| `missing_hash` | Bytes vorhanden, keine Prüfsumme (nicht prüfbar). |

Wann geprüft wird:

- **Einzelne Rechnung:** `GET /api/invoices/:id/integrity` (rein lesend).
- **Nächtlicher Lauf** um 02:40 Uhr Serverzeit (`IntegrityService.nightlyRun`):
  alle festgeschriebenen Rechnungen und der Nummernkreis.
- **Aufgabe „Beleg manipuliert“** auf der Startseite
  (`tasks/sources/document-tampered.source.ts`): live berechnet, 5 Minuten
  zwischengespeichert; es gibt keinen grünen Haken, die Aufgabe entsteht nur bei
  einem Befund.

**Das Ergebnis wird nie an der Rechnung gespeichert** (die Trigger ließen das nicht
zu und sollen es auch nicht). Ein Befund steht als Eintrag `invoice.integrity_failed`
im Audit-Log. Die Prüfung **repariert nichts und löscht nichts**.

## 6. Nummernkreis und Storno

- **Lückenlos je Jahr**, Format `JJJJ-NNN`. Die Nummer wird erst beim Festschreiben
  vergeben, in derselben Transaktion, mit einer Beratungssperre
  (`pg_advisory_xact_lock`) und als höchste vorhandene Nummer plus eins unter
  `READ COMMITTED`. Rollt ein Festschreiben zurück, entsteht keine Lücke, weil die
  Nummer nie vergeben wurde (`invoices/number-sequence.ts`). Eine Datenbanksequenz
  wäre dafür falsch, weil sie nach einem Rollback Lücken hinterlässt.
- **Lückenprüfung:** Der Integritätslauf (Abschnitt 5) sucht Lücken im Nummernkreis
  (`findNumberGaps`) und meldet sie in der Aufgabe „Beleg manipuliert“.
- **Korrektur nur durch Storno.** Eine Stornorechnung ist eine eigene, neue,
  festgeschriebene Rechnung mit eigener Nummer, verweist auf das Original und trägt
  die Begründung (`cancellationReason`). Das Original behält seinen Inhalt und
  wechselt nur den Status auf `cancelled`. Ein Original lässt sich genau einmal
  stornieren (Audit `invoice.cancelled`).
- **Entwürfe** ohne Nummer sind löschbar, nummerierte Rechnungen nie.

## 7. Aufbewahrung

- `Invoice.retentionUntil` wird beim Festschreiben gesetzt: **31.12. des Jahres der
  Festschreibung plus die konfigurierte Zahl Jahre** (`retentionEnd` in
  `invoice.service.ts`). Vorgabe sind **8 Jahre**; änderbar über das Manifest
  (`billing.retentionYears`, siehe [manifest.md](../manifest.md)). Bei einer
  Stornorechnung zählt ihr eigenes Festschreibejahr.
- **Welche Frist für welchen Beleg gilt, klärt die Steuerberatung.** Die Vorgabe ist
  ein Startwert, keine Rechtsauskunft. Eine spätere Änderung des Manifests wirkt nur
  auf künftig festgeschriebene Rechnungen, nicht rückwirkend.
- Es gibt **keinen Löschpfad** für festgeschriebene Rechnungen: Datenbank-Trigger
  (Abschnitt 4), Fremdschlüssel mit `onDelete: Restrict` und die R1/R2-Tests.
  Auch nach Fristende löscht die Software nichts von selbst (Regel R4).
- Die DSGVO-Löschung von Kontaktdaten betrifft die Organisation (`Company`), nie die
  Schnappschüsse in den Rechnungen. Ob und wie eine Löschanfrage mit der Aufbewahrungspflicht
  zusammenpasst, klärt der Betreiber im Einzelfall.

## 8. Protokoll und Zugriff für Prüfer

**Protokoll.** Das Audit-Log ist append-only (Abschnitt 4). Es hält fest: Entwurf,
Festschreiben, Dokumenterzeugung, **jeden Abruf** von PDF und XML,
Versand, Mahnung, Zahlungs- und Übertragungsvermerk, Storno, Integritätsbefunde und
GoBD-Exporte. Jeder Eintrag trägt technischen Zeitstempel (UTC), Benutzer (`actor`,
`userId`), Objekt und, soweit bekannt, IP-Adresse und Browserkennung. Die
Rechnungsansicht zeigt davon als „Verlauf“ nur Benutzer, Zeit und Aktion
(`invoices/invoice-history.service.ts`, höchstens 500 Zeilen). Kein Passwort, kein
Code, keine IBAN gelangt ins Audit-Log ([security-model.md](security-model.md),
Abschnitt 3).

**Export für die Betriebsprüfung (Datenträgerüberlassung, Z3).**
`GET` oder `POST /api/invoices/export/gobd` mit `from` und `to` (Rechnungsdatum), in
der Oberfläche unter Rechnungen der Knopf „Export für Betriebsprüfung“. Nur
`owner` und `administrator`, hinter dem zweiten Faktor, höchstens 5 Aufrufe je
Minute, höchstens 10 000 Rechnungen je Export (größere Zeiträume aufteilen),
auditiert als `invoice.gobd_export`. Das ZIP enthält:

| Inhalt | Zweck |
|---|---|
| `invoices/<Jahr>/<Nummer>.pdf`, `.xml`, `-xrechnung.xml` | die Dokumente unverändert, so wie gespeichert |
| `index.csv` | Verzeichnis aller Rechnungen (UTF-8 mit BOM, Trenner `;`, CRLF) mit Nummer, Datum, Empfänger, Beträgen, Status, Prüfsummen, Aufbewahrungsende und Integritätsergebnis |
| `index-description.json` | maschinenlesbare Beschreibung der Spalten von `index.csv` |
| `hashes.sha256` | SHA-256 aller Dateien im Format von `sha256sum` |
| `README.txt` | Anleitung zur Prüfung (`sha256sum -c hashes.sha256`) |

Der Export erzeugt nichts neu; er liefert die gespeicherten Bytes und rechnet zur
Kontrolle ihre Prüfsumme nach. Der Hinweis in der `README.txt` des Exports gilt
auch hier: technischer Export, keine Rechtsberatung.

## 9. Datensicherung des Rechnungsbestands

Details: [backup-and-recovery.md](backup-and-recovery.md). Für die GoBD zählt:

- Der **Backup-Agent** sichert täglich (oder zweimal täglich, je nach Einstellung)
  die Verwaltungs-Datenbank als verschlüsselten Dump **und** ein getrenntes
  **Rechnungsarchiv je Jahr** (alle PDFs und XMLs plus `hashes.sha256`, als
  `invoices/<Jahr>/<Zeitstempel>.tar.age`). Ein Jahr wird nur neu abgelegt, wenn sich
  sein Inhalt geändert hat.
- Der Agent **löscht niemals** Objekte unter `invoices/` und räumt sie auch nicht
  auf; alte Datenbank-Sicherungen räumt er nur nach gelungenem Lauf auf.
- Bei einem **S3-Ziel mit Object Lock** versieht der Agent jedes Rechnungsarchiv
  (und seine Meta-Datei) mit einer Aufbewahrungssperre im Modus **GOVERNANCE** bis
  zu einem Stichtag. Dieser Stichtag ist **Zeitpunkt der Sicherung plus
  `INVOICE_RETENTION_YEARS` Jahre** (Umgebungsvariable des Agents, Vorgabe 10),
  **nicht** das `retentionUntil` der einzelnen Rechnung. Wer eine andere Dauer will,
  stellt die Variable am Agent ein. Der Modus GOVERNANCE lässt sich von Konten mit dem
  Recht zum Umgehen der Sperre aufheben (die Zugangsdaten des Agents sollten dieses
  Recht nicht haben). Der Agent setzt immer GOVERNANCE; eine strengere Sperre
  (COMPLIANCE) setzt er nicht.
- Bei einer **Storage Box (SFTP)** gibt es keine Sperre durch den Agent. Schutz
  entsteht hier durch Schreibrechte, die nur der Agent hat, und durch Snapshots, die
  der Betreiber beim Anbieter einrichtet.
- **Wiederherstellbarkeit:** Eine Sicherung gilt erst als belegt, wenn sie
  zurückgespielt wurde. „Verifizieren“ in der Verwaltung prüft nur Größe und
  Prüfsumme der verschlüsselten Datei, nicht den Inhalt. Der Betreiber spielt
  regelmäßig ein Rechnungsarchiv mit seinem privaten Schlüssel zurück und prüft die
  `hashes.sha256` (Anleitung in backup-and-recovery.md).
- Der **private Entschlüsselungsschlüssel** liegt nicht auf dem Server. Geht er
  verloren, sind alle verschlüsselten Sicherungen, auch die Rechnungsarchive, nicht
  lesbar. Das gehört in die Verfahrensdokumentation.

## 10. Grenzen: was die Software nicht zusichert

- **`TRUNCATE` wird von den Triggern nicht erfasst.** Ein Zeilentrigger greift bei
  `TRUNCATE` nicht. Die Datenbankrolle der Anwendung sollte deshalb **kein**
  `TRUNCATE` besitzen und **nicht Eigentümerin** der Tabellen sein (Eigentümer können
  Trigger entfernen). Das ist **Aufgabe des Betreibers**, die Standardinstallation
  nimmt sie nicht ab: Sie legt eine einzige Datenbankrolle an, die auch die
  Migrationen ausführt. Wer die Unveränderbarkeit gegen Fehlbedienung auf dem
  Datenbankserver absichern will, trennt Migrationsrolle und Betriebsrolle und
  entzieht Letzterer `TRUNCATE`, `DROP` und `ALTER`. Das ist in dieser Version nicht
  umgesetzt.
- **Ein Administrator des Datenbankservers kann Trigger abschalten.** Die Trigger
  schützen vor Fehlern und vor Fehlverhalten über die Anwendung, nicht vor einem
  böswilligen Superuser. Dagegen helfen die Sicherungen mit Object Lock und die
  Prüfsummen in den Exporten, die eine spätere Veränderung nachweisbar machen.
- **Rechnungsdienst:** Das PDF/A-3 entsteht im Dienst `invoice-renderer`. Ein
  fehlerhaft gerendertes Dokument bemerkt die Anwendung nur im Rahmen ihrer eigenen
  Prüfung (`invoice.document.invalid`); die Prüfung gegen einen externen Validator
  bleibt Aufgabe des Betreibers.
- **Nicht umgesetzt:** eine Zeitstempelung durch Dritte (qualifizierter Zeitstempel),
  eine elektronische Signatur der Belege, ein Lösch- oder Sperrkonzept für
  Eingangsrechnungen und eine eigene Mahnverfahrensdokumentation.
- **Die Verfahrensdokumentation selbst** schreibt der Betreiber. Dieses Dokument ist
  eine Vorlage und ein Nachweis der technischen Bausteine, kein Ersatz.

## 11. Internes Kontrollsystem (Vorschläge für den Betreiber)

| Kontrolle | Rhythmus | Wer |
|---|---|---|
| Aufgabe „Beleg manipuliert“ leer? Integritätslauf im Audit-Log ohne `invoice.integrity_failed`? | täglich | Betreiber |
| Nummernkreis ohne Lücken (Integritätslauf) | täglich automatisch, Befund sofort klären | Betreiber |
| Sicherung gemeldet (Aufgabe „Sicherung überfällig“), Rechnungsarchiv im Sicherungsziel vorhanden | wöchentlich | Betreiber |
| Rückspielprobe des Rechnungsarchivs, Prüfsummen vergleichen | mindestens jährlich | Betreiber |
| Konten und Rollen prüfen, nicht mehr gebrauchte entfernen | vierteljährlich | Betreiber |
| GoBD-Export für einen abgeschlossenen Zeitraum probeweise ziehen und mit der Steuerberatung abstimmen | jährlich | Betreiber, Steuerberatung |
| Datenbankrolle: kein `TRUNCATE`, Betriebsrolle getrennt von der Migrationsrolle (Abschnitt 10) | bei Einrichtung und nach Änderungen | Betreiber |

## 12. Vorlage für die Verfahrensdokumentation

Die folgende Gliederung ist ein Vorschlag. Kursiv steht, was der Betreiber selbst
einsetzt. Die technischen Beschreibungen lassen sich aus den Abschnitten 2 bis 9
übernehmen.

1. **Allgemeine Beschreibung.** Unternehmen, *Name und Anschrift*, Zweck des
   Verfahrens, betroffene Belegarten (Ausgangsrechnungen), Geltungsbeginn,
   Verantwortliche (*Namen, Vertretung*).
2. **Anwenderdokumentation.** Wie eine Rechnung entsteht (Abschnitt 3), wer sie
   festschreibt, versendet, storniert, welche Eingaben Pflicht sind. *Schulung der
   Anwender, Berechtigungskonzept (Abschnitt 2)*.
3. **Technische Systemdokumentation.** Systemlandschaft (Verwaltung, Datenbank,
   Rechnungsdienst, Backup-Agent, Sicherungsziel, Server und Standort), Software und
   Versionen (*Stand des Release*), Datenmodell der Rechnung, Schnittstellen zur
   Buchhaltung (*eingesetztes Programm, Übergabeweg*), Beschreibung der
   Unveränderbarkeit (Abschnitt 4) und ihrer Grenzen (Abschnitt 10).
4. **Betriebsdokumentation.** Datensicherung (Abschnitt 9, *Ziel, Zeitplan,
   Aufbewahrung, Ablage des privaten Schlüssels, Name der Vertretung*), Rückspielprobe,
   Datenträgerwechsel und Migration, Notfallzugang
   ([emergency-access.md](emergency-access.md)), Updates und Änderungsverfahren
   (*wer prüft vor dem Einspielen eines neuen Standes*).
5. **Aufbewahrung und Löschung.** Fristen (Abschnitt 7, *mit der Steuerberatung
   abgestimmte Fristen*), Umgang mit Löschanfragen, Verhalten nach Fristende.
6. **Datenzugriff.** Verfahren für den Prüferzugriff (Abschnitt 8), *Ansprechpartner,
   Vorlauf, Beschreibung der Exportstruktur*.
7. **Internes Kontrollsystem.** Kontrollen aus Abschnitt 11 mit *Verantwortlichen*
   und Nachweis (zum Beispiel Notiz oder Eintrag im Betriebsjournal).
8. **Änderungshistorie dieser Dokumentation.** Tabelle mit *Datum, Version, Änderung,
   Verfasser*; jede Änderung am Verfahren (neue Version der Software, anderer
   Sicherungsweg, andere Frist) erhält eine Zeile.

Abgeschlossen wird mit einem Hinweis, dass die Dokumentation mit der
Steuerberatung abgestimmt wurde (*Datum, Name*).
