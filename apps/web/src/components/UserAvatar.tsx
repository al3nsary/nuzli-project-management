import { useState, type CSSProperties } from 'react';

/** Two initials, skipping «بن/بنت» and the article «ال» («نورة بنت سعد العتيبي» → «ن ع»). */
export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p && p !== 'بن' && p !== 'بنت');
  const pick = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts;
  // A zero-width non-joiner keeps the two letters apart (no ligature).
  return pick.map((p) => p.replace(/^ال(?=.)/, '')[0] ?? '').join('‌');
}

/**
 * The person avatar used across the app. Today it shows initials on the Muhsen green with a gold
 * ring; `photoUrl` is ready for the personal photos (owner request A8) — when it fails to load
 * the initials come back.
 */
export function UserAvatar({
  name,
  photoUrl,
  size = 34,
  ring = true,
  className,
  style,
}: {
  name: string;
  photoUrl?: string | null;
  size?: number;
  ring?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const [broken, setBroken] = useState(false);
  const showPhoto = Boolean(photoUrl) && !broken;
  return (
    <span
      className={['nz-avatar', ring ? 'nz-avatar--ring' : '', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), ...style }}
      aria-hidden
    >
      {showPhoto ? (
        <img src={photoUrl ?? undefined} alt="" onError={() => setBroken(true)} draggable={false} />
      ) : (
        <span>{initials(name)}</span>
      )}
    </span>
  );
}
