/**
 * The worker foreman's hard hat (A10) — the same glyph as the printed card ribbon
 * (`@nuzli/ui-print` HelmetGlyph), so the screen and the card speak one sign. Filled with
 * `currentColor`; decorative unless given a label.
 */
export function HardHat({ size = 16, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={{ flex: 'none', display: 'block' }}
    >
      <path d="M3 17.2h18a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-.8a1 1 0 0 1 1-1z" />
      <path d="M4 16.2a8 8 0 0 1 5.6-7.63V12h1.6V6.3a.8.8 0 0 1 .8-.8h0a.8.8 0 0 1 .8.8V12h1.6V8.57A8 8 0 0 1 20 16.2z" />
    </svg>
  );
}
