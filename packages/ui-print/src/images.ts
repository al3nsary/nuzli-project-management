export interface CardImagesResult {
  total: number;
  loaded: number;
  failed: number;
  /** True when the timeout fired before every image settled. */
  timedOut: boolean;
}

/** Default wait before printing anyway (photos are presigned URLs of a few hundred KB). */
export const CARD_IMAGES_TIMEOUT_MS = 10_000;

function settled(img: HTMLImageElement): 'loaded' | 'failed' | null {
  if (!img.getAttribute('src')) return 'failed';
  if (!img.complete) return null;
  return img.naturalWidth > 0 ? 'loaded' : 'failed';
}

/**
 * Resolves once every image inside the cards under `root` (photos, logos, PNG QR codes) has
 * loaded or failed, or after `timeoutMs` — call it before `window.print()` so a card never
 * prints with a blank photo frame (owner request A8). Never rejects.
 */
export function waitForCardImages(
  root: ParentNode,
  timeoutMs: number = CARD_IMAGES_TIMEOUT_MS,
): Promise<CardImagesResult> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('.nz-card img'));
  const result: CardImagesResult = { total: images.length, loaded: 0, failed: 0, timedOut: false };
  const pending: HTMLImageElement[] = [];
  for (const img of images) {
    const state = settled(img);
    if (state === 'loaded') result.loaded++;
    else if (state === 'failed') result.failed++;
    else pending.push(img);
  }
  if (!pending.length) return Promise.resolve(result);

  return new Promise((resolve) => {
    let left = pending.length;
    const cleanups: Array<() => void> = [];
    const finish = () => {
      clearTimeout(timer);
      for (const c of cleanups) c();
      resolve(result);
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      finish();
    }, timeoutMs);
    for (const img of pending) {
      const done = (ok: boolean) => () => {
        if (ok) result.loaded++;
        else result.failed++;
        cleanup();
        if (--left === 0) finish();
      };
      const onLoad = done(true);
      const onError = done(false);
      const cleanup = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      cleanups.push(cleanup);
    }
  });
}
