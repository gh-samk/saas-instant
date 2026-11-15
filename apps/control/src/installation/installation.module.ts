import { Module } from '@nestjs/common';
import { InstallationService } from './installation.service';

/** Bindung der Verwaltung an genau eine Software (siehe InstallationService). */
@Module({ providers: [InstallationService] })
export class InstallationModule {}
