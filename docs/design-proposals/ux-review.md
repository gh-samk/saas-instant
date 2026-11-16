# UX-Prüfung der Verwaltung: Vorschläge zur Vereinfachung

Stand: Vorschlagsbericht, **nichts davon ist umgesetzt**. Umgesetzt wird erst nach deiner Auswahl.
Prüfmaßstab: Regeln des Skills `ui-ux-pro-max` in seiner Reihenfolge: Barrierefreiheit, Touch und Interaktion, Layout und Responsive, Formulare und Rückmeldung, Navigation. Dazu Verständlichkeit, Dichte und Klickwege.
Screenshots (Zustand vorher, fiktive Demo-Daten): `docs/design-proposals/ux/`.

## Was geprüft wurde und wie

- Laufende Verwaltung mit Demo-Daten (Demo-Seed plus Rechnung an eine Behörde, Sicherungen für eine Instanz), Sicherungsagent und Rechnungsdienst als Attrappe bzw. Container.
- Ansichten: Anmeldung, Heute, Organisationen (Liste, Anlegen, Detail mit allen sechs Reitern), Instanzen, Rechnungen (Liste, Detail offen und überfällig, neuer Entwurf, Entwurf bearbeiten, Zahlung, Storno), Rundmail, Einstellungen (alle acht Reiter), Wiederherstellen-Dialog, Portal.
- Breiten: Desktop 1440, Mobil 375 (alle Ansichten), Tablet 768 (alle Ansichten als Bild erzeugt, Überlauf per Messung auf vier Seiten, Bildkontrolle stichprobenartig). Hell überall, dunkel stichprobenartig (Rechnungsliste als Bild geprüft).
- Tastatur: Tab-Reihenfolge am Seitenanfang, Fokusrahmen, Sprunglink. Touch-Ziele auf Rechnungsliste und Organisationsdetail bei 375 px gemessen.

### Einschränkungen der Prüfung

- Ohne Coolify-Anbindung: Die Instanz-Neuanlage lässt sich in der Demo nicht bis zum Ende durchspielen (jede Subdomain gilt als „vergeben"). Die Aufgabe „Sicherung überfällig" auf Heute ist ein Demo-Artefakt.
- Die Verwaltung lief mit dem zuletzt erfolgreich gebauten Server-Stand (der aktuelle Quellstand war durch parallele Arbeit am Rechnungsabsender gerade nicht baubar). Die Oberfläche kommt aus dem aktuellen Quellstand.
- Kontrast wurde nach Augenmaß und über die vorhandene Kontrast-Suite eingeschätzt, nicht neu gemessen.

## Was schon gut ist (nicht anfassen)

- Sprunglink „Zum Hauptinhalt springen" und sichtbarer Fokusrahmen (2 px) ab dem ersten Tab. Alle Icon-Knöpfe haben Namen („Zahlung zu 2026-001 erfassen", „E-Mail an …").
- Touch-Ziele bei 375 px: auf den geprüften Seiten kein Ziel unter 44 px.
- Anmeldung mit Passkey zuerst, sonst Zugangsdaten; kurz und klar.
- Dialog „Organisation anlegen": nur fünf Felder, nur der Name ist Pflicht, danach landet man direkt auf der neuen Organisation.
- Dialog „Zahlung erfassen": Datum und Betrag sind vorbelegt. Dialog „Rechnung stornieren": „Das passiert / Das passiert nicht" ist vorbildlich.
- Leerzustand der Rundmail erklärt, was eine Vorlage ist, und bietet den nächsten Schritt an.
- Dunkelmodus: Badges, Tabellen, Hinweisfarben bleiben lesbar.
- Das Portal ist bewusst minimal: eine Liste, ein Knopf je Verwaltung, ein Klick. Dort ist nichts zu vereinfachen.

## Klickwege (Ist-Zustand, gezählt)

| Aufgabe | Schritte heute | Auffälligkeit |
|---|---|---|
| Neue Organisation | Organisationen, „+ Organisation", Name tippen, „Anlegen" = **3 Klicks** | gut; danach leere Seite ohne Wegweiser (Punkt 1) |
| Instanz für sie anlegen | Reiter „Instanz", „Instanz anlegen", Subdomain, „Weiter", Vorschau bestätigen = **4 Klicks** | Weg ist unauffindbar, wenn man die Organisation nicht kennt (Punkt 1) |
| Erste Rechnung | Reiter „Rechnungen", „Rechnung anlegen", Posten ausfüllen, „Als Entwurf speichern", „Festschreiben …", bestätigen, „Versenden …", bestätigen = **7 Klicks** plus 6 bis 8 Felder | Zeiträume doppelt, Vorschlag nur halb nutzbar (Punkt 5) |
| Zahlung erfassen | Rechnungen, Icon in der Zeile (führt nur auf die Detailseite), nach unten scrollen, „Zahlung erfassen", „Zahlung vermerken" = **4 Klicks plus Scrollen** | Icon verspricht die Aktion, öffnet aber nur die Seite (Punkt 2) |
| Zahlungserinnerung (Mahnung) | wie Zahlung, dann „Erinnerung senden", bestätigen = **4 Klicks plus Scrollen** | Es gibt nur „Erinnerung", keine Mahnstufen (Punkt 20) |

Soll-Zustand nach den Vorschlägen: neue Organisation bis erste versendete Rechnung in etwa 8 statt 14 Klicks, Zahlung erfassen in 2 Klicks aus Liste oder Heute.

---

## P1: Hürden im Alltag

### 1. Neue Organisation: Seite ohne Wegweiser
- **Problem (Organisation, Reiter Überblick):** Direkt nach „Anlegen" zeigt die Seite sechs Kennzahlen mit „—" (Preisstufe, Zahlungsweise, Beschluss Pilot, Überprüfung, Instanz-Start, Angefragt) und „Nächste Schritte: Nichts offen — hier steht, was ansteht." Dabei fehlen genau Instanz, Vertrag und Rechnung. Wer nicht weiß, dass „Instanz" ein Reiter ist, findet den Weg nicht. Screenshot 02.
- **Vorschlag:** Der Überblick zeigt je nach Status eine Schrittliste mit je einem Knopf: „Vertrag festlegen (Preisstufe, Zahlungsweise)", „Instanz anlegen", „Erste Rechnung anlegen", „Stellvertretung eintragen". Erledigte Schritte werden abgehakt und klappen weg. Kennzahlen ohne Wert werden ausgeblendet statt „—" zu zeigen.
- **Aufwand:** M
- **Nutzen:** Hoch. Der Weg Organisation, Instanz, Rechnung wird zum geführten Pfad.
- **Dateien:** `apps/control/src/components/CompanyOverview.tsx`, `pages/CompanyDetailPage.tsx`, `i18n/locales/de/*`

### 2. Rechnungsaktionen: unten versteckt, Listen-Icons führen nur hin
- **Problem (Rechnungen, Rechnungsdetail):** Die Zeilen-Icons „Zahlung erfassen" und „Erinnerung senden" öffnen nur die Detailseite (`InvoicesPage.tsx`, Zeilenaktionen). Dort stehen sechs gleichrangige Knöpfe (PDF, XML, XRechnung, Versenden, Zahlung erfassen, Stornieren) **am Seitenende unter der langen Integritätskarte**, der rote „Stornieren" gleichauf mit „Zahlung erfassen". Screenshots 05, 06.
- **Vorschlag:** (a) In der Liste öffnet das Icon direkt den Zahlungsdialog (gleiches Muster für „Erinnerung"), ohne Seitenwechsel. (b) Im Detail eine Aktionsleiste **in der Kopfzeile** neben Titel und Status: je Status genau eine Hauptaktion (offen oder überfällig: „Zahlung erfassen"; Entwurf: „Festschreiben"; festgeschrieben, nie versendet: „Versenden"), Nebenaktionen als Textknöpfe, „Stornieren" im Menü „Weitere ⋯" und nicht mehr rot daneben. (c) Dieselben Direktaktionen als Zeilenknopf in „Heute".
- **Aufwand:** M
- **Nutzen:** Hoch. Zahlung erfassen sinkt von vier Klicks plus Scrollen auf zwei Klicks, Fehlgriff auf „Stornieren" wird unwahrscheinlicher.
- **Dateien:** `pages/InvoicesPage.tsx` (Zeilenaktionen), `pages/InvoiceDetailPage.tsx`, `components/InvoiceView.tsx`, `components/PaymentRecordDialog.tsx`, `pages/DashboardPage.tsx`

### 3. Serverfehler erscheinen englisch und roh am Seitenende
- **Problem (Rechnungsentwurf, „Festschreiben …"):** Schlägt die Prüfung des Servers fehl, steht unter dem Formular im Klartext `lines.0.unit must be shorter than or equal to 3 characters`, englisch, ohne Feldbezug, weit weg vom auslösenden Knopf. Das widerspricht der Regel „Fehler am Feld, verständlich, mit Lösung". Screenshot 08.
- **Vorschlag:** Die Fehlerabbildung in `api-client.ts` übersetzt Pfade wie `lines.N.unit` in „Posten N, Einheit" und setzt die Meldung ans Feld (`fieldError` existiert im Entwurf bereits), setzt den Fokus aufs erste fehlerhafte Feld und zeigt oben eine Zusammenfassung („2 Angaben prüfen"). Unbekannte Serverfehler bekommen einen deutschen Standardtext. Die Einheit ist keine Freitexteingabe, sondern eine Auswahl (Stück, Monat, Jahr, Pauschale).
- **Aufwand:** M
- **Nutzen:** Hoch. Fehler sind sonst nicht selbst behebbar.
- **Dateien:** `lib/api-client.ts` (Fallbacktexte, `FALLBACK_TEXT`), `components/InvoiceDraftForm.tsx`, `components/InvoiceFinalizeDialog.tsx`, `packages/shared` (DTO-Grenzen)

### 4. Mobil (375 px): Seite scrollt seitlich, Listen verstecken das Wichtige
- **Problem (Organisationen, Instanzen, Organisationsdetail):** Gemessene Seitenbreite 881 px (Organisationen), 827 px (Instanzen), 541 px (Detail, Karte „Nächste Schritte") bei 375 px Fenster. Die Liste zeigt mobil nur den Namen. Status, offener Betrag und Frist liegen hinter einem Seitwärtswischen („Die Tabelle lässt sich seitlich schieben"). Auf Tablet 768 tritt es nicht auf. Screenshot 13.
- **Vorschlag:** Unter 640 px werden Tabellenzeilen zu Karten: Name, darunter Statusbadge und offener Betrag in einer Zeile, Frist nur wenn vorhanden. Der Seitenüberlauf wird an der Wurzel behoben (`min-w-0` und `overflow-x-clip` am Hauptbereich, lange Zeilen in „Nächste Schritte" umbrechen).
- **Aufwand:** M
- **Nutzen:** Hoch für alle, die unterwegs kurz nachsehen. Verletzt die Regel „kein horizontales Scrollen".
- **Dateien:** `components/AppShell.tsx` (Hauptbereich), `pages/CompaniesPage.tsx`, `pages/InstancesPage.tsx`, `components/CompanyOverview.tsx`, die gemeinsame `Table` aus `packages/ui/src/components`

### 5. Rechnungsentwurf: doppelte Angaben und schwache Vorbelegung
- **Problem (Neue Rechnung, Entwurf bearbeiten):** (a) Leistungszeitraum steht oben rechts und noch einmal je Posten („Zeitraum von/bis"), in der neuen Rechnung vorbelegt mit „heute bis heute". (b) Der Preisvorschlag nennt die Stufe („Groß, Durchschnitt 61,1 Personen"), bietet in dieser Demo aber nur „Einrichtungspauschale hinzufügen" zum Übernehmen an, weil an der Organisation keine Preisstufe hinterlegt ist. Der Vorschlag hilft dann nur halb. (c) Die Spalte rechts („Rechnungsdaten") beginnt höher als die Hauptspalte, die Leserichtung bricht. (d) Zwei große Textfelder (Einleitung, Zahlungshinweis) und die Notiz stehen immer offen, obwohl sie meist leer bleiben. Screenshot 07.
- **Vorschlag:** Zeitraum nur einmal oben, abgeleitet aus Zahlungsweise des Vertrags (monatlich: Kalendermonat, halbjährlich: 6 Monate, jährlich: 12 Monate). Der Zeitraum je Posten wandert unter „Weitere Angaben" und gilt nur bei Abweichung. Der Vorschlag wird zu einem Knopf „Posten aus Vertrag übernehmen" (Stufe, Intervall, Preis), auch wenn nur ein Einrichtungs-Posten fehlt, mit Hinweis „Preisstufe an der Organisation festlegen". Texte und Notiz als eingeklappter Abschnitt „Texte und Notiz (optional)". Beide Spalten auf gleicher Höhe beginnen lassen.
- **Aufwand:** M
- **Nutzen:** Hoch. Die erste Rechnung braucht dann nur noch eine Prüfung statt Eingabe.
- **Dateien:** `components/InvoiceDraftForm.tsx`, `components/InvoicePriceSuggestion.tsx`, `invoices/pricing.service.ts` (Vorschlagslogik)

### 6. Firmendaten: 34 Felder, 3.900 px, alles gleich wichtig
- **Problem (Einstellungen, Firmendaten):** Die Seite ist inhaltlich gut gegliedert, aber sehr lang. Die acht Rechtsform-Karten allein beanspruchen etwa 230 px. Sitz, Registergericht und Registernummer stehen untereinander in voller Breite, obwohl kurze Werte. Optionale Blöcke (Kontakt, Steuer, Logo, Akzentfarbe) stehen gleichrangig zu Pflichtblöcken. „Speichern" liegt ganz unten. Mobil sind es über 5.200 px. Screenshots 09, 15.
- **Vorschlag:** (a) Rechtsform als Auswahlliste mit Erklärtext unter der Auswahl statt acht Karten. (b) Pflichtabschnitte aufgeklappt, optionale Abschnitte („Kontakt", „Steuer", „Logo und Farbe") zugeklappt mit Statuszeile („3 von 5 ausgefüllt"). (c) Zusammengehörige Kurzfelder in Zeilen: Sitz und Registergericht und Nummer, Bank und BIC. (d) Feste Fortschrittsleiste oben („Pflichtangaben vollständig") und feste Speicherleiste unten (siehe Punkt 8). (e) Inline-Prüfung beim Verlassen des Feldes für IBAN-Prüfsumme, USt-IdNr.-Format und Registernummer-Präfix, statt erst beim Speichern.
- **Aufwand:** M bis L
- **Nutzen:** Hoch. Das ist das längste Formular und die Quelle für „Rechnung kann nicht festgeschrieben werden".
- **Dateien:** `components/IssuerProfileCard.tsx`, `components/IssuerFormParts.tsx`, `lib/issuer-fields.ts`

### 7. Preise: 46 Felder, davon die Hälfte archiviert und technisch
- **Problem (Einstellungen, Preise):** Jede Stufe ist eine große Karte mit sieben Feldern. Die drei archivierten Stufen (nur Altlast) sind **voll bearbeitbar** und nehmen ein Drittel der Seite ein. „Schlüssel" (`klein`, `mittel`) ist ein technisches Feld, das man nicht versteht und nie ändern kann. Die Bezeichnung „Klein (bis 10 Personen)" wiederholt die Zahl aus „Bis aktive Personen", zwei Quellen für dieselbe Aussage. Halbjahres- und Jahrespreis folgen in den Demo-Daten einer festen Regel (5,5 bzw. 11 Monatspreise), werden aber einzeln getippt. Screenshot 10.
- **Vorschlag:** Aktive Stufen als **Tabelle** (eine Zeile je Stufe: Name, bis Personen, Monat, Halbjahr, Jahr, Einrichtung), drei Zeilen passen auf einen Bildschirm. Archivierte Stufen eingeklappt, nur lesbar mit „Wiederherstellen". „Schlüssel" automatisch aus dem Namen erzeugen und hinter „Technische Angaben" verstecken. Der Name wird aus „bis N Personen" angezeigt, nicht doppelt gepflegt. Optional: Halbjahr und Jahr als Vorschlag „aus Monatspreis berechnen" mit überschreibbarem Wert.
- **Aufwand:** M
- **Nutzen:** Hoch. Weniger Felder, weniger Fehler, Überblick über alle Stufen auf einen Blick.
- **Dateien:** `components/PricesCard.tsx` (`KEY_PATTERN`, `archived`-Zweige), `settings/price-settings.service.ts`

---

## P2: Spürbare Vereinfachung

### 8. Speichern überall gleich: feste Leiste, Änderungsstand, Warnung beim Verlassen
- **Problem (Firmendaten, Preise, Sicherung, Rechnungsentwurf):** „Speichern" liegt am Seitenende. Beim Rechnungsentwurf verteilen sich „Änderungen speichern" (unten rechts) und „Festschreiben …" (eigener Kasten darüber) auf zwei Stellen. Dass ungespeicherte Änderungen verloren gehen, sagt nichts, wenn man den Reiter wechselt.
- **Vorschlag:** Eine feste Aktionsleiste am unteren Rand (nur sichtbar, wenn etwas geändert ist: „Ungespeicherte Änderungen · Verwerfen · Speichern"), dazu Warnung beim Reiterwechsel. Beim Entwurf „Speichern" und „Festschreiben …" nebeneinander.
- **Aufwand:** M (ein gemeinsamer Baustein, dann je Formular einhängen)
- **Nutzen:** Mittel bis hoch. Gleiche Handhabung in allen langen Formularen, kein Suchen nach dem Knopf.
- **Dateien:** neu `components/StickySaveBar.tsx`, `IssuerProfileCard.tsx`, `PricesCard.tsx`, `BackupSettingsCard.tsx`, `InvoiceDraftForm.tsx`

### 9. Einstellungen: acht Reiter mischen Konto und Betrieb
- **Problem (Einstellungen):** Zugangsdaten, Sicherheit, Nutzer, Geräte, Funktionen, Firmendaten, Preise, Sicherung stehen in einer Reihe. Der Untertitel nennt nur „Anmeldemethoden, Sicherheitsprotokoll, Geräte und Funktionen", nicht Firmendaten, Preise oder Sicherung. Wer Preise sucht, sucht in „Konto".
- **Vorschlag:** Zwei Gruppen mit Überschrift: „Mein Konto" (Zugangsdaten, Sicherheit, Geräte) und „Betrieb" (Firmendaten, Preise, Sicherung, Nutzer, Funktionen), als linke Navigation ab 768 px, mobil als zwei Auswahllisten. Untertitel an alle Inhalte anpassen. Fehlermeldungen wie „Firmendaten unvollständig" verlinken direkt auf den Reiter.
- **Aufwand:** S bis M
- **Nutzen:** Mittel bis hoch. Ordnung statt Reihe; Reiter-Leiste bricht mobil schon zweizeilig um.
- **Dateien:** `pages/SettingsPage.tsx` (`TABS`, Kopf), i18n `einstellungen.*`

### 10. Sicherung: Fachbegriffe und 10 Felder in einer Spalte
- **Problem (Einstellungen, Sicherung):** Endpunkt, Region, Bucket, Präfix, „Path-Style-Adressierung", „Object Lock", Zugangsschlüssel-ID und Geheimer Schlüssel stehen untereinander in voller Breite. Die Hinweise sind hilfreich, aber für Menschen ohne S3-Wissen unverständlich. Screenshot 11.
- **Vorschlag:** Anbieter-Vorlagen („Hetzner Object Storage", „AWS S3", „MinIO / eigener Server", „Anderer") füllen Endpunkt, Region und Path-Style vor. Seltene Angaben (Präfix, Path-Style, Aufbewahrung) unter „Erweitert". „Object Lock" in Alltagssprache: „Rechnungsarchiv unveränderlich (kann bis zum Fristende nicht gelöscht werden)", Fachbegriff in Klammern. Zugangsdaten in zwei Spalten. „Speichern" und „Verbindung testen" zu „Speichern und testen". Felder nebeneinander statt untereinander.
- **Aufwand:** M
- **Nutzen:** Mittel. Setup-Hürde sinkt, Fehlkonfiguration wird seltener.
- **Dateien:** `components/BackupSettingsCard.tsx`, `backup-settings/*`

### 11. Wiederherstellen-Dialog: Dateiauswahl ungestylt und englisch
- **Problem (Instanz, Sicherungen, „Als neue Instanz wiederherstellen"):** Der Knopf „Schlüsseldatei wählen" ist der rohe Browser-Dateiknopf („Choose File / No file chosen", englisch, andere Optik). „Privater Schlüssel (Entschlüsselung)" und „Übernahme" werden nicht erklärt, es fehlt der Hinweis, wo man den Schlüssel findet. Das Eintippen des Instanznamens zur Bestätigung ist für eine nicht-zerstörerische Aktion (es entsteht eine neue Instanz, die alte bleibt) mehr Hürde als Schutz. Screenshot 12.
- **Vorschlag:** Gestylte Fläche „Schlüsseldatei hierher ziehen oder wählen" mit deutschem Namen der Datei. Unter dem Feld ein Satz „Den Schlüssel hast du bei der Einrichtung der Sicherung gespeichert (Datei `*.txt`)". „Übernahme" in einem Satz erklären oder in „Umschalten" umbenennen. Die Bestätigung durch Tippen entfällt, der Knopf „Wiederherstellung starten" nennt die neue Subdomain.
- **Aufwand:** S
- **Nutzen:** Mittel. Wird selten genutzt, aber im Notfall; dort ist Verständlichkeit entscheidend.
- **Dateien:** `components/RestoreInstanceDialog.tsx`, `components/AgeKeyDialog.tsx`

### 12. Instanz-Reiter: wiederholte Knöpfe und leere Spalten
- **Problem (Organisation, Reiter Instanz):** Fünf Sicherungszeilen tragen je denselben langen Knopf „Als neue Instanz wiederherstellen". Die Spalte „Art" ist überall „Instanz", die Spalte „Geprüft" überall „Nicht geprüft". Rund ein Drittel der Tabellenbreite zeigt keine Information. Screenshot 04.
- **Vorschlag:** Zeilenaktion „Wiederherstellen …" (der Dialogtitel erklärt den Rest). Spalte „Art" nur anzeigen, wenn es mehrere Arten gibt. „Geprüft" nur als Badge bei Ergebnis, sonst „Prüfen"-Link.
- **Aufwand:** S
- **Nutzen:** Mittel. Ruhigere Tabelle, größere Trefferfläche.
- **Dateien:** `components/InstanceBackups.tsx`

### 13. Heute: lange Texte, Wiederholung und keine Direktaktion
- **Problem (Heute):** Jede überfällige Rechnung trägt denselben Absatz „Der Zahlungseingang wird von Hand vermerkt — es gibt keinen Kontoabgleich. Prüfe den Kontoauszug und vermerke die Zahlung oder schicke eine Erinnerung." (viermal fast identisch). Organisationsnamen sind abgeschnitten („Demo Silberdistel Na…"), obwohl daneben Platz ist. Die Handlung ist ein Textlink „Rechnung öffnen →" statt der eigentlichen Aufgabe. Screenshot 01.
- **Vorschlag:** Zeile: kurzer Titel („Rechnung DEMO-0005 überfällig · 629,51 €"), eine Zeile Organisation und Alter („Steinbock Bergwacht-Förderkreis · seit 61 Tagen"). Die Erklärung steht **einmal** als Hinweis über der Gruppe. Zeilenknöpfe „Zahlung erfassen" und „Erinnerung senden" öffnen den Dialog direkt (Punkt 2). Gruppen mit Überschrift (Rechnungen, Sicherungen) statt Reiter plus Spalte „Art".
- **Aufwand:** M
- **Nutzen:** Mittel bis hoch. Die Startseite wird kürzer und handlungsfähig; auf Mobil (1.737 px) deutlich kürzer.
- **Dateien:** `pages/DashboardPage.tsx`, `tasks/sources/invoice-overdue.source.ts`, `tasks/tasks.types.ts`

### 14. Heute: Hinweisband mit Fachjargon
- **Problem (Heute, unten):** „Abgleich mit Coolify — noch nie gelaufen, also ungemessen." und ein getrennter Knopf „Jetzt prüfen" weit unten rechts. „Coolify", „ungemessen" sind interne Begriffe. Unklar, was es für die Arbeit heißt.
- **Vorschlag:** „Der Instanz-Status wurde noch nie abgeglichen. Zahlen zu Instanzen können fehlen. [Jetzt abgleichen]" als ein Band mit Knopf darin. Den Namen „Coolify" nur dort nennen, wo man ihn braucht (Einstellungen).
- **Aufwand:** S
- **Nutzen:** Mittel.
- **Dateien:** `pages/DashboardPage.tsx`, `i18n/locales/de/components.ts` (Schlüssel „Abgleich mit Coolify")

### 15. Organisationsdetail: Kopfknöpfe nur als Icons, Reiter „Kontakt & Vertrag" zu lang
- **Problem (Organisation):** Im Kopf stehen „Status ändern" als Text und drei **Icons** ohne sichtbare Beschriftung (Dokument-Plus = Rechnung anlegen, Briefumschlag = E-Mail, Stift = bearbeiten). Die Namen existieren für Screenreader, aber sehende Nutzer müssen raten. Der Reiter „Kontakt & Vertrag" ist 2.150 px lang: sieben Karten, jede mit eigenem Stift, viele Felder mit „—" (Website, Telefon, Name und Anschrift der Rechnungsadresse). Die Karte „Aufnahmeformular" steht **vor** den Stammdaten, obwohl sie nur in der Anfragephase gebraucht wird. Screenshot 03.
- **Vorschlag:** Kopf: eine kontextabhängige Hauptaktion mit Text („Rechnung anlegen", „Instanz anlegen"), der Rest im Menü „Weitere ⋯" mit Text. Leere optionale Felder nicht als „—" zeigen, sondern „+ Website hinzufügen". „Rechnungsadresse: wie Stammdaten" als eine Zeile, außer sie weicht ab. Aufnahmeformular nur bei Status „Anfrage" und nach den Stammdaten. Die E-Rechnungs-Karte nur zeigen, wenn Empfängerart Behörde ist oder Leitweg-ID gesetzt.
- **Aufwand:** M
- **Nutzen:** Mittel bis hoch.
- **Dateien:** `pages/CompanyDetailPage.tsx`, `components/DetailBlock.tsx`, `components/PaymentDetailsCard.tsx`, `components/IntakeCard.tsx`

### 16. Rechnungsliste: Knopfzeile, Aktionsspalte, Organisationswahl
- **Problem (Rechnungen):** Zwei gleich schwere Knöpfe im Kopf: „Export für Betriebsprüfung" (selten) und „Rechnung bei einer Organisation anlegen" (häufig, aber lang, und er führt nur auf die Organisationsliste). Entwurfszeilen haben einen großen „Bearbeiten"-Knopf, andere Zeilen zwei Icons, bezahlte ein Auge. Drei Optiken in einer Spalte. Die Spalte „Organisation" ist kleiner gesetzt als Nummer und Betrag. Screenshot 05.
- **Vorschlag:** Hauptknopf „+ Rechnung" öffnet einen kleinen Dialog mit Organisationssuche („Für welche Organisation?") und springt in den Entwurf. Export als Sekundärknopf bzw. Menü. Aktionsspalte einheitlich: ein Hauptknopf je Status (Entwurf: „Bearbeiten", offen: „Zahlung", überfällig: „Zahlung"), Rest im Zeilenmenü. Organisationsname in Normalgröße.
- **Aufwand:** M
- **Nutzen:** Mittel. Spart bei „Rechnung anlegen" einen Seitenwechsel.
- **Dateien:** `pages/InvoicesPage.tsx` (Kopf, Zeilenaktionen), `components/CompanyPicker` (neu oder aus `RecipientSelectCard.tsx`)

### 17. Rechnungsdetail: drei fast gleiche Downloads, schwere Integritätskarte
- **Problem (Rechnungsdetail):** „PDF (ZUGFeRD)", „XML herunterladen" und „XRechnung (XML)" klingen nach demselben. Dazu steht ein Hinweis „Behörde: Bitte die XRechnung (XML) senden". Die Karte „Integrität und Aufbewahrung" (Prüfsumme, Aufbewahrungsfrist, Verlauf, Zeiten in UTC) füllt ein Drittel der Seite, obwohl das Ergebnis nur „geprüft" lautet. „Übertragung an die Buchhaltung – Noch nicht vermerkt – Vermerken" ist ohne Vorwissen unverständlich. Screenshot 06.
- **Vorschlag:** Ein Menü „Herunterladen ▾" mit Einträgen, die je einen Satz erklären („PDF mit eingebetteter Rechnungsdatei, für Unternehmen", „XRechnung, für Behörden"). Die empfohlene Variante je Empfängerart steht oben. Integrität als Badge in der Kopfzeile („Integrität geprüft"), Details und Verlauf eingeklappt, Zeiten in lokaler Zeit. Buchhaltung als Schalter „An Buchhaltung übergeben" mit Datum.
- **Aufwand:** M
- **Nutzen:** Mittel.
- **Dateien:** `pages/InvoiceDetailPage.tsx`, `components/InvoiceView.tsx`, `components/InvoiceIntegrity.tsx`, `components/InvoiceStatusBadge.tsx`

### 18. Instanzen: Liste ohne Aussage und ohne Einstieg
- **Problem (Instanzen):** Die Liste zeigt Name, Status, Organisation, Datum. Nützliche Betriebsdaten (Version, aktive Personen, letzte Sicherung) stehen nur im Organisationsdetail. Es gibt keinen Weg „Instanz anlegen" auf dieser Seite, nur über die Organisation. Organisationsnamen sind abgeschnitten.
- **Vorschlag:** Spalten „Version", „Personen", „Letzte Sicherung" (mit Warnpunkt bei überfällig). Filter „Nur mit Problemen". Knopf „+ Instanz" mit Organisationsauswahl wie in Punkt 16.
- **Aufwand:** M
- **Nutzen:** Mittel. Die Seite wird zur Betriebsübersicht statt zur Verknüpfungsliste.
- **Dateien:** `pages/InstancesPage.tsx`, `instances/instance.controller.ts` (Felder in der Liste)

### 19. Pflichtfelder und Prüfzustand in Dialogen sichtbar machen
- **Problem (Organisation anlegen, Instanz anlegen):** Im Organisationsdialog ist „Anlegen" grau und deaktiviert, solange der Name fehlt, ohne Hinweis, dass nur der Name Pflicht ist (alle fünf Felder sehen gleich aus). Im Instanzdialog erscheint „Diese Subdomain ist bereits vergeben." in Rot schon beim Öffnen, auf einem Vorschlag, den man nicht getippt hat; es wird kein Ersatz vorgeschlagen. In der Demo ohne Coolify gilt jede Subdomain als vergeben; dort wäre „Prüfung nicht möglich" die ehrlichere Meldung.
- **Vorschlag:** Pflicht kennzeichnen („Name der Organisation *", andere „(optional)"). Bei „vergeben" einen freien Ersatz vorschlagen („muster-testverein-2") und die Prüfung erst nach Eingabe oder Verlassen des Feldes melden. Die Meldung „Prüfung gerade nicht möglich" von „vergeben" trennen.
- **Aufwand:** S
- **Nutzen:** Mittel.
- **Dateien:** `components/CompanyCreateDialog.tsx`, `components/InstanceCreateDialog.tsx` (Status `unknown`/`taken`), `components/FormFields.tsx`

---

## P3: Feinschliff

### 20. Begriffe vereinheitlichen
- **Problem:** Dieselbe Handlung heißt „Zahlung erfassen" (Knopf), „Zahlung vermerken" (Dialogknopf), „Als bezahlt markieren" (Kommentar), „Vermerken" (Buchhaltung). Eine „Mahnung" gibt es nicht, nur „Erinnerung senden". Das ist für alle, die „Mahnung" suchen, nicht auffindbar. Weitere erklärungsbedürftige Wörter: „Festschreiben", „Posten", „Leitweg-ID", „Übernahme", „Kennzahlen", „Stellvertretung".
- **Vorschlag:** Ein Wort je Handlung (Zahlung erfassen überall). Knopf „Zahlungserinnerung senden" mit Untertitel „Mahnung", bei Bedarf später Mahnstufen. Kurze Hilfetexte (Info-Icon mit Tooltip) für Festschreiben („danach nicht mehr änderbar") und Leitweg-ID („Pflicht bei Behörden").
- **Aufwand:** S
- **Nutzen:** Mittel. Weniger Rückfragen, bessere Suche.
- **Dateien:** `i18n/locales/de/*`, `components/PaymentRecordDialog.tsx`, `InvoiceFinalizeDialog.tsx`

### 21. Zahlungsdialog: Teilzahlungslogik in Fließtext
- **Problem (Zahlung erfassen):** Der Dialog ist gut vorbelegt, erklärt aber in drei Zeilen, dass der Betrag der „kumulierte Gesamtstand" ist. Das ist die richtige Regel, aber schwer zu lesen.
- **Vorschlag:** Zwei Optionen: „Voll bezahlt (58,31 €)" als Vorauswahl, „Teilzahlung …" öffnet das Betragsfeld mit „Bisher bezahlt: 0,00 € · offen: 58,31 €".
- **Aufwand:** S
- **Nutzen:** Niedrig bis mittel.
- **Dateien:** `components/PaymentRecordDialog.tsx`

### 22. Sicherheitsprotokoll und Passkey-Zeile
- **Problem (Einstellungen, Sicherheit und Zugangsdaten):** Die Spalte „Von" zeigt `::ffff:127.0.0.1` und `::1` (rohes IPv6). „Neu abfragen" muss von Hand gedrückt werden. Die Zeile „Passkey – Nicht eingerichtet" verweist mit „In der Geräteliste verwalten" auf einen anderen Reiter, statt einen Knopf „Passkey hinzufügen" zu zeigen.
- **Vorschlag:** IPv4-gemappte Adressen als IPv4 zeigen; Protokoll beim Öffnen automatisch laden. Knopf „Passkey hinzufügen" direkt in der Zeile.
- **Aufwand:** S
- **Nutzen:** Niedrig bis mittel.
- **Dateien:** `components/SecurityLog.tsx`, `pages/SettingsPage.tsx` (Anmeldemethoden)

### 23. Rundmail: doppelte Hinweise, unklare Reiter
- **Problem (Rundmail):** Die Seite heißt „Rundmail", der erste Reiter „Rundmails" (listet aber Vorlagen). Über der Leerliste steht ein grünes Band mit Link „Einwilligungen", der denselben Reiter ein zweites Mal anbietet. Alle drei Reiter zeigen „0". Screenshot nicht beigelegt, die Seite ist sonst unauffällig.
- **Vorschlag:** Reiter umbenennen: „Vorlagen · Einwilligungen · Sperrliste". Das Band („Versand nur an bestätigte Einwilligungen") als einzeiliger Hinweis im Versanddialog statt als Dauerband. Zähler „0" ausblenden.
- **Aufwand:** S
- **Nutzen:** Niedrig bis mittel.
- **Dateien:** `pages/BroadcastPage.tsx`, `components/BroadcastTabs.tsx`

### 24. Kleine Schrift im Dunkel- und Hellmodus
- **Problem:** Sekundärtexte (Organisationsspalte in Rechnungen, Hinweise unter Feldern, Tabellenkopf) sind etwa 12 bis 13 px in Grau. Im Hellmodus noch lesbar, im Dunkelmodus an der Grenze. Die vorhandene Kontrast-Suite deckt Farbpaare ab, nicht die Kombination aus Größe und Grau.
- **Vorschlag:** Sekundärtext mindestens 13 px; Nutzdaten (Organisation, Datum) in der Zeilenfarbe statt in Sekundärgrau. Kontrastprüfung für Sekundärtext in beiden Modi in die Suite aufnehmen.
- **Aufwand:** S
- **Nutzen:** Niedrig bis mittel.
- **Dateien:** `lib/density.ts` (`tableText`), `packages/ui/src/tokens.css`

### 25. Kommandopalette um Aktionen erweitern
- **Problem:** Die Suche oben (⌘K) findet Organisationen. Häufige Aktionen („Neue Organisation", „Rechnung anlegen", „Zahlung erfassen") erreicht man nur über Navigation.
- **Vorschlag:** ⌘K zeigt unter der Suche drei bis fünf Aktionen und die zuletzt geöffneten Organisationen. Damit erreicht die Tastatur-Bedienung alle Hauptaufgaben ohne Maus.
- **Aufwand:** M
- **Nutzen:** Niedrig bis mittel (Vielnutzer, Tastatur).
- **Dateien:** `components/AppShell.tsx` (Suche), neue `components/CommandPalette.tsx`

---

## Empfohlene Reihenfolge der Umsetzung

1. **Schnellgewinne (je S, hoher Nutzen oder wenig Risiko):** 3 (Fehlertexte), 11, 12, 14, 19, 20.
2. **Alltagsweg Organisation, Instanz, Rechnung:** 1, 2, 5, 13, 16, danach 17.
3. **Lange Formulare:** 8 (Speicherleiste) zuerst, dann 6, 7, 10.
4. **Mobil:** 4, begleitend 13.
5. **Rest** nach Bedarf: 9, 15, 18, 21 bis 25.

Hinweis zur Abstimmung mit laufenden Arbeiten: Die Punkte 6, 9, 10 und 22 berühren die Oberflächen für Tresor und Anmeldung der Teile 2 und 3 des Plans. Sinnvoll ist, sie **nach** deren Fertigstellung umzusetzen, damit Einrichtung, Entsperren und Konten-/Zugriffsansichten gleich mit vereinfacht werden.
