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

Wir haben die Absicht, den Eingang zeitnah zu bestätigen, die Meldung zu prüfen,
eine Behebung im Advisory abzustimmen und das Advisory erst zu veröffentlichen,
wenn eine korrigierte Fassung vorliegt. Auf Wunsch nennen wir die meldende Person
als Entdecker. Das ist eine Absicht und keine Zusage: Eine feste Reaktionszeit
können wir bei einem Projekt dieser Größe nicht garantieren. Weitere Meldewege
(Telefon, E-Mail) gibt es nicht; bitte nur den oben beschriebenen Weg nutzen.

## Unterstützte Versionen

Sicherheitskorrekturen gibt es für den aktuellen Stand des Hauptzweigs. Ältere
Stände werden nicht gepflegt.

## Was in den Geltungsbereich gehört

Der Quelltext dieses Repositories: die Verwaltung (`apps/control`), das Portal
(`apps/portal`), der Backup-Agent (`apps/backup-agent`), die gemeinsamen Pakete, `install.sh`, `bin/saas-instant` und die
mitgelieferten Compose- und Konfigurationsdateien. Das Sicherheitsmodell und seine
Zusagen stehen in [docs/operations/security-model.md](docs/operations/security-model.md).

Besonders willkommen sind Meldungen zum Backup-Agent (Signatur der Aufträge,
Umgang mit Zugangsdaten und dem privaten Schlüssel, Grenzen des Docker-Zugriffs).

Nicht dazu gehören Schwachstellen in Fremdkomponenten (Coolify, PostgreSQL, Docker,
die verwaltete Software, ein separater Rechnungsdienst) und Fehlkonfigurationen der
eigenen Installation. Betrifft eine Meldung eine Abhängigkeit, ist der Hinweis
trotzdem willkommen, wenn dieses Projekt sie auf eine verwundbare Weise nutzt.
