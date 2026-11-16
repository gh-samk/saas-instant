import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AccountsService, Role } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import { clientIp } from '../common/cookies';
import { ApiError, notFound } from '../common/errors';
import { PortalAdminGuard, RateLimit, SessionGuard } from '../common/guards';
import { PrismaService } from '../prisma.service';
import { SessionsService } from '../sessions/sessions.service';

class CreateAccountDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsBoolean() portalAdmin?: boolean;
}
class IdParam {
  @IsUUID() id!: string;
}
class RoleDto {
  @IsString() @MaxLength(64) clientId!: string;
  @IsIn(['admin', 'staff', 'none']) role!: Role | 'none';
}
class FlagDto {
  @IsBoolean() value!: boolean;
}

/** „Konten und Zugriffe": nur für Portal-Administratoren. */
@Controller('api/admin')
@UseGuards(SessionGuard, PortalAdminGuard)
@RateLimit('admin', 120)
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  private async summary(id: string) {
    const a = await this.prisma.account.findUnique({
      where: { id },
      include: { roles: true, _count: { select: { passkeys: true } } },
    });
    if (!a) throw notFound('Konto nicht gefunden.');
    return {
      id: a.id,
      email: a.email,
      name: a.name,
      portalAdmin: a.portalAdmin,
      disabled: !!a.disabledAt,
      locked: !!a.lockedUntil && a.lockedUntil > new Date(),
      setupPending: !a.passwordHash,
      totp: !!a.totpSecret,
      passkeys: a._count.passkeys,
      lastLoginAt: a.lastLoginAt,
      roles: Object.fromEntries(a.roles.map((r) => [r.clientId, r.role])),
    };
  }

  @Get('accounts')
  async list() {
    const rows = await this.prisma.account.findMany({ orderBy: { email: 'asc' }, select: { id: true } });
    return { accounts: await Promise.all(rows.map((r) => this.summary(r.id))) };
  }

  @Get('clients')
  async clients() {
    const rows = await this.prisma.oidcClient.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true } });
    return { clients: rows };
  }

  @Post('accounts')
  @HttpCode(201)
  async create(@Body() dto: CreateAccountDto, @Req() req: Request) {
    const { account, link } = await this.accounts.create(dto, req.portal!.account.email);
    return { account: await this.summary(account.id), setupLink: link };
  }

  /** Neuer Link: Einrichtung (noch kein Passwort) oder Zurücksetzen (Passwort und Faktoren neu). */
  @Post('accounts/:id/setup-link')
  @HttpCode(200)
  async setupLink(@Param() p: IdParam, @Req() req: Request) {
    const account = await this.prisma.account.findUnique({ where: { id: p.id } });
    if (!account) throw notFound('Konto nicht gefunden.');
    const link = await this.accounts.issueSetupLink(account.id, account.passwordHash ? 'reset' : 'setup');
    await this.audit.log({ action: 'account.setup_link_issued', accountId: account.id, ip: clientIp(req), detail: { by: req.portal!.account.email } });
    return { setupLink: link };
  }

  @Post('accounts/:id/roles')
  @HttpCode(200)
  async setRole(@Param() p: IdParam, @Body() dto: RoleDto, @Req() req: Request) {
    await this.accounts.setRole(p.id, dto.clientId, dto.role, req.portal!.account.email);
    return { account: await this.summary(p.id) };
  }

  @Post('accounts/:id/disable')
  @HttpCode(200)
  async disable(@Param() p: IdParam, @Req() req: Request) {
    if (p.id === req.portal!.account.id) throw new ApiError(409, 'self_action', 'Das eigene Konto lässt sich nicht sperren.');
    await this.prisma.account.update({ where: { id: p.id }, data: { disabledAt: new Date() } });
    const ended = await this.sessions.revokeAllOf(p.id);
    await this.audit.log({ action: 'account.disabled', accountId: p.id, ip: clientIp(req), detail: { by: req.portal!.account.email, sessionsEnded: ended } });
    return { account: await this.summary(p.id) };
  }

  @Post('accounts/:id/enable')
  @HttpCode(200)
  async enable(@Param() p: IdParam, @Req() req: Request) {
    await this.prisma.account.update({ where: { id: p.id }, data: { disabledAt: null } });
    await this.audit.log({ action: 'account.enabled', accountId: p.id, ip: clientIp(req), detail: { by: req.portal!.account.email } });
    return { account: await this.summary(p.id) };
  }

  @Post('accounts/:id/unlock')
  @HttpCode(200)
  async unlock(@Param() p: IdParam, @Req() req: Request) {
    await this.prisma.account.update({ where: { id: p.id }, data: { failedAttempts: 0, lockedUntil: null } });
    await this.audit.log({ action: 'account.unlocked', accountId: p.id, ip: clientIp(req), detail: { by: req.portal!.account.email } });
    return { account: await this.summary(p.id) };
  }

  @Post('accounts/:id/portal-admin')
  @HttpCode(200)
  async portalAdmin(@Param() p: IdParam, @Body() dto: FlagDto, @Req() req: Request) {
    if (p.id === req.portal!.account.id && !dto.value) {
      throw new ApiError(409, 'self_action', 'Die eigene Portal-Administration lässt sich nicht entziehen.');
    }
    await this.prisma.account.update({ where: { id: p.id }, data: { portalAdmin: dto.value } });
    await this.audit.log({ action: 'account.portal_admin_set', accountId: p.id, ip: clientIp(req), detail: { value: dto.value, by: req.portal!.account.email } });
    return { account: await this.summary(p.id) };
  }
}
