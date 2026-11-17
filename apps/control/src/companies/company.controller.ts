import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { CompanyStatus } from '.prisma/control-client';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import type {
  CompanyResponse,
  CompanyShort,
} from './company.response';
import {
  IntakeManagementService,
  type IntakeLinkSend,
} from '../intake/intake-send.service';
import { CompanyService, type Actor } from './company.service';
import type { InquiriesResponse } from './company.response';
import {
  ContactPersonChangeDto,
  CompanyCreateDto,
  CompanyUpdateDto,
  CompanyListDto,
  StatusChangeDto,
} from './dto/company.dto';

/**
 * Organisationen der Verwaltung.
 *
 * SCHUTZ: `SessionGuard` auf Klassenebene, dazu der global registrierte
 * `CsrfGuard` für alle schreibenden Routen und `SameSite=Strict` am
 * Sitzungs-Cookie.
 *
 * BEWUSST OHNE `SecondFactorGuard` — anders als am `ZugangController`. Der
 * Unterschied ist nicht Bequemlichkeit, sondern Gegenstand: am
 * `ZugangController` hängen die Routen, die den ZUGANG SELBST ändern (Passkey
 * anlegen, Faktor entfernen, Passwort setzen). Wer sie mit einem erbeuteten
 * Cookie erreicht, übernimmt das Konto dauerhaft — deshalb dort der erneute
 * Nachweis. Organisationsdaten zu ändern ist innerhalb der Sitzung folgenlos
 * für den Zugang, vollständig im Audit-Log nachvollziehbar (R6) und über die
 * Notizen sichtbar. Verlangte man hier alle zehn Minuten wieder das Passwort,
 * wäre die tägliche Arbeit unmöglich — und die Betreiberin gewöhnte sich an,
 * ihr Passwort auf Zuruf einzutippen. Das ist das schlechtere Ergebnis.
 *
 * `controller-schutz.spec.ts` zählt alle Controller auf und lässt keinen ohne
 * Entscheidung durch.
 */
@Controller('companies')
@UseGuards(SessionGuard)
export class CompanyController {
  constructor(
    private readonly companies: CompanyService,
    private readonly intake: IntakeManagementService,
  ) {}

  @Get()
  async list(@Query() filter: CompanyListDto): Promise<{
    companies: CompanyShort[];
    total: number;
    page: number;
    perPage: number;
    countPerStatus: Record<CompanyStatus, number>;
  }> {
    return this.companies.list(filter);
  }

  @Post()
  @HttpCode(201)
  async create(
    @LoggedInUser() user: SessionUser,
    @Body() dto: CompanyCreateDto,
    @Req() req: Request,
  ): Promise<CompanyResponse> {
    return this.companies.create(dto, asActor(user), sourceFrom(req));
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<CompanyResponse> {
    return this.companies.detail(id);
  }

  /** Was die Organisation über die Webseite angefragt hat und was passierte. */
  @Get(':id/inquiries')
  async inquiries(@Param('id') id: string): Promise<InquiriesResponse> {
    return this.companies.inquiries(id);
  }

  @Patch(':id')
  async update(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: CompanyUpdateDto,
    @Req() req: Request,
  ): Promise<CompanyResponse> {
    return this.companies.update(
      id,
      dto,
      asActor(user),
      sourceFrom(req),
    );
  }

  /**
   * Statuswechsel — eigener Endpunkt, weil jeder Wechsel Spuren hinterlässt.
   *
   * DIE ANTWORT TRÄGT DAS VERSANDERGEBNIS mit: Beim Wechsel auf
   * `trial` geht der Aufnahmelink automatisch hinaus, und die
   * Oberfläche soll EINMAL sagen können, ob er ankam und an welche Adresse.
   * `null` heisst: Bei diesem Wechsel war nichts zu versenden.
   */
  @Post(':id/status')
  @HttpCode(200)
  async statusChange(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: StatusChangeDto,
    @Req() req: Request,
  ): Promise<CompanyResponse & { intakeLink: IntakeLinkSend | null }> {
    return this.companies.statusChange(
      id,
      dto.status,
      asActor(user),
      sourceFrom(req),
    );
  }

  /** Ersetzt die Ansprechpartnerin und schreibt die Wechselnotiz. */
  /**
   * Zustand des Aufnahmezugangs — OHNE zweiten Faktor.
   *
   * Er nennt NIE den Token, sondern nur, ob ein Zugang offen ist, bis wann
   * und wie oft er hinausging. Das ist dasselbe, was ohnehin im Verlauf und
   * im Audit-Log steht; ein zweiter Faktor davor schützte nichts.
   */
  @Get(':id/intake-access')
  async intakeAccess(@Param('id') id: string) {
    return this.intake.state(id);
  }

  /**
   * Schickt den Aufnahmelink noch einmal an die HINTERLEGTE Adresse.
   *
   * KEIN zweiter Faktor: Die Betreiberin erfährt dabei nichts, was sie nicht
   * schon weiss, und die Mail geht an eine Adresse, die bereits im Datensatz
   * steht — sie lässt sich nicht umlenken. Wer den Link SEHEN will, braucht
   * ihn (`/aufnahmelink/anzeigen`).
   */
  @Post(':id/intake-link/send')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async intakeLinkSend(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
  ) {
    return this.intake.sendAgain(id, asActor(user));
  }

  @Post(':id/contact-person')
  @HttpCode(200)
  async contactPersonChange(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: ContactPersonChangeDto,
    @Req() req: Request,
  ): Promise<CompanyResponse> {
    return this.companies.contactPersonChange(
      id,
      dto,
      asActor(user),
      sourceFrom(req),
    );
  }
}

/** Der Akteur kommt aus der Sitzung, niemals aus dem Body. */
export function asActor(user: SessionUser): Actor {
  return { userId: user.id, name: user.username };
}
