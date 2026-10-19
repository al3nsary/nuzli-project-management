/**
 * A task checklist (A9). Admins add, tick, rename, delete and reorder by drag (dnd-kit, vertical
 * only — no direction sign needed); the assignee ticks (`done` only, the API refuses text edits);
 * everyone else reads. Reordering is optimistic and rolled back on error.
 */
import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ActionIcon, Button, Checkbox, Group, Progress, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconGripVertical, IconListCheck, IconPencil, IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ChecklistItemDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { qkA9, useChecklist } from '../../api/a9Queries';
import { qk4 } from '../../api/projectQueries';
import { formatDateTime, formatNumber, t } from '../../i18n';

export type ChecklistMode = 'admin' | 'assignee' | 'read';

export function TaskChecklist({ taskId, projectId, mode }: { taskId: string; projectId?: string; mode: ChecklistMode }) {
  const api = useApi();
  const qc = useQueryClient();
  const list = useChecklist(taskId);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = qkA9.checklist(taskId);
  const items = list.data ?? [];
  const done = items.filter((i) => i.done).length;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const refreshAround = () => {
    void qc.invalidateQueries({ queryKey: qkA9.task(taskId) });
    void qc.invalidateQueries({ queryKey: qk4.myTasks });
    if (projectId) void qc.invalidateQueries({ queryKey: qk4.gantt(projectId) });
  };
  const fail = (err: unknown) => {
    setError(errorMessage(err));
    void qc.invalidateQueries({ queryKey: key });
  };

  const tick = async (item: ChecklistItemDto, value: boolean) => {
    setError(null);
    qc.setQueryData<ChecklistItemDto[]>(key, (cur = []) => cur.map((i) => (i.id === item.id ? { ...i, done: value } : i)));
    try {
      const next = await api.tasks.updateChecklistItem(taskId, item.id, { done: value });
      qc.setQueryData<ChecklistItemDto[]>(key, (cur = []) => cur.map((i) => (i.id === next.id ? next : i)));
      refreshAround();
    } catch (err) {
      fail(err);
    }
  };

  const rename = async (item: ChecklistItemDto, value: string) => {
    setError(null);
    try {
      const next = await api.tasks.updateChecklistItem(taskId, item.id, { text: value });
      qc.setQueryData<ChecklistItemDto[]>(key, (cur = []) => cur.map((i) => (i.id === next.id ? next : i)));
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  const remove = async (item: ChecklistItemDto) => {
    setError(null);
    try {
      await api.tasks.removeChecklistItem(taskId, item.id);
      qc.setQueryData<ChecklistItemDto[]>(key, (cur = []) => cur.filter((i) => i.id !== item.id));
      refreshAround();
      notifications.show({ color: 'ok', message: t('a9s.checklist.removed') });
    } catch (err) {
      fail(err);
    }
  };

  const add = async () => {
    const v = text.trim();
    if (!v) return;
    setAdding(true);
    setError(null);
    try {
      const item = await api.tasks.addChecklistItem(taskId, { text: v });
      qc.setQueryData<ChecklistItemDto[]>(key, (cur = []) => [...cur, item]);
      setText('');
      refreshAround();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((i) => i.id === e.active.id);
    const to = items.findIndex((i) => i.id === e.over!.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(items, from, to);
    qc.setQueryData<ChecklistItemDto[]>(key, next);
    try {
      const saved = await api.tasks.reorderChecklist(taskId, { ids: next.map((i) => i.id) });
      qc.setQueryData<ChecklistItemDto[]>(key, saved);
    } catch (err) {
      fail(err);
    }
  };

  if (list.isLoading) {
    return (
      <Text size="sm" c="dimmed">
        {t('app.loading')}
      </Text>
    );
  }
  if (list.isError) {
    return (
      <Group gap="xs">
        <Text size="sm" c="var(--red)">
          {errorMessage(list.error)}
        </Text>
        <Button size="xs" variant="light" onClick={() => void list.refetch()}>
          {t('common.retry')}
        </Button>
      </Group>
    );
  }

  return (
    <Stack gap="xs">
      {items.length ? (
        <Group gap="sm" wrap="nowrap">
          <Progress value={(done / items.length) * 100} color={done === items.length ? 'ok' : 'field'} radius="xl" size="sm" style={{ flex: 1 }} aria-label={t('a9s.checklist.progress')} />
          <Text size="sm" c="dimmed" className="num">
            {t('a9s.checklist.count', { done: formatNumber(done), total: formatNumber(items.length) })}
          </Text>
        </Group>
      ) : (
        <Group gap="xs" c="dimmed">
          <IconListCheck size={18} aria-hidden />
          <Text size="sm" c="dimmed">
            {mode === 'admin' ? t('a9s.checklist.emptyAdmin') : t('a9s.checklist.empty')}
          </Text>
        </Group>
      )}
      {error ? (
        <Text size="sm" c="var(--red)" role="alert">
          {error}
        </Text>
      ) : null}
      {mode === 'admin' ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ul className="nz-checklist" aria-label={t('a9s.checklist.title')}>
              {items.map((item) => (
                <SortableRow key={item.id} item={item} onTick={tick} onRename={rename} onRemove={remove} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      ) : items.length ? (
        <ul className="nz-checklist" aria-label={t('a9s.checklist.title')}>
          {items.map((item) => (
            <li key={item.id} className="nz-check-row">
              <Checkbox
                size="md"
                checked={item.done}
                disabled={mode === 'read'}
                onChange={(e) => void tick(item, e.currentTarget.checked)}
                label={<CheckLabel item={item} />}
                styles={{ body: { alignItems: 'flex-start' }, labelWrapper: { minWidth: 0 } }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {mode === 'admin' ? (
        <Group gap="xs" wrap="nowrap" align="flex-end">
          <TextInput
            style={{ flex: 1 }}
            placeholder={t('a9s.checklist.addPlaceholder')}
            aria-label={t('a9s.checklist.addLabel')}
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void add();
              }
            }}
          />
          <Button leftSection={<IconPlus size={16} />} variant="light" onClick={() => void add()} loading={adding} disabled={!text.trim()}>
            {t('a9s.checklist.add')}
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}

function CheckLabel({ item }: { item: ChecklistItemDto }) {
  return (
    <span style={{ display: 'block', minWidth: 0 }}>
      <Text span size="sm" td={item.done ? 'line-through' : undefined} c={item.done ? 'dimmed' : undefined} style={{ overflowWrap: 'anywhere' }}>
        {item.text}
      </Text>
      {item.done && item.doneBy ? (
        <Text span size="xs" c="dimmed" display="block">
          {t('a9s.checklist.doneBy', { name: item.doneBy.fullName, at: item.doneAt ? formatDateTime(item.doneAt) : '' })}
        </Text>
      ) : null}
    </span>
  );
}

function SortableRow({
  item,
  onTick,
  onRename,
  onRemove,
}: {
  item: ChecklistItemDto;
  onTick(item: ChecklistItemDto, v: boolean): Promise<void>;
  onRename(item: ChecklistItemDto, v: string): Promise<boolean>;
  onRemove(item: ChecklistItemDto): Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 2 : undefined,
    boxShadow: isDragging ? 'var(--lift)' : undefined,
  };
  const save = async () => {
    const v = draft.trim();
    if (!v || v === item.text) {
      setEditing(false);
      setDraft(item.text);
      return;
    }
    if (await onRename(item, v)) setEditing(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      setEditing(false);
      setDraft(item.text);
    }
  };
  return (
    <li ref={setNodeRef} style={style} className="nz-check-row" data-dragging={isDragging || undefined}>
      <ActionIcon
        ref={setActivatorNodeRef}
        variant="subtle"
        color="gray"
        size={36}
        aria-label={t('a9s.checklist.drag', { text: item.text })}
        style={{ cursor: 'grab', touchAction: 'none', flex: '0 0 auto' }}
        {...attributes}
        {...listeners}
      >
        <IconGripVertical size={18} />
      </ActionIcon>
      {editing ? (
        <Group gap={4} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            style={{ flex: 1 }}
            value={draft}
            maxLength={500}
            autoFocus
            aria-label={t('a9s.checklist.editLabel')}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={onKey}
          />
          <ActionIcon variant="light" color="field" size={36} aria-label={t('a9s.checklist.saveEdit')} onClick={() => void save()}>
            <IconCheck size={18} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="gray"
            size={36}
            aria-label={t('common.cancel')}
            onClick={() => {
              setEditing(false);
              setDraft(item.text);
            }}
          >
            <IconX size={18} />
          </ActionIcon>
        </Group>
      ) : (
        <>
          <Checkbox
            size="md"
            style={{ flex: 1, minWidth: 0 }}
            checked={item.done}
            onChange={(e) => void onTick(item, e.currentTarget.checked)}
            label={<CheckLabel item={item} />}
            styles={{ body: { alignItems: 'flex-start' }, labelWrapper: { minWidth: 0 } }}
          />
          <ActionIcon variant="subtle" color="gray" size={36} aria-label={t('a9s.checklist.edit', { text: item.text })} onClick={() => setEditing(true)}>
            <IconPencil size={17} />
          </ActionIcon>
          <ActionIcon variant="subtle" color="breach" size={36} aria-label={t('a9s.checklist.remove', { text: item.text })} onClick={() => void onRemove(item)}>
            <IconTrash size={17} />
          </ActionIcon>
        </>
      )}
    </li>
  );
}
