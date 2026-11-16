import { Module } from '@nestjs/common';
import { OauthController, WellKnownController } from './oidc.controller';
import { OidcService } from './oidc.service';

@Module({ controllers: [WellKnownController, OauthController], providers: [OidcService] })
export class OidcModule {}
