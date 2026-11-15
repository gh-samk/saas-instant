import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../common/guards/session.guard';
import { InstanceService } from './instance.service';
import type { InstanceListenEntry } from './instance.types';

/**
 * Die Übersicht aller Instanzen — der Menüpunkt „Instanzen".
 *
 * NUR LESEND, hinter der Sitzung. Er zeigt Subdomain, Status und
 * Organisation und führt in den Reiter „Instanz" der jeweiligen
 * Organisation; alles, was dort geschieht (anlegen, archivieren,
 * Einrichtungslink), bleibt dort und hinter den Schranken, die es dort hat.
 *
 * Ein eigener Controller unter `/instances`, weil der bestehende
 * `InstanceController` unter `/companies/:id/instanz` hängt — eine Liste
 * über alle Organisationen gehört nicht unter eine einzelne.
 */
@Controller('instances')
@UseGuards(SessionGuard)
export class InstancesController {
  constructor(private readonly instances: InstanceService) {}

  @Get()
  async list(): Promise<InstanceListenEntry[]> {
    return this.instances.all();
  }
}
