/**
 * A12: the version of this build, stamped by vite.config.ts — the package version (or
 * NUZLI_APP_VERSION), the short git commit and the build time. Shown in «المزيد» next to
 * «البحث عن تحديث», so a field user can tell support exactly which build they run.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
export const APP_BUILD: string = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'local';
export const APP_BUILT_AT: string | null = typeof __APP_BUILT_AT__ !== 'undefined' ? __APP_BUILT_AT__ : null;

/** «0.1.0 (c41a162)». */
export function versionLabel(version = APP_VERSION, build = APP_BUILD): string {
  return build && build !== 'local' ? `${version} (${build})` : version;
}
