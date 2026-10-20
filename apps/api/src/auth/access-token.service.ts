import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { AppConfig } from '../config/app-config';

const ISSUER = 'nuzli-api';
const AUDIENCE = 'nuzli-web';

export interface AccessClaims {
  sub: string;
  /**
   * A12: the workspace the session is bound to (null = none chosen yet). The guard re-checks it
   * against the user's live memberships on every request; roles are never taken from the token.
   */
  wid: string | null;
}

/** Short-lived HS256 access JWT kept in memory by the web app (ADR-010). */
@Injectable()
export class AccessTokenService {
  constructor(private readonly cfg: AppConfig) {}

  get ttlSeconds(): number {
    return this.cfg.JWT_ACCESS_TTL_SECONDS;
  }

  sign(user: { id: string }, workspaceId: string | null): string {
    return jwt.sign({ wid: workspaceId }, this.cfg.JWT_ACCESS_SECRET, {
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
      const wid = typeof payload.wid === 'string' && payload.wid.length > 0 ? payload.wid : null;
      return { sub: payload.sub, wid };
    } catch {
      return null;
    }
  }
}
