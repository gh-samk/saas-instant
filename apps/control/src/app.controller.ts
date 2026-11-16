import { readFileSync } from 'fs';
import { join } from 'path';
import { Controller, Get, Header } from '@nestjs/common';
import { APP_VERSION } from './version';
import { AllowWhileLocked } from './vault/allow-while-locked.decorator';
import { VaultService, type VaultState } from './vault/vault.service';

/**
 * Bauzeitpunkt aus der Datei, die das Image mitbringt (apps/control/Dockerfile).
 * Coolify liefert bei Compose-Deployments weder Commit noch Bauzeitpunkt von
 * allein; den Commit setzt, wer ausrollt, den Zeitpunkt schreibt das Image.
 *
 * EINMAL beim Start gelesen — der Wert ändert sich zur Laufzeit nie.
 */
function buildTimeFromFile(): string | null {
  try {
    return readFileSync(join(__dirname, '..', 'BUILD_TIME'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const BUILD_TIME = buildTimeFromFile();

@Controller()
export class AppController {
  constructor(private readonly vault: VaultService) {}

  /**
   * Reines Lebenszeichen für Healthchecks im Container.
   *
   * BEWUSST OHNE JEDEN ZUSTAND. Der Endpunkt hat keinen Guard und wird von
   * nginx unter `/api/` nach außen durchgereicht — alles, was hier steht, ist
   * anonym abfragbar.
   *
   * Vorher meldete er den Stand des Postausgangs. Damit war der
   * Aufzählungskanal wieder offen, den die Einheitsantwort der
   * Anforderungsroute gerade geschlossen hatte: `letzterFehler.zeitpunkt`
   * änderte sich genau dann, wenn ein Versand versucht wurde — also genau dann,
   * wenn das Konto existiert UND den E-Mail-Faktor eingerichtet hat. Wer die
   * Anforderung auslöste und danach hier nachsah, bekam sein Ja/Nein. Zusätzlich
   * ging die rohe Relay-Meldung hinaus, in der bei einer Empfängerabsage die
   * Zustelladresse des zweiten Faktors steht ([K2]).
   *
   * Der Mailstand liegt jetzt hinter der Sitzung: `GET /api/zugang/postausgang`.
   */
  @AllowWhileLocked(
    'Betrieb und Monitoring: meldet gerade den Tresor-Zustand und liest keine Kundendaten.',
  )
  @Get('health')
  async health(): Promise<{ status: VaultState }> {
    // Einziger Zustand, den der Endpunkt verrät: ob der Tresor entsperrt ist.
    // Das Monitoring braucht ihn ("locked" nach einem Neustart = jemand muss
    // entsperren), er sagt nichts über Daten oder Konten. HTTP 200 bleibt in
    // jedem Zustand, damit der Container-Healthcheck nicht neu startet.
    return { status: await this.vault.state() };
  }

  /**
   * Welcher Stand läuft hier? — für Betrieb und Fehlersuche.
   *
   * BEWUSST OHNE SITZUNG, wie in der Kundenanwendung. Der Nutzen liegt genau
   * dort, wo man sich NICHT anmelden kann: nach einem Ausrollen prüfen, ob der
   * neue Stand wirklich steht. Wäre der Endpunkt geschützt, fehlte die Auskunft
   * im Störungsfall.
   *
   * WAS ER PREISGIBT, IST ABGEWOGEN: Fassung, Commit und Bauzeitpunkt. Das ist
   * KEIN Aufzählungskanal — anders als der Mailstand, der aus gutem Grund hinter
   * die Sitzung gewandert ist (siehe `gesundheit` oben): Diese Werte hängen an
   * keinem Konto und ändern sich nur beim Ausrollen. Das Repository ist privat,
   * ein Commit-Abdruck also nicht auf Quelltext abbildbar.
   *
   * `||` statt `??`: Ein LEER gesetztes APP_GIT_SHA ist nicht `undefined` —
   * genau daran zeigte die Kundenanwendung lange einen leeren Commit.
   */
  @AllowWhileLocked('Fassung, Commit und Bauzeitpunkt; keine Datenbankzugriffe.')
  @Get('version')
  version(): { version: string; commit: string; builtAt: string | null } {
    return {
      version: APP_VERSION,
      commit: process.env.APP_GIT_SHA || 'dev',
      builtAt: process.env.APP_BUILD_TIME || BUILD_TIME,
    };
  }
}

/**
 * `/robots.txt` liegt bewusst AUSSERHALB des Präfixes `/api` — Suchmaschinen
 * fragen die Datei immer in der Wurzel ab.
 */
@AllowWhileLocked('Statischer Text ohne Datenbankzugriff.')
@Controller()
export class RobotsController {
  @Get('robots.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  robots(): string {
    return 'User-agent: *\nDisallow: /\n';
  }
}
