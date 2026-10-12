/**
 * Placeholder "photos" for the seeded demo violations: drawn on a canvas when first viewed,
 * clearly labelled as demo images. Never real photos (seed/demo/README.md).
 */

/** 1×1 grey PNG, used where no canvas exists (tests, very old browsers). */
const FALLBACK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+f9/PQAJYwPVb6U3SQAAAABJRU5ErkJggg==';

function fallback(): { data: ArrayBuffer; type: string } {
  const bin = atob(FALLBACK_PNG);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { data: bytes.buffer, type: 'image/png' };
}

export async function drawPlaceholder(opts: {
  title: string;
  subtitle: string;
  hue: number;
  idCard?: boolean;
}): Promise<{ data: ArrayBuffer; type: string }> {
  // jsdom (tests) has no canvas.
  if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return fallback();
  const canvas = document.createElement('canvas');
  const w = opts.idCard ? 856 : 960;
  const h = opts.idCard ? 540 : 720;
  canvas.width = w;
  canvas.height = h;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return fallback();

  // Muted background with diagonal hatching, so it never reads as a real photo.
  ctx.fillStyle = `hsl(${opts.hue} 18% 86%)`;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = `hsl(${opts.hue} 20% 76%)`;
  ctx.lineWidth = 14;
  for (let x = -h; x < w; x += 56) {
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + h, 0);
    ctx.stroke();
  }
  if (opts.idCard) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(40, 40, w - 80, h - 80);
    ctx.fillStyle = `hsl(${opts.hue} 25% 70%)`;
    ctx.fillRect(w - 260, 90, 180, 220);
  }
  ctx.fillStyle = '#0D1A13';
  ctx.direction = 'rtl';
  ctx.textAlign = 'center';
  ctx.font = `600 ${opts.idCard ? 44 : 56}px "IBM Plex Sans Arabic", system-ui, sans-serif`;
  ctx.fillText(opts.title, w / 2, h / 2 - 10);
  ctx.font = `400 ${opts.idCard ? 28 : 32}px "IBM Plex Sans Arabic", system-ui, sans-serif`;
  ctx.fillStyle = '#5B6B72';
  ctx.fillText(opts.subtitle, w / 2, h / 2 + 48);

  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8);
    } catch {
      resolve(null);
    }
  });
  if (!blob) return fallback();
  return { data: await blob.arrayBuffer(), type: 'image/jpeg' };
}

/**
 * Owner request A8: a generated placeholder portrait for seeded demo members and supervisors —
 * an abstract silhouette in muted tones with a «تجريبية» tag. Never a real face or stock photo.
 */
export async function drawPortrait(opts: { hue: number; variant?: number }): Promise<{ data: ArrayBuffer; type: string }> {
  if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return fallback();
  const size = 600;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return fallback();
  const h = opts.hue;
  const v = (opts.variant ?? 0) % 3;
  const bg = ctx.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, `hsl(${h} 22% 84%)`);
  bg.addColorStop(1, `hsl(${(h + 24) % 360} 18% 72%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  // Soft concentric rings behind the figure, so it reads as an illustration.
  ctx.strokeStyle = `hsla(${h} 25% 96% / .35)`;
  ctx.lineWidth = 10;
  for (let r = 120; r < 520; r += 70) {
    ctx.beginPath();
    ctx.arc(size / 2, size * 0.42, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  const ink = `hsl(${h} 16% ${38 + v * 6}%)`;
  ctx.fillStyle = ink;
  // Shoulders.
  ctx.beginPath();
  ctx.ellipse(size / 2, size * 0.98, size * (0.36 + v * 0.03), size * 0.32, 0, Math.PI, 0);
  ctx.fill();
  // Neck.
  ctx.fillRect(size / 2 - 38, size * 0.52, 76, 90);
  // Head (a plain oval — no features).
  ctx.beginPath();
  ctx.ellipse(size / 2, size * 0.4, 104 - v * 6, 124 - v * 4, 0, 0, Math.PI * 2);
  ctx.fill();
  if (v === 1) {
    // A headscarf-like outline for variety, still abstract.
    ctx.beginPath();
    ctx.ellipse(size / 2, size * 0.42, 132, 150, 0, Math.PI * 1.05, Math.PI * 1.95);
    ctx.lineWidth = 26;
    ctx.strokeStyle = `hsl(${h} 14% 30%)`;
    ctx.stroke();
  }
  // Demo tag.
  ctx.fillStyle = 'rgba(255,255,255,.78)';
  ctx.fillRect(size / 2 - 92, size - 76, 184, 44);
  ctx.fillStyle = '#0D1A13';
  ctx.direction = 'rtl';
  ctx.textAlign = 'center';
  ctx.font = '600 26px "IBM Plex Sans Arabic", system-ui, sans-serif';
  ctx.fillText('صورة تجريبية', size / 2, size - 45);
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85);
    } catch {
      resolve(null);
    }
  });
  if (!blob) return fallback();
  return { data: await blob.arrayBuffer(), type: 'image/jpeg' };
}
