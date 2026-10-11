import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { AppConfig } from '../config/app-config';

const ISSUER = 'nuzli-api';
const AUDIENCE = 'nuzli-web';

export interface AccessClaims {
  sub: string;
  /** Informational only: guards always reload role and status from the database. */
  role: string;
}

/** Short-lived HS256 access JWT kept in memory by the web app (ADR-010). */
@Injectable()
export class AccessTokenService {
  constructor(private readonly cfg: AppConfig) {}

  get ttlSeconds(): number {
    return this.cfg.JWT_ACCESS_TTL_SECONDS;
  }

  sign(user: { id: string; role: string }): string {
    return jwt.sign({ role: user.role }, this.cfg.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: user.id,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: this.cfg.JWT_ACCESS_TTL_SECONDS,
    });
  }

  /** Returns the claims, or null when the token is missing, malformed, expired or forged. */
  verify(token: string): AccessClaims | null {
    try {
      const payload = jwt.verify(token, this.cfg.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (typeof payload === 'string' || typeof payload.sub !== 'string') return null;
      return { sub: payload.sub, role: String(payload.role ?? '') };
    } catch {
      return null;
    }
  }
}
