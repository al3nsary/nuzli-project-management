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
  ctx.fillStyle = '#1F2430';
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
  ctx.fillStyle = '#1F2430';
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

/**
 * Owner request A9 (demo seed): a synthetic ID card drawn on a canvas, clearly marked
 * «بطاقة تجريبية — ليست وثيقة حقيقية». Plain black text on white in large type, the number in
 * clear Western digits on its own line under its label, so the in-browser OCR demonstrably
 * reads it. The number is generated to pass the check digit and belongs to nobody.
 */
export async function drawIdCard(card: {
  name: string;
  nameLatin?: string;
  nationalId: string;
  nationality: string;
  birthDate: string;
  expiryDate: string;
}): Promise<{ data: ArrayBuffer; type: string }> {
  if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return fallback();
  const w = 1400;
  const h = 880;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return fallback();
  const arabic = (px: number, weight = 600) => `${weight} ${px}px Tahoma, "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  // A thin frame and a header band that says plainly what this is.
  ctx.strokeStyle = '#9AA3B2';
  ctx.lineWidth = 6;
  ctx.strokeRect(12, 12, w - 24, h - 24);
  ctx.fillStyle = '#B42318';
  ctx.fillRect(12, 12, w - 24, 92);
  ctx.fillStyle = '#FFFFFF';
  ctx.direction = 'rtl';
  ctx.textAlign = 'center';
  ctx.font = arabic(46, 700);
  ctx.fillText('بطاقة تجريبية — ليست وثيقة حقيقية', w / 2, 76);

  // Photo area (an abstract silhouette) on the physical left, text on the right (RTL card).
  ctx.fillStyle = '#E4E7EC';
  ctx.fillRect(60, 150, 300, 380);
  ctx.fillStyle = '#98A2B3';
  ctx.beginPath();
  ctx.ellipse(210, 290, 80, 96, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(210, 540, 130, 120, 0, Math.PI, 0);
  ctx.fill();

  const right = w - 70;
  ctx.fillStyle = '#101828';
  ctx.textAlign = 'right';
  ctx.direction = 'rtl';
  ctx.font = arabic(52, 700);
  ctx.fillText(`الاسم: ${card.name}`, right, 200);
  if (card.nameLatin) {
    ctx.direction = 'ltr';
    ctx.textAlign = 'right';
    ctx.font = '600 40px Arial, sans-serif';
    ctx.fillText(card.nameLatin, right, 265);
    ctx.direction = 'rtl';
  }
  ctx.font = arabic(46, 600);
  ctx.fillText('رقم الهوية', right, 350);
  // The number alone on its line, large and in Western digits.
  ctx.direction = 'ltr';
  ctx.textAlign = 'right';
  ctx.font = '700 88px "Courier New", Consolas, monospace';
  ctx.fillText(card.nationalId, right, 450);
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.font = arabic(44, 600);
  ctx.fillText(`الجنسية: ${card.nationality}`, right, 560);
  ctx.fillText(`تاريخ الميلاد: ${card.birthDate}`, right, 640);
  ctx.fillText(`تاريخ الانتهاء: ${card.expiryDate}`, right, 720);
  ctx.font = arabic(28, 400);
  ctx.fillStyle = '#667085';
  ctx.textAlign = 'center';
  ctx.fillText('نسخة العرض — بيانات مختلقة لأغراض التجربة فقط', w / 2, h - 50);

  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/png');
    } catch {
      resolve(null);
    }
  });
  if (!blob) return fallback();
  return { data: await blob.arrayBuffer(), type: 'image/png' };
}

/** A9 demo seed: a minimal one-page PDF (a framed blank page) for seeded task attachments. */
export function placeholderPdf(): { data: ArrayBuffer; type: string } {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
  ];
  const stream = '0.19 0.25 0.62 RG 4 w 40 40 515 762 re S 0.9 0.92 0.97 rg 80 600 435 160 re f';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new TextEncoder().encode(out);
  return { data: bytes.buffer.slice(0) as ArrayBuffer, type: 'application/pdf' };
}
