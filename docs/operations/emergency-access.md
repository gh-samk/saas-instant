# Notfallzugang

Wenn ein Anmeldemittel verloren geht, gibt es keinen Selbstbedienungsweg: kein
„Passwort vergessen“ per E-Mail und keine Konto-Wiederherstellung durch Dritte.
Der E-Mail-Anmeldecode ändert daran nichts. Er ist ein zweiter **Faktor** und
setzt das Passwort voraus, statt es zu ersetzen. Wer Zugriff auf den Container
der Verwaltung hat, hilft mit vier Kommandos aus.

Alle Kommandos schreiben ins Audit-Log, mit dem Akteur `cli:<OS-Benutzer>`.
Die Links werden beim Erzeugen **und** beim Einlösen protokolliert (Regel R6).

## Aufruf

Je Verwaltung läuft ein Container `control-api`. Im Projektverzeichnis:

```bash
# über das Hilfsprogramm (<slug> = Kennung der Verwaltung, siehe `saas-instant list`)
bin/saas-instant emergency <slug> enrollment <kennung>

# oder direkt mit Docker Compose
docker compose exec control-api node dist/cli/emergency.js enrollment <kennung>
```

Bei einer Installation mit eigener `.env` je Verwaltung gehört
`--env-file installations/<slug>/.env` zum `docker compose`-Aufruf; das
Hilfsprogramm erledigt das.

`<kennung>` ist der **Benutzername oder die E-Mail-Adresse** des Kontos. Ohne
Argumente gibt das Kommando seine Hilfe aus.

## Wann welches Kommando

Ein **bekanntes** Passwort braucht keines der Kommandos: Es ändert sich in der
Oberfläche unter Einstellungen. Die Kommandos sind für den Fall, dass der Zugang
selbst fehlt.

| Lage | Kommando |
|---|---|
| Es gibt noch gar kein Konto (frische Installation) | `first-account` |
| Passwort vergessen | `password` |
| Neues Gerät soll einen Passkey bekommen und der bisherige Zugang fehlt | `enrollment` |
| Passkey und Authenticator-App verloren, Wiederherstellungscodes aufgebraucht | `enrollment` |
| Fünf Fehlversuche, die 15 Minuten Sperre soll sofort enden | `unlock` |

## `first-account <email> <name>`

Legt das **allererste Konto** einer leeren Verwaltung an (Rolle `owner`) und gibt
einen einmaligen, 15 Minuten gültigen Passkey-Link aus. Alles nach der Adresse
gilt als Name, Anführungszeichen sind nicht nötig.

Der Weg steht **nur einer leeren Verwaltung** offen. Sobald ein einziges Konto
existiert, auch ein deaktiviertes, verweigert das Kommando den Dienst. Damit
lässt er sich später nicht als Hintertür benutzen.

Es erzeugt bewusst einen **Passkey-Link**, keinen Passwort-Link. Der Passkey
ersetzt Passwort und zweiten Faktor zugleich, das erste Konto kommt damit hinein,
**bevor** der Mailversand eingerichtet ist. Ein Passwort-Link führte in eine
Sackgasse: Nach dem Passwort verlangt die Anmeldung einen zweiten Faktor, und der
erste wäre der E-Mail-Code.

`pnpm --filter @saas-instant/control seed` ist nur für die Entwicklung. Der Seed
läuft nur mit `CONTROL_SEED_ALLOWED=ja` und bricht bei `NODE_ENV=production` ab,
bevor er etwas schreibt.

## `enrollment <kennung>`

Erzeugt einen **einmaligen, 15 Minuten gültigen** Link auf
`/emergency-enrollment?token=…` und gibt ihn auf stdout aus.

Im Browser geöffnet, legt der Link einen Passkey an. Danach ist der Link
verbraucht, die Sitzung steht, und die Oberfläche führt in die Ersteinrichtung
weiter (Authenticator-App, Passkey, Wiederherstellungscodes).

> Ein Passkey kann nur im Browser entstehen. Er ist an das Gerät und dessen
> Sicherheitschip gebunden, der private Schlüssel verlässt das Gerät nie. Ein
> Kommando im Container kann deshalb keinen Passkey anlegen, es öffnet nur den
> Weg dorthin. Der Link muss auf **dem Gerät** geöffnet werden, auf dem der
> Passkey liegen soll.

## `password <kennung>`

Erzeugt einen **einmaligen, 15 Minuten gültigen** Link auf
`/emergency-password?token=…`. Im Browser zeigt er ein Formular „Neues Passwort
setzen“ mit Stärkeanzeige und Countdown. Läuft der Countdown ab, wechselt die
Seite in „Link ungültig“. Nach dem Absenden ist der Link verbraucht.

Zwei Dinge sind Absicht:

- Das Kommando nimmt **kein Passwort entgegen** und gibt **keines aus**. Ein
  Passwort läuft nie über Terminal, stdout oder Container-Logs. Das einzige
  Geheimnis auf stdout ist der Link, und der lebt 15 Minuten.
- Das Setzen des Passworts erzeugt **keine Sitzung**. Danach folgt die reguläre
  Anmeldung mit Passwort **und** zweitem Faktor. Ein Passwort-Link allein ist nie
  ein vollständiger Zugang.

Zusätzlich entwertet das Setzen alle Merk-Geräte.

## `unlock <kennung>`

Setzt Fehlversuchszähler und Kontosperre sofort zurück und meldet, ob das Konto
überhaupt gesperrt war. Es erzeugt weder Link noch Geheimnis. Die Sperre
(5 Fehlversuche, 15 Minuten) endet ohnehin von selbst. Das Kommando ist die
Abkürzung für alle, die nicht warten wollen.

## Hinweise für den Betrieb

- Die Links enthalten die Adresse aus `CONTROL_APP_URL`. Stimmt sie nicht, zeigt
  der Link ins Leere.
- Wer Zugriff auf den Container hat, kommt über `enrollment` an jedes Konto. Der
  Zugriff auf den Server ist damit der eigentliche Schlüssel und gehört
  entsprechend geschützt (siehe [security-model.md](security-model.md)).
- Links nicht in Chats oder Tickets kopieren. Sie sind bis zur Einlösung ein
  vollständiges Geheimnis.
