import { can, canAny, type Permission, type PermissionSubject } from '@nuzli/shared';

export type FileEntity = 'violation' | 'task' | 'logo' | 'member_photo';

/** Object-key folder per entity: `{folder}/{yyyy}/{mm}/{uuid}.{ext}` (brief §3.2). */
export const ENTITY_FOLDERS: Record<FileEntity, string> = {
  violation: 'violations',
  task: 'tasks',
  logo: 'logos',
  member_photo: 'member-photos',
};

/** Who may upload a file for each entity type. */
const UPLOAD_PERMISSIONS: Record<FileEntity, Permission[]> = {
  violation: ['violations.create', 'violations.manage'],
  task: ['tasks.manage', 'tasks.comment'],
  logo: ['logos.manage'],
  member_photo: ['members.manage', 'members.manageOwn'],
};

/**
 * Who may read files of each entity type besides the uploader. Data-scoped rules (own team,
 * granted project) arrive with their modules (Phases 2–4) and only ever narrow access.
 */
const READ_PERMISSIONS: Record<FileEntity, Permission[]> = {
  violation: ['violations.readAll'],
  task: ['projects.readAll'],
  logo: ['cards.print', 'logos.manage'],
  member_photo: ['teams.readAll', 'members.manage', 'cards.print'],
};

export function canUpload(user: PermissionSubject, entity: FileEntity, kind?: string): boolean {
  if (kind === 'ID_CARD' && entity !== 'violation') return false;
  return canAny(user, UPLOAD_PERMISSIONS[entity]);
}

export interface FileForPolicy {
  entityType: string;
  kind: string | null;
  uploadedById: string | null;
}

/** Read check for presigned GET URLs. ID-card photos also need `violations.viewIdPhoto`. */
export function canReadFile(user: PermissionSubject & { id: string }, file: FileForPolicy): boolean {
  if (file.kind === 'ID_CARD' && !can(user, 'violations.viewIdPhoto')) return false;
  if (user.status && user.status !== 'ACTIVE') return false;
  if (file.uploadedById && file.uploadedById === user.id) return true;
  const perms = READ_PERMISSIONS[file.entityType as FileEntity];
  return perms ? canAny(user, perms) : false;
}
