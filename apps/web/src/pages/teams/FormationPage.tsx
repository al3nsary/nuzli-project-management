import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Modal,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import {
  IconArrowsExchange,
  IconChevronLeft,
  IconChevronRight,
  IconDots,
  IconGripVertical,
  IconHelmetOff,
  IconHistory,
  IconSearch,
  IconUserOff,
  IconX,
} from '@tabler/icons-react';
import { Menu } from '@mantine/core';
import { ForemanBadge, SupervisorAvatars, supervisorsOf } from './shared';
import type { MemberDto, TeamDto, TeamSummaryDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useAllMembers, useInvalidateTeams, useTeams } from '../../api/queries';
import { ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { VestBand } from '../../theme/VestBand';
import { MemberAvatar } from '../../components/UserAvatar';
import { scrollInline } from '../../lib/direction';
import { EDGE_SAFE_MIDDLEWARES, revealTarget } from '../../lib/floating';
import { formatNumber, localizeDigits, t } from '../../i18n';
import { MemberDrawer } from '../members/MemberDrawer';
import { useOverlayParam } from '../../lib/useUrlState';
import { ForemanAvatar, foremanFirst } from '../../components/Foreman';
import { HardHat } from '../../components/HardHat';

/** Column id of people without an open membership. Moves into it are not part of the API. */
export const UNASSIGNED = 'unassigned';
const ALL_MEMBERS_KEY = ['members', 'all'] as const;
const EDGE = 64;
const SPEED = 14;

interface Column {
  id: string;
  team: TeamDto | null;
}

interface PendingMove {
  memberIds: string[];
  toTeam: TeamDto;
}

const colOf = (m: MemberDto) => m.team?.id ?? UNASSIGNED;

/**
 * Arrow keys jump between columns by their on-screen position: ArrowLeft goes to the column
 * physically on the left, whatever the direction — so it is right in RTL without a sign flip.
 * Up/Down nudge vertically inside a column.
 */
const columnJump: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
  const { code } = event;
  if (code === 'ArrowUp' || code === 'ArrowDown') {
    event.preventDefault();
    return { ...currentCoordinates, y: currentCoordinates.y + (code === 'ArrowDown' ? 48 : -48) };
  }
  if (code !== 'ArrowLeft' && code !== 'ArrowRight') return undefined;
  event.preventDefault();
  const active = context.collisionRect;
  if (!active) return currentCoordinates;
  const centre = active.left + active.width / 2;
  const targets = [...context.droppableContainers.values()]
    .filter((c) => !c.disabled)
    .map((c) => context.droppableRects.get(c.id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({ left: r.left, width: r.width, centre: r.left + r.width / 2 }))
    .sort((a, b) => a.centre - b.centre);
  const next =
    code === 'ArrowLeft'
      ? [...targets].reverse().find((r) => r.centre < centre - 4)
      : targets.find((r) => r.centre > centre + 4);
  if (!next) return currentCoordinates;
  return { x: currentCoordinates.x + (next.centre - centre), y: currentCoordinates.y };
};

/** Pointer first; the keyboard has no pointer, so fall back to rectangle overlap. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

const MemberCard = memo(function MemberCard({
  member,
  selected,
  onToggle,
  onOpen,
  onForeman,
  dragging,
}: {
  member: MemberDto;
  selected: boolean;
  onToggle: (id: string, additive: boolean) => void;
  onOpen: (id: string) => void;
  /** A9 (ADR-101): set (true) or clear (false) this member as the team's worker foreman. */
  onForeman?: (member: MemberDto, on: boolean) => void;
  dragging: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: member.id,
    data: { from: colOf(member) },
  });
  const menuTarget = useRef<HTMLButtonElement>(null);
  const style: CSSProperties = {
    opacity: isDragging || (dragging && selected) ? 0.4 : 1,
    ['--team' as string]: member.team?.color.hex ?? 'var(--muted)',
  };
  return (
    <div
      ref={setNodeRef}
      className="nz-member-card vest"
      data-selected={selected || undefined}
      data-foreman={member.isForeman || undefined}
      style={style}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          onToggle(member.id, true);
        }
      }}
    >
      <Checkbox
        size="sm"
        checked={selected}
        onChange={() => onToggle(member.id, true)}
        aria-label={t('formation.select', { name: member.fullName })}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        className="nz-member-handle"
        {...listeners}
        {...attributes}
        aria-roledescription={t('formation.a11y.role')}
        aria-label={t('formation.dragLabel', { name: member.fullName })}
      >
        <IconGripVertical size={16} aria-hidden />
        <ForemanAvatar foreman={member.isForeman} size={28}>
          <MemberAvatar member={member} size={28} />
        </ForemanAvatar>
        <span className="nz-member-text">
          <span className="nz-member-name">{member.fullName}</span>
          {member.isForeman ? (
            <span className="nz-member-foreman">
              <ForemanBadge size="xs" />
            </span>
          ) : null}
          <span className="nz-member-meta">
            {member.jobTitle ?? t('common.none')} ·{' '}
            <span className="ltr mono">{localizeDigits(member.nationalIdMasked)}</span>
          </span>
        </span>
      </button>
      {onForeman && member.team ? (
        <Menu
          position="bottom-end"
          width={220}
          shadow="md"
          withinPortal
          middlewares={EDGE_SAFE_MIDDLEWARES}
          onOpen={() => revealTarget(menuTarget.current)}
        >
          <Menu.Target>
            <ActionIcon
              ref={menuTarget}
              variant="subtle"
              color="slate"
              size={32}
              aria-label={t('formation.memberActions', { name: member.fullName })}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <IconDots size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconHistory size={16} />} onClick={() => onOpen(member.id)}>
              {t('members.history')}
            </Menu.Item>
            {member.isForeman ? (
              <Menu.Item leftSection={<IconHelmetOff size={16} />} onClick={() => onForeman(member, false)}>
                {t('teams.foreman.clear')}
              </Menu.Item>
            ) : (
              <Menu.Item leftSection={<HardHat size={16} />} onClick={() => onForeman(member, true)}>
                {t('teams.foreman.setShort')}
              </Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      ) : (
        <ActionIcon
          variant="subtle"
          color="slate"
          size={32}
          onClick={() => onOpen(member.id)}
          aria-label={t('members.historyOf', { name: member.fullName })}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconHistory size={16} />
        </ActionIcon>
      )}
    </div>
  );
});

function BoardColumn({
  column,
  members,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  onForeman,
  dragging,
}: {
  column: Column;
  members: MemberDto[];
  selected: Set<string>;
  onToggle: (id: string, additive: boolean) => void;
  onToggleAll: (ids: string[], on: boolean) => void;
  onOpen: (id: string) => void;
  onForeman?: (member: MemberDto, on: boolean) => void;
  dragging: boolean;
}) {
  const isUnassigned = column.team === null;
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: isUnassigned });
  const allSelected = members.length > 0 && members.every((m) => selected.has(m.id));
  const headerStyle = column.team
    ? ({ background: column.team.color.hex, color: '#fff' } as CSSProperties)
    : undefined;
  return (
    <section
      className="nz-col"
      data-col={column.id}
      data-over={isOver || undefined}
      aria-label={column.team ? t('team.badgeTitle', { name: column.team.name }) : t('formation.unassigned')}
    >
      <header className={column.team ? 'nz-col-head' : 'nz-col-head nz-col-head--none'} style={headerStyle}>
        <Group justify="space-between" wrap="nowrap" gap={6}>
          <Text fw={700} lh={1.3} className="nz-clamp-2" c="inherit">
            {column.team ? column.team.name : t('formation.unassigned')}
          </Text>
          <Badge
            variant={column.team ? 'white' : 'light'}
            color={column.team ? 'dark' : 'slate'}
            className="num"
            style={{ flex: 'none' }}
          >
            {formatNumber(members.length)}
          </Badge>
        </Group>
        {column.team ? (
          <div className="nz-col-sups">
            <SupervisorAvatars supervisors={supervisorsOf(column.team)} size={24} max={3} />
            <Text size="xs" c="inherit" opacity={0.92} truncate>
              {supervisorsOf(column.team)
                .map((s) => (s.isPrimary ? t('teams.sup.namePrimary', { name: s.fullName }) : s.fullName))
                .join('، ') || t('teams.noSupervisor')}
            </Text>
          </div>
        ) : null}
        {column.team && members.some((m) => m.isForeman) ? (
          <span className="nz-col-foreman">
            <HardHat size={13} />
            {t('teams.foreman.label')}: {members.find((m) => m.isForeman)?.fullName}
          </span>
        ) : null}
        {column.team ? null : (
          <Text size="xs" c="inherit" opacity={0.9} truncate>
            {t('formation.unassignedHint')}
          </Text>
        )}
        {members.length ? (
          <Checkbox
            mt={6}
            size="xs"
            checked={allSelected}
            indeterminate={!allSelected && members.some((m) => selected.has(m.id))}
            onChange={() => onToggleAll(members.map((m) => m.id), !allSelected)}
            label={t('formation.selectColumn')}
            styles={{ label: { color: 'inherit' } }}
            color={column.team ? 'dark' : 'field'}
          />
        ) : null}
      </header>
      <div ref={setNodeRef} className="nz-col-body">
        {members.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            {isUnassigned ? t('formation.noneUnassigned') : t('formation.dropHere')}
          </Text>
        ) : (
          members.map((m) => (
            <MemberCard
              key={m.id}
              member={m}
              selected={selected.has(m.id)}
              onToggle={onToggle}
              onOpen={onOpen}
              onForeman={onForeman}
              dragging={dragging}
            />
          ))
        )}
      </div>
    </section>
  );
}

export function FormationPage() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateTeams();
  const teamsQ = useTeams({ status: 'ACTIVE' });
  const membersQ = useAllMembers();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search, 200);
  const [shownTeams, setShownTeams] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [reason, setReason] = useState('');
  const [bulkTarget, setBulkTarget] = useState<string | null>(null);
  const drawer = useOverlayParam('member');
  const boardRef = useRef<HTMLDivElement>(null);
  const pointerX = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnJump }),
  );

  /** A9 (ADR-101): set or clear a team's worker foreman from its card. */
  const setForeman = async (m: MemberDto, on: boolean) => {
    if (!m.team) return;
    try {
      if (on) await api.teams.setForeman(m.team.id, m.id);
      else await api.teams.clearForeman(m.team.id);
      await invalidate();
      await qc.invalidateQueries({ queryKey: ALL_MEMBERS_KEY });
      notifications.show({
        color: 'ok',
        message: on ? t('teams.foreman.set', { name: m.fullName }) : t('teams.foreman.cleared', { name: m.fullName }),
      });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

  const teams = teamsQ.data ?? [];
  const members = membersQ.data ?? [];
  const teamById = useMemo(() => new Map(teams.map((tm) => [tm.id, tm])), [teams]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const columns: Column[] = useMemo(() => {
    const visible = shownTeams.length ? teams.filter((tm) => shownTeams.includes(tm.id)) : teams;
    return [{ id: UNASSIGNED, team: null }, ...visible.map((team) => ({ id: team.id, team }))];
  }, [teams, shownTeams]);

  const byColumn = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const map = new Map<string, MemberDto[]>(columns.map((c) => [c.id, []]));
    for (const m of members) {
      if (
        needle &&
        !m.fullName.toLowerCase().includes(needle) &&
        !(m.jobTitle ?? '').toLowerCase().includes(needle) &&
        !(m.department ?? '').toLowerCase().includes(needle)
      )
        continue;
      map.get(colOf(m))?.push(m);
    }
    // A10: the worker foreman is pinned at the top of their team column.
    for (const [k, list] of map) map.set(k, foremanFirst(list));
    return map;
  }, [members, columns, q]);

  const toggle = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleAll = useCallback((ids: string[], on: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  // ---------------------------------------------------------------- edge auto-scroll
  // dnd-kit's auto-scroller assumes scrollLeft grows to the right, which is false in RTL
  // (scrollLeft is 0 at the start and negative towards the left). Pointer x and scrollBy are
  // both physical, so this loop is correct in either direction without a sign flip.
  const stopAutoScroll = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    pointerX.current = null;
  };
  const tick = () => {
    const board = boardRef.current;
    const x = pointerX.current;
    if (board && x !== null) {
      const rect = board.getBoundingClientRect();
      if (x < rect.left + EDGE) board.scrollBy({ left: -SPEED });
      else if (x > rect.right - EDGE) board.scrollBy({ left: SPEED });
    }
    raf.current = requestAnimationFrame(tick);
  };
  useEffect(() => stopAutoScroll, []);

  const startX = useRef(0);
  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
    const ev = e.activatorEvent as MouseEvent | TouchEvent;
    const isPointer = 'touches' in ev || 'clientX' in ev;
    if (isPointer) {
      startX.current = 'touches' in ev ? ev.touches[0]?.clientX ?? 0 : ev.clientX;
      pointerX.current = startX.current;
      raf.current = requestAnimationFrame(tick);
    }
  };
  const onDragMove = (e: DragMoveEvent) => {
    if (pointerX.current !== null) pointerX.current = startX.current + e.delta.x;
  };
  const onDragOver = (e: DragOverEvent) => {
    // Keyboard moves: bring the target column into view (scrollIntoView is direction-aware).
    if (e.over && pointerX.current === null) {
      document
        .querySelector(`[data-col="${String(e.over.id)}"]`)
        ?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
    }
  };

  const requestMove = (memberIds: string[], toTeamId: string) => {
    const toTeam = teamById.get(toTeamId);
    if (!toTeam) return;
    const ids = memberIds.filter((id) => memberById.get(id)?.team?.id !== toTeamId);
    if (!ids.length) {
      notifications.show({ color: 'slate', message: t('formation.alreadyThere', { team: toTeam.name }) });
      return;
    }
    setReason('');
    setPending({ memberIds: ids, toTeam });
  };

  const onDragEnd = (e: DragEndEvent) => {
    stopAutoScroll();
    setActiveId(null);
    const id = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!over || over === UNASSIGNED) return;
    const ids = selected.has(id) ? [...selected] : [id];
    requestMove(ids, over);
  };

  /** Optimistic: the board moves at once; on error it rolls back and says why. */
  const confirmMove = async () => {
    if (!pending) return;
    const { memberIds, toTeam } = pending;
    const summary: TeamSummaryDto = { id: toTeam.id, name: toTeam.name, color: toTeam.color };
    const previous = qc.getQueryData<MemberDto[]>(ALL_MEMBERS_KEY);
    qc.setQueryData<MemberDto[]>(ALL_MEMBERS_KEY, (old) =>
      (old ?? []).map((m) => (memberIds.includes(m.id) ? { ...m, team: summary } : m)),
    );
    setPending(null);
    setSelected(new Set());
    try {
      await api.members.move({ memberIds, toTeamId: toTeam.id, reason: reason.trim() || undefined });
      notifications.show({
        color: 'ok',
        message: t('formation.moved', { count: memberIds.length, team: toTeam.name }),
      });
      await invalidate();
    } catch (err) {
      qc.setQueryData(ALL_MEMBERS_KEY, previous);
      notifications.show({
        color: 'breach',
        title: t('formation.moveFailed'),
        message: errorMessage(err),
      });
    }
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t('formation.a11y.start', { name: memberById.get(String(active.id))?.fullName ?? '' }),
    onDragOver: ({ active, over }) => {
      const name = memberById.get(String(active.id))?.fullName ?? '';
      const team = over ? teamById.get(String(over.id))?.name : undefined;
      return team ? t('formation.a11y.over', { name, team }) : t('formation.a11y.outside', { name });
    },
    onDragEnd: ({ active, over }) => {
      const name = memberById.get(String(active.id))?.fullName ?? '';
      const team = over ? teamById.get(String(over.id))?.name : undefined;
      return team ? t('formation.a11y.drop', { name, team }) : t('formation.a11y.cancel', { name });
    },
    onDragCancel: ({ active }) =>
      t('formation.a11y.cancel', { name: memberById.get(String(active.id))?.fullName ?? '' }),
  };

  if (teamsQ.isLoading || membersQ.isLoading) return <LoadingBlock variant="board" header />;
  if (teamsQ.isError) return <ErrorBlock error={teamsQ.error} onRetry={() => void teamsQ.refetch()} />;
  if (membersQ.isError)
    return <ErrorBlock error={membersQ.error} onRetry={() => void membersQ.refetch()} />;

  const active = activeId ? memberById.get(activeId) : undefined;
  const dragCount = activeId && selected.has(activeId) ? selected.size : 1;
  const colWidth = () =>
    (boardRef.current?.querySelector('.nz-col') as HTMLElement | null)?.offsetWidth ?? 300;

  return (
    <>
      <PageHeader title={t('formation.title')} lead={t('formation.lead')} />
      <Stack gap="sm">
        <Group gap="sm" wrap="wrap" align="flex-end">
          <TextInput
            leftSection={<IconSearch size={16} />}
            placeholder={t('formation.search')}
            aria-label={t('formation.search')}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            style={{ flex: '1 1 220px' }}
          />
          <MultiSelect
            aria-label={t('formation.filterTeams')}
            placeholder={shownTeams.length ? undefined : t('formation.allTeams')}
            data={teams.map((tm) => ({ value: tm.id, label: tm.name }))}
            value={shownTeams}
            onChange={setShownTeams}
            clearable
            searchable
            style={{ flex: '1 1 240px' }}
          />
          <Group gap={4} wrap="nowrap">
            {/* «السابق/التالي» scroll along the reading direction: the sign comes from dirSign(). */}
            <ActionIcon
              variant="default"
              size={40}
              aria-label={t('formation.prevColumns')}
              onClick={() => boardRef.current && scrollInline(boardRef.current, -colWidth())}
            >
              <IconChevronLeft size={18} className="mirror-rtl" />
            </ActionIcon>
            <ActionIcon
              variant="default"
              size={40}
              aria-label={t('formation.nextColumns')}
              onClick={() => boardRef.current && scrollInline(boardRef.current, colWidth())}
            >
              <IconChevronRight size={18} className="mirror-rtl" />
            </ActionIcon>
          </Group>
        </Group>
        <Text size="xs" c="dimmed">
          {t('formation.keyboardHint')}
        </Text>

        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          autoScroll={false}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          accessibility={{
            announcements,
            screenReaderInstructions: { draggable: t('formation.a11y.instructions') },
          }}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            stopAutoScroll();
            setActiveId(null);
          }}
        >
          <div ref={boardRef} className="nz-board" role="region" aria-label={t('formation.board')}>
            {columns.map((c) => (
              <BoardColumn
                key={c.id}
                column={c}
                members={byColumn.get(c.id) ?? []}
                selected={selected}
                onToggle={toggle}
                onToggleAll={toggleAll}
                onOpen={drawer.open}
                onForeman={(m, on) => void setForeman(m, on)}
                dragging={Boolean(activeId)}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {active ? (
              <VestBand color={active.team?.color.hex ?? 'var(--muted)'} className="nz-member-card nz-member-overlay">
                <Text fw={600} size="sm">
                  {active.fullName}
                </Text>
                {dragCount > 1 ? (
                  <Badge color="field" variant="filled" size="sm">
                    {t('formation.dragMany', { count: dragCount })}
                  </Badge>
                ) : null}
              </VestBand>
            ) : null}
          </DragOverlay>
        </DndContext>
      </Stack>

      {selected.size ? (
        <Paper className="nz-bulk-bar" shadow="md" withBorder>
          <Group gap="sm" wrap="wrap" justify="space-between">
            <Group gap="xs">
              <Badge color="field" variant="filled" className="num">
                {formatNumber(selected.size)}
              </Badge>
              <Text size="sm" fw={500}>
                {t('formation.selected')}
              </Text>
              <Button
                variant="subtle"
                size="compact-sm"
                leftSection={<IconX size={14} />}
                onClick={() => setSelected(new Set())}
              >
                {t('formation.clearSelection')}
              </Button>
            </Group>
            <Group gap="xs" wrap="nowrap" style={{ flex: '1 1 280px' }}>
              <Select
                aria-label={t('formation.moveTo')}
                placeholder={t('formation.moveTo')}
                data={teams.map((tm) => ({ value: tm.id, label: tm.name }))}
                value={bulkTarget}
                onChange={setBulkTarget}
                searchable
                style={{ flex: 1 }}
                comboboxProps={{ position: 'top' }}
              />
              <Button
                leftSection={<IconArrowsExchange size={18} />}
                disabled={!bulkTarget}
                onClick={() => bulkTarget && requestMove([...selected], bulkTarget)}
              >
                {t('formation.move')}
              </Button>
            </Group>
          </Group>
        </Paper>
      ) : null}

      <Modal
        opened={Boolean(pending)}
        onClose={() => setPending(null)}
        title={t('formation.confirmTitle')}
      >
        {pending ? (
          <Stack>
            <Text>
              {t('formation.confirmBody', {
                count: pending.memberIds.length,
                team: pending.toTeam.name,
              })}
            </Text>
            <Box component="ul" m={0} ps="lg" mah={160} style={{ overflow: 'auto' }}>
              {pending.memberIds.slice(0, 20).map((id) => {
                const m = memberById.get(id);
                return (
                  <li key={id}>
                    <Text size="sm">
                      {m?.fullName}{' '}
                      <Text span c="dimmed" size="xs">
                        ({m?.team?.name ?? t('formation.unassigned')})
                      </Text>
                    </Text>
                  </li>
                );
              })}
            </Box>
            <Text size="xs" c="dimmed">
              {t('formation.historyNote')}
            </Text>
            <Textarea
              label={t('teams.reasonOptional')}
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              autosize
              minRows={2}
              maxLength={300}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setPending(null)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void confirmMove()} leftSection={<IconArrowsExchange size={18} />}>
                {t('formation.confirm', { count: pending.memberIds.length })}
              </Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>
      <MemberDrawer memberId={drawer.value} onClose={drawer.close} />
      {teams.length === 0 ? (
        <Group mt="md" gap="xs" c="dimmed">
          <IconUserOff size={18} />
          <Text size="sm">{t('formation.noTeams')}</Text>
        </Group>
      ) : null}
    </>
  );
}
