import type { CSSProperties } from 'react';

interface TeamBadgeProps {
  name: string;
  color: string;
  size?: 'sm' | 'md';
}

/**
 * A team chip: the vest band in the team colour, always next to the team name —
 * colour is never the only signal (brief §12).
 */
export function TeamBadge({ name, color, size = 'md' }: TeamBadgeProps) {
  const style = {
    '--team': color,
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    overflow: 'hidden',
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    paddingInlineEnd: size === 'sm' ? 8 : 12,
    fontSize: size === 'sm' ? 'var(--fs-xs)' : 'var(--fs-sm)',
    fontWeight: 500,
    lineHeight: size === 'sm' ? '22px' : '28px',
    whiteSpace: 'nowrap',
  } as CSSProperties;
  return (
    <span className="vest" style={style} data-team-color={color}>
      {name}
    </span>
  );
}
