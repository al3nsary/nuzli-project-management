import type { CSSProperties } from 'react';
import { Badge, Group, Progress, Text } from '@mantine/core';
import type { MyTaskDto, Priority, ProjectStatus, TaskDto, TaskStatus } from '@nuzli/shared';
import { formatNumber, t, tKey } from '../../i18n';
import { DualRoleBadge } from '../../features/workspaces/DualRole';

export const TASK_STATUSES: TaskStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'DONE'];
export const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const PROJECT_STATUSES: ProjectStatus[] = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'];

export const taskStatusLabel = (s: string) => tKey(`taskStatus.${s}`, 'common.none');
export const priorityLabel = (p: string) => tKey(`priority.${p}`, 'common.none');
export const projectStatusLabel = (s: string) => tKey(`projectStatus.${s}`, 'common.none');
export const taskTypeLabel = (s: string) => tKey(`taskType.${s}`, 'common.none');

/** Colour carries state only (design skill): done = ok, in progress = field, on hold = signal. */
const STATUS_COLOR: Record<TaskStatus, string> = {
  NOT_STARTED: 'gray',
  IN_PROGRESS: 'field',
  ON_HOLD: 'signal',
  DONE: 'ok',
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge variant="light" color={STATUS_COLOR[status]} radius="xl">
      {taskStatusLabel(status)}
    </Badge>
  );
}

export function PriorityText({ priority }: { priority: Priority }) {
  const urgent = priority === 'URGENT' || priority === 'HIGH';
  return (
    <Text size="sm" fw={urgent ? 600 : 400} c={priority === 'URGENT' ? 'var(--breach)' : undefined}>
      {priorityLabel(priority)}
    </Text>
  );
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const color = status === 'ACTIVE' ? 'field' : status === 'COMPLETED' ? 'ok' : status === 'ON_HOLD' ? 'signal' : 'gray';
  return (
    // min-width: max-content — in a squeezed table cell the label used to shrink to «ـ.» (A9 QA).
    <Badge variant="light" color={color} radius="xl" style={{ minWidth: 'max-content' }}>
      {projectStatusLabel(status)}
    </Badge>
  );
}

export function ProgressLine({ value, label }: { value: number; label?: string }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Progress value={value} color={value >= 100 ? 'ok' : 'field'} size="md" radius="xl" style={{ flex: 1 }} aria-label={label ?? t('task.progress')} />
      <Text size="sm" className="num" style={{ minWidth: 40, textAlign: 'end' }}>
        {`${formatNumber(Math.round(value))}٪`}
      </Text>
    </Group>
  );
}

/** Assignee with the vest band in the team colour, always with the team name. */
export function AssigneeChip({ assignee, size = 'md' }: { assignee: TaskDto['assignee']; size?: 'sm' | 'md' }) {
  if (!assignee) {
    return (
      <Text size="sm" c="dimmed">
        {t('task.unassigned')}
      </Text>
    );
  }
  const style = {
    '--team': assignee.teamColor ?? 'var(--muted)',
    display: 'inline-flex',
    flexDirection: 'column',
    lineHeight: 1.25,
    borderRadius: 6,
    minWidth: 0,
    paddingBlock: 2,
  } as CSSProperties;
  return (
    <span className="vest" style={style}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <Text span size={size === 'sm' ? 'xs' : 'sm'} fw={500} truncate>
          {assignee.fullName}
        </Text>
        <DualRoleBadge user={assignee} compact={size === 'sm'} />
      </span>
      <Text span size="xs" c="dimmed" truncate>
        {assignee.teamName ?? t('gantt.noTeam')}
      </Text>
    </span>
  );
}

export type Bucket = 'overdue' | 'soon' | 'later' | 'done';

/** «مهامي» groups, from the API's flags (ADR-059). */
export function bucketOf(task: MyTaskDto): Bucket {
  if (task.status === 'DONE') return 'done';
  if (task.overdue) return 'overdue';
  if (task.dueSoon) return 'soon';
  return 'later';
}
