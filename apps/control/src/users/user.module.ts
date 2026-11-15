import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { FirstAccountService } from './first-account.service';

/**
 * Die Nutzerverwaltung.
 *
 * Sie hängt am `AuthModule`, weil der Einladungslink ein NOTFALL-LINK ist:
 * derselbe Weg, der seit der ersten Etappe existiert, um im Browser ein
 * Passwort zu setzen. Ein eigener Token-Mechanismus daneben wäre ein zweiter
 * mit denselben Fehlermöglichkeiten an denselben Stellen.
 */
@Module({
  imports: [AuthModule],
  controllers: [UserController],
  providers: [UserService, FirstAccountService],
  exports: [UserService, FirstAccountService],
})
export class UserModule {}
