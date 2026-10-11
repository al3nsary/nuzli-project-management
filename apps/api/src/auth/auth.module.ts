import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { AccessTokenService } from './access-token.service';
import { AuthController, MeController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard, JwtAuthGuard, PermissionsGuard, PrismaUserLoader } from './guards';
import { PasswordService } from './password.service';
import {
  PrismaRefreshTokenRepo,
  REFRESH_TOKEN_REPO,
  RefreshTokenService,
  type RefreshTokenRepo,
} from './refresh-tokens';

@Global()
@Module({
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    AccessTokenService,
    PasswordService,
    PrismaUserLoader,
    JwtAuthGuard,
    PermissionsGuard,
    CsrfGuard,
    { provide: REFRESH_TOKEN_REPO, useClass: PrismaRefreshTokenRepo },
    {
      provide: RefreshTokenService,
      inject: [REFRESH_TOKEN_REPO, AppConfig],
      useFactory: (repo: RefreshTokenRepo, cfg: AppConfig) => new RefreshTokenService(repo, cfg),
    },
  ],
  exports: [AuthService, AccessTokenService, PasswordService, RefreshTokenService, PrismaUserLoader],
})
export class AuthModule {}
