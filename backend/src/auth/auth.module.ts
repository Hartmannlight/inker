import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { PinAuthGuard } from './guards/pin-auth.guard';
import { AdminCredentialService } from './admin-credential.service';
import { AdminSessionService } from './admin-session.service';
import { PasswordHasherService } from './password-hasher.service';

@Module({
  controllers: [AuthController],
  providers: [
    PasswordHasherService,
    AdminCredentialService,
    AdminSessionService,
    {
      provide: APP_GUARD,
      useClass: PinAuthGuard,
    },
  ],
  exports: [AdminSessionService],
})
export class AuthModule {}
