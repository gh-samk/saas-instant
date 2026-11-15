import { Global, Module } from '@nestjs/common';
import { ManifestService } from './manifest.service';
import { PublicConfigController } from './public-config.controller';

@Global()
@Module({
  controllers: [PublicConfigController],
  providers: [ManifestService],
  exports: [ManifestService],
})
export class ManifestModule {}
