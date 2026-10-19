/**
 * «لوحة» (Kanban) by status with dnd-kit (brief §6.1). Admins move any task; a supervisor moves
 * only tasks assigned to them, and only the status changes (ADR-007). Keyboard: on a card,
 * ←/→ move it to the next/previous column in reading order (RTL), Enter opens it.
 */
import { useMemo, useState, type KeyboardEvent } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Badge, Button, Group, SegmentedControl, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { can, type GanttDto, type TaskDto, type TaskStatus } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import type { useProjectWrites } from '../../api/projectWrites';
import { useAuthStore } from '../../stores/auth';
import { formatDate, formatNumber, t } from '../../i18n';
import { mergeTasks } from '../../features/gantt/batch';
import { riyadhToday } from '../../features/projects/engine';
import { useQueryClient } from '@tanstack/react-query';
import { qk4 } from '../../api/projectQueries';
import { AssigneeChip, TASK_STATUSES, taskStatusLabel } from './parts';
import { ConflictAlert } from './TaskDrawer';
import { TaskChatButton, type ChatCount } from '../../features/tasks/TaskChatButton';

type Writes = ReturnType<typeof useProjectWrites>;
const PAGE = 60;

export function BoardView({
  data,
  writes,
  onOpenTask,
  chatCounts,
  onOpenChat,
}: {
  data: GanttDto;
  writes: Writes;
  onOpenTask(id: string): void;
  /** A10: the chat icon on every card. */
  chatCounts?: ReadonlyMap<string, ChatCount>;
  onOpenChat?(id: string): void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const admin = can(user, 'tasks.manage');
  const [scope, setScope] = useState<'all' | 'mine'>(admin ? 'all' : 'mine');
  const [limit, setLimit] = useState<Record<string, number>>({});
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const parents = useMemo(() => new Set(data.tasks.map((x) => x.parentId).filter(Boolean)), [data.tasks]);
  const cards = useMemo(
    () => data.tasks.filter((x) => !parents.has(x.id) && x.type !== 'GROUP' && (scope === 'all' || x.assignee?.id === user?.id)),
    [data.tasks, parents, scope, user?.id],
  );
  const canMove = (task: TaskDto) => admin || (task.assignee?.id === user?.id && can(user, 'tasks.updateAssigned'));

  const move = async (task: TaskDto, status: TaskStatus) => {
    if (task.status === status || !canMove(task)) return;
    const key = qk4.gantt(data.project.id);
    const snapshot = qc.getQueryData<GanttDto>(key);
    if (snapshot) qc.setQueryData(key, mergeTasks(snapshot, [{ ...task, status }])); // optimistic
    try {
      const res = await writes.run(() => api.tasks.update(task.id, { version: task.version, status }));
      writes.merge([res.task, ...res.affected]);
      notifications.show({ color: 'ok', message: t('board.moved', { name: task.name, status: taskStatusLabel(status) }) });
    } catch (err) {
      if (snapshot) qc.setQueryData(key, snapshot); // rollback
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    const task = cards.find((x) => x.id === e.active.id);
    const status = e.over?.id as TaskStatus | undefined;
    if (task && status) void move(task, status);
  };

  const onCardKey = (e: KeyboardEvent<HTMLDivElement>, task: TaskDto) => {
    const i = TASK_STATUSES.indexOf(task.status);
    // Columns read right → left in RTL: ← is the next column.
    if (e.key === 'ArrowLeft' && i < TASK_STATUSES.length - 1) {
      e.preventDefault();
      void move(task, TASK_STATUSES[i + 1]!);
    } else if (e.key === 'ArrowRight' && i > 0) {
      e.preventDefault();
      void move(task, TASK_STATUSES[i - 1]!);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onOpenTask(task.id);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      {writes.conflict ? <ConflictAlert onRefresh={() => void writes.refresh()} /> : null}
      <Group justify="space-between" wrap="wrap" gap="xs">
        <SegmentedControl
          size="xs"
          value={scope}
          onChange={(v) => setScope(v as 'all' | 'mine')}
          data={[
            { value: 'all', label: t('board.all') },
            { value: 'mine', label: t('board.mine') },
          ]}
        />
        <Text size="xs" c="dimmed">
          {admin ? t('board.hintAdmin') : t('board.hintSupervisor')}
        </Text>
      </Group>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="nz-board" role="list" aria-label={t('board.label')}>
          {TASK_STATUSES.map((status) => {
            const items = cards.filter((x) => x.status === status);
            const shown = items.slice(0, limit[status] ?? PAGE);
            return (
              <Column key={status} status={status} count={items.length}>
                {shown.map((task) => (
                  <Card key={task.id} task={task} locked={!canMove(task)} onOpen={onOpenTask} onKey={onCardKey} chat={chatCounts?.get(task.id)} onOpenChat={onOpenChat} />
                ))}
                {items.length > shown.length ? (
                  <Button variant="subtle" size="xs" onClick={() => setLimit((l) => ({ ...l, [status]: (l[status] ?? PAGE) + PAGE }))}>
                    {t('board.more', { count: formatNumber(items.length - shown.length) })}
                  </Button>
                ) : null}
              </Column>
            );
          })}
        </div>
      </DndContext>
    </div>
  );
}

function Column({ status, count, children }: { status: TaskStatus; count: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section ref={setNodeRef} className="nz-board-col" data-over={isOver} role="listitem" aria-label={taskStatusLabel(status)}>
      <Group justify="space-between" px={4} pb={6}>
        <Text fw={600}>{taskStatusLabel(status)}</Text>
        <Badge variant="light" color="gray" radius="xl" className="num">
          {formatNumber(count)}
        </Badge>
      </Group>
      <div className="nz-board-list">{children}</div>
    </section>
  );
}

function Card({
  task,
  locked,
  onOpen,
  onKey,
  chat,
  onOpenChat,
}: {
  task: TaskDto;
  locked: boolean;
  onOpen(id: string): void;
  onKey(e: KeyboardEvent<HTMLDivElement>, t: TaskDto): void;
  chat?: ChatCount;
  onOpenChat?(id: string): void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id, disabled: locked });
  const late = task.status !== 'DONE' && task.endDate < riyadhToday();
  // dnd-kit gives a physical delta; the transform is applied as is (not a logical offset).
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 5, opacity: isDragging ? 0.9 : 1 } : undefined;
  return (
    <div
      ref={setNodeRef}
      className="nz-board-card"
      data-locked={locked}
      style={style}
      {...attributes}
      {...(locked ? {} : listeners)}
      role="button"
      tabIndex={0}
      aria-roledescription={locked ? undefined : t('board.cardRole')}
      aria-label={t('board.cardLabel', { name: task.name, status: taskStatusLabel(task.status) })}
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => (locked ? e.key === 'Enter' && onOpen(task.id) : onKey(e, task))}
    >
      <Group justify="space-between" gap={4} wrap="nowrap">
        <Text size="xs" c="dimmed" className="mono">
          {task.wbs}
        </Text>
        {late ? (
          <Badge size="xs" color="breach" variant="light">
            {t('gantt.overdue')}
          </Badge>
        ) : null}
      </Group>
      <Text fw={600} size="sm" lh={1.4} className="nz-clamp-2">
        {task.name}
      </Text>
      <Text size="xs" c="dimmed" mt={2}>
        {t('board.due', { date: formatDate(task.endDate) })} · {`${formatNumber(Math.round(task.progress))}٪`}
      </Text>
      <Group justify="space-between" gap={6} wrap="nowrap" mt={6}>
        <AssigneeChip assignee={task.assignee} size="sm" />
        {onOpenChat ? <TaskChatButton taskName={task.name} chat={chat} onOpen={() => onOpenChat(task.id)} /> : null}
      </Group>
    </div>
  );
}
