/**
 * Owner request A10: the distinctive chat icon on every task row/card of a project (Gantt grid,
 * list, board). Indigo speech bubble — outlined when the thread is empty, filled when it has
 * messages — with the message count and a red unread badge. Clicking opens the same task screen
 * the supervisor has (`?chat=<taskId>`, TaskChatDrawer).
 */
import { memo, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tooltip } from '@mantine/core';
import { IconMessageCircle2, IconMessageCircle2Filled } from '@tabler/icons-react';
import type { TaskDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { useAuthStore } from '../../stores/auth';
import { formatNumber, t, tCount } from '../../i18n';
import './taskChatButton.css';

export interface ChatCount {
  /** Messages in the thread. */
  count: number;
  /** Messages by others after the viewer's last read. */
  unread: number;
}

type WithUnread = Pick<TaskDto, 'id' | 'commentCount'> & { unreadCount?: number };

/**
 * Message and unread counts per task of a project. `commentCount` comes with every task;
 * `unreadCount` is sent by the API from A10 (optional in the type) — when a task lacks it, the
 * unread numbers come from the communication hub filtered to the project (same read marks).
 */
export function useTaskChatCounts(projectId: string, tasks: readonly WithUnread[], enabled = true): Map<string, ChatCount> {
  const api = useApi();
  const signedIn = useAuthStore((s) => s.status === 'authenticated');
  const needHub = enabled && tasks.some((x) => typeof x.unreadCount !== 'number');
  const hub = useQuery({
    // Starts with 'hub' so marking a thread read (which invalidates ['hub']) refreshes the badges.
    queryKey: ['hub', 'all', projectId, '', 'chat-counts'],
    queryFn: () => api.hub.list({ filter: 'all', projectId, pageSize: 100 }),
    enabled: signedIn && needHub && Boolean(projectId),
    refetchInterval: 60_000,
  });
  return useMemo(() => {
    const fromHub = new Map((hub.data?.items ?? []).map((i) => [i.task.id, i]));
    const out = new Map<string, ChatCount>();
    for (const x of tasks) {
      const h = fromHub.get(x.id);
      const count = Math.max(x.commentCount ?? 0, h?.commentCount ?? 0);
      const unread = typeof x.unreadCount === 'number' ? x.unreadCount : (h?.unreadCount ?? 0);
      out.set(x.id, { count, unread: Math.min(unread, count) });
    }
    return out;
  }, [tasks, hub.data]);
}

export const TaskChatButton = memo(function TaskChatButton({
  taskName,
  chat,
  onOpen,
  size = 'sm',
}: {
  taskName: string;
  chat: ChatCount | undefined;
  onOpen(): void;
  size?: 'sm' | 'md';
}) {
  const count = chat?.count ?? 0;
  const unread = chat?.unread ?? 0;
  const Icon = count > 0 ? IconMessageCircle2Filled : IconMessageCircle2;
  const label = count > 0
    ? tCount('a10.chat.aria', count, { name: taskName, unread: formatNumber(unread) })
    : t('a10.chat.ariaNone', { name: taskName });
  return (
    <Tooltip label={count > 0 ? t('a10.chat.tooltip') : t('a10.chat.tooltipNone')} openDelay={350} withinPortal>
      <button
        type="button"
        className="nz-chatbtn"
        data-size={size}
        data-has={count > 0 || undefined}
        data-unread={unread > 0 || undefined}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Icon size={size === 'md' ? 20 : 17} aria-hidden />
        {count > 0 ? <span className="nz-chatbtn-n num">{formatNumber(count)}</span> : null}
        {unread > 0 ? (
          <span className="nz-chatbtn-unread num" aria-hidden>
            {formatNumber(unread)}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
});
