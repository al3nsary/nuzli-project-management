/**
 * A12 — the project on phones («نظرة عامة»), in the style of the owner's Figma reference (Project
 * view 0:1938 / 0:2120) in our identity: the cover with «تعديل», the title and a short description
 * («اقرأ المزيد»), the owner, an info grid (المدة · المعالم · البداية · النهاية · الميزانية when
 * allowed · الإنجاز), «عرض المخطط» (the Gantt full screen, best in landscape), the other views as
 * chips, and the sections as collapsible groups of tasks — each with its status pill, assignee
 * avatar and chat button with the unread count. Tapping a task opens the task drawer.
 */
import { useMemo, useState } from 'react';
import { Button } from '@mantine/core';
import {
  IconCalendarEvent,
  IconCalendarDue,
  IconChartBar,
  IconChevronDown,
  IconClockHour4,
  IconCoin,
  IconFlag,
  IconPencil,
  IconProgress,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import type { GanttView, TaskView } from '../../api/hoursWire';
import type { ProjectAccess } from '../../features/participants/access';
import { ProjectCover } from '../../features/projects/ProjectCover';
import { TaskChatButton, useTaskChatCounts } from '../../features/tasks/TaskChatButton';
import { UserAvatar, UserPhotoAvatar } from '../../components/UserAvatar';
import { DualRoleBadge } from '../../features/workspaces/DualRole';
import { formatDate, formatMoney, formatNumber, t, tCount } from '../../i18n';
import { taskStatusLabel } from './parts';

const STATUS_TONE: Record<string, string> = { NOT_STARTED: 'grey', IN_PROGRESS: 'brand', ON_HOLD: 'wait', DONE: 'live' };

function Info({ icon: Glyph, label, value }: { icon: typeof IconFlag; label: string; value: string }) {
  return (
    <div className="nz-pv-info">
      <Glyph size={20} stroke={1.7} aria-hidden />
      <span>
        <span className="nz-pv-info-l">{label}</span>
        <b className="nz-pv-info-v">{value}</b>
      </span>
    </div>
  );
}

interface Section {
  id: string;
  name: string;
  tasks: TaskView[];
  done: number;
}

/** Root groups with their descendant leaves; root leaves gather in «مهام مستقلة». */
export function sectionsOf(tasks: TaskView[]): Section[] {
  const kids = new Map<string | null, TaskView[]>();
  for (const x of tasks) {
    const k = x.parentId ?? null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k)!.push(x);
  }
  for (const list of kids.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
  const leaves = (id: string): TaskView[] =>
    (kids.get(id) ?? []).flatMap((c) => (kids.get(c.id)?.length ? leaves(c.id) : [c]));
  const out: Section[] = [];
  const loose: TaskView[] = [];
  for (const root of kids.get(null) ?? []) {
    if (kids.get(root.id)?.length) {
      const list = leaves(root.id);
      out.push({ id: root.id, name: root.name, tasks: list, done: list.filter((x) => x.status === 'DONE').length });
    } else loose.push(root);
  }
  if (loose.length) out.push({ id: '__loose', name: t('mproject.ungrouped'), tasks: loose, done: loose.filter((x) => x.status === 'DONE').length });
  return out;
}

function TaskRow({
  task,
  chat,
  onOpen,
  onChat,
}: {
  task: TaskView;
  chat: { count: number; unread: number } | undefined;
  onOpen(): void;
  onChat?: () => void;
}) {
  const late = task.status !== 'DONE' && task.deadlinePassed;
  return (
    <li className="nz-pv-task">
      <button type="button" className="nz-pv-task-main" onClick={onOpen}>
        <span className="nz-pv-task-top">
          {task.type === 'MILESTONE' ? <IconFlag size={16} stroke={1.8} className="nz-pv-ms" aria-hidden /> : null}
          <b>{task.name}</b>
        </span>
        <span className="nz-pv-task-meta">
          <span className={`pill ${STATUS_TONE[task.status] ?? 'grey'}`}>{taskStatusLabel(task.status)}</span>
          <span className={late ? 'nz-pv-due late' : 'nz-pv-due'}>{formatDate(task.endDate.slice(0, 10))}</span>
        </span>
      </button>
      <span className="nz-pv-task-end">
        {task.assignee ? (
          <span className="nz-pv-av" title={task.assignee.fullName} style={{ ['--team' as string]: task.assignee.teamColor ?? 'var(--line2)' }}>
            <UserAvatar name={task.assignee.fullName} size={30} />
            <DualRoleBadge user={task.assignee} compact />
          </span>
        ) : null}
        {onChat ? <TaskChatButton taskName={task.name} chat={chat} onOpen={onChat} size="md" /> : null}
      </span>
    </li>
  );
}

export function PhoneProjectOverview({
  data,
  access,
  onSettings,
  onShowGantt,
  onOpenTask,
  onOpenChat,
  views,
}: {
  data: GanttView;
  access: ProjectAccess;
  onSettings(): void;
  onShowGantt(): void;
  onOpenTask(id: string): void;
  onOpenChat?: (id: string) => void;
  /** The other views as chips (board, list…). */
  views: React.ReactNode;
}) {
  const p = data.project;
  const [more, setMore] = useState(false);
  const sections = useMemo(() => sectionsOf(data.tasks), [data.tasks]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const chats = useTaskChatCounts(p.id, data.tasks, Boolean(onOpenChat));
  const milestones = data.tasks.filter((x) => x.type === 'MILESTONE').length;
  const done = data.tasks.filter((x) => x.status === 'DONE').length;
  const end = p.endDate ?? data.tasks.reduce<string | null>((m, x) => (!m || x.endDate > m ? x.endDate : m), null);
  const days = end ? dayjs(end.slice(0, 10)).diff(dayjs(p.startDate.slice(0, 10)), 'day') + 1 : null;
  const showMoney = access.budgetRead && p.budget != null;
  return (
    <div className="nz-pv">
      <div className="nz-pv-cover">
        <ProjectCover project={p} variant="card" />
        {access.manageProject ? (
          <button type="button" className="nz-pv-edit" onClick={onSettings}>
            <IconPencil size={16} stroke={1.9} aria-hidden />
            {t('mproject.edit')}
          </button>
        ) : null}
      </div>

      <h1 className="nz-pv-title" tabIndex={-1}>
        {p.name}
      </h1>
      {p.description ? (
        <div className="nz-pv-desc">
          <p data-open={more || undefined}>{p.description}</p>
          {p.description.length > 140 ? (
            <button type="button" className="nz-pv-more" onClick={() => setMore((m) => !m)} aria-expanded={more}>
              {more ? t('mproject.readLess') : t('mproject.readMore')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="nz-pv-owner">
        <UserPhotoAvatar user={p.owner} size={44} />
        <b>{p.owner.fullName}</b>
      </div>

      <div className="nz-pv-grid">
        <Info icon={IconClockHour4} label={t('mproject.info.duration')} value={days ? tCount('duration.days', days) : t('mproject.info.noEnd')} />
        <Info icon={IconFlag} label={t('mproject.info.milestones')} value={formatNumber(milestones)} />
        <Info icon={IconCalendarEvent} label={t('mproject.info.start')} value={formatDate(p.startDate.slice(0, 10))} />
        <Info icon={IconCalendarDue} label={t('mproject.info.end')} value={end ? formatDate(end.slice(0, 10)) : t('mproject.info.noEnd')} />
        <Info icon={IconProgress} label={t('mproject.info.progress')} value={`${formatNumber(Math.round(p.progress))}٪ · ${formatNumber(done)}/${formatNumber(data.tasks.length)}`} />
        {showMoney ? <Info icon={IconCoin} label={t('mproject.info.budget')} value={formatMoney(p.budget!, p.currency)} /> : null}
      </div>

      <Button size="md" fullWidth leftSection={<IconChartBar size={20} />} onClick={onShowGantt} className="nz-pv-gantt" data-testid="show-gantt">
        {t('mproject.showGantt')}
      </Button>

      {views}

      <h2 className="nz-pv-h">{t('mproject.sections')}</h2>
      {sections.length ? (
        <div className="nz-pv-sections">
          {sections.map((s, i) => {
            const isOpen = open[s.id] ?? i === 0;
            return (
              <section key={s.id} className="nz-pv-sec" data-open={isOpen || undefined}>
                <button type="button" className="nz-pv-sec-head" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [s.id]: !isOpen }))}>
                  <span className="nz-pv-sec-dot" aria-hidden />
                  <b>{s.name}</b>
                  <span className="nz-pv-sec-n num">{`${formatNumber(s.done)}/${formatNumber(s.tasks.length)}`}</span>
                  <IconChevronDown size={20} stroke={1.8} className="nz-pv-sec-chev" aria-hidden />
                </button>
                {isOpen ? (
                  <ul className="nz-pv-tasks">
                    {s.tasks.map((x) => (
                      <TaskRow key={x.id} task={x} chat={chats.get(x.id)} onOpen={() => onOpenTask(x.id)} onChat={onOpenChat ? () => onOpenChat(x.id) : undefined} />
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <p className="nz-hcard-empty">{t('mproject.noTasks')}</p>
      )}
    </div>
  );
}
