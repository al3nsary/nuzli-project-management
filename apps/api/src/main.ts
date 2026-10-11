import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';

export const API_PREFIX = 'api/v1';

/** Shared by main() and the integration tests so both run the exact same pipeline. */
export function configureApp(app: NestExpressApplication, cfg: AppConfig): void {
  app.set('trust proxy', cfg.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Swagger UI injects a few inline styles.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: (origin, callback) => {
      // Same-origin requests (through nginx) and server-to-server calls carry no Origin.
      if (!origin || cfg.CORS_ORIGINS.includes(origin)) callback(null, true);
      else callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();

  if (cfg.SWAGGER_ENABLED) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Nuzli API')
        .setDescription('نزلي — إدارة المشاريع والفرق الميدانية. Errors: { code, message_ar, details }.')
        .setVersion('1')
        .addBearerAuth()
        .addCookieAuth('nz_rt')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, doc);
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const cfg = app.get(AppConfig);
  configureApp(app, cfg);
  await app.listen(cfg.PORT, '0.0.0.0');
}

if (require.main === module) {
  void bootstrap();
}
