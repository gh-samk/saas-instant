import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { asActor } from './invoice.controller';
import { TransferDto, PaymentDto } from './dto/invoice.dto';
import { PaymentService } from './payment.service';
import type { InvoiceResponse } from './invoice.response';

/**
 * DER ZAHLUNGSSTAND — hinter dem `SecondFactorGuard`.
 *
 * ===========================================================================
 * WARUM HIER UND NICHT AM `InvoiceController`
 * ===========================================================================
 *
 * Der `OrganisationVertraulichController` aus Etappe 2 zeigt das Muster und
 * nennt das Kriterium: Zahlungsdaten und unumkehrbare Vorgänge gehören hinter
 * einen zweiten Faktor, alltägliche Arbeit nicht. Für Rechnungen fällt die
 * Abwägung so aus:
 *
 * BELEGE ANLEGEN, FESTSCHREIBEN, STORNIEREN bleiben ohne zweiten Faktor. Nicht
 * weil sie harmlos wären — sie sind es nicht —, sondern weil jeder dieser
 * Vorgänge ein DOKUMENT hinterlässt: eine Rechnungsnummer, eine Systemnotiz im
 * Verlauf, einen Audit-Eintrag, und bei einem Storno zwei Belege, die beide
 * bestehen bleiben. Wer damit Schaden anrichtet, hinterlässt Spuren, die beim
 * nächsten Blick auf die Organisation ins Auge fallen.
 *
 * DER ZAHLUNGSSTAND HINTERLÄSST KEINES. Wer mit einem erbeuteten Sitzungs-
 * Cookie offene Rechnungen als „bezahlt" markiert, erzeugt kein Dokument,
 * keine Notiz und keine Nummer — er löscht lautlos Forderungen aus der
 * Übersicht. Die Dashboard-Aufgabe „überfällig" verschwindet gleich mit, weil
 * sie abgeleitet ist. Das ist genau die Sorte stiller Wirkung, gegen die der
 * zweite Faktor steht ([W4]).
 *
 * ALLE ROUTEN SIND POST. Das ist Absicht und dieselbe Begründung wie am
 * `OrganisationVertraulichController`: Der `SecondFactorGuard` liest den
 * Nachweis (`currentPassword` oder `totpCode`) aus dem Body, und ein GET hat
 * keinen. Die Ausnahme für eine FRISCHE Sitzung (unter zehn Minuten) gilt auch
 * hier — wer gerade eine Zahlung nach der anderen abhakt, tippt sein Passwort
 * einmal und nicht zehnmal.
 *
 * ES GIBT HIER KEINEN KONTOABGLEICH. Kein SEPA-XML, keine Bankschnittstelle,
 * kein automatischer Abgleich — ausdrücklich nicht Teil dieses Systems. Was
 * hier hereinkommt, hat ein Mensch von einem Kontoauszug abgetippt.
 */
@Controller('invoices')
@UseGuards(SessionGuard, SecondFactorGuard)
export class InvoicePaymentController {
  constructor(private readonly payments: PaymentService) {}

  /**
   * Vermerkt den KUMULIERTEN Zahlungsstand.
   *
   * `paidAmountCent` ist der Gesamtstand, nicht die einzelne
   * Überweisung: Zwei Teilzahlungen ergeben zwei Aufrufe mit steigendem
   * Betrag. Ein Modell mit Einzelbuchungen bräuchte einen Weg, eine falsch
   * erfasste Buchung zurückzunehmen — also einen Löschpfad an einem Beleg.
   */
  @Post(':id/payment')
  @HttpCode(200)
  // Der Nachweis lässt sich hier erraten wie an einer Anmelderoute.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async payment(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: PaymentDto,
    @Req() req: Request,
  ): Promise<InvoiceResponse> {
    return this.payments.note(
      id,
      dto.paymentDate,
      dto.paidAmountCent,
      asActor(user),
      sourceFrom(req),
      dto.expectedPaidCent,
    );
  }

  /**
   * Vermerkt die Übertragung an die Buchhaltung.
   *
   * KEINE lexoffice- und KEINE sevDesk-Schnittstelle — ausdrücklich nicht
   * gebaut. Der Auftraggeber überträgt die Belege von Hand und hält hier fest,
   * dass er es getan hat. Steht hinter dem zweiten Faktor, weil ein falscher
   * Vermerk „ist übertragen" dieselbe stille Wirkung hätte wie ein falsches
   * „ist bezahlt": Der Beleg verschwindet aus der Liste dessen, was noch zu
   * tun ist.
   */
  @Post(':id/transfer')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async transfer(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: TransferDto,
    @Req() req: Request,
  ): Promise<InvoiceResponse> {
    return this.payments.noteTransfer(
      id,
      dto.transferStatus,
      asActor(user),
      sourceFrom(req),
    );
  }
}
