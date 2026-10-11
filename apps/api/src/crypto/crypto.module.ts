import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { CryptoService } from './crypto.service';

@Global()
@Module({
  providers: [
    {
      provide: CryptoService,
      inject: [AppConfig],
      useFactory: (cfg: AppConfig) =>
        new CryptoService({
          encKey: cfg.NATIONAL_ID_ENC_KEY,
          oldEncKeys: cfg.NATIONAL_ID_ENC_KEYS_OLD,
          hmacKey: cfg.NATIONAL_ID_HMAC_KEY,
        }),
    },
  ],
  exports: [CryptoService],
})
export class CryptoModule {}
