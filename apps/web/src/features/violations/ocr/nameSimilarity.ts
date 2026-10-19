// Ported verbatim from apps/api/src/violations/ocr/name-similarity.ts (ADR-104) — keep both in step.
/**
 * Name similarity for OCR suggestions (A9, ADR-104): Dice coefficient over character trigrams
 * of a normalised Arabic (or Latin) name — the same idea as PostgreSQL pg_trgm, in plain JS so no
 * extension is needed. Word order is ignored by also comparing the sorted words.
 */

/** Unifies spellings OCR and people mix up: alef forms, taa marbuta, alef maqsura, hamza seats. */
export function normaliseName(name: string): string {
  return name
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\s]/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function trigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const word of text.split(' ')) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      const g = padded.slice(i, i + 3);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
  }
  return out;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const n of a.values()) sizeA += n;
  for (const n of b.values()) sizeB += n;
  if (!sizeA || !sizeB) return 0;
  for (const [g, n] of a) inter += Math.min(n, b.get(g) ?? 0);
  return (2 * inter) / (sizeA + sizeB);
}

/** 0–1. 1 = same name after normalisation. */
export function nameSimilarity(a: string, b: string): number {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const full = dice(trigrams(na), trigrams(nb));
  const sorted = dice(trigrams(na.split(' ').sort().join(' ')), trigrams(nb.split(' ').sort().join(' ')));
  return Math.round(Math.max(full, sorted) * 1000) / 1000;
}

/** The best matches above `threshold`, highest first. */
export function rankByName<T extends { fullName: string }>(
  target: string,
  rows: readonly T[],
  opts: { threshold?: number; limit?: number } = {},
): Array<T & { score: number }> {
  const threshold = opts.threshold ?? 0.45;
  const limit = opts.limit ?? 5;
  return rows
    .map((r) => ({ ...r, score: nameSimilarity(target, r.fullName) }))
    .filter((r) => r.score >= threshold)
    .sort((x, y) => y.score - x.score || x.fullName.localeCompare(y.fullName, 'ar'))
    .slice(0, limit);
}
