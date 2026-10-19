/**
 * Owner request A11: the Figma project-dashboard design is a SECOND design, switched with a button
 * in the top bar so the owner can compare the two. «classic» (the current design) is the default
 * and is untouched; «figma» only adds `html[data-design='figma']` overrides (design-figma.css) and
 * a few extra pieces of markup. On approval the loser is deleted.
 *
 * The choice is remembered per browser (localStorage, try/catch) and can be forced with
 * `?design=figma` or `?design=classic` in any URL (handy for side-by-side windows).
 */
import { create } from 'zustand';

export type Design = 'classic' | 'figma';
export const DESIGN_STORAGE_KEY = 'nz.design';

function readStored(): Design {
  try {
    return window.localStorage.getItem(DESIGN_STORAGE_KEY) === 'figma' ? 'figma' : 'classic';
  } catch {
    return 'classic';
  }
}

function writeStored(design: Design) {
  try {
    window.localStorage.setItem(DESIGN_STORAGE_KEY, design);
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
}

function apply(design: Design) {
  if (typeof document === 'undefined') return;
  if (design === 'figma') document.documentElement.setAttribute('data-design', 'figma');
  else document.documentElement.removeAttribute('data-design');
}

/** The design to start with: the URL wins (and is remembered), then the stored choice. */
export function initialDesign(search = typeof window !== 'undefined' ? window.location.search : ''): Design {
  const q = new URLSearchParams(search).get('design');
  if (q === 'figma' || q === 'classic') {
    writeStored(q);
    return q;
  }
  return readStored();
}

interface DesignState {
  design: Design;
  setDesign(design: Design): void;
  toggle(): void;
}

export const useDesignStore = create<DesignState>((set, get) => ({
  design: 'classic',
  setDesign(design) {
    writeStored(design);
    apply(design);
    set({ design });
  },
  toggle() {
    get().setDesign(get().design === 'figma' ? 'classic' : 'figma');
  },
}));

/** Applies the starting design to <html> and the store before the first render (no flash). */
export function bootDesign(): void {
  const design = initialDesign();
  apply(design);
  useDesignStore.setState({ design });
}

/** True while the Figma design is on. */
export const useFigma = () => useDesignStore((s) => s.design === 'figma');
