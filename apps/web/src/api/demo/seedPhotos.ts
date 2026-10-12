// Demo data lives at the repository root (seed/demo), clearly marked and replaceable.
import photosSeed from '../../../../../seed/demo/photos.json';
import cardsSeed from '../../../../../seed/demo/cards.json';
import type { DemoDb, DemoFile } from './db';

interface PhotoSeed {
  entityType: 'user_photo' | 'member_photo';
  entityId: string;
  fileId: string;
  hue: number;
  variant: number;
}

export const SEED_PHOTOS = (photosSeed as { photos: PhotoSeed[] }).photos;

/**
 * Owner request A8 in the demo: a few members and two supervisors get a placeholder portrait
 * (drawn on a canvas when first viewed — an abstract silhouette, never a face); everyone else
 * shows initials. Also turns the photo area on for the three seeded templates, like the API
 * migration does (ADR-084). Runs once per browser, also for browsers seeded before A8.
 */
export async function seedPhotos(db: DemoDb) {
  if (await db.kv.get('seededPhotos')) return;
  const now = new Date().toISOString();
  const seedTemplateIds = new Set((cardsSeed as { templates: { id: string }[] }).templates.map((x) => x.id));
  await db.transaction('rw', [db.users, db.members, db.files, db.cardTemplates, db.kv], async () => {
    for (const p of SEED_PHOTOS) {
      const owner =
        p.entityType === 'user_photo' ? await db.users.get(p.entityId) : await db.members.get(p.entityId);
      if (!owner || owner.photoFileId) continue;
      const file: DemoFile = {
        id: p.fileId,
        entityType: p.entityType,
        entityId: p.entityId,
        kind: 'PHOTO',
        mimeType: 'image/jpeg',
        sizeBytes: 40_000,
        status: 'READY',
        createdById: p.entityType === 'user_photo' ? p.entityId : '00000000-0000-4000-8000-000000000001',
        createdAt: now,
        expiresAt: now,
        violationId: null,
        placeholder: { label: String(p.variant), hue: p.hue, portrait: true },
      };
      await db.files.put(file);
      if (p.entityType === 'user_photo') await db.users.update(p.entityId, { photoFileId: p.fileId });
      else await db.members.update(p.entityId, { photoFileId: p.fileId });
    }
    for (const tpl of await db.cardTemplates.toArray()) {
      if (!seedTemplateIds.has(tpl.id) || tpl.config.fields.photo) continue;
      await db.cardTemplates.update(tpl.id, {
        config: { ...tpl.config, fields: { ...tpl.config.fields, photo: true } },
      });
    }
    await db.kv.put({ key: 'seededPhotos', value: now });
  });
}
