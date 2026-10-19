// Ported verbatim from apps/api/src/violations/ocr/ocr-parser.ts (ADR-104) — keep both in step.
// The demo reads the card in the browser with the SAME rules as the server.
import { isValidNationalId, toWesternDigits } from '@nuzli/shared';

/**
 * Parses the OCR text of a Saudi national ID card or Iqama (owner request A9, ADR-104).
 * Pure and deterministic, so it is fully unit-tested on synthetic OCR output. The parser never
 * logs or returns the raw text: only the extracted fields, each with a 0–100 confidence.
 */

export interface OcrLine {
  text: string;
  /** Tesseract line confidence 0–100 (unknown → 60). */
  confidence?: number;
}

export interface OcrInput {
  text: string;
  lines?: OcrLine[];
}

export interface ExtractedField {
  value: string;
  confidence: number;
}

export interface ExtractedDate extends ExtractedField {
  calendar: 'HIJRI' | 'GREGORIAN';
}

export interface ExtractedCard {
  nationalId: ExtractedField | null;
  name: ExtractedField | null;
  nameLatin: ExtractedField | null;
  birthDate: ExtractedDate | null;
  expiryDate: ExtractedDate | null;
  nationality: ExtractedField | null;
  /** Number of distinct valid ID numbers seen (more than one lowers the ID confidence). */
  idCandidates: number;
}

const DEFAULT_CONF = 60;
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// ───────────────────────────────────────────── normalisation

const ARABIC_LETTER = /[ء-يٱ-ۓ]/;
const ARABIC_LETTERS_G = /[ء-يٱ-ۓ]/g;
const DIACRITICS = /[ً-ْٰـ]/g; // harakat, superscript alef, tatweel

/** Western digits, no diacritics/tatweel, single spaces. */
export function normaliseLine(text: string): string {
  return toWesternDigits(text).replace(DIACRITICS, '').replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * In number-like tokens OCR often reads O/o/Q/D as 0 and l/I/|/! as 1. Only tokens that are at
 * least 60 % digits (and 3+ characters) are touched, so words stay intact.
 */
export function fixDigitLookalikes(text: string): string {
  return text.replace(/\S+/g, (token) => {
    const digits = token.replace(/\D/g, '').length;
    if (token.length < 3 || digits / token.length < 0.6) return token;
    return token.replace(/[OoQD]/g, '0').replace(/[lI|!]/g, '1');
  });
}

function toLines(input: OcrInput): OcrLine[] {
  const src = input.lines?.length
    ? input.lines
    : input.text.split(/\r?\n/).map((text) => ({ text, confidence: undefined }));
  return src
    .map((l) => ({ text: normaliseLine(l.text ?? ''), confidence: l.confidence ?? DEFAULT_CONF }))
    .filter((l) => l.text.length > 0);
}

// ───────────────────────────────────────────── national ID / Iqama

const ID_LABEL = /(رقم\s*(ال)?(هوية|هويه|الإقامة|الاقامة|إقامة|اقامة|السجل)|السجل\s*المدني|ID\s*(No|Number|#)|Iqama|Identity\s*No|Civil)/i;

export interface IdCandidate {
  value: string;
  /** 3 = a standalone 10-digit run, 2 = digits split by spaces/dashes, 1 = a window inside a longer run. */
  quality: number;
  labelled: boolean;
  lineConfidence: number;
}

/**
 * Every 10-digit sequence starting with 1 or 2 that passes the check digit, after normalising
 * Arabic-Indic digits and digit look-alikes. Candidates with an invalid check digit are dropped.
 */
export function idCandidates(lines: readonly OcrLine[]): IdCandidate[] {
  const out: IdCandidate[] = [];
  const push = (value: string, quality: number, line: OcrLine, labelled: boolean) => {
    if (!isValidNationalId(value)) return;
    out.push({ value, quality, labelled, lineConfidence: line.confidence ?? DEFAULT_CONF });
  };
  lines.forEach((line, i) => {
    const text = fixDigitLookalikes(normaliseLine(line.text));
    const labelled = ID_LABEL.test(line.text) || (i > 0 && ID_LABEL.test(lines[i - 1]!.text) && !/\d{4}/.test(lines[i - 1]!.text));
    // 1) standalone runs of exactly 10 digits
    for (const m of text.matchAll(/(?<!\d)\d{10}(?!\d)/g)) push(m[0], 3, line, labelled);
    // 2) digit groups separated by spaces, dashes or dots ("1 0 2 3 4 5 6 7 8 9", "1023-456-789")
    for (const m of text.matchAll(/\d(?:[ \t.\-–]{0,2}\d)+/g)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length === 10 && /\D/.test(m[0])) push(digits, 2, line, labelled);
      // 3) a longer run (two numbers glued together): every 10-digit window
      if (digits.length > 10 && digits.length <= 24) {
        for (let k = 0; k + 10 <= digits.length; k++) {
          const w = digits.slice(k, k + 10);
          if (w[0] === '1' || w[0] === '2') push(w, 1, line, labelled);
        }
      }
    }
  });
  return out;
}

export function pickNationalId(lines: readonly OcrLine[]): { field: ExtractedField | null; distinct: number } {
  const cands = idCandidates(lines);
  if (!cands.length) return { field: null, distinct: 0 };
  const distinct = new Set(cands.map((c) => c.value)).size;
  const score = (c: IdCandidate) => c.quality * 10 + (c.labelled ? 15 : 0) + c.lineConfidence / 10;
  const best = [...cands].sort((a, b) => score(b) - score(a))[0]!;
  // Confidence: the line confidence, lowered for split/windowed reads and for competing numbers.
  let conf = best.lineConfidence * (best.quality === 3 ? 1 : best.quality === 2 ? 0.85 : 0.6);
  if (best.labelled) conf = Math.min(100, conf + 10);
  if (distinct > 1) conf *= 0.6;
  return { field: { value: best.value, confidence: clamp(conf) }, distinct };
}

// ───────────────────────────────────────────── names

/** Card furniture that is never a person's name. */
const NOT_A_NAME = [
  'المملكة', 'العربية', 'السعودية', 'وزارة', 'الداخلية', 'هوية', 'هويه', 'وطنية', 'وطنيه', 'بطاقة', 'بطاقه',
  'إقامة', 'اقامة', 'اقامه', 'الإقامة', 'الاقامة', 'رقم', 'تاريخ', 'الميلاد', 'الانتهاء', 'الإنتهاء', 'الإصدار',
  'الاصدار', 'الجنسية', 'الجنسيه', 'المهنة', 'المهنه', 'مكان', 'صاحب', 'العمل', 'الديانة', 'الديانه', 'الجوازات',
  'المديرية', 'العامة', 'للجوازات', 'الأحوال', 'الاحوال', 'المدنية', 'المدنيه', 'السجل', 'المدني', 'الحالة',
  'صلاحية', 'صالحة', 'حتى', 'هـ', 'م', 'ذكر', 'أنثى', 'انثى', 'الجنس', 'النسخة', 'مقيم', 'زائر',
  // The demo cards' banner «بطاقة تجريبية — ليست وثيقة حقيقية» (A9 QA: it was read as a name).
  'تجريبية', 'تجريبيه', 'ليست', 'وثيقة', 'وثيقه', 'وثبقة', 'حقيقية', 'حقيقيه',
];
const NOT_A_NAME_SET = new Set(NOT_A_NAME);
const NAME_LABEL = /^(?:ال)?اسم(?:\s*الكامل)?\s*[:：\-]?\s*/;
const LATIN_NOISE = /\b(KINGDOM|SAUDI|ARABIA|MINISTRY|INTERIOR|IDENTITY|CARD|RESIDENT|IDENTITY|PERMIT|NATIONAL|NATIONALITY|DATE|BIRTH|EXPIRY|ISSUE|PLACE|SEX|OCCUPATION|EMPLOYER|NO|NUMBER|VERSION|IQAMA)\b/i;

function arabicRatio(text: string): number {
  const letters = text.replace(/[\s\d\p{P}]/gu, '');
  if (!letters.length) return 0;
  return (text.match(ARABIC_LETTERS_G)?.length ?? 0) / letters.length;
}

/** Keeps Arabic letters and spaces; drops furniture words; 2–6 words of ≥ 2 letters, else null. */
export function cleanArabicName(text: string): string | null {
  const words = text
    .replace(/[^ء-يٱ-ۓ\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 1);
  // Keep single-letter particles only inside a name ("عبد ال رحمن" style splits are rare); drop furniture.
  const kept = words.filter((w) => !NOT_A_NAME_SET.has(w) && (w.length >= 2 || w === 'و'));
  if (kept.length < 2 || kept.length > 6) return null;
  if (kept.some((w) => w.length > 15)) return null;
  return kept.join(' ');
}

export function pickArabicName(lines: readonly OcrLine[]): ExtractedField | null {
  // 1) a line labelled «الاسم» (the value on the same line after the label, or the next line)
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.text;
    const m = t.match(/(?:^|\s)(?:ال)?اسم(?:\s*الكامل)?\s*[:：\-]?\s*(.*)$/);
    if (!m) continue;
    const same = cleanArabicName(m[1] ?? '');
    if (same) return { value: same, confidence: clamp((lines[i]!.confidence ?? DEFAULT_CONF) + 5) };
    const next = lines[i + 1];
    const below = next && !/\d{4}/.test(next.text) ? cleanArabicName(next.text.replace(NAME_LABEL, '')) : null;
    if (below) return { value: below, confidence: clamp((next!.confidence ?? DEFAULT_CONF) + 5) };
  }
  // 2) otherwise the longest mostly-Arabic, digit-free line in the top two thirds of the card
  const limit = Math.max(3, Math.ceil(lines.length * 0.67));
  let best: { value: string; conf: number; score: number } | null = null;
  lines.slice(0, limit).forEach((l, idx) => {
    if (/\d/.test(l.text) || !ARABIC_LETTER.test(l.text) || arabicRatio(l.text) < 0.8) return;
    const value = cleanArabicName(l.text);
    if (!value) return;
    const score = value.length - idx * 0.5;
    if (!best || score > best.score) best = { value, conf: (l.confidence ?? DEFAULT_CONF) * 0.8, score };
  });
  const found = best as { value: string; conf: number; score: number } | null;
  return found ? { value: found.value, confidence: clamp(found.conf) } : null;
}

export function pickLatinName(lines: readonly OcrLine[]): ExtractedField | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.text.match(/\bName\s*[:：]?\s*([A-Za-z][A-Za-z .'-]{3,})$/i);
    if (m) {
      const v = m[1]!.replace(/\s+/g, ' ').trim().toUpperCase();
      if (v.split(' ').length >= 2) return { value: v, confidence: clamp(lines[i]!.confidence ?? DEFAULT_CONF) };
    }
  }
  let best: { value: string; conf: number } | null = null;
  for (const l of lines) {
    if (/\d/.test(l.text) || LATIN_NOISE.test(l.text)) continue;
    if (!/^[A-Z][A-Z .'-]+$/.test(l.text)) continue;
    const words = l.text.split(' ').filter((w) => w.length >= 2);
    if (words.length < 2 || words.length > 6) continue;
    if (!best || l.text.length > best.value.length) best = { value: words.join(' '), conf: (l.confidence ?? DEFAULT_CONF) * 0.8 };
  }
  return best ? { value: best.value, confidence: clamp(best.conf) } : null;
}

// ───────────────────────────────────────────── dates

const BIRTH_LABEL = /(الميلاد|ميلاد|Birth|DOB)/i;
const EXPIRY_LABEL = /(الانتهاء|الإنتهاء|انتهاء|إنتهاء|صالحة\s*حتى|Expiry|Expiration|Valid\s*until)/i;
const ISSUE_LABEL = /(الإصدار|الاصدار|إصدار|اصدار|Issue)/i;

interface DateHit {
  value: string;
  calendar: 'HIJRI' | 'GREGORIAN';
  /** Approximate Gregorian year, to order Hijri and Gregorian dates together. */
  approxYear: number;
  label: 'BIRTH' | 'EXPIRY' | 'ISSUE' | null;
  confidence: number;
  index: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

function toDateHit(y: number, m: number, d: number): Pick<DateHit, 'value' | 'calendar' | 'approxYear'> | null {
  if (m < 1 || m > 12 || d < 1 || d > (y >= 1300 && y <= 1600 ? 30 : 31)) return null;
  if (y >= 1300 && y <= 1600) return { value: `${y}-${pad(m)}-${pad(d)}`, calendar: 'HIJRI', approxYear: Math.round(y * 0.97 + 622) };
  if (y >= 1900 && y <= 2100) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return { value: `${y}-${pad(m)}-${pad(d)}`, calendar: 'GREGORIAN', approxYear: y };
  }
  return null;
}

export function findDates(lines: readonly OcrLine[]): DateHit[] {
  const hits: DateHit[] = [];
  lines.forEach((line, index) => {
    const text = fixDigitLookalikes(normaliseLine(line.text));
    const label = BIRTH_LABEL.test(text) ? 'BIRTH' : EXPIRY_LABEL.test(text) ? 'EXPIRY' : ISSUE_LABEL.test(text) ? 'ISSUE' : null;
    const prevLabel =
      index > 0 && !/\d{4}/.test(lines[index - 1]!.text)
        ? BIRTH_LABEL.test(lines[index - 1]!.text)
          ? 'BIRTH'
          : EXPIRY_LABEL.test(lines[index - 1]!.text)
            ? 'EXPIRY'
            : ISSUE_LABEL.test(lines[index - 1]!.text)
              ? 'ISSUE'
              : null
        : null;
    const conf = line.confidence ?? DEFAULT_CONF;
    // yyyy/mm/dd
    for (const m of text.matchAll(/(?<!\d)(\d{4})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?!\d)/g)) {
      const h = toDateHit(+m[1]!, +m[2]!, +m[3]!);
      if (h) hits.push({ ...h, label: label ?? prevLabel, confidence: conf, index });
    }
    // dd/mm/yyyy
    for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4})(?!\d)/g)) {
      const h = toDateHit(+m[3]!, +m[2]!, +m[1]!);
      if (h) hits.push({ ...h, label: label ?? prevLabel, confidence: conf, index });
    }
  });
  return hits;
}

export function pickDates(lines: readonly OcrLine[]): { birthDate: ExtractedDate | null; expiryDate: ExtractedDate | null } {
  const hits = findDates(lines);
  const asField = (h: DateHit | undefined, factor: number): ExtractedDate | null =>
    h ? { value: h.value, calendar: h.calendar, confidence: clamp(h.confidence * factor) } : null;
  let birth = hits.find((h) => h.label === 'BIRTH');
  let expiry = hits.find((h) => h.label === 'EXPIRY');
  const unlabelled = hits.filter((h) => !h.label).sort((a, b) => a.approxYear - b.approxYear);
  let birthFactor = 1;
  let expiryFactor = 1;
  // Without labels: the earliest date is the birth date, the latest one the expiry date.
  if (!birth && unlabelled.length) {
    birth = unlabelled[0];
    birthFactor = 0.6;
  }
  if (!expiry && unlabelled.length > 1) {
    const last = unlabelled[unlabelled.length - 1]!;
    if (last !== birth && last.approxYear >= 2000) {
      expiry = last;
      expiryFactor = 0.6;
    }
  }
  return { birthDate: asField(birth, birthFactor), expiryDate: asField(expiry, expiryFactor) };
}

// ───────────────────────────────────────────── nationality

const NATIONALITIES = [
  'سعودي', 'سعودية', 'هندي', 'هندية', 'باكستاني', 'باكستانية', 'بنغلاديشي', 'بنغلاديشية', 'بنجلاديشي', 'مصري', 'مصرية',
  'يمني', 'يمنية', 'سوداني', 'سودانية', 'فلبيني', 'فلبينية', 'نيبالي', 'نيبالية', 'إندونيسي', 'اندونيسي', 'إندونيسية',
  'سريلانكي', 'سريلانكية', 'أردني', 'اردني', 'سوري', 'سورية', 'لبناني', 'فلسطيني', 'إثيوبي', 'اثيوبي', 'كيني', 'أوغندي',
  'تركي', 'أفغاني', 'افغاني', 'ميانماري', 'تشادي', 'نيجيري', 'مغربي', 'تونسي', 'جزائري', 'عراقي', 'أمريكي', 'بريطاني',
];
const LATIN_NATIONALITIES = /\b(SAUDI|INDIA|INDIAN|PAKISTAN|PAKISTANI|BANGLADESH|BANGLADESHI|EGYPT|EGYPTIAN|YEMEN|YEMENI|SUDAN|SUDANESE|PHILIPPINES|FILIPINO|NEPAL|NEPALI|INDONESIA|INDONESIAN|SRI LANKA|SRI LANKAN|JORDAN|JORDANIAN|SYRIA|SYRIAN|ETHIOPIA|ETHIOPIAN|KENYA|KENYAN|UGANDA|UGANDAN)\b/i;

export function pickNationality(lines: readonly OcrLine[], idValue: string | null): ExtractedField | null {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.text;
    const conf = lines[i]!.confidence ?? DEFAULT_CONF;
    const m = t.match(/(?:الجنسية|الجنسيه)\s*[:：\-]?\s*([ء-ي ]{3,})/);
    if (m) {
      const word = m[1]!.trim().split(' ')[0]!;
      if (word.length >= 3) return { value: word, confidence: clamp(conf) };
    }
    const en = t.match(/Nationality\s*[:：]?\s*([A-Za-z ]{3,})/i);
    if (en) return { value: en[1]!.trim().toUpperCase(), confidence: clamp(conf) };
  }
  for (const l of lines) {
    const word = l.text.split(' ').find((w) => NATIONALITIES.includes(w));
    if (word) return { value: word, confidence: clamp((l.confidence ?? DEFAULT_CONF) * 0.7) };
    const en = l.text.match(LATIN_NATIONALITIES);
    if (en && !/KINGDOM|ARABIA/i.test(l.text)) return { value: en[1]!.toUpperCase(), confidence: clamp((l.confidence ?? DEFAULT_CONF) * 0.6) };
  }
  // A national ID starting with 1 belongs to a Saudi citizen (brief §4.2).
  if (idValue?.startsWith('1')) return { value: 'سعودي', confidence: 50 };
  return null;
}

// ───────────────────────────────────────────── entry point

export function parseIdCard(input: OcrInput): ExtractedCard {
  const lines = toLines(input);
  const { field: nationalId, distinct } = pickNationalId(lines);
  const { birthDate, expiryDate } = pickDates(lines);
  return {
    nationalId,
    name: pickArabicName(lines),
    nameLatin: pickLatinName(lines),
    birthDate,
    expiryDate,
    nationality: pickNationality(lines, nationalId?.value ?? null),
    idCandidates: distinct,
  };
}
