import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfig } from './app-config';
import { loadEnv } from './env.schema';

@Global()
@Module({
  imports: [
    // Loads .env (if present) into process.env and validates it at startup.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', '../../.env'],
      validate: (raw) => loadEnv(raw as NodeJS.ProcessEnv),
    }),
  ],
  providers: [{ provide: AppConfig, useFactory: () => loadEnv(process.env) }],
  exports: [AppConfig],
})
export class AppConfigModule {}
