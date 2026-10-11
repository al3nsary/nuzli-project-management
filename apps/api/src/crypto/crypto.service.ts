import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { toWesternDigits } from '@nuzli/shared';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_RE = /^v\d{1,4}$/;

export interface CryptoKeys {
  /** Current encryption key: `v1:<base64>` or bare base64 (= v1). 32 bytes. */
  encKey: string;
  /** Older keys still accepted for decryption during rotation (`v1:<base64>`). */
  oldEncKeys?: string[];
  /** HMAC key for the blind index (base64, 32 bytes). */
  hmacKey: string;
}

export interface ProtectedNationalId {
  enc: Buffer;
  hash: string;
  first: string;
  last2: string;
  last4: string;
}

function parseKey(value: string): { version: string; key: Buffer } {
  const sep = value.indexOf(':');
  const version = sep > 0 ? value.slice(0, sep) : 'v1';
  const key = Buffer.from(sep > 0 ? value.slice(sep + 1) : value, 'base64');
  if (!VERSION_RE.test(version)) throw new Error(`Invalid key version "${version}"`);
  if (key.length !== 32) throw new Error(`Key ${version} must be 32 bytes (base64)`);
  return { version, key };
}

/** Random URL-safe token (refresh tokens, action tokens, CSRF). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored as SHA-256 hex, never in clear (ADR-010). */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * National-ID protection (ADR-011).
 * Ciphertext layout: ASCII `v1:` | iv (12) | auth tag (16) | ciphertext.
 * Blind index: HMAC-SHA256(hmacKey, normalised id) as hex — unique index + exact lookup.
 */
export class CryptoService {
  private readonly current: { version: string; key: Buffer };
  private readonly keyring = new Map<string, Buffer>();
  private readonly hmacKey: Buffer;

  constructor(keys: CryptoKeys) {
    this.current = parseKey(keys.encKey);
    for (const old of keys.oldEncKeys ?? []) {
      const parsed = parseKey(old);
      this.keyring.set(parsed.version, parsed.key);
    }
    this.keyring.set(this.current.version, this.current.key);
    this.hmacKey = parseKey(keys.hmacKey).key;
  }

  get keyVersion(): string {
    return this.current.version;
  }

  encrypt(plain: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.current.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from(`${this.current.version}:`, 'ascii'), iv, tag, ciphertext]);
  }

  decrypt(payload: Buffer | Uint8Array): string {
    const buf = Buffer.from(payload);
    const sep = buf.indexOf(0x3a); // ':'
    if (sep < 2 || sep > 6) throw new Error('Ciphertext has no key version prefix');
    const version = buf.subarray(0, sep).toString('ascii');
    const key = this.keyring.get(version);
    if (!key) throw new Error(`No key for version ${version}`);
    const body = buf.subarray(sep + 1);
    const iv = body.subarray(0, IV_BYTES);
    const tag = body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = body.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** Version of the key that encrypted this payload (for rotation scripts). */
  versionOf(payload: Buffer | Uint8Array): string {
    const buf = Buffer.from(payload);
    return buf.subarray(0, buf.indexOf(0x3a)).toString('ascii');
  }

  blindIndex(nationalId: string): string {
    return createHmac('sha256', this.hmacKey).update(normalizeId(nationalId)).digest('hex');
  }

  protectNationalId(nationalId: string): ProtectedNationalId {
    const id = normalizeId(nationalId);
    return {
      enc: this.encrypt(id),
      hash: this.blindIndex(id),
      first: id.slice(0, 1),
      last2: id.slice(-2),
      last4: id.slice(-4),
    };
  }
}

function normalizeId(value: string): string {
  return toWesternDigits(value).trim();
}
