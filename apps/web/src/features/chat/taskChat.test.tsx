/**
 * A9 task chat (owner request: «ملاحظات مثل الشات على كل مهمة … يرى الملاحظات كشات ويمكنه الرد
 * عليها»): timeline ordering, day separators and grouping (pure), and the rendered chat with a
 * DemoApi — own messages on the inline end, the unread divider from the read mark, markRead on
 * open, reply quoting and jumping to the quoted message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TaskAttachmentDto, TaskCommentDto } from '@nuzli/shared';
import { AppProviders } from '../../app/App';
import { DemoApi } from '../../api/demo/DemoApi';
import { DEMO_PASSWORD } from '../../api/demo/constants';
import { useAuthStore } from '../../stores/auth';
import { ApiError } from '../../api/errors';
import { TaskChat } from './TaskChat';
import { buildTimeline, dayKind, firstUnreadId, mergeEntries, splitMentions } from './timeline';

const SUP = 'supervisor1@demo.nuzli.example';
const ADMIN = 'admin1@demo.nuzli.example';

const comment = (id: string, at: string, authorId: string, body = id, replyTo: TaskCommentDto['replyTo'] = null): TaskCommentDto => ({
  id,
  author: { id: authorId, fullName: authorId === 'me' ? 'فهد' : 'عبدالله' },
  body,
  mentions: [],
  createdAt: at,
  replyTo,
});
const file = (id: string, at: string): TaskAttachmentDto => ({ id, mimeType: 'image/png', sizeBytes: 2048, uploadedBy: { id: 'me', fullName: 'فهد' }, createdAt: at });

afterEach(() => vi.restoreAllMocks());

describe('chat timeline (pure)', () => {
  it('merges comments and attachments by time and inserts Riyadh day separators', () => {
    const entries = mergeEntries(
      [comment('c2', '2026-10-18T09:00:00.000Z', 'admin'), comment('c1', '2026-10-17T20:30:00.000Z', 'me')],
      [file('f1', '2026-10-18T09:01:00.000Z')],
    );
    expect(entries.map((e) => e.id)).toEqual(['c1', 'c2', 'f1']);
    const rows = buildTimeline(entries, 'me', null);
    // 20:30Z on the 17th is 23:30 in Riyadh (still the 17th); 09:00Z on the 18th is the 18th.
    expect(rows.filter((r) => r.type === 'day').map((r) => (r.type === 'day' ? r.day : ''))).toEqual(['2026-10-17', '2026-10-18']);
    const msgs = rows.filter((r) => r.type === 'entry');
    expect(msgs.map((r) => (r.type === 'entry' ? r.mine : null))).toEqual([true, false, true]);
  });

  it('groups a run by one author within five minutes under one head', () => {
    const entries = mergeEntries(
      [comment('a', '2026-10-18T09:00:00.000Z', 'admin'), comment('b', '2026-10-18T09:03:00.000Z', 'admin'), comment('c', '2026-10-18T09:20:00.000Z', 'admin')],
      [],
    );
    const heads = buildTimeline(entries, 'me', null).flatMap((r) => (r.type === 'entry' ? [r.head] : []));
    expect(heads).toEqual([true, false, true]);
  });

  it('puts the unread divider before the first message by someone else after the read mark', () => {
    const entries = mergeEntries(
      [
        comment('a', '2026-10-18T09:00:00.000Z', 'admin'),
        comment('b', '2026-10-18T10:00:00.000Z', 'me'),
        comment('c', '2026-10-18T11:00:00.000Z', 'admin'),
      ],
      [],
    );
    expect(firstUnreadId(entries, 'me', '2026-10-18T09:30:00.000Z')).toBe('c');
    expect(firstUnreadId(entries, 'me', null)).toBe('a');
    expect(firstUnreadId(entries, 'me', '2026-10-18T12:00:00.000Z')).toBeNull();
    expect(firstUnreadId(entries, 'me', undefined)).toBeNull();
    const rows = buildTimeline(entries, 'me', 'c');
    const at = rows.findIndex((r) => r.type === 'unread');
    expect(rows[at + 1]).toMatchObject({ type: 'entry', head: true });
    expect(rows[at + 1]?.type === 'entry' && rows[at + 1]?.key).toBe('comment-c');
  });

  it('labels today and yesterday and highlights known @names (longest first)', () => {
    expect(dayKind('2026-10-19', '2026-10-19')).toBe('today');
    expect(dayKind('2026-10-18', '2026-10-19')).toBe('yesterday');
    expect(dayKind('2026-09-30', '2026-10-01')).toBe('yesterday');
    expect(dayKind('2026-10-10', '2026-10-19')).toBe('date');
    expect(splitMentions('مرحبًا @نورة بنت محمد و@نورة', ['نورة', 'نورة بنت محمد'])).toEqual([
      { text: 'مرحبًا ', mention: false },
      { text: '@نورة بنت محمد', mention: true },
      { text: ' و', mention: false },
      { text: '@نورة', mention: true },
    ]);
  });
});

// ---------------------------------------------------------------- rendered with DemoApi

async function supervisorTask(api: DemoApi) {
  await api.auth.login({ identifier: SUP, password: DEMO_PASSWORD });
  const mine = await api.tasks.mine();
  expect(mine.length).toBeGreaterThan(0);
  return mine.find((x) => x.type !== 'GROUP') ?? mine[0]!;
}

async function renderChat(api: DemoApi, identifier: string, taskId: string, assignee: { id: string; fullName: string } | null) {
  await api.auth.login({ identifier, password: DEMO_PASSWORD });
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null });
  return render(
    <AppProviders api={api}>
      <div style={{ height: 600 }}>
        <TaskChat taskId={taskId} assignee={assignee} />
      </div>
    </AppProviders>,
  );
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TaskChat with DemoApi', () => {
  it('orders the thread, puts own messages on the inline end, shows the unread divider and marks read on open', async () => {
    const api = new DemoApi({ dbName: `nuzli-chat-${Math.random()}` });
    const task = await supervisorTask(api);
    // The supervisor writes, reads the thread, then an admin answers.
    await api.tasks.addComment(task.id, { body: 'وصلنا الموقع وبدأنا العمل', mentions: [] });
    await api.tasks.markRead(task.id);
    await pause(5);
    await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    await api.tasks.addComment(task.id, { body: 'ممتاز، أرسل صورة بعد الانتهاء', mentions: [] });

    await api.auth.login({ identifier: SUP, password: DEMO_PASSWORD });
    const expected = await api.tasks.comments(task.id);
    const markRead = vi.spyOn(api.tasks, 'markRead');

    await renderChat(api, SUP, task.id, task.assignee);
    const log = await screen.findByRole('log', {}, { timeout: 8000 });
    await waitFor(() => expect(within(log).getAllByTestId('chat-message').length).toBeGreaterThanOrEqual(expected.length), { timeout: 8000 });

    // Ordered by time, as the API answers.
    const texts = within(log)
      .getAllByTestId('chat-message')
      .map((el) => el.textContent ?? '');
    const order = expected.map((c) => texts.findIndex((x) => x.includes(c.body)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // Own message on the inline end; the admin's on the inline start.
    const own = within(log).getByText('وصلنا الموقع وبدأنا العمل').closest('[data-testid="chat-message"]')!;
    const theirs = within(log).getByText('ممتاز، أرسل صورة بعد الانتهاء').closest('[data-testid="chat-message"]')!;
    expect(own).toHaveAttribute('data-mine', 'true');
    expect(theirs).not.toHaveAttribute('data-mine');

    // «غير مقروءة» sits right before the admin's answer.
    const divider = await within(log).findByTestId('chat-unread');
    expect(divider).toHaveTextContent('غير مقروءة');
    const next = divider.nextElementSibling;
    expect(next?.textContent).toContain('ممتاز، أرسل صورة بعد الانتهاء');

    await waitFor(() => expect(markRead).toHaveBeenCalledWith(task.id));
    // The hub now counts nothing unread on this task for the supervisor.
    await waitFor(async () => {
      const hub = await api.hub.list({ filter: 'all', pageSize: 100 });
      expect(hub.items.find((i) => i.task.id === task.id)?.unreadCount ?? 0).toBe(0);
    });
  }, 30_000);

  it('replies with a quote, sends with Enter and jumps to the quoted message', async () => {
    const api = new DemoApi({ dbName: `nuzli-chat-${Math.random()}` });
    const task = await supervisorTask(api);
    await api.auth.login({ identifier: ADMIN, password: DEMO_PASSWORD });
    await api.tasks.addComment(task.id, { body: 'هل انتهت أعمال الحفر؟', mentions: [] });

    await renderChat(api, SUP, task.id, task.assignee);
    const log = await screen.findByRole('log', {}, { timeout: 8000 });
    const question = await within(log).findByText('هل انتهت أعمال الحفر؟', {}, { timeout: 8000 });
    const row = question.closest('[data-testid="chat-message"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /^الرد على/ }));

    // The quoted strip appears above the composer.
    expect(await screen.findByText(/^تردّ على/)).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'نص الملاحظة' });
    fireEvent.change(input, { target: { value: 'نعم، انتهت اليوم' } });
    // Shift+Enter does not send.
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(input).toHaveValue('نعم، انتهت اليوم');
    fireEvent.keyDown(input, { key: 'Enter' });

    const reply = await within(log).findByText('نعم، انتهت اليوم', {}, { timeout: 8000 });
    const bubble = reply.closest('[data-testid="chat-message"]') as HTMLElement;
    expect(bubble).toHaveAttribute('data-mine', 'true');
    const quote = within(bubble).getByRole('button', { name: /^الانتقال إلى رسالة/ });
    expect(quote).toHaveTextContent('هل انتهت أعمال الحفر؟');
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByText(/^تردّ على/)).toBeNull();

    // The API stored the reply link.
    const stored = (await api.tasks.comments(task.id)).find((c) => c.body === 'نعم، انتهت اليوم');
    expect(stored?.replyTo?.bodyPreview).toContain('هل انتهت أعمال الحفر؟');

    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    fireEvent.click(quote);
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.contexts[0]).toBe(row);
  }, 30_000);

  it('keeps the text and shows the API message when a mention is refused', async () => {
    const api = new DemoApi({ dbName: `nuzli-chat-${Math.random()}` });
    const task = await supervisorTask(api);
    await renderChat(api, SUP, task.id, task.assignee);
    await screen.findByRole('log', {}, { timeout: 8000 });
    vi.spyOn(api.tasks, 'addComment').mockRejectedValueOnce(
      new ApiError(400, 'VALIDATION_FAILED', 'تحقق', { fieldErrors: { mentions: ['يمكن الإشارة فقط إلى من يستطيع فتح هذه المهمة'] } }),
    );
    // Under a loaded test run the composer can mount a moment after the log.
    const input = await screen.findByRole('textbox', { name: 'نص الملاحظة' }, { timeout: 8000 });
    fireEvent.change(input, { target: { value: 'تنبيه @أحد' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('يمكن الإشارة فقط إلى من يستطيع فتح هذه المهمة');
    expect(input).toHaveValue('تنبيه @أحد');
  }, 30_000);
});
