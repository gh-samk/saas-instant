import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Die Verwaltung gehört in keinen Suchindex. Der Header wird global gesetzt,
 * nicht nur auf HTML-Seiten — auch API-Antworten und Fehlerseiten.
 */
@Injectable()
export class RobotsMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  }
}
