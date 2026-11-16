import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { LockoutService } from './lockout.service';
import { LoginService } from './login.service';

@Module({
  controllers: [AuthController],
  providers: [LoginService, LockoutService],
  exports: [LockoutService],
})
export class AuthModule {}
