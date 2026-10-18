import { describe, expect, it } from 'vitest';
import {
  can,
  createOrgPositionSchema,
  createOrgUnitSchema,
  createTeamSchema,
  createViolationSchema,
  moveOrgUnitSchema,
  presignUploadSchema,
  registerViolationMemberSchema,
  removeTeamSupervisorSchema,
  updateOrgUnitSchema,
  violationFilterSchema,
} from './index';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

describe('A9 shared contracts — teams, org, violations', () => {
  it('createTeamSchema: several supervisors; the primary must be one of them', () => {
    const base = { name: 'فريق', colorId: U1 };
    expect(createTeamSchema.safeParse({ ...base, supervisorIds: [U2, U3], primarySupervisorId: U3 }).success).toBe(true);
    expect(createTeamSchema.safeParse({ ...base, supervisorId: U2, primarySupervisorId: U2 }).success).toBe(true);
    expect(createTeamSchema.safeParse({ ...base, supervisorIds: [U2], primarySupervisorId: U3 }).success).toBe(false);
  });

  it('removing a supervisor needs a reason; the successor is optional in the schema', () => {
    expect(removeTeamSupervisorSchema.safeParse({ reason: 'نقل' }).success).toBe(true);
    expect(removeTeamSupervisorSchema.safeParse({}).success).toBe(false);
  });

  it('createViolationSchema: memberId optional, one person photo by default', () => {
    const v = createViolationSchema.parse({
      clientUuid: U1,
      typeId: U2,
      description: 'وصف كافٍ',
      latitude: 24,
      longitude: 46,
      accuracyM: 5,
      capturedAt: '2026-10-19T08:00:00Z',
      expectedEvidencePhotos: 1,
    });
    expect(v.memberId).toBeUndefined();
    expect(v.expectedPersonPhotos).toBe(1);
    expect(presignUploadSchema.safeParse({ entityType: 'violation', entityId: U1, kind: 'PERSON', contentType: 'image/jpeg', sizeBytes: 10 }).success).toBe(true);
    expect(violationFilterSchema.parse({ assigned: 'false' }).assigned).toBe('false');
  });

  it('registerViolationMemberSchema validates the national ID (Arabic digits accepted)', () => {
    const ok = registerViolationMemberSchema.parse({ fullName: 'راجيش كومار', nationalId: '٢٣٤٥٦٧٨٩٠٤' });
    expect(ok).toMatchObject({ nationalId: '2345678904', usePersonPhoto: true });
    expect(registerViolationMemberSchema.safeParse({ fullName: 'راجيش كومار', nationalId: '2345678900' }).success).toBe(false);
  });

  it('org schemas: holder XOR, move with a nullable parent, update needs something', () => {
    expect(createOrgUnitSchema.parse({ name: 'إدارة', kind: 'DEPARTMENT' }).parentId).toBeNull();
    expect(createOrgPositionSchema.safeParse({ unitId: U1, title: 'مدير', holderUserId: U2, holderMemberId: U3 }).success).toBe(false);
    expect(createOrgPositionSchema.safeParse({ unitId: U1, title: 'مدير' }).success).toBe(true); // vacant
    expect(moveOrgUnitSchema.safeParse({ parentId: null }).success).toBe(true);
    expect(updateOrgUnitSchema.safeParse({}).success).toBe(false);
  });

  it('org permissions: admins manage, supervisors read, monitors neither', () => {
    const admin = { role: 'ADMIN' as const, status: 'ACTIVE' };
    const sup = { role: 'SUPERVISOR' as const, status: 'ACTIVE' };
    const mon = { role: 'MONITOR' as const, status: 'ACTIVE' };
    expect([can(admin, 'org.read'), can(admin, 'org.manage')]).toEqual([true, true]);
    expect([can(sup, 'org.read'), can(sup, 'org.manage')]).toEqual([true, false]);
    expect([can(mon, 'org.read'), can(mon, 'org.manage')]).toEqual([false, false]);
  });
});
