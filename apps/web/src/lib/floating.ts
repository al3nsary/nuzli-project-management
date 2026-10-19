/**
 * A10: menus that never open past the page edge. Mantine's default `shift` uses floating-ui's
 * `limitShift`, which keeps the dropdown glued to its target — so a menu opened on a card whose
 * board column is partly scrolled off-screen followed the card out of the viewport. Here the
 * dropdown (rendered in a portal, so its boundary is the viewport) may slide freely along both
 * axes with an 8px margin, and flips to the other side or the other end when there is no room.
 */
import type { MenuProps } from '@mantine/core';

type Middlewares = NonNullable<MenuProps['middlewares']>;

export const EDGE_SAFE_MIDDLEWARES: Middlewares = {
  flip: { padding: 8, fallbackPlacements: ['bottom-start', 'top-end', 'top-start'] },
  shift: { padding: 8, crossAxis: true, limiter: { fn: ({ x, y }: { x: number; y: number }) => ({ x, y }) } },
};

/** Brings a menu's target fully into view (nearest edge) before its dropdown is positioned. */
export function revealTarget(el: HTMLElement | null): void {
  el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
