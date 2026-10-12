import { useEffect, useState, type CSSProperties } from 'react';
import type { PhotoTarget } from '../api/client';
import { usePhotoUrl } from '../api/photoQueries';

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
 * The person avatar used across the app: initials on the Muhsen green with a gold ring, or the
 * personal photo (owner request A8) when `photoUrl` is given — if it fails to load (expired
 * signed URL, offline) the initials come back. Photos are fetched with no referrer.
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
  useEffect(() => setBroken(false), [photoUrl]);
  const showPhoto = Boolean(photoUrl) && !broken;
  return (
    <span
      className={['nz-avatar', ring ? 'nz-avatar--ring' : '', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), ...style }}
      data-photo={showPhoto || undefined}
      aria-hidden
    >
      {showPhoto ? (
        <img
          src={photoUrl ?? undefined}
          alt=""
          onError={() => setBroken(true)}
          draggable={false}
          referrerPolicy="no-referrer"
          decoding="async"
        />
      ) : (
        <span>{initials(name)}</span>
      )}
    </span>
  );
}

/** A person with a photo record: fetches the signed URL (when `hasPhoto`) and renders the avatar. */
export function PhotoAvatar({
  target,
  name,
  hasPhoto,
  fileId,
  size,
  ring,
  className,
  style,
}: {
  target: PhotoTarget | null;
  name: string;
  /** False skips the request; undefined (unknown) asks once and treats 404 as "no photo". */
  hasPhoto?: boolean;
  fileId?: string | null;
  size?: number;
  ring?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const url = usePhotoUrl(target, { hasPhoto, fileId });
  return <UserAvatar name={name} photoUrl={url} size={size} ring={ring} className={className} style={style} />;
}

/** Shorthand for a team member. */
export function MemberAvatar({
  member,
  size = 28,
  ring = false,
}: {
  member: { id: string; fullName: string; hasPhoto?: boolean; photoFileId?: string | null };
  size?: number;
  ring?: boolean;
}) {
  return (
    <PhotoAvatar
      target={{ kind: 'member', id: member.id }}
      name={member.fullName}
      hasPhoto={member.hasPhoto ?? Boolean(member.photoFileId)}
      fileId={member.photoFileId}
      size={size}
      ring={ring}
    />
  );
}

/** Shorthand for a login user (the signed-in user's own photo uses `/me`). */
export function UserPhotoAvatar({
  user,
  self = false,
  size = 28,
  ring = false,
}: {
  user: { id: string; fullName: string; hasPhoto?: boolean; photoFileId?: string | null };
  self?: boolean;
  size?: number;
  ring?: boolean;
}) {
  return (
    <PhotoAvatar
      target={{ kind: self ? 'me' : 'user', id: user.id }}
      name={user.fullName}
      hasPhoto={user.hasPhoto ?? (user.photoFileId === undefined ? undefined : Boolean(user.photoFileId))}
      fileId={user.photoFileId}
      size={size}
      ring={ring}
    />
  );
}
