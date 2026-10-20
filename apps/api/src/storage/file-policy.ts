import { can, canAny, type Permission, type PermissionSubject } from '@nuzli/shared';

export type FileEntity = 'violation' | 'task' | 'logo' | 'member_photo' | 'user_photo' | 'import' | 'project_cover';

/** Object-key folder per entity: `{folder}/{yyyy}/{mm}/{uuid}.{ext}` (brief §3.2). */
export const ENTITY_FOLDERS: Record<FileEntity, string> = {
  violation: 'violations',
  task: 'tasks',
  logo: 'logos',
  member_photo: 'member-photos',
  user_photo: 'user-photos',
  import: 'imports',
  project_cover: 'project-covers',
};

/**
 * Entities whose uploads are scoped by a hook (entity id, limits, linking at confirm). Without
 * its hook registered such an upload is refused instead of being accepted unchecked.
 */
export const HOOKED_ENTITIES: ReadonlySet<FileEntity> = new Set<FileEntity>(['violation', 'task', 'member_photo', 'user_photo', 'project_cover']);

/**
 * Who may upload a file for each entity type (the coarse gate; hooks add the data scope).
 * Security review L3 (ADR-066): logos are admin-only (`logos.manage`).
 * Owner request A8 supersedes the temporary member-photo closure: member photos are open to
 * `members.manage` (admin) and `members.manageOwn` (the supervisor leading the member's team —
 * checked by PhotosService); user photos to everyone for themselves (`profile.update`) and to
 * admins (`users.manageRoles`) for anyone.
 */
const UPLOAD_PERMISSIONS: Record<FileEntity, Permission[]> = {
  violation: ['violations.create', 'violations.manage'],
  task: ['tasks.manage', 'tasks.comment'],
  logo: ['logos.manage'],
  member_photo: ['members.manage', 'members.manageOwn'],
  user_photo: ['profile.update', 'users.manageRoles'],
  // A9 (ADR-110): project imports are admin-only (projects.create).
  import: ['projects.create'],
  // A12 round 2: the project cover (admins, assistants with projects:edit).
  project_cover: ['projects.manage'],
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
  // Scoped photo reads go through GET /users/:id/photo-url and /members/:id/photo-url.
  user_photo: ['users.read', 'cards.print'],
  // Only the uploader reads an import file (the importer reads it server-side).
  import: [],
  // A12 round 2: read through GET /projects/:id/cover-url (scoped to the viewer's projects).
  project_cover: ['projects.readAll'],
};

export function canUpload(user: PermissionSubject, entity: FileEntity, kind?: string, entityId?: string): boolean {
  // ID-card and person photos (A9) exist only on violations.
  if ((kind === 'ID_CARD' || kind === 'PERSON') && entity !== 'violation') return false;
  // A logo belongs to no entity; an entityId there would only be an untracked label.
  if ((entity === 'logo' || entity === 'import') && entityId) return false;
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
