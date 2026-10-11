import { randomBytes } from 'node:crypto';
import { nationalIdCheckDigit } from '@nuzli/shared';
import { CryptoService, randomToken, sha256Hex } from './crypto.service';

const key = () => randomBytes(32).toString('base64');
const validId = (first9: string) => first9 + nationalIdCheckDigit(first9);

describe('CryptoService (ADR-011)', () => {
  const encKey = key();
  const hmacKey = key();
  const svc = new CryptoService({ encKey, hmacKey });

  it('round-trips a national ID through AES-256-GCM', () => {
    const id = validId('123456789');
    const enc = svc.encrypt(id);
    expect(enc.toString('utf8')).not.toContain(id);
    expect(svc.decrypt(enc)).toBe(id);
  });

  it('uses a fresh IV each time (same input → different ciphertext)', () => {
    const id = validId('223456789');
    expect(svc.encrypt(id).equals(svc.encrypt(id))).toBe(false);
  });

  it('prefixes the ciphertext with the key version', () => {
    const enc = svc.encrypt('1000000008');
    expect(enc.subarray(0, 3).toString('ascii')).toBe('v1:');
    expect(svc.versionOf(enc)).toBe('v1');
    // version prefix (3) + iv (12) + tag (16) + 10 bytes of plaintext
    expect(enc.length).toBe(3 + 12 + 16 + 10);
  });

  it('honours an explicit key version and still decrypts older versions after rotation', () => {
    const v1 = new CryptoService({ encKey: `v1:${encKey}`, hmacKey });
    const oldCipher = v1.encrypt('1234567890');
    const v2Key = key();
    const v2 = new CryptoService({ encKey: `v2:${v2Key}`, oldEncKeys: [`v1:${encKey}`], hmacKey });
    expect(v2.keyVersion).toBe('v2');
    expect(v2.decrypt(oldCipher)).toBe('1234567890');
    expect(v2.versionOf(v2.encrypt('x'))).toBe('v2');
  });

  it('fails on tampered ciphertext (GCM auth tag)', () => {
    const enc = svc.encrypt('1234567890');
    enc[enc.length - 1] = (enc[enc.length - 1] ?? 0) ^ 0xff;
    expect(() => svc.decrypt(enc)).toThrow();
  });

  it('fails without the right key', () => {
    const other = new CryptoService({ encKey: key(), hmacKey });
    expect(() => other.decrypt(svc.encrypt('1234567890'))).toThrow();
  });

  it('computes a stable blind index that ignores digit script and spaces', () => {
    const id = validId('112233445');
    const arabic = id.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    expect(svc.blindIndex(id)).toBe(svc.blindIndex(id));
    expect(svc.blindIndex(` ${arabic} `)).toBe(svc.blindIndex(id));
    expect(svc.blindIndex(id)).toMatch(/^[a-f0-9]{64}$/);
    expect(svc.blindIndex(id)).not.toBe(svc.blindIndex(validId('112233446')));
  });

  it('blind index depends on the HMAC key', () => {
    const other = new CryptoService({ encKey, hmacKey: key() });
    expect(other.blindIndex('1234567890')).not.toBe(svc.blindIndex('1234567890'));
  });

  it('protectNationalId keeps only first digit and last digits in clear', () => {
    const id = validId('298765432');
    const p = svc.protectNationalId(id);
    expect(p.first).toBe('2');
    expect(p.last2).toBe(id.slice(-2));
    expect(p.last4).toBe(id.slice(-4));
    expect(svc.decrypt(p.enc)).toBe(id);
    expect(p.hash).toBe(svc.blindIndex(id));
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new CryptoService({ encKey: randomBytes(16).toString('base64'), hmacKey })).toThrow();
  });

  it('token helpers', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
