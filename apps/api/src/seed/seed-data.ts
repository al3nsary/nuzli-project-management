/**
 * System reference data seeded on every start (idempotent). These are placeholders the admin
 * can edit or retire later (brief §10) — not business data.
 */

/** 24 visually distinct colours, each dark enough for white text (≥ 4.5:1), with Arabic names. */
export const TEAM_PALETTE: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'أخضر بترولي', hex: '#1D5C63' },
  { name: 'أزرق ملكي', hex: '#1D4ED8' },
  { name: 'أحمر قرمزي', hex: '#B91C1C' },
  { name: 'أخضر زمردي', hex: '#15803D' },
  { name: 'بنفسجي', hex: '#7C3AED' },
  { name: 'برتقالي محروق', hex: '#C2410C' },
  { name: 'فيروزي داكن', hex: '#0E7490' },
  { name: 'ذهبي داكن', hex: '#8A5A00' },
  { name: 'فوشي', hex: '#BE185D' },
  { name: 'نيلي', hex: '#4338CA' },
  { name: 'أخضر نعناعي داكن', hex: '#047857' },
  { name: 'عنّابي', hex: '#9F1239' },
  { name: 'كحلي', hex: '#1E3A8A' },
  { name: 'أخضر عشبي', hex: '#3F6212' },
  { name: 'أرجواني', hex: '#6B21A8' },
  { name: 'كهرماني', hex: '#B45309' },
  { name: 'أخضر مزرق', hex: '#0F766E' },
  { name: 'رمادي أردوازي', hex: '#475569' },
  { name: 'ماجنتا داكن', hex: '#86198F' },
  { name: 'بني', hex: '#7C2D12' },
  { name: 'أزرق سماوي داكن', hex: '#0369A1' },
  { name: 'أحمر', hex: '#DC2626' },
  { name: 'فحمي', hex: '#1F2937' },
  { name: 'بني رمادي', hex: '#57534E' },
];

/** Built-in card sizes (brief §8.3). Custom sizes are added by admins. */
export const BUILTIN_CARD_SIZES: ReadonlyArray<{ name: string; widthMm: number; heightMm: number }> = [
  { name: 'CR80 (بطاقة قياسية)', widthMm: 85.6, heightMm: 54 },
  { name: '90 × 40', widthMm: 90, heightMm: 40 },
  { name: '4″ × 2″', widthMm: 101.6, heightMm: 50.8 },
  { name: '3″ × 2″', widthMm: 76.2, heightMm: 50.8 },
  { name: '4″ × 3″', widthMm: 101.6, heightMm: 76.2 },
  { name: '2.25″ × 1.25″', widthMm: 57, heightMm: 32 },
];

export const DEFAULT_CALENDAR = {
  name: 'التقويم الافتراضي',
  /** 0 = Sunday … 6 = Saturday → Friday and Saturday (brief §6.1). */
  weekendDays: [5, 6],
};

/**
 * Three built-in layouts (brief §8.4), created once by name. The admin may edit or archive
 * them; a missing one is recreated on the next start only if no template has its name.
 * Sizes refer to BUILTIN_CARD_SIZES by name. The first becomes the default when none exists.
 */
export const BUILTIN_CARD_TEMPLATES: ReadonlyArray<{
  name: string;
  sizeName: string;
  orientation: 'LANDSCAPE' | 'PORTRAIT';
  layoutKey: 'CLASSIC_HORIZONTAL' | 'VERTICAL_BADGE' | 'COMPACT_LABEL';
  config: Record<string, unknown>;
  isDefault: boolean;
}> = [
  {
    name: 'كلاسيكية أفقية — CR80',
    sizeName: 'CR80 (بطاقة قياسية)',
    orientation: 'LANDSCAPE',
    layoutKey: 'CLASSIC_HORIZONTAL',
    config: {},
    isDefault: true,
  },
  {
    name: 'شارة عمودية — CR80',
    sizeName: 'CR80 (بطاقة قياسية)',
    orientation: 'PORTRAIT',
    layoutKey: 'VERTICAL_BADGE',
    config: { logoPosition: 'center', accentStrip: 'top', fontSizes: { name: 12, body: 7 } },
    isDefault: false,
  },
  {
    name: 'ملصق مدمج — 90 × 40',
    sizeName: '90 × 40',
    orientation: 'LANDSCAPE',
    layoutKey: 'COMPACT_LABEL',
    config: {
      fields: { department: false, qr: false, photo: false },
      fontSizes: { name: 10, body: 6 },
      accentStrip: 'start',
    },
    isDefault: false,
  },
];
