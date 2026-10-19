import { detectFileType } from './magic-bytes';
import { buildObjectKey } from './files.service';
import { canReadFile, canUpload } from './file-policy';

const bytes = (...b: number[]) => Uint8Array.from(b);
const text = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));

describe('magic-byte detection', () => {
  it('recognises JPEG, PNG, WebP and PDF', () => {
    expect(detectFileType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe('image/jpeg');
    expect(detectFileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(detectFileType(text('RIFF\x24\x00\x00\x00WEBPVP8 '))).toBe('image/webp');
    expect(detectFileType(text('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('rejects SVG, HTML, GIF, ZIP, executables and truncated headers', () => {
    expect(detectFileType(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectFileType(text('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(detectFileType(text('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(detectFileType(text('GIF89a'))).toBeNull();
    expect(detectFileType(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
    expect(detectFileType(text('MZ\x90\x00'))).toBeNull();
    expect(detectFileType(text('RIFF\x24\x00\x00\x00WAVE'))).toBeNull();
    expect(detectFileType(bytes(0x89, 0x50, 0x4e))).toBeNull();
    expect(detectFileType(new Uint8Array())).toBeNull();
  });
});

describe('object keys', () => {
  it('follow {entity}/{yyyy}/{mm}/{uuid}.{ext} and carry no personal data', () => {
    const id = '0b9f1e2c-1111-4c3a-9d1e-123456789abc';
    expect(buildObjectKey('violations', 'image/jpeg', id, new Date('2026-03-05T23:30:00Z'))).toBe(
      `violations/2026/03/${id}.jpg`,
    );
    expect(buildObjectKey('logos', 'application/pdf', id, new Date('2026-12-31T00:00:00Z'))).toBe(
      `logos/2026/12/${id}.pdf`,
    );
  });
});

describe('file policy', () => {
  const admin = { id: 'a', role: 'ADMIN' as const, status: 'ACTIVE' };
  const monitor = { id: 'm', role: 'MONITOR' as const, status: 'ACTIVE' };
  const supervisor = { id: 's', role: 'SUPERVISOR' as const, status: 'ACTIVE' };

  it('upload rights follow the permission matrix', () => {
    expect(canUpload(monitor, 'violation', 'ID_CARD')).toBe(true);
    expect(canUpload(monitor, 'logo')).toBe(false);
    expect(canUpload(admin, 'logo')).toBe(true);
    expect(canUpload(admin, 'logo', 'ID_CARD')).toBe(false);
    expect(canUpload(supervisor, 'violation')).toBe(false);
  });

  it('A9 project imports: admins only, never linked to an entity, readable by the uploader only', () => {
    expect(canUpload(admin, 'import')).toBe(true);
    expect(canUpload(supervisor, 'import')).toBe(false);
    expect(canUpload(monitor, 'import')).toBe(false);
    expect(canUpload(admin, 'import', undefined, 'e0000000-0000-4000-8000-00000000000e')).toBe(false);
    expect(canUpload(admin, 'import', 'ID_CARD')).toBe(false);
    expect(canReadFile(admin, { entityType: 'import', kind: null, uploadedById: 'a' })).toBe(true);
    expect(canReadFile({ ...admin, id: 'other' }, { entityType: 'import', kind: null, uploadedById: 'a' })).toBe(false);
    expect(buildObjectKey('imports', 'application/vnd.ms-project', 'abc', new Date('2026-10-19T00:00:00Z'))).toBe('imports/2026/10/abc.mpp');
  });

  it('ID-card photos need violations.viewIdPhoto; others need read rights or ownership', () => {
    const idCard = { entityType: 'violation', kind: 'ID_CARD', uploadedById: 'm' };
    expect(canReadFile(monitor, idCard)).toBe(true);
    expect(canReadFile(admin, idCard)).toBe(true);
    expect(canReadFile({ ...monitor, id: 'other' }, idCard)).toBe(false);
    expect(canReadFile(supervisor, idCard)).toBe(false);
    expect(canReadFile({ ...monitor, status: 'SUSPENDED' }, idCard)).toBe(false);
    expect(canReadFile(supervisor, { entityType: 'logo', kind: 'LOGO', uploadedById: 'a' })).toBe(false);
    expect(canReadFile(admin, { entityType: 'unknown', kind: null, uploadedById: null })).toBe(false);
  });
});
