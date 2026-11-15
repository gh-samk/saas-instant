# Pflichtangaben auf Rechnungen je Rechtsform

Stand der Zusammenstellung: November 2026. **Keine Rechtsberatung.** Die Software prüft, ob die hier genannten Angaben hinterlegt sind, bevor eine Rechnung festgeschrieben wird. Ob die Angaben für Ihren Fall genügen, klären Sie mit Ihrer Steuerberatung.

## Für alle Rechtsformen (§ 14 Abs. 4 UStG)

| Angabe | Hinweis |
| --- | --- |
| Vollständiger Name und Anschrift der Ausstellerin | Firma wie im Register (mit Rechtsformzusatz) |
| Steuernummer **oder** USt-IdNr. | mindestens eine von beiden; bei Kleinunternehmerregelung (§ 19 UStG) genügt die Steuernummer plus Hinweis |
| Bankverbindung (IBAN) | für Überweisung; BIC optional |
| Ansprechangaben (Telefon, E-Mail, Web) | optional, gedruckt wenn hinterlegt |

Empfänger, Rechnungsnummer, Datum, Leistungszeitraum, Menge/Art, Entgelt, Steuersatz und -betrag stammen aus der Rechnung selbst.

## Zusätzlich je Rechtsform (Geschäftsbriefangaben)

| Rechtsform | Zusätzliche Pflichtangaben | Rechtsgrundlage |
| --- | --- | --- |
| **Einzelunternehmen** (nicht eingetragen), Freiberuflerin | Vor- und Nachname der Inhaberin | § 14 Abs. 4 Nr. 1 UStG |
| **Einzelunternehmen, eingetragen (e.K.)** | Firma mit Zusatz „e.K.", Sitz, Registergericht, HRA-Nummer | § 37a HGB, § 19 HGB |
| **GbR** | Name der GbR und Namen der Gesellschafter (mindestens eine Person); bei eingetragener GbR (eGbR): Zusatz „eGbR", Registergericht und Registernummer | § 14 UStG, § 707a BGB |
| **OHG** | Rechtsform, Sitz, Registergericht, HRA-Nummer | § 125a HGB, § 37a HGB |
| **GmbH** | Rechtsform, Sitz, Registergericht, HRB-Nummer, **alle** Geschäftsführer mit Familienname und mindestens einem ausgeschriebenen Vornamen, ggf. Vorsitz des Aufsichtsrats; bei Angabe des Stammkapitals auch die ausstehenden Einlagen; Hinweis bei Liquidation | § 35a GmbHG |
| **UG (haftungsbeschränkt)** | wie GmbH; Firma mit „UG (haftungsbeschränkt)" oder „Unternehmergesellschaft (haftungsbeschränkt)" | § 35a GmbHG, § 5a GmbHG |
| **GmbH & Co. KG** | für die KG: Rechtsform, Sitz, Registergericht, HRA-Nummer; **zusätzlich für die Komplementär-GmbH**: Firma, Rechtsform, Sitz, Registergericht, HRB-Nummer, alle Geschäftsführer (wie bei der GmbH), ggf. Vorsitz des Aufsichtsrats | § 125a Abs. 1 und 2 HGB, § 177a HGB |
| **eG** | Rechtsform, Sitz, Registergericht, Nummer im Genossenschaftsregister (GnR), **alle** Vorstandsmitglieder, Vorsitzende oder Vorsitzender des Aufsichtsrats (falls vorhanden) mit Familienname und mindestens einem ausgeschriebenen Vornamen | § 25a GenG |
| **e.V.** | Name mit Zusatz „e.V.", Sitz, Registergericht, Vereinsregisternummer, vertretungsberechtigter Vorstand | § 65 BGB, § 26 BGB. Eine ausdrückliche Geschäftsbriefpflicht wie im HGB gibt es für Vereine nicht; die Software verlangt die Angaben dennoch, weil sie üblich und zur Identifikation hilfreich sind |

## Umsetzung

Die Pflichtfelder sind je Rechtsform in `packages/shared/src/issuer-profile.ts` als Tabelle hinterlegt. Die Verwaltung prüft sie beim **Festschreiben** einer Rechnung. Fehlt etwas, wird nicht festgeschrieben, und die Meldung nennt jedes fehlende Feld. Die Angaben werden unter Einstellungen → Firmendaten gepflegt.

## Automatische Prüfung

Die Ende-zu-Ende-Suite `invoice` (`tests/e2e/`, siehe dortige README) prüft für jede Rechtsform der Tabelle oben, dass ein unvollständiges Profil das Festschreiben mit genau den fehlenden Feldern blockiert und dass das fertige PDF und das eingebettete XML alle Pflichtzeilen enthalten. Die erwarteten Zeilen stehen dort von Hand, nicht aus dem Produktcode berechnet; ändert sich diese Tabelle, müssen `tests/e2e/invoice/fixtures.mjs` und `packages/shared/src/issuer-profile.ts` gemeinsam angepasst werden.
