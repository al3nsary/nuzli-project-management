import type { CSSProperties, ReactNode } from 'react';

interface VestBandProps {
  /** Team colour (hex). Defaults to the field teal. */
  color?: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  component?: 'div' | 'span' | 'li' | 'section';
}

/** Wraps any team-bound object with the vest band on its inline-start edge. */
export function VestBand({ color, children, className, style, component = 'div' }: VestBandProps) {
  const Tag = component;
  const vars = { '--team': color ?? 'var(--field)' } as CSSProperties;
  return (
    <Tag className={['vest', className].filter(Boolean).join(' ')} style={{ ...vars, ...style }}>
      {children}
    </Tag>
  );
}
