-- Security review 2026-10, M2 (ADR-064): card_print_items.rendered_data never holds a full
-- national ID again. A flag records whether the physical card carried it in full; the full
-- value is decrypted from team_members / users only for a print run.

-- AlterTable
ALTER TABLE "card_print_items" ADD COLUMN     "national_id_printed" TEXT NOT NULL DEFAULT 'MASKED';

ALTER TABLE "card_print_items"
  ADD CONSTRAINT "card_print_items_national_id_printed_chk"
  CHECK ("national_id_printed" IN ('FULL', 'MASKED'));

-- Scrub rows written before this migration: any unmasked ID (no '•') is replaced by the
-- masked form (first digit, seven dots, last two digits) and the row is flagged FULL.
UPDATE "card_print_items"
SET "national_id_printed" = 'FULL',
    "rendered_data" = jsonb_set(
      "rendered_data"::jsonb,
      '{nationalId}',
      to_jsonb(
        left("rendered_data"->>'nationalId', 1)
        || repeat('•', greatest(char_length("rendered_data"->>'nationalId') - 3, 0))
        || right("rendered_data"->>'nationalId', 2)
      )
    )
WHERE coalesce("rendered_data"->>'nationalId', '') <> ''
  AND position('•' in "rendered_data"->>'nationalId') = 0;
