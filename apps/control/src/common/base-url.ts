import type { ConfigService } from '@nestjs/config';
import { APP_URL_DEFAULT } from './app-defaults';

/**
 * ===========================================================================
 * DIE ADRESSE, UNTER DER DIE VERWALTUNG ERREICHBAR IST — an EINER Stelle
 * ===========================================================================
 *
 * Sie steckt in jedem Link, den das Haus verschickt: im Bestätigungslink des
 * Double-Opt-in, im Abmeldelink jeder werblichen Mail, im Einladungslink eines
 * neuen Kontos und seit [A.34] im Verweis der Betreiber-Benachrichtigung.
 *
 * WARUM DAS EINE EIGENE DATEI RECHTFERTIGT. Dieselben fünf Zeilen standen
 * bereits ZWEIMAL — in `einwilligung.service.ts` und in
 * `benutzer.service.ts`. Die zweite Abschrift begründet im eigenen Kommentar,
 * warum das gefährlich ist: „Zwei Konfigurationswerte fuer dieselbe Adresse
 * liefen unweigerlich auseinander, und dann zeigte der eine Link ins Leere."
 * Das Argument stimmt — es galt nur schon für die Abschrift selbst. Eine
 * dritte hätte den Satz endgültig zur Ironie gemacht.
 *
 * WARUM EINE FUNKTION UND KEIN DIENST. Sie hat keinen Zustand, keine
 * Abhängigkeit ausser dem Konfigurationsleser und keine Entscheidung zu
 * treffen. Als Dienst brauchte jedes Modul, das sie benutzt, einen Eintrag in
 * seiner Providerliste — und `OeffentlichService` bekäme eine Verdrahtung
 * dafür, dass er eine Zeichenkette zusammensetzt.
 *
 * DIE VORRANGREGEL: `CONTROL_MAIL_BASE_URL` schlägt `CONTROL_APP_URL`. Das
 * ist kein Zufall, sondern der Fall, in dem die Oberfläche intern anders
 * erreichbar ist als von aussen — dann trägt die Mail die öffentliche
 * Adresse, und nur sie.
 */
export function baseUrl(config: ConfigService): string {
  const raw =
    config.get<string>('CONTROL_MAIL_BASE_URL') ??
    config.get<string>('CONTROL_APP_URL', APP_URL_DEFAULT);
  // Ohne Schrägstrich am Ende: Jeder Aufrufer hängt einen eigenen an, und
  // `https://host//api/…` ist zwar meist harmlos, aber nirgends richtig.
  return raw.replace(/\/+$/, '');
}

/**
 * Der Verweis auf EINE Organisation in der Verwaltungsoberfläche.
 *
 * Der Pfad entspricht der Route in `App.tsx` (`/companies/:id`). Er steht
 * hier und nicht im Aufrufer, damit eine Umbenennung der Route genau eine
 * Stelle trifft — und damit `basis-url.spec.ts` ihn gegen den Router halten
 * kann.
 */
export function companyUrl(config: ConfigService, id: string): string {
  return `${baseUrl(config)}/companies/${id}`;
}
