/**
 * The task chat timeline (owner request A9: «ملاحظات مثل الشات على كل مهمة»): comments and
 * attachments of one task in one list ordered by time, with day separators and the «غير مقروءة»
 * divider at the first message by someone else after the viewer's read mark. Pure, so it is
 * unit-tested without the DOM.
 */
import type { TaskAttachmentDto, TaskCommentDto } from '@nuzli/shared';
import { riyadhDay } from '../../i18n/format';

export type ChatEntry =
  | { kind: 'comment'; id: string; at: string; authorId: string; authorName: string; comment: TaskCommentDto }
  | { kind: 'file'; id: string; at: string; authorId: string | null; authorName: string; file: TaskAttachmentDto };

export type TimelineRow =
  | { type: 'day'; key: string; day: string }
  | { type: 'unread'; key: string }
  | {
      type: 'entry';
      key: string;
      entry: ChatEntry;
      mine: boolean;
      /** The first of a run by the same author within a few minutes: shows avatar and name. */
      head: boolean;
    };

/** Messages by one author closer than this are grouped under one avatar. */
export const GROUP_GAP_MS = 5 * 60_000;

export function mergeEntries(comments: readonly TaskCommentDto[], files: readonly TaskAttachmentDto[]): ChatEntry[] {
  const out: ChatEntry[] = [
    ...comments.map((c): ChatEntry => ({ kind: 'comment', id: c.id, at: c.createdAt, authorId: c.author.id, authorName: c.author.fullName, comment: c })),
    ...files.map(
      (f): ChatEntry => ({ kind: 'file', id: f.id, at: f.createdAt, authorId: f.uploadedBy?.id ?? null, authorName: f.uploadedBy?.fullName ?? '', file: f }),
    ),
  ];
  return out.sort((a, b) => a.at.localeCompare(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Id of the first comment by someone else after `readMark` (null: nothing unread). */
export function firstUnreadId(entries: readonly ChatEntry[], viewerId: string | null, readMark: string | null | undefined): string | null {
  // `undefined` = the mark is not known yet: no divider rather than a wrong one.
  if (readMark === undefined) return null;
  const hit = entries.find((e) => e.kind === 'comment' && e.authorId !== viewerId && (readMark === null || e.at > readMark));
  return hit?.id ?? null;
}

export function buildTimeline(entries: readonly ChatEntry[], viewerId: string | null, unreadId: string | null): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let day = '';
  let prev: ChatEntry | null = null;
  for (const e of entries) {
    const d = riyadhDay(new Date(e.at));
    let broke = false;
    if (d !== day) {
      rows.push({ type: 'day', key: `day-${d}`, day: d });
      day = d;
      broke = true;
    }
    if (e.id === unreadId) {
      rows.push({ type: 'unread', key: 'unread' });
      broke = true;
    }
    const head = broke || !prev || prev.authorId !== e.authorId || Date.parse(e.at) - Date.parse(prev.at) > GROUP_GAP_MS;
    rows.push({ type: 'entry', key: `${e.kind}-${e.id}`, entry: e, mine: !!viewerId && e.authorId === viewerId, head });
    prev = e;
  }
  return rows;
}

/** «اليوم» / «أمس» / a date — the separator label kind for a Riyadh day. */
export function dayKind(day: string, today: string): 'today' | 'yesterday' | 'date' {
  if (day === today) return 'today';
  const y = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return day === y ? 'yesterday' : 'date';
}

/** `HH:MM` of an instant on the Riyadh wall clock. */
export function riyadhClock(at: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

/**
 * Splits a body into text and `@name` pieces for the names given (longest first, so «@نورة بنت
 * محمد» wins over «@نورة»).
 */
export function splitMentions(body: string, names: readonly string[]): Array<{ text: string; mention: boolean }> {
  const list = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return [{ text: body, mention: false }];
  const esc = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`@(?:${esc.join('|')})`, 'g');
  const out: Array<{ text: string; mention: boolean }> = [];
  let last = 0;
  for (const m of body.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: body.slice(last, i), mention: false });
    out.push({ text: m[0], mention: true });
    last = i + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false });
  return out;
}
