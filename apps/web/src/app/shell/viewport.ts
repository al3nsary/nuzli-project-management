import { useEffect } from 'react';
import { useMediaQuery } from '@mantine/hooks';

/*
 * A12 (owner: «في عرض الهاتف والتابلت… كالسيف»): the shell's three sizes, in one place.
 *
 *  - phone            < 768px            pages switch to their phone layouts (cards, sheets, inbox)
 *  - compact shell    < 1024px           phones and portrait tablets: the five-tab bottom bar, the
 *                                        side as a drawer, the light top bar
 *  - landscape tablet 1024–1279px        the side opens on the 68px rail (unless the user chose)
 *
 * Page components keep their own `(max-width: 767px)` checks; only the shell reads `compact`.
 */
export const PHONE_QUERY = '(max-width: 47.99em)';
export const COMPACT_QUERY = '(max-width: 63.99em)';
export const TABLET_LANDSCAPE_QUERY = '(min-width: 64em) and (max-width: 79.99em)';

const opts = { getInitialValueInEffect: false } as const;

export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY, false, opts) ?? false;
}

export function useCompactShell(): boolean {
  return useMediaQuery(COMPACT_QUERY, false, opts) ?? false;
}

export function useTabletLandscape(): boolean {
  return useMediaQuery(TABLET_LANDSCAPE_QUERY, false, opts) ?? false;
}

/**
 * The on-screen keyboard's height, from `visualViewport` (iOS Safari does not resize the layout
 * viewport when the keyboard opens). Published as `--kb` on <html> so sticky form buttons sit
 * right above the keyboard instead of under it (`bottom: var(--kb)`).
 */
export function keyboardInset(win: Pick<Window, 'innerHeight'> & { visualViewport?: Pick<VisualViewport, 'height' | 'offsetTop'> | null }): number {
  const vv = win.visualViewport;
  if (!vv) return 0;
  const inset = Math.round(win.innerHeight - vv.height - vv.offsetTop);
  // Ignore the toolbar wobble of mobile browsers; a keyboard is always taller than 80px.
  return inset > 80 ? inset : 0;
}

export function useKeyboardInset() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    const root = document.documentElement;
    const apply = () => {
      const kb = keyboardInset(window);
      root.style.setProperty('--kb', `${kb}px`);
      root.toggleAttribute('data-kb', kb > 0);
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
    };
  }, []);
}
