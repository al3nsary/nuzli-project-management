/**
 * The chat of one task (owner request A9: «ملاحظات مثل الشات على كل مهمة رئيسية … يمكنه أن يرى
 * الملاحظات كشات ويمكنه الرد عليها»). Used by the supervisor's task page and by the admin task
 * drawer. Comments and attachments share one timeline; the viewer's own messages sit on the
 * inline end. Replies quote an earlier comment (`replyToId`); @mentions are limited to the people
 * who can open the task (active admins + the assignee — the API rejects anyone else with 400).
 * The thread polls every 20 s while open and is marked read on open and when new messages arrive
 * while it is visible.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';
import { ActionIcon, CloseButton, FileButton, Loader, Text, Textarea, Tooltip } from '@mantine/core';
import { IconArrowBackUp, IconArrowDown, IconFileTypePdf, IconMessages, IconPhoto, IconPaperclip, IconSend } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ALLOWED_UPLOAD_TYPES, can, type TaskCommentDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { qk4 } from '../../api/projectQueries';
import { useUsers } from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { UserAvatar } from '../../components/UserAvatar';
import { formatClock, formatDate, formatDateTime, formatNumber, riyadhDay, t } from '../../i18n';
import { invalidateTaskFiles, isImage, uploadTaskFile } from '../tasks/upload';
import { buildTimeline, dayKind, firstUnreadId, mergeEntries, riyadhClock, splitMentions, type ChatEntry } from './timeline';
import css from './TaskChat.module.css';

export const CHAT_POLL_MS = 20_000;
/** A mark later than any comment: "the read mark is unknown, show no divider". */
const NO_DIVIDER = '9999-12-31T00:00:00.000Z';

export interface TaskChatProps {
  taskId: string;
  /** Narrows the hub lookup of the read mark (and refreshes the chart counts after a send). */
  taskName?: string;
  projectId?: string;
  assignee: { id: string; fullName: string } | null;
  className?: string;
  /** A12 round 2: overrides «may write» (participant level, team task). */
  canWrite?: boolean;
  /** A12 round 2: overrides «may attach files». */
  canUpload?: boolean;
}

interface Person {
  id: string;
  fullName: string;
}

export function TaskChat({ taskId, taskName, projectId, assignee, className, canWrite: canWriteProp, canUpload: canUploadProp }: TaskChatProps) {
  const api = useApi();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const viewerId = user?.id ?? null;
  const signedIn = useAuthStore((s) => s.status === 'authenticated');
  // A12 round 2: the caller may override from the project/task relation (participants, team tasks).
  const canWrite = canWriteProp ?? can(user, 'tasks.comment');
  const canUpload = canUploadProp ?? (can(user, 'tasks.manage') || (!!assignee && assignee.id === viewerId));

  const comments = useQuery({
    queryKey: qk4.comments(taskId),
    queryFn: () => api.tasks.comments(taskId),
    enabled: signedIn && !!taskId,
    refetchInterval: CHAT_POLL_MS,
    refetchIntervalInBackground: false,
  });
  const files = useQuery({
    queryKey: qk4.attachments(taskId),
    queryFn: () => api.tasks.attachments(taskId),
    enabled: signedIn && !!taskId,
    refetchInterval: CHAT_POLL_MS,
    refetchIntervalInBackground: false,
  });

  // ------------------------------------------------------------ read mark (snapshot at open)
  const [readMark, setReadMark] = useState<string | null | undefined>(undefined);
  const markRead = useCallback(async () => {
    try {
      await api.tasks.markRead(taskId);
      void qc.invalidateQueries({ queryKey: ['hub'] });
      // A10: the project's chat icons carry the unread count too.
      if (projectId) void qc.invalidateQueries({ queryKey: qk4.gantt(projectId) });
      void qc.invalidateQueries({ queryKey: qk4.myTasks });
    } catch {
      // Reading is best effort; the thread stays usable.
    }
  }, [api, qc, taskId, projectId]);

  useEffect(() => {
    let alive = true;
    setReadMark(undefined);
    void (async () => {
      let mark: string | null = NO_DIVIDER;
      try {
        const page = await api.hub.list({ filter: 'all', projectId, q: taskName?.trim().slice(0, 100) || undefined, pageSize: 100 });
        const item = page.items.find((i) => i.task.id === taskId);
        if (item) mark = item.lastReadAt;
      } catch {
        mark = NO_DIVIDER;
      }
      if (!alive) return;
      setReadMark(mark);
      await markRead();
    })();
    return () => {
      alive = false;
    };
  }, [api, taskId, projectId, taskName, markRead]);

  const entries = useMemo(() => mergeEntries(comments.data ?? [], files.data ?? []), [comments.data, files.data]);
  const unreadId = useMemo(() => firstUnreadId(entries, viewerId, readMark), [entries, viewerId, readMark]);
  const rows = useMemo(() => buildTimeline(entries, viewerId, unreadId), [entries, viewerId, unreadId]);
  const byId = useMemo(() => new Map((comments.data ?? []).map((c) => [c.id, c])), [comments.data]);

  // New messages by others while the thread is open and visible: read them too.
  const lastComment = comments.data?.at(-1);
  const seenLast = useRef<string | null>(null);
  useEffect(() => {
    if (!lastComment || readMark === undefined) return;
    if (seenLast.current === null) {
      seenLast.current = lastComment.id;
      return;
    }
    if (seenLast.current === lastComment.id) return;
    seenLast.current = lastComment.id;
    if (lastComment.author.id !== viewerId && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) void markRead();
  }, [lastComment, readMark, viewerId, markRead]);

  // ------------------------------------------------------------ mentions
  const people = useMentionPeople(comments.data ?? [], assignee);
  const names = useMemo(() => {
    const out = people.map((p) => p.fullName);
    for (const c of comments.data ?? []) out.push(c.author.fullName);
    if (user) out.push(user.fullName);
    return out;
  }, [people, comments.data, user]);

  // ------------------------------------------------------------ scrolling
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const forceBottom = useRef(false);
  const initial = useRef(true);
  const lastKey = useRef<string | null>(null);
  const [newPill, setNewPill] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const toBottom = useCallback((smooth = false) => {
    const el = logRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setNewPill(false);
  }, []);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current) setNewPill(false);
  };

  const tail = rows.length ? rows[rows.length - 1]!.key : null;
  useLayoutEffect(() => {
    if (!tail || comments.isLoading) return;
    if (initial.current) {
      initial.current = false;
      lastKey.current = tail;
      toBottom();
      return;
    }
    if (tail === lastKey.current) return;
    lastKey.current = tail;
    if (atBottom.current || forceBottom.current) {
      forceBottom.current = false;
      toBottom(true);
    } else setNewPill(true);
  }, [tail, comments.isLoading, toBottom]);

  const jumpTo = (id: string) => {
    const el = document.getElementById(`nz-msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(id);
    window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 1700);
  };

  // ------------------------------------------------------------ reply
  const [reply, setReply] = useState<TaskCommentDto | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const startReply = (c: TaskCommentDto) => {
    setReply(c);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const today = riyadhDay();
  const dayLabel = (day: string) => {
    const k = dayKind(day, today);
    return k === 'today' ? t('a9s.chat.today') : k === 'yesterday' ? t('a9s.chat.yesterday') : formatDate(day);
  };
  const timeLabel = (at: string) => (riyadhDay(new Date(at)) === today ? formatClock(riyadhClock(at)) : formatDateTime(at));

  return (
    <section className={[css.root, className].filter(Boolean).join(' ')} aria-label={t('a9s.chat.title')}>
      <div className={css.logWrap}>
        <div
          ref={logRef}
          className={css.log}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={t('a9s.chat.log')}
          onScroll={onScroll}
          tabIndex={0}
        >
          {comments.isLoading ? (
            <div className={css.loading}>
              <Loader size="sm" />
              <span className="sr-only">{t('app.loading')}</span>
            </div>
          ) : comments.isError ? (
            <div className={css.empty}>
              <div>
                <Text size="sm" c="var(--red)" mb={6}>
                  {errorMessage(comments.error)}
                </Text>
                <button type="button" className={css.fileChip} onClick={() => void comments.refetch()}>
                  {t('common.retry')}
                </button>
              </div>
            </div>
          ) : !rows.length ? (
            <div className={css.empty}>
              <div>
                <span className={css.emptyIcon} aria-hidden>
                  <IconMessages size={24} stroke={1.6} />
                </span>
                <Text fw={600} c="var(--ink)">
                  {t('a9s.chat.emptyTitle')}
                </Text>
                <Text size="sm" c="dimmed">
                  {canWrite ? t('a9s.chat.emptyBody') : t('a9s.chat.emptyReadOnly')}
                </Text>
              </div>
            </div>
          ) : (
            rows.map((row) => {
              if (row.type === 'day') {
                return (
                  <div key={row.key} className={css.day} role="separator">
                    <span className={css.dayLabel}>{dayLabel(row.day)}</span>
                  </div>
                );
              }
              if (row.type === 'unread') {
                return (
                  <div key={row.key} className={css.unread} role="separator" data-testid="chat-unread">
                    {t('a9s.chat.unread')}
                  </div>
                );
              }
              return (
                <Message
                  key={row.key}
                  entry={row.entry}
                  mine={row.mine}
                  head={row.head}
                  flash={flash === row.entry.id}
                  taskId={taskId}
                  names={names}
                  time={timeLabel(row.entry.at)}
                  original={row.entry.kind === 'comment' && row.entry.comment.replyTo ? byId.get(row.entry.comment.replyTo.id) ?? null : null}
                  onReply={canWrite ? startReply : undefined}
                  onJump={jumpTo}
                />
              );
            })
          )}
        </div>
        {newPill ? (
          <button type="button" className={css.pill} onClick={() => toBottom(true)}>
            <IconArrowDown size={16} aria-hidden />
            {t('a9s.chat.newMessages')}
          </button>
        ) : null}
      </div>
      {canWrite ? (
        <Composer
          taskId={taskId}
          projectId={projectId}
          people={people}
          reply={reply}
          onCancelReply={() => setReply(null)}
          onSent={() => {
            setReply(null);
            forceBottom.current = true;
          }}
          canUpload={canUpload}
          inputRef={inputRef}
          qcInvalidate={() => {
            void qc.invalidateQueries({ queryKey: qk4.comments(taskId) });
            void qc.invalidateQueries({ queryKey: ['hub'] });
            void qc.invalidateQueries({ queryKey: qk4.myTasks });
            void qc.invalidateQueries({ queryKey: ['task', taskId, 'dto'] });
            if (projectId) void qc.invalidateQueries({ queryKey: qk4.gantt(projectId) });
          }}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- one message

function Message({
  entry,
  mine,
  head,
  flash,
  taskId,
  names,
  time,
  original,
  onReply,
  onJump,
}: {
  entry: ChatEntry;
  mine: boolean;
  head: boolean;
  flash: boolean;
  taskId: string;
  names: string[];
  time: string;
  original: TaskCommentDto | null;
  onReply?: (c: TaskCommentDto) => void;
  onJump(id: string): void;
}) {
  const press = useRef<number | null>(null);
  const comment = entry.kind === 'comment' ? entry.comment : null;
  const startPress = () => {
    if (!comment || !onReply) return;
    press.current = window.setTimeout(() => onReply(comment), 500);
  };
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current);
    press.current = null;
  };
  const authorName = entry.authorName || t('common.unknownUser');
  const cls = [css.row, mine ? css.mine : '', head ? css.head : '', flash ? css.flash : ''].filter(Boolean).join(' ');
  return (
    <div
      id={`nz-msg-${entry.id}`}
      className={cls}
      data-mine={mine || undefined}
      data-testid="chat-message"
      onTouchStart={startPress}
      onTouchEnd={endPress}
      onTouchMove={endPress}
      onTouchCancel={endPress}
    >
      {!mine ? <span className={css.avatarSlot}>{head ? <UserAvatar name={authorName} size={32} ring={false} /> : null}</span> : null}
      <div className={css.stack}>
        {head && !mine ? <span className={css.name}>{authorName}</span> : null}
        <div className={css.line}>
          <div className={css.bubble}>
            <span className="sr-only">{mine ? t('a9s.chat.you') : authorName}</span>
            {comment?.replyTo ? (
              <button
                type="button"
                className={css.quote}
                onClick={() => onJump(comment.replyTo!.id)}
                aria-label={t('a9s.chat.jumpTo', { name: comment.replyTo.authorName })}
                disabled={!original}
              >
                <span className={css.quoteName}>{comment.replyTo.authorName}</span>
                <span className={css.quoteBody}>{comment.replyTo.bodyPreview}</span>
              </button>
            ) : null}
            {comment ? (
              <div className={css.body}>
                {splitMentions(comment.body, names).map((p, i) =>
                  p.mention ? (
                    <span key={i} className={css.mention}>
                      {p.text}
                    </span>
                  ) : (
                    <span key={i}>{p.text}</span>
                  ),
                )}
              </div>
            ) : entry.kind === 'file' ? (
              <ChatFile taskId={taskId} file={entry.file} />
            ) : null}
            <time className={css.meta} dateTime={entry.at} title={formatDateTime(entry.at)}>
              {time}
            </time>
          </div>
          {comment && onReply ? (
            <span className={css.actions}>
              <Tooltip label={t('a9s.chat.reply')} openDelay={400}>
                <ActionIcon variant="subtle" color="gray" radius="xl" size={36} aria-label={t('a9s.chat.replyTo', { name: authorName })} onClick={() => onReply(comment)}>
                  <IconArrowBackUp size={18} className="mirror-rtl" />
                </ActionIcon>
              </Tooltip>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ChatFile({ taskId, file }: { taskId: string; file: { id: string; mimeType: string; sizeBytes: number } }) {
  const api = useApi();
  const image = isImage(file.mimeType);
  const url = useQuery({
    queryKey: ['task', taskId, 'file-url', file.id],
    queryFn: () => api.tasks.attachmentUrl(taskId, file.id),
    enabled: image,
    staleTime: 4 * 60_000,
  });
  const open = async () => {
    try {
      const u = url.data?.url ?? (await api.tasks.attachmentUrl(taskId, file.id)).url;
      window.open(u, '_blank', 'noopener');
    } catch {
      // The chip stays; the next poll may bring a fresh URL.
    }
  };
  const size = t('a9s.files.size', { kb: formatNumber(Math.max(1, Math.ceil(file.sizeBytes / 1024))) });
  if (image && url.data?.url) {
    return (
      <button type="button" className={css.thumbBtn} onClick={() => void open()} aria-label={t('a9s.chat.openImage')}>
        <img src={url.data.url} alt={t('a9s.chat.imageAlt')} className={css.thumb} loading="lazy" referrerPolicy="no-referrer" />
      </button>
    );
  }
  return (
    <button type="button" className={css.fileChip} onClick={() => void open()}>
      {image ? <IconPhoto size={22} aria-hidden style={{ color: 'var(--accent)', flex: '0 0 auto' }} /> : <IconFileTypePdf size={22} className={css.fileIcon} aria-hidden />}
      <span>
        <Text span size="sm" fw={600} display="block">
          {image ? t('a9s.chat.image') : t('a9s.chat.pdf')}
        </Text>
        <Text span size="xs" c="dimmed">
          {size}
        </Text>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- composer

function Composer({
  taskId,
  people,
  reply,
  onCancelReply,
  onSent,
  canUpload,
  inputRef,
  qcInvalidate,
  projectId,
}: {
  taskId: string;
  projectId?: string;
  people: Person[];
  reply: TaskCommentDto | null;
  onCancelReply(): void;
  onSent(): void;
  canUpload: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  qcInvalidate(): void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<Map<string, string>>(new Map());
  const [query, setQuery] = useState<{ start: number; text: string } | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = query ? people.filter((p) => p.fullName.includes(query.text)).slice(0, 6) : [];
  const listOpen = Boolean(query && matches.length);

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.currentTarget.value;
    setBody(v);
    const caret = e.currentTarget.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]!)) && !/\n/.test(before.slice(at)) && before.length - at <= 30) {
      setQuery({ start: at, text: before.slice(at + 1) });
      setActive(0);
    } else setQuery(null);
  };

  const pick = (p: Person) => {
    if (!query) return;
    const caret = query.start + 1 + query.text.length;
    setBody(`${body.slice(0, query.start)}@${p.fullName} ${body.slice(caret)}`);
    setMentions((m) => new Map(m).set(p.id, p.fullName));
    setQuery(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const send = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Only mentions whose name is still in the text are sent.
      const ids = [...mentions].filter(([, name]) => text.includes(`@${name}`)).map(([id]) => id);
      await api.tasks.addComment(taskId, { body: text, mentions: ids, ...(reply ? { replyToId: reply.id } : {}) });
      setBody('');
      setMentions(new Map());
      onSent();
      qcInvalidate();
    } catch (err) {
      // The text stays so nothing typed is lost.
      setError(err instanceof ApiError ? err.fieldErrors.mentions ?? err.fieldErrors.replyToId ?? errorMessage(err) : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[active]!);
        return;
      }
      if (e.key === 'Escape') {
        setQuery(null);
        return;
      }
    }
    if (e.key === 'Escape' && reply) {
      onCancelReply();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const upload = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      await uploadTaskFile(api, taskId, file);
      onSent();
      invalidateTaskFiles(qc, taskId, projectId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className={css.composer}>
      {error ? (
        <Text size="sm" c="var(--red)" role="alert" mb={6}>
          {error}
        </Text>
      ) : null}
      {reply ? (
        <div className={css.replyStrip}>
          <IconArrowBackUp size={16} className="mirror-rtl" aria-hidden style={{ color: 'var(--accent)', flex: '0 0 auto' }} />
          <div className={css.replyText}>
            <Text size="xs" fw={600} c="var(--accent)">
              {t('a9s.chat.replyingTo', { name: reply.author.fullName })}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {reply.body}
            </Text>
          </div>
          <CloseButton size="lg" aria-label={t('a9s.chat.cancelReply')} onClick={onCancelReply} />
        </div>
      ) : null}
      {listOpen ? (
        <div id={`nz-mentions-${taskId}`} role="listbox" aria-label={t('task.mentionList')} className={css.mentionList}>
          {matches.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={css.mentionItem}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(p)}
            >
              <UserAvatar name={p.fullName} size={26} ring={false} />
              {p.fullName}
            </button>
          ))}
        </div>
      ) : null}
      <div className={css.inputRow}>
        {canUpload ? (
          <FileButton onChange={(f) => void upload(f)} accept={ALLOWED_UPLOAD_TYPES.join(',')}>
            {(props) => (
              <Tooltip label={t('a9s.chat.attach')} openDelay={400}>
                <ActionIcon {...props} variant="subtle" color="gray" size={44} radius="md" aria-label={t('a9s.chat.attach')} loading={uploading}>
                  <IconPaperclip size={20} />
                </ActionIcon>
              </Tooltip>
            )}
          </FileButton>
        ) : null}
        <Textarea
          ref={inputRef}
          className={css.input}
          value={body}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={t('a9s.chat.placeholder')}
          aria-label={t('a9s.chat.input')}
          autosize
          minRows={1}
          maxRows={6}
          radius="md"
          aria-autocomplete="list"
          aria-controls={listOpen ? `nz-mentions-${taskId}` : undefined}
          aria-expanded={listOpen}
        />
        <ActionIcon
          size={44}
          radius="md"
          variant="filled"
          color="field"
          aria-label={t('a9s.chat.send')}
          onClick={() => void send()}
          loading={busy}
          disabled={!body.trim()}
        >
          <IconSend size={20} className="mirror-rtl" />
        </ActionIcon>
      </div>
      <div className={css.hint}>{t('a9s.chat.hint')}</div>
    </div>
  );
}

// ---------------------------------------------------------------- mention candidates

/**
 * Who can be mentioned: the people who can open the task — active admins and the assignee.
 * Supervisors cannot list users, so they are offered the people who already wrote in the
 * thread (the admins) and the assignee; the API answers 400 for anyone else.
 */
function useMentionPeople(comments: readonly TaskCommentDto[], assignee: { id: string; fullName: string } | null): Person[] {
  const user = useAuthStore((s) => s.user);
  const listUsers = can(user, 'users.read');
  const admins = useUsers({ role: 'ADMIN', status: 'ACTIVE', pageSize: 200 }, listUsers);
  return useMemo(() => {
    const m = new Map<string, Person>();
    if (listUsers) for (const u of admins.data?.items ?? []) m.set(u.id, { id: u.id, fullName: u.fullName });
    else for (const c of comments) m.set(c.author.id, { id: c.author.id, fullName: c.author.fullName });
    if (assignee) m.set(assignee.id, { id: assignee.id, fullName: assignee.fullName });
    if (user) m.delete(user.id);
    return [...m.values()].sort((a, b) => a.fullName.localeCompare(b.fullName, 'ar'));
  }, [listUsers, admins.data, comments, assignee, user]);
}
