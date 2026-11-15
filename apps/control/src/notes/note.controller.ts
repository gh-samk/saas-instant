import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { sourceFrom } from '../common/inquiry-source';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { asActor } from '../companies/company.controller';
import {
  NoteCreateDto,
  NoteUpdateDto,
  NoteHistoryDto,
} from './dto/note.dto';
import type { NoteResponse } from './note.service';
import { NoteService } from './note.service';

/**
 * Notizen zu Organisationen.
 *
 * Schutz wie beim `CompanyController`: Sitzung plus CSRF, kein
 * Zweitfaktor-Nachweis — die Begründung steht dort ausführlich.
 *
 * Systemerzeugte Notizen sind hier weder änderbar noch löschbar; das prüft der
 * Service, nicht die Oberfläche.
 */
@Controller('notes')
@UseGuards(SessionGuard)
export class NoteController {
  constructor(private readonly notes: NoteService) {}

  @Get()
  async history(
    @Query() filter: NoteHistoryDto,
  ): Promise<{ notes: NoteResponse[] }> {
    return { notes: await this.notes.history(filter.companyId) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @LoggedInUser() user: SessionUser,
    @Body() dto: NoteCreateDto,
    @Req() req: Request,
  ): Promise<NoteResponse> {
    return this.notes.create(dto, asActor(user), sourceFrom(req));
  }

  @Patch(':id')
  async update(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: NoteUpdateDto,
    @Req() req: Request,
  ): Promise<NoteResponse> {
    return this.notes.update(id, dto, asActor(user), sourceFrom(req));
  }

  @Delete(':id')
  @HttpCode(200)
  async delete(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ deleted: true }> {
    return this.notes.delete(id, asActor(user), sourceFrom(req));
  }
}
