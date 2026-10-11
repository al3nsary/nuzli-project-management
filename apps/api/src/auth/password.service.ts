import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/** argon2id with the library defaults (m=64 MiB, t=3, p=4). */
@Injectable()
export class PasswordService {
  private dummy: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!hash) {
      // Same cost as a real check, so response time does not reveal unknown accounts.
      await this.verify(await this.dummyHash(), password);
      return false;
    }
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  private dummyHash(): Promise<string> {
    this.dummy ??= this.hash('nuzli-dummy-password-0');
    return this.dummy;
  }
}
