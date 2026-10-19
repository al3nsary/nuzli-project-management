import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ActionIcon, Badge, Menu, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  IconArchive,
  IconArrowsMove,
  IconBriefcase,
  IconBuilding,
  IconChevronDown,
  IconDots,
  IconGripVertical,
  IconLink,
  IconPencil,
  IconPlus,
  IconSitemap,
  IconTrash,
  IconUnlink,
  IconUserQuestion,
  IconUsersGroup,
} from '@tabler/icons-react';
import type { OrgPositionDto, OrgUnitDto, OrgUnitKind } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { PhotoAvatar } from '../../components/UserAvatar';
import { TeamBadge } from '../../theme/TeamBadge';
import { buildForest, canMoveUnit, visibleRows, type OrgNode } from '../../features/org/layout';
import { dirSign } from '../../lib/direction';
import { formatNumber, t, type MessageKey } from '../../i18n';
import { kindLabel, useOrgAction } from './dialogs';
import { ForemanAvatar, ForemanBadge } from '../../components/Foreman';

export type TreeIntent =
  | { kind: 'addUnit'; parentId: string | null }
  | { kind: 'editUnit'; unit: OrgUnitDto }
  | { kind: 'addPosition'; unitId: string }
  | { kind: 'editPosition'; position: OrgPositionDto }
  | { kind: 'move'; subject: { kind: 'unit'; unit: OrgUnitDto } | { kind: 'position'; position: OrgPositionDto } }
  | { kind: 'linkTeam'; unit: OrgUnitDto };

const KIND_ICON: Record<OrgUnitKind, typeof IconBuilding> = {
  DEPARTMENT: IconBuilding,
  SECTION: IconSitemap,
  UNIT: IconBriefcase,
  TEAM_GROUP: IconUsersGroup,
};

/** A10: a member holder who is their team's worker foreman (`isForeman`, optional on the wire). */
export const isForemanHolder = (h: NonNullable<OrgPositionDto['holder']>) => h.type === 'MEMBER' && (h as { isForeman?: boolean }).isForeman === true;

export function Holder({ position, size = 28 }: { position: OrgPositionDto; size?: number }) {
  const h = position.holder;
  if (!h) {
    return (
      <span className="og-holder og-holder--vacant">
        <span className="og-vacant-ic" style={{ width: size, height: size }} aria-hidden>
          <IconUserQuestion size={Math.round(size * 0.55)} />
        </span>
        <Badge variant="outline" color="signal" size="sm">
          {t('org.pos.vacant')}
        </Badge>
      </span>
    );
  }
  return (
    <span className="og-holder">
      <ForemanAvatar foreman={isForemanHolder(h)} size={size}>
        <PhotoAvatar target={{ kind: h.type === 'USER' ? 'user' : 'member', id: h.id }} name={h.fullName} hasPhoto={h.hasPhoto} size={size} ring={false} />
      </ForemanAvatar>
      <span className="og-holder-name">{h.fullName}</span>
      {isForemanHolder(h) ? <ForemanBadge size="xs" /> : null}
      {h.type === 'USER' && h.role ? <span className="og-holder-role">{t(`role.${h.role}` as MessageKey)}</span> : null}
      {h.type === 'MEMBER' && h.team ? <TeamBadge name={h.team.name} color={h.team.color.hex} size="sm" /> : null}
    </span>
  );
}

function DragHandle({ id, label }: { id: string; label: string }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id });
  return (
    <button ref={setNodeRef} type="button" className="og-handle" {...listeners} {...attributes} aria-label={label} aria-roledescription={t('org.dnd.role')}>
      <IconGripVertical size={16} aria-hidden />
    </button>
  );
}

function UnitDrop({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={className} data-over={isOver || undefined}>
      {children}
    </div>
  );
}

/**
 * The structure as a collapsible tree (owner request A9, ADR-102): units with their kind, code,
 * positions (holder with photo, or «شاغر») and linked teams. Admins drag units onto another unit
 * (or onto «أعلى الهيكل») and positions onto another unit; every drag also has a menu item
 * «نقل إلى…» for keyboard and screen-reader users. WAI-ARIA tree keys: ↑/↓ between rows,
 * the inline-end arrow opens/enters, the inline-start arrow closes/goes to the parent, Home/End.
 */
export function OrgTree({
  units,
  canManage,
  onIntent,
}: {
  units: OrgUnitDto[];
  canManage: boolean;
  onIntent: (i: TreeIntent) => void;
}) {
  const api = useApi();
  const action = useOrgAction();
  const forest = useMemo(() => buildForest(units), [units]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());
  const rows = useMemo(() => visibleRows(forest, collapsed), [forest, collapsed]);
  const byId = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const positionById = useMemo(() => new Map(units.flatMap((u) => u.positions.map((p) => [p.id, p] as const))), [units]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  const toggle = (id: string, open?: boolean) =>
    setCollapsed((s) => {
      const next = new Set(s);
      const isOpen = !next.has(id);
      if (open === undefined ? isOpen : !open) next.add(id);
      else next.delete(id);
      return next;
    });

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocused(id);
    rowsRef.current.get(id)?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, node: OrgNode) => {
    const i = rows.findIndex((r) => r.unit.id === node.unit.id);
    const rtl = dirSign() === -1;
    const toEnd = rtl ? 'ArrowLeft' : 'ArrowRight';
    const toStart = rtl ? 'ArrowRight' : 'ArrowLeft';
    const isOpen = !collapsed.has(node.unit.id);
    if (e.key === 'ArrowDown') focusRow(rows[i + 1]?.unit.id);
    else if (e.key === 'ArrowUp') focusRow(rows[i - 1]?.unit.id);
    else if (e.key === 'Home') focusRow(rows[0]?.unit.id);
    else if (e.key === 'End') focusRow(rows[rows.length - 1]?.unit.id);
    else if (e.key === toEnd) {
      if (node.children.length && !isOpen) toggle(node.unit.id, true);
      else focusRow(node.children[0]?.unit.id);
    } else if (e.key === toStart) {
      if (node.children.length && isOpen) toggle(node.unit.id, false);
      else focusRow(node.unit.parentId ?? undefined);
    } else return;
    e.preventDefault();
  };

  const onDragStart = (e: DragStartEvent) => setDragging(String(e.active.id));
  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const from = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (!over) return;
    const targetUnit = over === 'drop:root' ? null : over.replace(/^drop:/, '');
    if (from.startsWith('unit:')) {
      const id = from.slice(5);
      const unit = byId.get(id);
      if (!unit || unit.parentId === targetUnit || id === targetUnit) return;
      if (!canMoveUnit(units, id, targetUnit)) {
        // Same answer as the API (ORG_CYCLE); the server would refuse it too.
        await action.run(() => api.org.moveUnit(id, { parentId: targetUnit }), '');
        return;
      }
      await action.run(() => api.org.moveUnit(id, { parentId: targetUnit }), t('org.move.done', { name: unit.name }));
      if (targetUnit) toggle(targetUnit, true);
    } else if (from.startsWith('pos:') && targetUnit) {
      const pos = positionById.get(from.slice(4));
      if (!pos || pos.unitId === targetUnit) return;
      await action.run(() => api.org.movePosition(pos.id, { unitId: targetUnit }), t('org.move.done', { name: pos.title }));
      toggle(targetUnit, true);
    }
  };

  const nameOf = (id: string) => {
    if (id.startsWith('unit:')) return byId.get(id.slice(5))?.name ?? '';
    if (id.startsWith('pos:')) return positionById.get(id.slice(4))?.title ?? '';
    if (id === 'drop:root') return t('org.move.root');
    return byId.get(id.replace(/^drop:/, ''))?.name ?? '';
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('org.dnd.start', { name: nameOf(String(active.id)) }),
    onDragOver: ({ active, over }) => (over ? t('org.dnd.over', { name: nameOf(String(active.id)), target: nameOf(String(over.id)) }) : t('org.dnd.none')),
    onDragEnd: ({ active, over }) => (over ? t('org.dnd.end', { name: nameOf(String(active.id)), target: nameOf(String(over.id)) }) : t('org.dnd.cancel')),
    onDragCancel: () => t('org.dnd.cancel'),
  };

  const confirmDelete = (title: string, body: string, fn: () => Promise<unknown>, ok: string) =>
    modals.openConfirmModal({
      title,
      children: <p className="og-confirm">{body}</p>,
      labels: { confirm: t('org.delete.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'breach' },
      onConfirm: () => void action.run(fn, ok),
    });

  const renderNode = (node: OrgNode) => {
    const u = node.unit;
    const open = !collapsed.has(u.id);
    const Icon = KIND_ICON[u.kind];
    const tabIndex = (focused ?? rows[0]?.unit.id) === u.id ? 0 : -1;
    return (
      <li
        key={u.id}
        role="treeitem"
        aria-level={node.depth + 1}
        aria-expanded={node.children.length || u.positions.length || u.teams.length ? open : undefined}
        aria-label={`${kindLabel(u.kind)} ${u.name}`}
        className="og-item"
      >
        <UnitDrop id={`drop:${u.id}`} className="og-row-wrap">
          <div
            className="og-row"
            data-kind={u.kind}
            data-dragging={dragging === `unit:${u.id}` || undefined}
            tabIndex={tabIndex}
            ref={(el) => {
              if (el) rowsRef.current.set(u.id, el);
              else rowsRef.current.delete(u.id);
            }}
            onFocus={() => setFocused(u.id)}
            onKeyDown={(e) => onKey(e, node)}
          >
            {canManage ? <DragHandle id={`unit:${u.id}`} label={t('org.dnd.unitLabel', { name: u.name })} /> : null}
            <button
              type="button"
              className="og-toggle"
              onClick={() => toggle(u.id)}
              tabIndex={-1}
              aria-label={open ? t('org.tree.collapse', { name: u.name }) : t('org.tree.expand', { name: u.name })}
            >
              <IconChevronDown size={16} className={open ? undefined : 'og-chev-closed'} aria-hidden />
            </button>
            <span className="og-kind-ic" data-kind={u.kind} aria-hidden>
              <Icon size={16} />
            </span>
            <span className="og-name">{u.name}</span>
            <span className="og-kind">{kindLabel(u.kind)}</span>
            {u.code ? <span className="og-code ltr mono">{u.code}</span> : null}
            <span className="og-counts">
              {t('org.tree.counts', { positions: formatNumber(u.positions.length), teams: formatNumber(u.teams.length) })}
            </span>
            {canManage ? (
              <Menu position="bottom-end" width={240} shadow="md" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="subtle" size={34} aria-label={t('org.tree.actionsOf', { name: u.name })} tabIndex={-1}>
                    <IconDots size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item leftSection={<IconPlus size={16} />} onClick={() => onIntent({ kind: 'addUnit', parentId: u.id })}>
                    {t('org.unit.addChild')}
                  </Menu.Item>
                  <Menu.Item leftSection={<IconBriefcase size={16} />} onClick={() => onIntent({ kind: 'addPosition', unitId: u.id })}>
                    {t('org.pos.add')}
                  </Menu.Item>
                  <Menu.Item leftSection={<IconLink size={16} />} onClick={() => onIntent({ kind: 'linkTeam', unit: u })}>
                    {t('org.link.action')}
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item leftSection={<IconPencil size={16} />} onClick={() => onIntent({ kind: 'editUnit', unit: u })}>
                    {t('org.unit.edit')}
                  </Menu.Item>
                  <Menu.Item leftSection={<IconArrowsMove size={16} />} onClick={() => onIntent({ kind: 'move', subject: { kind: 'unit', unit: u } })}>
                    {t('org.move.action')}
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconArchive size={16} />}
                    onClick={() =>
                      void action.run(() => api.org.updateUnit(u.id, { archived: true }), t('org.unit.archived', { name: u.name }))
                    }
                  >
                    {t('org.unit.archive')}
                  </Menu.Item>
                  <Menu.Item
                    color="breach"
                    leftSection={<IconTrash size={16} />}
                    onClick={() =>
                      confirmDelete(
                        t('org.unit.deleteTitle', { name: u.name }),
                        t('org.unit.deleteBody'),
                        () => api.org.deleteUnit(u.id),
                        t('org.unit.deleted', { name: u.name }),
                      )
                    }
                  >
                    {t('org.unit.delete')}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            ) : null}
          </div>
        </UnitDrop>
        {open && (u.positions.length || u.teams.length) ? (
          <div className="og-detail">
            {u.positions.length ? (
              <ul className="og-positions" aria-label={t('org.tree.positionsOf', { name: u.name })}>
                {u.positions.map((p) => (
                  <li key={p.id} className="og-pos" data-dragging={dragging === `pos:${p.id}` || undefined}>
                    {canManage ? <DragHandle id={`pos:${p.id}`} label={t('org.dnd.posLabel', { title: p.title })} /> : null}
                    <span className="og-pos-title">{p.title}</span>
                    <Holder position={p} />
                    {p.reportsToPositionId && positionById.get(p.reportsToPositionId) ? (
                      <span className="og-reports">{t('org.pos.reportsToShort', { title: positionById.get(p.reportsToPositionId)!.title })}</span>
                    ) : null}
                    {canManage ? (
                      <Menu position="bottom-end" width={220} shadow="md" withinPortal>
                        <Menu.Target>
                          <ActionIcon variant="subtle" size={32} aria-label={t('org.pos.actionsOf', { title: p.title })}>
                            <IconDots size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item leftSection={<IconPencil size={16} />} onClick={() => onIntent({ kind: 'editPosition', position: p })}>
                            {t('org.pos.edit')}
                          </Menu.Item>
                          <Menu.Item leftSection={<IconArrowsMove size={16} />} onClick={() => onIntent({ kind: 'move', subject: { kind: 'position', position: p } })}>
                            {t('org.move.posAction')}
                          </Menu.Item>
                          <Menu.Item
                            color="breach"
                            leftSection={<IconTrash size={16} />}
                            onClick={() =>
                              confirmDelete(
                                t('org.pos.deleteTitle', { title: p.title }),
                                t('org.pos.deleteBody'),
                                () => api.org.deletePosition(p.id),
                                t('org.pos.deleted', { title: p.title }),
                              )
                            }
                          >
                            {t('org.pos.delete')}
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {u.teams.length ? (
              <div className="og-teams" aria-label={t('org.tree.teamsOf', { name: u.name })}>
                {u.teams.map((tm) => (
                  <span key={tm.id} className="og-team">
                    <Link to={`/teams/${tm.id}`} className="og-team-link">
                      <TeamBadge name={tm.name} color={tm.color.hex} size="sm" />
                    </Link>
                    {canManage ? (
                      <Tooltip label={t('org.link.unlinkOf', { name: tm.name })}>
                        <ActionIcon
                          variant="subtle"
                          size={28}
                          color="slate"
                          aria-label={t('org.link.unlinkOf', { name: tm.name })}
                          onClick={() => void action.run(() => api.teams.update(tm.id, { orgUnitId: null }), t('org.link.unlinked', { name: tm.name }))}
                        >
                          <IconUnlink size={14} />
                        </ActionIcon>
                      </Tooltip>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {open && node.children.length ? (
          <ul role="group" className="og-children">
            {node.children.map(renderNode)}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={(e) => void onDragEnd(e)} onDragCancel={() => setDragging(null)} accessibility={{ announcements }}>
      {action.error ? (
        <div className="og-error" role="alert">
          {errorMessage(action.error)}
        </div>
      ) : null}
      {canManage ? (
        <UnitDrop id="drop:root" className={dragging?.startsWith('unit:') ? 'og-root-drop og-root-drop--live' : 'og-root-drop'}>
          {t('org.move.rootDrop')}
        </UnitDrop>
      ) : null}
      <ul role="tree" aria-label={t('org.tree.aria')} className="og-tree">
        {forest.map(renderNode)}
      </ul>
      <DragOverlay dropAnimation={null}>{dragging ? <div className="og-ghost">{nameOf(dragging)}</div> : null}</DragOverlay>
    </DndContext>
  );
}
