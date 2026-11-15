import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { WithoutSecondFactor } from '../common/decorators/without-second-factor.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { AddressDto, UserDto, AccessDto } from './dto/user.dto';
import type { UserLine, AccessResult } from './user.service';
import { UserService } from './user.service';

/**
 * ===========================================================================
 * DIE NUTZERVERWALTUNG — alle können dasselbe
 * ===========================================================================
 *
 * ES GIBT GENAU EINE ROLLE. Wer hier Zugang hat, darf alles: festschreiben,
 * stornieren, sperren, löschen, weitere Konten anlegen. Das ist eine
 * ausdrückliche Entscheidung des Auftraggebers und keine Auslassung — ein
 * Betrieb mit zwei Personen braucht keine Rechteverwaltung, sondern
 * Vertrauen und einen Nachweis darüber, wer was getan hat. Den Nachweis gibt
 * es: das Audit-Log und sein Protokoll unter „Einstellungen → Sicherheit".
 *
 * WAS DAS BEDEUTET, STEHT AUCH IN DER OBERFLÄCHE. Wer jemanden einträgt,
 * gibt ihm dieselben Rechte, die er selbst hat — das darf keine Überraschung
 * sein.
 *
 * JEDE SCHREIBENDE ROUTE HINTER DEM ZWEITEN FAKTOR. Ein weiteres Konto
 * anzulegen ist die folgenreichste Handlung im System: Sie vergibt alles
 * andere gleich mit.
 */
@Controller('users')
@UseGuards(SessionGuard, SecondFactorGuard)
export class UserController {
  constructor(private readonly user: UserService) {}

  @Get()
  @WithoutSecondFactor(
    'Reines Lesen. Es geht kein Geheimnis heraus — keine Hashes, keine Token.',
  )
  async list(
    @LoggedInUser() user: SessionUser,
  ): Promise<UserLine[]> {
    return this.user.overview(user.id);
  }

  /**
   * Trägt ein weiteres Konto ein und gibt EINMALIG den Link zurück, mit dem
   * die eingetragene Person ihr Passwort setzt.
   *
   * WARUM NICHT GLEICH EIN PASSWORT SETZEN: Wer das Passwort einer anderen
   * Person kennt, kann in ihrem Namen handeln — und das Audit-Log schriebe
   * dann ihren Namen. Der Link führt an genau eine Stelle: „setze ein
   * Passwort für ein Konto, das noch keines hat". Dahinter gibt es nichts zu
   * sehen.
   *
   * ES GEHT KEINE MAIL HINAUS. Der Link wird angezeigt und von Hand
   * weitergegeben.
   */
  @Post()
  async register(
    @Body() dto: UserDto,
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<AccessResult> {
    return this.user.register(
      { name: dto.name, email: dto.email },
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }

  /** Ein neuer Zugangslink für ein Konto, das noch keines eingelöst hat. */
  @Post(':id/access-link')
  async newLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: AccessDto,
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<{ link: string; expiresAt: string }> {
    return this.user.newAccessLink(
      id,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }

  /**
   * Adresse eines Kontos OHNE Zugang berichtigen ([Review B1]).
   *
   * Der Link geht an die Administration, nicht an die Adresse — ein Tippfehler
   * fiele erst auf, wenn der Anmeldecode ins Leere geht, und war bisher nicht
   * zu beheben. Nur solange niemand angemeldet war; danach gehört die Adresse
   * der Person.
   */
  @Patch(':id/address')
  async address(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddressDto,
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<UserLine> {
    return this.user.correctAddress(
      id,
      dto.email,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }

  /**
   * Zugang entziehen oder wieder erteilen.
   *
   * EIN FELD `aktiv` STATT EINES `DELETE`. Gelöscht wird hier nichts (R4):
   * Ein gelöschtes Konto verlöre die Zuordnung seiner Audit-Einträge, und die
   * Frage „wer hat diese Rechnung festgeschrieben?" wäre nicht mehr zu
   * beantworten. Der Weg zurück sieht deshalb genauso aus wie der Weg hin.
   */
  @Patch(':id/access')
  async access(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AccessDto,
    @LoggedInUser() user: SessionUser,
    @Req() req: Request,
  ): Promise<UserLine> {
    return this.user.setAccess(
      id,
      dto.active === true,
      { userId: user.id, name: user.username },
      sourceFrom(req),
    );
  }
}
