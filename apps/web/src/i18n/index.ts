import { ar, type MessageKey } from './ar';
import { formatNumber } from './format';
import { plural, type PluralForms } from './plural';

export type { MessageKey } from './ar';
export * from './format';
export * from './plural';

export type MessageVars = Record<string, string | number | null | undefined>;

/**
 * Looks up an Arabic string and fills `{placeholders}`. Numbers are formatted with the
 * user's digit preference. Unknown placeholders are left visible so they are caught in review.
 */
export function t(key: MessageKey, vars?: MessageVars): string {
  return interpolate(ar[key], vars);
}

/** The plural forms of a message: `key` is "other", `key.zero` … `key.many` the other categories. */
export function formsOf(key: MessageKey): PluralForms {
  const dict = ar as Record<string, string>;
  return {
    zero: dict[`${key}.zero`],
    one: dict[`${key}.one`],
    two: dict[`${key}.two`],
    few: dict[`${key}.few`],
    many: dict[`${key}.many`],
    other: ar[key],
  };
}

/**
 * A count with its noun in correct Arabic agreement (calculations audit M5: «٩ مهمة» → «٩ مهام»,
 * «١٠٣ أيام», «١١ يومًا», «١٠٠ يوم»): the CLDR category of the NUMBER `count` picks `key.zero` …
 * `key.many` when that form exists, otherwise `key` (the "other" form). `{count}` and `{n}` are
 * filled with the formatted number (the user's digits). Never pass a pre-formatted string.
 */
export function tCount(key: MessageKey, count: number, vars?: MessageVars): string {
  return interpolate(plural(count, formsOf(key)), { n: count, ...vars, count });
}

/**
 * For keys built at runtime (`role.${role}`, `audit.action.${action}`). Falls back to
 * `fallback` so a code we have no label for never shows a raw (Latin) identifier.
 */
export function tKey(key: string, fallback: MessageKey, vars?: MessageVars): string {
  const value = (ar as Record<string, string>)[key];
  return interpolate(value ?? ar[fallback], vars);
}

export function hasKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(ar, key);
}

export function interpolate(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) return match;
    return typeof v === 'number' ? formatNumber(v) : v;
  });
}
