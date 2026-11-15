import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { SubdomainQueryDto, SubdomainDto } from './dto/instance.dto';
import { InstanceService } from './instance.service';
import type { InstanceDetail, InstancePreviewResponse } from './instance.types';
import { ReconciliationService, type ReconciliationResult } from './reconciliation.service';
import { SetupStatusService } from './setup-status.service';
import { MetricsFetchService, type ErrorKind } from './metrics-fetch.service';

/**
 * Die Instanzverwaltung an der Organisation.
 *
 * SCHUTZ: `SessionGuard` auf Klassenebene plus der global registrierte
 * `CsrfGuard`. Kein `SecondFactorGuard` — die Abwägung steht in
 * `controller-protection.spec.ts` und ist dort abgenommen.
 *
 * ES GIBT HIER GENAU ZWEI SCHREIBENDE ROUTEN gegen eine Kundeninstanz:
 * `POST :id/instanz` (anlegen) und `POST :id/instanz/archivieren`. Kein
 * Löschen, kein Wiederherstellen, kein „erneut versuchen" — die dritte
 * Schreiboperation, die R1 nicht kennt, existiert auch nicht als Endpunkt.
 * `POST :id/instanz/vorschau` schreibt ausschliesslich in die EIGENE
 * Datenbank und ist der serverseitig erzwungene Pflichtschritt davor.
 */
@Controller('companies')
@UseGuards(SessionGuard)
export class InstanceController {
  constructor(
    private readonly instances: InstanceService,
    private readonly reconciliation: ReconciliationService,
    private readonly setup: SetupStatusService,
    private readonly metrics: MetricsFetchService,
  ) {}

  /**
   * Den Abgleich mit Coolify JETZT laufen lassen.
   *
   * WARUM ES DEN WEG BRAUCHT: Bis hierher lief der Abgleich ausschliesslich
   * naechtlich (`@Cron`). Wer etwas an der Zuordnung aenderte — eine Instanz
   * eintrug, ein eigenes Deployment aus der Waisenliste nahm —, sah das
   * Ergebnis fruehestens am naechsten Morgen. Die Karte auf „Heute" zeigte
   * derweil einen Befund, den es nicht mehr gab, und man fing an, ihr nicht
   * mehr zu glauben.
   *
   * KEIN ZWEITER FAKTOR. Der Lauf liest Coolify und schreibt einen
   * `AbgleichLauf`. Er aendert nichts an einer Instanz, stoesst kein
   * Deployment an und gibt keine Adresse heraus — dieselbe Abwaegung wie beim
   * uebrigen `InstanceController` ([W6]).
   *
   * NICHT AM `AufgabenController`, obwohl das Ergebnis dort erscheint: Der ist
   * ausdruecklich „ausschliesslich lesend und rein abgeleitet" (siehe
   * `controller-protection.spec.ts`). Eine Route, die einen Lauf ausloest, waere
   * dort das erste, was diese Zusage bricht.
   */
  @Post('reconciliation')
  async reconcile(
    @LoggedInUser() user: SessionUser,
  ): Promise<ReconciliationResult> {
    return this.reconciliation.executeFrom({
      actor: user.username,
      userId: user.id,
    });
  }

  /**
   * Die Instanz — vorher, falls nötig, einmal nachgesehen, ob sie inzwischen
   * eingerichtet ist (`SetupStatusService`). Das geschieht nur, solange
   * der Einrichtungslink nach bisherigem Stand offen wäre, und scheitert nie
   * laut: Im Zweifel zeigt die Karte den bisherigen Stand.
   */
  @Get(':id/instance')
  async detail(@Param('id') id: string): Promise<InstanceDetail | null> {
    await this.setup.check(id);
    return this.instances.get(id);
  }

  /**
   * Die Kennzahlen dieser einen Instanz JETZT abrufen.
   *
   * Sonst erschienen App-Version und Zahlen einer neuen Instanz frühestens um
   * 04:00 des Folgetags. Rein lesend gegen die Instanz (derselbe Endpunkt wie
   * der Tageslauf) — deshalb, wie der Abgleich, ohne zweiten Faktor ([W6]).
   */
  @Post(':id/instance/fetch-metrics')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async metricsFetch(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
  ): Promise<{ successful: boolean; errorKind: ErrorKind | null } | null> {
    return this.metrics.executeFromFor(id, {
      actor: user.username,
      userId: user.id,
    });
  }

  /** Der Vorschlag aus dem Organisationsnamen, für das leere Formularfeld. */
  @Get(':id/instance/subdomain-suggestion')
  async suggestion(@Param('id') id: string): Promise<{ subdomain: string }> {
    return this.instances.suggestion(id);
  }

  /**
   * Ist die Subdomain frei? Geprüft gegen CRM UND Coolify.
   *
   * Sie läuft VOR jeder Handlung — der Auftrag nennt den Grund: eine falsch
   * getippte Subdomain, die eine bestehende überschreibt, wäre bei voller
   * Automatik ein stiller Datenverlust.
   */
  @Get(':id/instance/subdomain-available')
  // Das Feld prüft bei jeder Eingabe; ein enges Limit machte die Anzeige
  // unbrauchbar. Die Route ist rein lesend und nur angemeldet erreichbar.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async available(
    @Param('id') _id: string,
    @Query() query: SubdomainQueryDto,
  ): Promise<{ available: boolean }> {
    return this.instances.checkSubdomain(query.value);
  }

  /**
   * PFLICHTSCHRITT VOR DEM ANLEGEN.
   *
   * Legt eine kurzlebige Vorschau-Zeile an, die `POST :id/instanz` atomar
   * verbraucht. Ohne sie geht dort nichts durch — damit ist die Vorschau eine
   * Eigenschaft des Servers und keine Höflichkeit der Oberfläche (E3-9).
   */
  @Post(':id/instance/preview')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async preview(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: SubdomainDto,
    @Req() req: Request,
  ): Promise<InstancePreviewResponse> {
    return this.instances.createPreview(
      id,
      dto.subdomain,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }

  /**
   * SCHREIBVORGANG 1 gegen eine Kundeninstanz: anlegen.
   *
   * Die Antwort kommt, sobald die Instanz-Zeile steht — der minutenlange
   * Coolify-Teil läuft danach im Hintergrund und ist über `GET :id/instanz`
   * verfolgbar.
   */
  @Post(':id/instance')
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async create(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: SubdomainDto,
    @Req() req: Request,
  ): Promise<InstanceDetail> {
    return this.instances.create(
      id,
      dto.subdomain,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }

  /**
   * „ERNEUT PRÜFEN": Antwortet eine ausgerollte Instanz inzwischen?
   *
   * KEIN SCHREIBVORGANG GEGEN COOLIFY — gefragt wird nur die Instanz selbst.
   * Ohne diese Route blieb eine Instanz, deren Zertifikat beim ersten
   * Health-Check noch unterwegs war, für immer auf `wird_erstellt`, obwohl
   * sie lief.
   */
  @Post(':id/instance/check-reachability')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async reachabilityCheck(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
  ): Promise<{ reachable: boolean }> {
    return this.instances.checkReachability(id, {
      userId: user.id,
      name: user.username,
    });
  }

  /**
   * VERWIRFT EINE GESCHEITERTE ERSTELLUNG ([W4]).
   *
   * KEIN SCHREIBVORGANG GEGEN COOLIFY — die Route ist überhaupt nur erlaubt,
   * wenn dort gar nichts entstanden ist. Sie gibt eine CRM-Zeile über einen
   * Vorgang auf, der nie stattgefunden hat, und macht damit den Weg für einen
   * neuen Versuch frei. Ohne sie ist eine gescheiterte Erstellung eine
   * Sackgasse: `wird_erstellt` bleibt stehen, und `Instanz.companyId`
   * ist unique.
   */
  @Post(':id/instance/discard')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async discard(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ discarded: true }> {
    return this.instances.discardCreation(
      id,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }

  /**
   * SCHREIBVORGANG 2 gegen eine Kundeninstanz: stoppen, Status setzen.
   *
   * NIEMALS LÖSCHEN. Es gibt keinen Endpunkt, der ein Deployment oder eine
   * Datenbank entfernt, und keinen, der eine Sicherung zurückspielt. Der
   * Sicherungsstand wird beim Archivieren GENANNT, nicht behauptet ([W2]).
   */
  @Post(':id/instance/archive')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async archive(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<InstanceDetail> {
    return this.instances.archive(
      id,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }
}
