import type { Prisma } from '@prisma/client';
import {
  can,
  maskNationalIdParts,
  type ViolationDto,
  type ViolationTypeDto,
} from '@nuzli/shared';
import { TEAM_SUMMARY_SELECT, toTeamSummary, type Viewer } from '../teams/team-dto';

export const VIOLATION_TYPE_SELECT = {
  id: true,
  name: true,
  severity: true,
  isActive: true,
} satisfies Prisma.ViolationTypeSelect;

export function toTypeDto(t: Prisma.ViolationTypeGetPayload<{ select: typeof VIOLATION_TYPE_SELECT }>): ViolationTypeDto {
  return { id: t.id, name: t.name, severity: t.severity, isActive: t.isActive };
}

/** Everything a ViolationDto needs in one query (never the encrypted national ID). */
export const VIOLATION_SELECT = {
  id: true,
  clientUuid: true,
  memberId: true,
  teamIdSnapshot: true,
  supervisorIdsSnapshot: true,
  assignedAt: true,
  recordedById: true,
  description: true,
  notes: true,
  latitude: true,
  longitude: true,
  accuracyM: true,
  capturedAt: true,
  receivedAt: true,
  clientSentAt: true,
  clockDriftSuspect: true,
  deviceInfo: true,
  expectedIdPhotos: true,
  expectedEvidence: true,
  expectedPerson: true,
  status: true,
  cancelReason: true,
  typeId: true,
  member: { select: { id: true, fullName: true, nationalIdFirst: true, nationalIdLast4: true } },
  team: { select: TEAM_SUMMARY_SELECT },
  supervisor: { select: { id: true, fullName: true } },
  recordedBy: { select: { id: true, fullName: true } },
  assignedBy: { select: { id: true, fullName: true } },
  ocr: { select: { status: true } },
  type: { select: VIOLATION_TYPE_SELECT },
  files: {
    select: { kind: true, file: { select: { id: true, mimeType: true, status: true, deletedAt: true } } },
    orderBy: { createdAt: 'asc' },
  },
  responses: {
    select: { id: true, body: true, createdAt: true, supervisor: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.ViolationSelect;

export type ViolationRow = Prisma.ViolationGetPayload<{ select: typeof VIOLATION_SELECT }>;

/** Lists skip files and responses (the detail view loads them). */
export const VIOLATION_LIST_SELECT = {
  ...VIOLATION_SELECT,
  responses: false,
} as const;

export function editableUntil(receivedAt: Date, windowMinutes: number): Date {
  return new Date(receivedAt.getTime() + windowMinutes * 60_000);
}

/** Supervisor ids of the snapshots in `rows` (names are looked up in one query). */
export function snapshotSupervisorIds(rows: ReadonlyArray<{ supervisorIdsSnapshot: string[] }>): string[] {
  return [...new Set(rows.flatMap((r) => r.supervisorIdsSnapshot ?? []))];
}

export function toViolationDto(
  v: Omit<ViolationRow, 'responses'> & { responses?: ViolationRow['responses'] },
  opts: { viewer: Viewer; editWindowMinutes: number; supervisorNames?: ReadonlyMap<string, string> },
): ViolationDto {
  const names = opts.supervisorNames;
  const dto: ViolationDto = {
    id: v.id,
    clientUuid: v.clientUuid,
    // A9 (ADR-103): null until a person is assigned.
    member: v.member
      ? {
          id: v.member.id,
          fullName: v.member.fullName,
          nationalIdMasked: maskNationalIdParts(v.member.nationalIdFirst, v.member.nationalIdLast4),
        }
      : null,
    assigned: !!v.memberId,
    assignedAt: v.assignedAt?.toISOString() ?? null,
    assignedBy: v.assignedBy ? { id: v.assignedBy.id, fullName: v.assignedBy.fullName } : null,
    team: v.team ? toTeamSummary(v.team) : null,
    supervisor: v.supervisor ? { id: v.supervisor.id, fullName: v.supervisor.fullName } : null,
    supervisors: (v.supervisorIdsSnapshot ?? []).map((id) => ({
      id,
      fullName: names?.get(id) ?? (v.supervisor?.id === id ? v.supervisor.fullName : ''),
    })),
    recordedBy: { id: v.recordedBy.id, fullName: v.recordedBy.fullName },
    type: toTypeDto(v.type),
    description: v.description,
    notes: v.notes,
    latitude: v.latitude,
    longitude: v.longitude,
    accuracyM: v.accuracyM,
    capturedAt: v.capturedAt.toISOString(),
    receivedAt: v.receivedAt.toISOString(),
    clockDriftSuspect: v.clockDriftSuspect,
    status: v.status,
    cancelReason: v.cancelReason,
    files: v.files.map((f) => ({
      id: f.file.id,
      kind: f.kind,
      mimeType: f.file.mimeType,
      ready: f.file.status === 'READY' && !f.file.deletedAt,
    })),
    responses: (v.responses ?? []).map((r) => ({
      id: r.id,
      supervisor: { id: r.supervisor.id, fullName: r.supervisor.fullName },
      body: r.body,
      createdAt: r.createdAt.toISOString(),
    })),
    editableUntil: editableUntil(v.receivedAt, opts.editWindowMinutes).toISOString(),
    expectedPhotos: { idCard: v.expectedIdPhotos, evidence: v.expectedEvidence, person: v.expectedPerson },
    clientSentAt: v.clientSentAt?.toISOString() ?? null,
  };
  if (can(opts.viewer, 'violations.manage')) {
    dto.deviceInfo = (v.deviceInfo ?? {}) as Record<string, unknown>;
  }
  // OCR state: admins and the recorder (the people who assign the violation).
  if (can(opts.viewer, 'violations.manage') || v.recordedById === opts.viewer.id) {
    dto.ocrStatus = v.ocr?.status ?? null;
  }
  return dto;
}

/**
 * Device information keeps only what helps an admin judge a record (brief §7.2):
 * user agent, platform, app version and the online flag. Anything else the client sends
 * (screen size, location, identifiers…) is dropped.
 */
export function sanitizeDeviceInfo(input: unknown): Prisma.InputJsonObject {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Record<string, string | boolean> = {};
  const text = (key: string, max: number) => {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, max);
  };
  text('userAgent', 400);
  text('platform', 80);
  text('appVersion', 40);
  if (typeof src.online === 'boolean') out.online = src.online;
  return out;
}
