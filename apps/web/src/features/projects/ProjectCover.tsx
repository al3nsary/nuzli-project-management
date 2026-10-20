/**
 * The project cover (A12 round 2, owner decision «صورة غلاف اختيارية مع غلاف مولَّد»): the uploaded
 * 16:9 image when the project has one (`hasCover` → `GET /projects/:id/cover-url`), otherwise a
 * generated cover — the project's stable colour (`color`, or `projectColor(id)`), a quiet
 * low-contrast pattern and two initials of its name. If the image fails to load (expired signed
 * URL, offline) the generated cover comes back. Pure CSS/SVG, works in RTL and LTR alike.
 */
import { useId, useState, type CSSProperties } from 'react';
import { projectColor } from '@nuzli/shared';
import { useProjectCoverUrl } from '../../api/a12Queries';
import { initials } from '../../components/UserAvatar';
import { t } from '../../i18n';
import './cover.css';

/** Words that say nothing about a project («مشروع صيانة الحديقة» → «ص‌ح»). */
const FILLER = new Set(['مشروع', 'مشاريع', 'خطة', 'برنامج']);

/** Two letters, Arabic-aware (the article «ال» skipped, «بن» ignored, like person initials). */
export function projectInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w));
  const base = (kept.length ? kept : words).join(' ');
  return initials(base) || '؟';
}

export interface CoverProject {
  id: string;
  name: string;
  hasCover?: boolean;
  color?: string;
}

export function ProjectCover({
  project,
  variant = 'card',
  className,
}: {
  project: CoverProject;
  /** card: 16:9 at the top of a project card · thumb: small 16:9 in the project header · frame: settings preview. */
  variant?: 'card' | 'thumb' | 'frame';
  className?: string;
}) {
  const color = project.color || projectColor(project.id);
  const url = useProjectCoverUrl(project.id, project.hasCover);
  const [failed, setFailed] = useState<string | null>(null);
  const src = project.hasCover && url.data && failed !== url.data ? url.data : null;
  return (
    <div
      className={['nz-cover', className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-testid="project-cover"
      data-kind={src ? 'image' : 'generated'}
      style={{ '--cover': color } as CSSProperties}
      role="img"
      aria-label={t('a12roles.cover.alt', { name: project.name })}
    >
      {src ? (
        <img className="nz-cover-img" src={src} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(src)} />
      ) : (
        <>
          <CoverPattern />
          <span className="nz-cover-initials" aria-hidden>
            {projectInitials(project.name)}
          </span>
        </>
      )}
    </div>
  );
}

/** A quiet diagonal grid of dots and strokes in white at low opacity (decorative, symmetric, no gradient). */
function CoverPattern() {
  const id = `nz-cover-pat-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg className="nz-cover-pattern" aria-hidden focusable="false" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      <defs>
        <pattern id={id} width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
          <path d="M0 14 H28" stroke="#fff" strokeOpacity="0.09" strokeWidth="1" />
          <circle cx="14" cy="14" r="1.6" fill="#fff" fillOpacity="0.16" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
