import {
  Body,
  Controller,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { asActor } from './company.controller';
import type { PaymentDetailsResponse } from './company.response';
import { IntakeManagementService } from '../intake/intake-send.service';
import { CompanyService } from './company.service';
import {
  ContactDataDeleteDto,
  EvidenceDto,
  CompanyDeleteDto,
  PaymentDetailsDto,
} from './dto/company.dto';

/**
 * DIE HEIKLEN VORGÄNGE AN EINER ORGANISATION — hinter dem `SecondFactorGuard`.
 *
 * Warum es diesen Controller gibt: Für die alltägliche Arbeit trägt die
 * Begründung des `CompanyController` („Stammdaten zu ändern ist innerhalb
 * der Sitzung folgenlos für den Zugang"). Für zwei Dinge trägt sie NICHT:
 *
 * - ZAHLUNGSDATEN. Mit einem 25 Stunden alten Sitzungs-Cookie waren IBAN und
 *   SEPA-Mandat lesbar und änderbar. Eine geänderte Bankverbindung ist kein
 *   Stammdatum, sie ist der Zahlungsweg ([W4]).
 * - KONTAKTDATEN LÖSCHEN. Unumkehrbar. Mit einem erbeuteten Cookie ließe sich
 *   sonst der Kundenbestand entwerten.
 *
 * ALLE ROUTEN SIND POST ODER PATCH — auch das Anzeigen. Das ist Absicht: Der
 * `SecondFactorGuard` liest den Nachweis (`currentPassword` oder `totpCode`)
 * aus dem Body, und ein GET hat keinen. Ein „lesend, deshalb harmlos" wäre hier
 * genau die Ausnahme, die den Befund erst möglich gemacht hat. Wer die
 * Bankverbindung sehen will, weist sich aus.
 *
 * Ausnahme bleibt die FRISCHE Sitzung (unter zehn Minuten) — dieselbe Regel
 * wie am `ZugangController`, damit die Ersteinrichtung nicht in eine Sackgasse
 * läuft.
 */
@Controller('companies')
@UseGuards(SessionGuard, SecondFactorGuard)
export class CompanyConfidentialController {
  constructor(
    private readonly companies: CompanyService,
    private readonly intake: IntakeManagementService,
  ) {}

  /** Zeigt die Zahlungsdaten. Der Zugriff selbst steht im Audit-Log. */
  @Post(':id/payment-details/reveal')
  @HttpCode(200)
  // Der Nachweis lässt sich hier erraten wie an einer Anmelderoute.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async paymentDetails(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() _dto: EvidenceDto,
    @Req() req: Request,
  ): Promise<PaymentDetailsResponse> {
    return this.companies.paymentDetails(
      id,
      asActor(user),
      sourceFrom(req),
    );
  }

  /**
   * =======================================================================
   * DEN AUFNAHMELINK IM KLARTEXT ZEIGEN
   * =======================================================================
   *
   * HINTER DEM ZWEITEN FAKTOR, weil der Link zur IBAN-Erfassung führt: Wer
   * ihn hat, kann für diese Organisation Bankdaten hinterlegen. Dieselbe
   * Schwelle wie beim Einrichtungslink der Instanz.
   *
   * Er wird NEU ERZEUGT und zieht dabei einen offenen zurück — den alten
   * Klartext gibt es nicht mehr, er stand nur einmal zur Verfügung. Das ist
   * kein Mangel, sondern die Eigenschaft, die den Hash in der Datenbank
   * überhaupt sinnvoll macht.
   */
  @Post(':id/intake-link/reveal')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async intakeLinkReveal(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() _dto: EvidenceDto,
  ): Promise<{ link: string; expiresAt: string }> {
    return this.intake.showLink(id, asActor(user));
  }

  @Patch(':id/payment-details')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async paymentDetailsSet(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: PaymentDetailsDto,
    @Req() req: Request,
  ): Promise<PaymentDetailsResponse> {
    return this.companies.paymentDetailsSet(
      id,
      dto,
      asActor(user),
      sourceFrom(req),
    );
  }

  /**
   * Löscht die Kontaktdaten — von Hand ausgelöst, niemals automatisch (R4).
   *
   * Das ist die Handlung, auf die die Dashboard-Aufgabe „Löschung prüfen"
   * hinausläuft. Ohne sie wäre der Vorschlag eine Zusage, die niemand einlösen
   * kann.
   */
  @Post(':id/delete-contact-data')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async contactDataDelete(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: ContactDataDeleteDto,
    @Req() req: Request,
  ): Promise<{
    cleanedUpFields: string[];
    deletedNotes: number;
    rewrittenNotes: number;
  }> {
    return this.companies.contactDataDelete(
      id,
      dto.confirmation,
      asActor(user),
      sourceFrom(req),
    );
  }

  /**
   * Entfernt die Organisation vollständig — samt Notizen, Vorschauen und
   * Transaktionsmails.
   *
   * NUR SOLANGE NICHTS DARAN HÄNGT: keine Instanz, keine Rechnung, keine
   * werbliche Mail. Andernfalls antwortet der Dienst mit 409 und nennt ALLE
   * Hindernisse, nicht nur das erste. Die Begründung im Einzelnen steht an
   * `CompanyService.vollstaendigLoeschen`.
   *
   * WARUM ER HIER STEHT UND NICHT AM `CompanyController`: Die Löschung
   * ist unumkehrbar. Mit einem erbeuteten Sitzungs-Cookie ließe sich sonst der
   * halbe Bestand räumen — genau die Erwägung, die diesen Controller
   * überhaupt begründet.
   *
   * POST, NICHT DELETE. Der `SecondFactorGuard` liest den Nachweis aus dem
   * Body, und ein DELETE hat keinen.
   */
  @Post(':id/delete')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async delete(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: CompanyDeleteDto,
    @Req() req: Request,
  ): Promise<{
    name: string;
    deletedNotes: number;
    deletedPreviews: number;
    deletedSendRows: number;
    deletedConsents: number;
    detachedBlockEntries: number;
  }> {
    return this.companies.completeDelete(
      id,
      dto.confirmation,
      asActor(user),
      sourceFrom(req),
    );
  }
}
