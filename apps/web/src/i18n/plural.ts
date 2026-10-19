/**
 * Arabic plural forms (calculations audit M5). Arabic has six CLDR categories:
 * zero (0) · one (1) · two (2) · few (n % 100 in 3..10: «٣ مهام», «١٠٣ أيام») ·
 * many (n % 100 in 11..99: «١١ مهمة», «٢٥ يومًا») · other (100, 101, 102, 1000, fractions: «١٠٠ يوم»).
 * The category is read from the NUMBER, never from a formatted string.
 */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export interface PluralForms {
  zero?: string | undefined;
  one?: string | undefined;
  two?: string | undefined;
  few?: string | undefined;
  many?: string | undefined;
  /** Required: the fallback and the form for 100, 101, 102, … and fractions. */
  other: string;
}

const rules = new Intl.PluralRules('ar');

/** The CLDR category of `n` in Arabic (the sign is ignored: −3 days counts like 3). */
export function pluralCategory(n: number): PluralCategory {
  return rules.select(Math.abs(n)) as PluralCategory;
}

/** The form for `n`, falling back to `other` when that category has no form. */
export function plural(n: number, forms: PluralForms): string {
  return forms[pluralCategory(n)] ?? forms.other;
}
