import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../common/guards/session.guard';
import type { NavigationCounter } from './navigation.service';
import { NavigationService } from './navigation.service';

/**
 * Die Zähler der Seitenleiste. AUSSCHLIESSLICH LESEND — es gibt hier keinen
 * Endpunkt, der irgendetwas ändert.
 *
 * Schutz: Sitzung, wie beim `AufgabenController`. Kein zweiter Faktor: Die
 * Antwort besteht aus zwei Zahlen ohne Personenbezug, und sie steht ohnehin
 * hinter derselben Sitzung wie die Listen, aus denen sie stammt.
 */
@Controller('navigation')
@UseGuards(SessionGuard)
export class NavigationController {
  constructor(private readonly navigation: NavigationService) {}

  @Get('counters')
  async counter(): Promise<NavigationCounter> {
    return this.navigation.count();
  }
}
