import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, PermissionsGuard } from './auth/guards';
import { AllExceptionsFilter } from './common/error.filter';
import { AppConfig } from './config/app-config';
import { AppConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { HealthController } from './health/health.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { ColorsModule } from './colors/colors.module';
import { TeamsModule } from './teams/teams.module';
import { MembersModule } from './members/members.module';
import { ReferenceModule } from './reference/reference.module';
import { CardsModule } from './cards/cards.module';
import { ViolationsModule } from './violations/violations.module';
import { ProjectsModule } from './projects/projects.module';
import { PhotosModule } from './photos/photos.module';
import { OrgModule } from './org/org.module';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** Never logged (brief §13: no personal data or secrets in logs). */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.nationalId',
  '*.national_id',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.*.password',
  '*.*.nationalId',
  '*.*.token',
];

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (cfg: AppConfig) => ({
        pinoHttp: {
          level: cfg.LOG_LEVEL,
          // Reuse a sane incoming X-Request-Id (from nginx), else generate one; echo it back.
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const incoming = req.headers['x-request-id'];
            const id =
              typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
            res.setHeader('X-Request-Id', id);
            return id;
          },
          // Every log line written during a request carries `requestId`.
          quietReqLogger: true,
          customAttributeKeys: { reqId: 'requestId' },
          redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
          serializers: {
            // Only method + path: query strings may carry tokens (set-password links).
            req: (req: { id: unknown; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: String(req.url).split('?')[0],
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          autoLogging: { ignore: (req: IncomingMessage) => /\/(health|ready)$/.test(req.url ?? '') },
          transport:
            cfg.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (cfg: AppConfig) => [{ name: 'default', ttl: 60_000, limit: cfg.THROTTLE_DEFAULT_LIMIT }],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    CryptoModule,
    AuditModule,
    NotificationsModule,
    SettingsModule,
    StorageModule,
    AuthModule,
    UsersModule,
    ColorsModule,
    MembersModule,
    TeamsModule,
    ReferenceModule,
    CardsModule,
    ViolationsModule,
    ProjectsModule,
    PhotosModule,
    OrgModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate limit → authenticate → authorise.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
