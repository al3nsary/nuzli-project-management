-- Owner request A8 (ADR-083): personal photos for login users; team_members.photo_file_id
-- already exists. Both photo columns are indexed for the orphan-cleanup job.
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "photo_file_id" UUID;

-- CreateIndex
CREATE INDEX "users_photo_file_id_idx" ON "users"("photo_file_id");

-- CreateIndex
CREATE INDEX "team_members_photo_file_id_idx" ON "team_members"("photo_file_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_photo_file_id_fkey" FOREIGN KEY ("photo_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The three built-in card templates (seeded, created_by IS NULL, matched by their seed names)
-- now reserve a photo area. Templates made or renamed by an admin are left as they are.
UPDATE "card_templates"
SET "config" = jsonb_set(
      coalesce("config"::jsonb, '{}'::jsonb),
      '{fields}',
      coalesce("config"::jsonb -> 'fields', '{}'::jsonb) || '{"photo": true}'::jsonb
    )
WHERE "created_by" IS NULL
  AND "name" IN ('كلاسيكية أفقية — CR80', 'شارة عمودية — CR80', 'ملصق مدمج — 90 × 40');
