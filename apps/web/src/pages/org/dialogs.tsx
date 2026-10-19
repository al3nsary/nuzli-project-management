import { useEffect, useState } from 'react';
import { Button, Group, Modal, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import {
  ORG_UNIT_KINDS,
  createOrgPositionSchema,
  createOrgUnitSchema,
  type OrgPositionDto,
  type OrgUnitDto,
  type OrgUnitKind,
} from '@nuzli/shared';
import { useApi } from '../../api/context';
import { useAllMembers, useTeams, useUsers } from '../../api/queries';
import { FormError } from '../../components/ui';
import { canMoveUnit } from '../../features/org/layout';
import { t, type MessageKey } from '../../i18n';

export const kindLabel = (k: OrgUnitKind) => t(`org.kind.${k}` as MessageKey);

/** Invalidate everything the structure shows (units, positions, linked teams). */
export function useInvalidateOrg() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['org'] }), qc.invalidateQueries({ queryKey: ['teams'] }), qc.invalidateQueries({ queryKey: ['team'] })]);
}

/** Runs a write, refreshes the structure and reports in Arabic (the API's own message on failure). */
export function useOrgAction() {
  const invalidate = useInvalidateOrg();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await invalidate();
      notifications.show({ color: 'ok', message: ok });
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

// ---------------------------------------------------------------- unit

export function UnitDialog({
  opened,
  onClose,
  units,
  unit,
  parentId,
}: {
  opened: boolean;
  onClose: () => void;
  units: OrgUnitDto[];
  /** Editing this unit; absent = create. */
  unit?: OrgUnitDto | null;
  /** Create under this unit (null = a top-level unit). */
  parentId?: string | null;
}) {
  const api = useApi();
  const action = useOrgAction();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<OrgUnitKind>('DEPARTMENT');
  const [code, setCode] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!opened) return;
    setName(unit?.name ?? '');
    setCode(unit?.code ?? '');
    setParent(unit ? unit.parentId : (parentId ?? null));
    const parentKind = units.find((u) => u.id === (unit?.parentId ?? parentId))?.kind;
    setKind(unit?.kind ?? (parentKind === 'DEPARTMENT' ? 'SECTION' : parentKind === 'SECTION' ? 'UNIT' : parentKind ? 'TEAM_GROUP' : 'DEPARTMENT'));
    setErrors({});
    action.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, unit?.id, parentId]);

  const submit = async () => {
    const input = { parentId: parent, name: name.trim(), kind, code: code.trim() || undefined };
    const parsed = createOrgUnitSchema.safeParse(input);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    const ok = unit
      ? await action.run(async () => {
          await api.org.updateUnit(unit.id, { name: input.name, kind, code: code.trim() || null });
          if (parent !== unit.parentId) await api.org.moveUnit(unit.id, { parentId: parent });
        }, t('org.unit.saved', { name: input.name }))
      : await action.run(() => api.org.createUnit(input), t('org.unit.created', { name: input.name }));
    if (ok) onClose();
  };

  const parentOptions = units
    .filter((u) => !u.archivedAt && (!unit || canMoveUnit(units, unit.id, u.id)))
    .map((u) => ({ value: u.id, label: `${kindLabel(u.kind)} — ${u.name}` }));

  return (
    <Modal opened={opened} onClose={onClose} title={unit ? t('org.unit.editTitle', { name: unit.name }) : t('org.unit.addTitle')}>
      <Stack gap="sm">
        <FormError error={action.error} />
        <TextInput
          label={t('org.unit.name')}
          placeholder={t('org.unit.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          error={errors.name}
          maxLength={120}
          withAsterisk
          data-autofocus
        />
        <Select
          label={t('org.unit.kind')}
          data={ORG_UNIT_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
          value={kind}
          onChange={(v) => v && setKind(v as OrgUnitKind)}
          allowDeselect={false}
        />
        <Select
          label={t('org.unit.parent')}
          placeholder={t('org.unit.noParent')}
          data={parentOptions}
          value={parent}
          onChange={setParent}
          clearable
          searchable
          nothingFoundMessage={t('org.unit.noUnits')}
        />
        <TextInput
          label={t('org.unit.code')}
          description={t('org.unit.codeHint')}
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
          error={errors.code}
          maxLength={30}
          classNames={{ input: 'ltr mono' }}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={action.busy} onClick={() => void submit()}>
            {unit ? t('org.unit.save') : t('org.unit.create')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------- position

type HolderKind = 'USER' | 'MEMBER' | 'VACANT';

export function PositionDialog({
  opened,
  onClose,
  units,
  unitId,
  position,
}: {
  opened: boolean;
  onClose: () => void;
  units: OrgUnitDto[];
  unitId: string | null;
  position?: OrgPositionDto | null;
}) {
  const api = useApi();
  const action = useOrgAction();
  const users = useUsers({ status: 'ACTIVE', pageSize: 200 }, opened);
  const members = useAllMembers(opened);
  const [title, setTitle] = useState('');
  const [holderKind, setHolderKind] = useState<HolderKind>('VACANT');
  const [userId, setUserId] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [reportsTo, setReportsTo] = useState<string | null>(null);
  const [unit, setUnit] = useState<string | null>(unitId);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!opened) return;
    setTitle(position?.title ?? '');
    setHolderKind(position?.holder ? position.holder.type : 'VACANT');
    setUserId(position?.holder?.type === 'USER' ? position.holder.id : null);
    setMemberId(position?.holder?.type === 'MEMBER' ? position.holder.id : null);
    setReportsTo(position?.reportsToPositionId ?? null);
    setUnit(position?.unitId ?? unitId);
    setErrors({});
    action.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, position?.id, unitId]);

  const allPositions = units.flatMap((u) => u.positions.map((p) => ({ p, unit: u })));
  const submit = async () => {
    const holder = {
      holderUserId: holderKind === 'USER' ? userId : null,
      holderMemberId: holderKind === 'MEMBER' ? memberId : null,
    };
    const errs: Record<string, string> = {};
    if (holderKind === 'USER' && !userId) errs.holder = t('org.pos.pickUser');
    if (holderKind === 'MEMBER' && !memberId) errs.holder = t('org.pos.pickMember');
    const parsed = createOrgPositionSchema.safeParse({ unitId: unit ?? '', title: title.trim(), ...holder, reportsToPositionId: reportsTo });
    if (!parsed.success) for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
    if (!unit) errs.unitId = t('org.pos.pickUnit');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const ok = position
      ? await action.run(async () => {
          await api.org.updatePosition(position.id, { title: title.trim(), ...holder, reportsToPositionId: reportsTo });
          if (unit && unit !== position.unitId) await api.org.movePosition(position.id, { unitId: unit });
        }, t('org.pos.saved', { title: title.trim() }))
      : await action.run(
          () => api.org.createPosition({ unitId: unit!, title: title.trim(), ...holder, reportsToPositionId: reportsTo }),
          t('org.pos.created', { title: title.trim() }),
        );
    if (ok) onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title={position ? t('org.pos.editTitle', { title: position.title }) : t('org.pos.addTitle')}>
      <Stack gap="sm">
        <FormError error={action.error} />
        <TextInput
          label={t('org.pos.title')}
          placeholder={t('org.pos.titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          error={errors.title}
          maxLength={120}
          withAsterisk
          data-autofocus
        />
        <Select
          label={t('org.pos.unit')}
          data={units.filter((u) => !u.archivedAt).map((u) => ({ value: u.id, label: `${kindLabel(u.kind)} — ${u.name}` }))}
          value={unit}
          onChange={setUnit}
          error={errors.unitId}
          searchable
          allowDeselect={false}
        />
        <div>
          <Text size="sm" fw={500} mb={4}>
            {t('org.pos.holder')}
          </Text>
          <SegmentedControl
            fullWidth
            value={holderKind}
            onChange={(v) => setHolderKind(v as HolderKind)}
            data={[
              { value: 'USER', label: t('org.pos.holderUser') },
              { value: 'MEMBER', label: t('org.pos.holderMember') },
              { value: 'VACANT', label: t('org.pos.vacant') },
            ]}
          />
        </div>
        {holderKind === 'USER' ? (
          <Select
            aria-label={t('org.pos.holderUser')}
            placeholder={t('org.pos.pickUser')}
            data={(users.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.fullName} — ${t(`role.${u.role}` as MessageKey)}` }))}
            value={userId}
            onChange={setUserId}
            searchable
            error={errors.holder}
            nothingFoundMessage={t('org.pos.noUsers')}
          />
        ) : holderKind === 'MEMBER' ? (
          <Select
            aria-label={t('org.pos.holderMember')}
            placeholder={t('org.pos.pickMember')}
            data={(members.data ?? []).map((m) => ({ value: m.id, label: m.team ? `${m.fullName} — ${m.team.name}` : m.fullName }))}
            value={memberId}
            onChange={setMemberId}
            searchable
            limit={50}
            error={errors.holder}
            nothingFoundMessage={t('org.pos.noMembers')}
          />
        ) : (
          <Text size="sm" c="dimmed">
            {t('org.pos.vacantHint')}
          </Text>
        )}
        <Select
          label={t('org.pos.reportsTo')}
          placeholder={t('org.pos.reportsToNone')}
          data={allPositions
            .filter(({ p }) => p.id !== position?.id)
            .map(({ p, unit: u }) => ({ value: p.id, label: `${p.title} — ${u.name}${p.holder ? ` (${p.holder.fullName})` : ''}` }))}
          value={reportsTo}
          onChange={setReportsTo}
          clearable
          searchable
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={action.busy} onClick={() => void submit()}>
            {position ? t('org.pos.save') : t('org.pos.create')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------- move (keyboard alternative to drag)

export function MoveDialog({
  opened,
  onClose,
  units,
  subject,
}: {
  opened: boolean;
  onClose: () => void;
  units: OrgUnitDto[];
  subject: { kind: 'unit'; unit: OrgUnitDto } | { kind: 'position'; position: OrgPositionDto } | null;
}) {
  const api = useApi();
  const action = useOrgAction();
  const ROOT = '__root__';
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!opened || !subject) return;
    setTarget(subject.kind === 'unit' ? (subject.unit.parentId ?? ROOT) : subject.position.unitId);
    action.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, subject]);
  if (!subject) return null;
  const options =
    subject.kind === 'unit'
      ? [
          { value: ROOT, label: t('org.move.root') },
          ...units
            .filter((u) => !u.archivedAt && u.id !== subject.unit.id)
            .map((u) => ({
              value: u.id,
              label: `${kindLabel(u.kind)} — ${u.name}`,
              disabled: !canMoveUnit(units, subject.unit.id, u.id),
            })),
        ]
      : units.filter((u) => !u.archivedAt).map((u) => ({ value: u.id, label: `${kindLabel(u.kind)} — ${u.name}` }));
  const name = subject.kind === 'unit' ? subject.unit.name : subject.position.title;
  return (
    <Modal opened={opened} onClose={onClose} title={t('org.move.title', { name })}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {subject.kind === 'unit' ? t('org.move.unitBody') : t('org.move.positionBody')}
        </Text>
        <FormError error={action.error} />
        <Select label={t('org.move.target')} data={options} value={target} onChange={setTarget} searchable allowDeselect={false} data-autofocus />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={action.busy}
            disabled={!target}
            onClick={async () => {
              const ok =
                subject.kind === 'unit'
                  ? await action.run(
                      () => api.org.moveUnit(subject.unit.id, { parentId: target === ROOT ? null : target }),
                      t('org.move.done', { name }),
                    )
                  : await action.run(() => api.org.movePosition(subject.position.id, { unitId: target! }), t('org.move.done', { name }));
              if (ok) onClose();
            }}
          >
            {t('org.move.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------- link a team

export function LinkTeamDialog({ opened, onClose, unit }: { opened: boolean; onClose: () => void; unit: OrgUnitDto | null }) {
  const api = useApi();
  const action = useOrgAction();
  const teams = useTeams({}, opened);
  const [teamId, setTeamId] = useState<string | null>(null);
  useEffect(() => {
    if (opened) {
      setTeamId(null);
      action.setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);
  if (!unit) return null;
  const linked = new Set(unit.teams.map((tm) => tm.id));
  return (
    <Modal opened={opened} onClose={onClose} title={t('org.link.title', { name: unit.name })}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('org.link.body')}
        </Text>
        <FormError error={action.error} />
        <Select
          label={t('org.link.team')}
          data={(teams.data ?? [])
            .filter((tm) => tm.status !== 'ARCHIVED' && !linked.has(tm.id))
            .map((tm) => ({ value: tm.id, label: tm.orgUnit ? `${tm.name} — ${t('org.link.movesFrom', { unit: tm.orgUnit.name })}` : tm.name }))}
          value={teamId}
          onChange={setTeamId}
          searchable
          nothingFoundMessage={t('org.link.noTeams')}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={action.busy}
            disabled={!teamId}
            onClick={async () => {
              if (await action.run(() => api.teams.update(teamId!, { orgUnitId: unit.id }), t('org.link.done'))) onClose();
            }}
          >
            {t('org.link.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
