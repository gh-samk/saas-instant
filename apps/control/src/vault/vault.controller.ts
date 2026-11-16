import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { SessionUser } from '../auth/session.service';
import { LoggedInUser } from '../common/decorators/logged-in-user.decorator';
import { WithoutSecondFactor } from '../common/decorators/without-second-factor.decorator';
import { SecondFactorGuard } from '../common/guards/second-factor.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { RequireAdmin } from '../common/decorators/require-role.decorator';
import { RoleGuard } from '../common/guards/role.guard';
import { sourceFrom } from '../common/inquiry-source';
import {
  AddPassphraseDto,
  ChangePassphraseDto,
  SetupVaultDto,
  UnlockDto,
  VaultEvidenceDto,
} from './vault.dto';
import {
  VaultService,
  type VaultActor,
  type VaultEntryInfo,
  type VaultState,
} from './vault.service';

function actorOf(user: SessionUser, req: Request): VaultActor {
  const source = sourceFrom(req);
  return {
    userId: user.id,
    actor: user.username,
    ip: source.ip,
    userAgent: source.userAgent,
  };
}

/**
 * Nur der Zustand, anonym: "uninitialized" | "locked" | "unlocked". Die
 * Anmelde- und Entsperrseite braucht ihn vor der Anmeldung; er verrät nichts
 * über Daten, Konten oder Schlüssel.
 */
@Controller('vault')
export class VaultStatusController {
  constructor(private readonly vault: VaultService) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  async status(): Promise<{ state: VaultState }> {
    return { state: await this.vault.state() };
  }
}

/**
 * Tresor-Verwaltung. Entsperren verlangt eine Sitzung (die Anmeldung inklusive
 * zweitem Faktor liegt davor); alles, was Schlüsselverpackungen verändert,
 * zusätzlich einen frischen zweiten Faktor.
 */
@Controller('vault')
@UseGuards(SessionGuard, RoleGuard, SecondFactorGuard)
@RequireAdmin()
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Post('unlock')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @WithoutSecondFactor(
    'Das Entsperren ist selbst der Nachweis: Passphrase oder Wiederherstellungs' +
      'schlüssel. Davor liegt die Anmeldung mit zweitem Faktor; eine zusätzliche ' +
      'Abfrage änderte nichts, außer dass nach einem Neustart niemand mehr hineinkäme.',
  )
  async unlock(
    @LoggedInUser() user: SessionUser,
    @Body() dto: UnlockDto,
    @Req() req: Request,
  ): Promise<{ state: VaultState }> {
    await this.vault.unlock(dto.secret, actorOf(user, req), req.ip ?? 'unknown');
    // Antwort erst, wenn auch der Einmal-Lauf (encrypt-existing) durch ist.
    await this.vault.settled();
    return { state: await this.vault.state() };
  }

  /** Erste Einrichtung. Antwort trägt EINMALIG den Wiederherstellungsschlüssel. */
  @Post('setup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async setup(
    @LoggedInUser() user: SessionUser,
    @Body() dto: SetupVaultDto,
    @Req() req: Request,
  ): Promise<{ recoveryKey: string }> {
    const result = await this.vault.initialize(dto.passphrase, actorOf(user, req));
    await this.vault.settled();
    return result;
  }

  @Get('entries')
  @WithoutSecondFactor(
    'Rein lesend: Art, Bezeichnung und Anlegedatum der Einträge. Keine Schlüssel, keine Salze.',
  )
  async entries(): Promise<VaultEntryInfo[]> {
    return this.vault.listEntries();
  }

  @Post('passphrases')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async addPassphrase(
    @LoggedInUser() user: SessionUser,
    @Body() dto: AddPassphraseDto,
    @Req() req: Request,
  ): Promise<VaultEntryInfo> {
    return this.vault.addPassphrase(
      dto.passphrase,
      dto.label ?? user.username,
      user.id,
      actorOf(user, req),
    );
  }

  @Put('passphrases/:id')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async changePassphrase(
    @LoggedInUser() user: SessionUser,
    @Param('id') id: string,
    @Body() dto: ChangePassphraseDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.vault.changePassphrase(
      id,
      dto.currentPassphrase,
      dto.newPassphrase,
      actorOf(user, req),
    );
    return { ok: true };
  }

  @Post('recovery')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async regenerateRecovery(
    @LoggedInUser() user: SessionUser,
    @Body() _dto: VaultEvidenceDto,
    @Req() req: Request,
  ): Promise<{ recoveryKey: string }> {
    return this.vault.regenerateRecovery(actorOf(user, req));
  }
}
