# Sicherheitsrichtlinie / Security policy

*English summary: Please report vulnerabilities privately through GitHub Security
Advisories ("Report a vulnerability" on the Security tab of this repository). Do not open
public issues for security problems. Details below, in German.*

## Sicherheitslücken melden

Melde Sicherheitslücken **nicht** als öffentliches Issue und nicht per öffentlichem
Pull Request, sondern vertraulich über **GitHub Security Advisories**:

1. Im Repository den Reiter **Security** öffnen.
2. **Report a vulnerability** wählen (Advisories → „Report a vulnerability“).
3. Die Lücke beschreiben: betroffene Version oder Commit, Schritte zum Nachstellen,
   erwartete und tatsächliche Wirkung, wenn möglich ein Vorschlag zur Behebung.

Bitte **keine echten Zugangsdaten, Kundendaten oder Geheimnisse** in die Meldung
schreiben. Test- oder Beispielwerte genügen.

## Was danach geschieht

Wir bestätigen den Eingang so bald wie möglich, prüfen die Meldung, stimmen eine
Behebung im Advisory ab und veröffentlichen das Advisory erst, wenn eine
korrigierte Fassung vorliegt. Auf Wunsch nennen wir die meldende Person als
Entdecker. Eine feste Reaktionszeit können wir bei einem Projekt dieser Größe
nicht zusagen.

## Unterstützte Versionen

Sicherheitskorrekturen gibt es für den aktuellen Stand des Hauptzweigs. Ältere
Stände werden nicht gepflegt.

## Was in den Geltungsbereich gehört

Der Quelltext dieses Repositories: die Verwaltung (`apps/control`), das Portal
(`apps/portal`), die gemeinsamen Pakete, `install.sh`, `bin/saas-instant` und die
mitgelieferten Compose- und Konfigurationsdateien. Das Sicherheitsmodell und seine
Zusagen stehen in [docs/operations/security-model.md](docs/operations/security-model.md).

Nicht dazu gehören Schwachstellen in Fremdkomponenten (Coolify, PostgreSQL, Docker,
die verwaltete Software, ein separater Rechnungsdienst) und Fehlkonfigurationen der
eigenen Installation. Betrifft eine Meldung eine Abhängigkeit, ist der Hinweis
trotzdem willkommen, wenn dieses Projekt sie auf eine verwundbare Weise nutzt.
