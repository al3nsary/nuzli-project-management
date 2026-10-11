import { ar, type MessageKey } from './ar';
import { formatNumber } from './format';

export type { MessageKey } from './ar';
export * from './format';

export type MessageVars = Record<string, string | number | null | undefined>;

/**
 * Looks up an Arabic string and fills `{placeholders}`. Numbers are formatted with the
 * user's digit preference. Unknown placeholders are left visible so they are caught in review.
 */
export function t(key: MessageKey, vars?: MessageVars): string {
  return interpolate(ar[key], vars);
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
