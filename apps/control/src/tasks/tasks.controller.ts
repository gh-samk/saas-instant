import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../common/guards/session.guard';
import type { TasksResponse } from './tasks.service';
import { TasksService } from './tasks.service';
import { TasksQueryDto } from './dto/tasks.dto';

/**
 * Die Aufgaben des Dashboards. Ausschließlich LESEND — es gibt keinen
 * Endpunkt, der eine Aufgabe anlegt, abhakt oder speichert, weil es keine
 * gespeicherten Aufgaben gibt.
 *
 * Schutz: Sitzung. Begründung wie beim `CompanyController`.
 */
@Controller('tasks')
@UseGuards(SessionGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  async list(@Query() query: TasksQueryDto): Promise<TasksResponse> {
    return this.tasks.collect(query.since);
  }
}
