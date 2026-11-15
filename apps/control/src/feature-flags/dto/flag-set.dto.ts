import { IsBoolean } from 'class-validator';

/** Neuer Stand eines Funktionsschalters. */
export class FlagSetDto {
  // Ohne @IsBoolean nähme der ValidationPipe (whitelist) das Feld gar nicht
  // an — dieselbe Falle wie bei `active` im ZugangDto.
  @IsBoolean({ message: 'aktiv muss true oder false sein.' })
  enabled!: boolean;
}
