/**
 * Physical offsets do not flip with `dir` (skill nuzli-arabic-rtl): `scrollLeft`, `scrollBy`,
 * `translateX` and pointer `clientX` deltas are physical. Multiply a logical offset
 * ("towards the inline end") by this sign before using it: -1 in RTL, 1 in LTR.
 */
export function dirSign(el?: Element | null): 1 | -1 {
  const node = el ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!node) return -1;
  const dir =
    typeof getComputedStyle === 'function'
      ? getComputedStyle(node).direction || node.closest('[dir]')?.getAttribute('dir')
      : node.closest('[dir]')?.getAttribute('dir');
  return dir === 'ltr' ? 1 : -1;
}

/** Scrolls a horizontal scroller by `logical` pixels towards its inline end, in either direction. */
export function scrollInline(el: HTMLElement, logical: number, smooth = true) {
  el.scrollBy({ left: logical * dirSign(el), behavior: smooth ? 'smooth' : 'auto' });
}
