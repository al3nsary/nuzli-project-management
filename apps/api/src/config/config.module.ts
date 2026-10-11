import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfig } from './app-config';
import { loadEnv } from './env.schema';

@Global()
@Module({
  imports: [
    // Loads env files (if present) into process.env and validates them at startup. On the host
    // (npm run dev:api) the API reads env/api.env (ADR-068); in Docker, compose injects it.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', '../../env/api.env', '../../.env'],
      validate: (raw) => loadEnv(raw as NodeJS.ProcessEnv),
    }),
  ],
  providers: [{ provide: AppConfig, useFactory: () => loadEnv(process.env) }],
  exports: [AppConfig],
})
export class AppConfigModule {}
