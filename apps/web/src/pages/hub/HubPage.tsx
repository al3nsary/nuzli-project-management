import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ActionIcon, Button, Select, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  IconArrowLeft,
  IconAt,
  IconExternalLink,
  IconFolder,
  IconMessage2,
  IconMessages,
  IconSearch,
  IconSparkles,
  IconUserCheck,
  IconUserEdit,
} from '@tabler/icons-react';
import { can, HUB_FILTERS, type HubFilter, type HubItemDto } from '@nuzli/shared';
import { DualRoleBadge } from '../../features/workspaces/DualRole';
import { useApi } from '../../api/context';
import { useProjects } from '../../api/projectQueries';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { TaskChat } from '../../features/chat/TaskChat';
import { formatDate, formatNumber, riyadhDay, t, tCount, type MessageKey } from '../../i18n';
import { riyadhClock } from '../../features/chat/timeline';
import './hub.css';

const PAGE = 25;

const TAB_ICON: Record<HubFilter, typeof IconMessages> = {
  all: IconMessages,
  new: IconSparkles,
  mentioned: IconAt,
  assigned: IconUserCheck,
  created: IconUserEdit,
};

/** «١٠:٤٥ ص» today, «أمس», else the date — like GanttPRO's hub list. */
export function hubTime(at: string, now = new Date()): string {
  const day = riyadhDay(new Date(at));
  const today = riyadhDay(now);
  if (day === today) return riyadhClock(at);
  const yesterday = riyadhDay(new Date(now.getTime() - 86_400_000));
  if (day === yesterday) return t('hub.yesterday');
  return formatDate(at);
}

/** The hub's URL state: `?filter=&project=&q=&task=` (deep-linkable, back closes the chat on phones). */
function useHubParams() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const rawFilter = params.get('filter');
  const filter: HubFilter = (HUB_FILTERS as readonly string[]).includes(rawFilter ?? '') ? (rawFilter as HubFilter) : 'all';
  const set = (patch: Record<string, string | null>, mode: 'push' | 'replace' = 'replace') => {
    const next = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '' || (k === 'filter' && v === 'all')) next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    navigate(
      { pathname: location.pathname, search: s ? `?${s}` : '' },
      { replace: mode === 'replace', preventScrollReset: true, state: mode === 'push' ? { nzHubTask: true } : location.state },
    );
  };
  return {
    filter,
    projectId: params.get('project') ?? '',
    q: params.get('q') ?? '',
    taskId: params.get('task'),
    pushedTask: (location.state as { nzHubTask?: boolean } | null)?.nzHubTask === true,
    set,
    goBack: () => navigate(-1),
  };
}

function HubRow({ item, selected, onOpen }: { item: HubItemDto; selected: boolean; onOpen: () => void }) {
  const unread = item.unreadCount > 0;
  const path = item.path.length ? item.path.join(' › ') : null;
  return (
    <li>
      <button
        type="button"
        className="hb-row"
        data-selected={selected || undefined}
        data-unread={unread || undefined}
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
      >
        <span className="hb-row-main">
          <span className="hb-row-top">
            <span className="hb-task">{item.task.name}</span>
            {item.lastComment ? <span className="hb-time">{hubTime(item.lastComment.createdAt)}</span> : null}
          </span>
          <span className="hb-project">
            <IconFolder size={14} stroke={1.8} aria-hidden />
            <span>{item.project.name}</span>
          </span>
          {path ? (
            <span className="hb-path" title={path}>
              {t('hub.parentPath', { path })}
            </span>
          ) : null}
          {item.lastComment ? (
            <span className="hb-preview">
              <b>
                {item.lastComment.author.fullName}
                <DualRoleBadge user={item.lastComment.author} compact />:
              </b>{' '}
              {item.lastComment.bodyPreview}
            </span>
          ) : null}
        </span>
        <span className="hb-row-side">
          {unread ? (
            <span className="hb-unread" aria-label={tCount('hub.unreadAria', item.unreadCount)}>
              {formatNumber(item.unreadCount)}
            </span>
          ) : (
            <span className="hb-count" aria-label={tCount('hub.commentsAria', item.commentCount)}>
              <IconMessage2 size={14} aria-hidden />
              {formatNumber(item.commentCount)}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * «مركز التواصل» (route `/hub`, owner request A9, screenshot 3): every conversation on every task
 * the viewer can open — admins all of them, supervisors only the tasks assigned to them. A project
 * filter, a search on the task name or the comment text, five tabs (all · with new comments ·
 * mentioned · assigned · created), the task list with its project and parent path, the latest
 * comment and the unread count; the selected task's chat (TaskChat) opens beside the list on
 * wide screens and full-screen on phones; opening marks the thread read.
 */
export function HubPage() {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const isAdmin = can(user, 'projects.readAll');
  const wide = useMediaQuery('(min-width: 62em)', true);
  const p = useHubParams();
  const [search, setSearch] = useState(p.q);
  const [debounced] = useDebouncedValue(search.trim(), 300);
  const [size, setSize] = useState(PAGE);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (debounced !== p.q) p.set({ q: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => setSize(PAGE), [p.filter, p.projectId, p.q]);

  const hub = useQuery({
    queryKey: ['hub', 'page', p.filter, p.projectId, p.q, size],
    queryFn: () => api.hub.list({ filter: p.filter, projectId: p.projectId || undefined, q: p.q || undefined, pageSize: size }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  // Admins pick from every project; supervisors (no project access, ADR-092) from their tasks' projects.
  const projects = useProjects({}, isAdmin);
  const mine = useQuery({
    queryKey: ['hub', 'projects-of-mine'],
    queryFn: () => api.hub.list({ filter: 'all', pageSize: 100 }),
    enabled: !isAdmin,
    staleTime: 60_000,
  });
  const projectOptions = useMemo(() => {
    if (isAdmin) return (projects.data ?? []).map((pr) => ({ value: pr.id, label: pr.name }));
    const seen = new Map<string, string>();
    for (const it of mine.data?.items ?? []) seen.set(it.project.id, it.project.name);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [isAdmin, projects.data, mine.data]);

  const items = hub.data?.items ?? [];
  const selected = items.find((i) => i.task.id === p.taskId) ?? null;
  // A deep link to a task outside the current page/tab still opens its chat.
  const deepTask = useQuery({
    queryKey: ['hub', 'deep', p.taskId],
    queryFn: () => api.tasks.get(p.taskId!),
    enabled: Boolean(p.taskId) && !selected && !hub.isLoading,
    retry: false,
  });

  const open = (it: HubItemDto) => p.set({ task: it.task.id }, wide || p.taskId ? 'replace' : 'push');
  const closeChat = () => (p.pushedTask ? p.goBack() : p.set({ task: null }));

  const chatTask = selected
    ? { id: selected.task.id, name: selected.task.name, projectId: selected.project.id, projectName: selected.project.name, assignee: selected.task.assignee, path: selected.path }
    : deepTask.data
      ? { id: deepTask.data.id, name: deepTask.data.name, projectId: deepTask.data.projectId, projectName: null, assignee: deepTask.data.assignee ?? null, path: [] as string[] }
      : null;
  const taskLink = chatTask
    ? isAdmin
      ? // A10: admins open the same task screen the supervisor has, over the project.
        `/projects/${encodeURIComponent(chatTask.projectId)}?chat=${encodeURIComponent(chatTask.id)}`
      : `/my-tasks/${encodeURIComponent(chatTask.id)}`
    : null;

  const chatPanel = chatTask ? (
    <section className="hb-chat" aria-label={t('hub.chatOf', { task: chatTask.name })}>
      <header className="hb-chat-head">
        {!wide ? (
          <ActionIcon variant="subtle" size={40} onClick={closeChat} aria-label={t('hub.backToList')}>
            <IconArrowLeft size={20} className="mirror-rtl" />
          </ActionIcon>
        ) : null}
        <div className="hb-chat-title">
          <h2>{chatTask.name}</h2>
          <span>
            {chatTask.projectName ? (
              <>
                <IconFolder size={13} aria-hidden /> {chatTask.projectName}
              </>
            ) : null}
            {chatTask.path.length ? ` · ${chatTask.path.join(' › ')}` : ''}
          </span>
        </div>
        {taskLink ? (
          <Tooltip label={t('hub.openTask')}>
            <ActionIcon component={Link} to={taskLink} variant="subtle" size={40} aria-label={t('hub.openTask')}>
              <IconExternalLink size={18} />
            </ActionIcon>
          </Tooltip>
        ) : null}
      </header>
      <TaskChat
        key={chatTask.id}
        taskId={chatTask.id}
        taskName={chatTask.name}
        projectId={chatTask.projectId}
        assignee={chatTask.assignee}
        className="hb-chat-body"
      />
    </section>
  ) : null;

  // Phones: the chat replaces the list (full screen); back returns to the list.
  if (!wide && chatPanel) return <div className="hb-phone-chat">{chatPanel}</div>;

  const counts = hub.data?.counts;
  return (
    <>
      <PageHeader title={t('nav.communication')} lead={isAdmin ? t('hub.leadAdmin') : t('hub.leadSupervisor')} />
      <div className="hb-shell" data-has-chat={Boolean(chatPanel) || undefined}>
        <div className="hb-list-pane">
          <div className="hb-tools">
            <Select
              aria-label={t('hub.project')}
              placeholder={t('hub.allProjects')}
              data={projectOptions}
              value={p.projectId || null}
              onChange={(v) => p.set({ project: v, task: null })}
              clearable
              searchable
              leftSection={<IconFolder size={16} />}
              nothingFoundMessage={t('hub.noProjects')}
              className="hb-project-select"
            />
            <TextInput
              aria-label={t('hub.search')}
              placeholder={t('hub.search')}
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              className="hb-search"
            />
          </div>
          <div className="hb-tabs" role="tablist" aria-label={t('hub.tabs')}>
            {HUB_FILTERS.map((f) => {
              const Icon = TAB_ICON[f];
              const n = counts?.[f];
              return (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={p.filter === f}
                  className="hb-tab"
                  onClick={() => p.set({ filter: f, task: null })}
                >
                  <Icon size={15} aria-hidden />
                  <span>{t(`hub.tab.${f}` as MessageKey)}</span>
                  {n !== undefined ? <span className="hb-tab-n">{formatNumber(n)}</span> : null}
                </button>
              );
            })}
          </div>
          {hub.isLoading ? (
            <LoadingBlock variant="list" rows={6} />
          ) : hub.isError ? (
            <ErrorBlock error={hub.error} onRetry={() => void hub.refetch()} />
          ) : !items.length ? (
            <EmptyState
              icon={IconMessages}
              title={p.q || p.projectId || p.filter !== 'all' ? t('hub.emptyFiltered') : t('hub.empty')}
              body={p.q || p.projectId || p.filter !== 'all' ? t('hub.emptyFilteredBody') : isAdmin ? t('hub.emptyBodyAdmin') : t('hub.emptyBodySupervisor')}
              action={
                p.q || p.projectId || p.filter !== 'all'
                  ? {
                      label: t('hub.clearFilters'),
                      onClick: () => {
                        setSearch('');
                        p.set({ filter: null, project: null, q: null, task: null });
                      },
                    }
                  : undefined
              }
            />
          ) : (
            <>
              <ul className="hb-list" ref={listRef} aria-label={t('hub.listAria')}>
                {items.map((it) => (
                  <HubRow key={it.task.id} item={it} selected={it.task.id === p.taskId} onOpen={() => open(it)} />
                ))}
              </ul>
              <div className="hb-list-foot">
                <span>{t('hub.shown', { n: items.length, total: hub.data?.total ?? items.length })}</span>
                {hub.data && hub.data.total > items.length && size < 100 ? (
                  <Button variant="subtle" size="compact-sm" onClick={() => setSize((s) => Math.min(100, s + PAGE))} loading={hub.isFetching}>
                    {t('hub.more')}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
        {wide ? (
          chatPanel ?? (
            <div className="hb-chat hb-chat--empty">
              <IconMessages size={40} stroke={1.3} aria-hidden />
              <p>{t('hub.pickTask')}</p>
            </div>
          )
        ) : null}
      </div>
    </>
  );
}
