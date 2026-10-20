import { useId } from 'react';
import { Box, MultiSelect, Stack, Switch, Text } from '@mantine/core';
import { IconEye, IconLock, IconPencil } from '@tabler/icons-react';
import {
  ASSISTANT_LEVEL_LABELS,
  ASSISTANT_LEVELS,
  ASSISTANT_MODULE_LABELS,
  ASSISTANT_MODULES,
  VIEW_ONLY_MODULES,
  assistantGrants,
  type AssistantLevel,
  type AssistantModule,
  type AssistantPermissions,
  type AssistantScope,
  type Permission,
} from '@nuzli/shared';
import { useTeams } from '../../api/queries';
import { useProjects } from '../../api/projectQueries';
import { t, tKey } from '../../i18n';
import './users.css';

/** Permissions that open a page (reading); every other grant is an action. */
const PAGE_GRANTS: ReadonlySet<Permission> = new Set<Permission>([
  'projects.readAll',
  'budget.read',
  'teams.readAll',
  'cards.read',
  'violations.readAll',
  'violations.stats',
  'calendars.read',
  'org.read',
  'users.read',
  'registrations.read',
  'reports.read',
  'audit.read',
]);

/** What the assistant will see: the pages and the actions their grants open, in Arabic. */
export function assistantPreview(permissions: AssistantPermissions): { pages: string[]; actions: string[] } {
  const grants = assistantGrants(permissions);
  const label = (p: Permission) => tKey(`a12admin.grant.${p}`, 'common.none');
  return {
    pages: grants.filter((p) => PAGE_GRANTS.has(p)).map(label),
    actions: grants.filter((p) => !PAGE_GRANTS.has(p)).map(label),
  };
}

const LEVEL_ICON = { none: null, view: IconEye, edit: IconPencil } as const;

/**
 * The admin's grid for an assistant (مساعد): one row per module, three levels (لا شيء / اطّلاع /
 * تعديل). Each row is a radiogroup named by its module; «تعديل» is locked on view-only modules.
 */
export function AssistantGrid({
  value,
  onChange,
  disabled,
}: {
  value: AssistantPermissions;
  onChange: (next: AssistantPermissions) => void;
  disabled?: boolean;
}) {
  const uid = useId();
  const set = (m: AssistantModule, level: AssistantLevel) => {
    const next: AssistantPermissions = { ...value };
    if (level === 'none') delete next[m];
    else next[m] = level;
    onChange(next);
  };
  return (
    <div className="nz-agrid" data-testid="assistant-grid">
      <div className="nz-agrid-head" aria-hidden>
        <span>{t('a12admin.grid.module')}</span>
        {ASSISTANT_LEVELS.map((l) => (
          <span key={l}>{ASSISTANT_LEVEL_LABELS[l]}</span>
        ))}
      </div>
      {ASSISTANT_MODULES.map((m) => {
        const current = value[m] ?? 'none';
        const viewOnly = VIEW_ONLY_MODULES.has(m);
        const labelId = `${uid}-${m}`;
        return (
          <div key={m} className="nz-agrid-row" role="radiogroup" aria-labelledby={labelId} data-module={m}>
            <div className="nz-agrid-name">
              <span id={labelId}>{ASSISTANT_MODULE_LABELS[m]}</span>
              {viewOnly ? (
                <span className="nz-agrid-lock">
                  <IconLock size={12} aria-hidden />
                  {t('a12admin.grid.viewOnly')}
                </span>
              ) : null}
            </div>
            {ASSISTANT_LEVELS.map((l) => {
              const locked = viewOnly && l === 'edit';
              const Icon = LEVEL_ICON[l];
              return (
                <label
                  key={l}
                  className={`nz-agrid-cell${current === l ? ' on' : ''}${locked ? ' locked' : ''}`}
                  title={locked ? t('a12admin.grid.lockedReason') : undefined}
                >
                  <input
                    type="radio"
                    name={`${uid}-r-${m}`}
                    value={l}
                    checked={current === l}
                    disabled={disabled || locked}
                    onChange={() => set(m, l)}
                    aria-label={`${ASSISTANT_MODULE_LABELS[m]}: ${ASSISTANT_LEVEL_LABELS[l]}`}
                    aria-describedby={locked ? `${labelId}-lock` : undefined}
                    data-testid={`agrid-${m}-${l}`}
                  />
                  <span className="nz-agrid-cell-text">
                    {Icon ? <Icon size={14} aria-hidden /> : null}
                    {ASSISTANT_LEVEL_LABELS[l]}
                  </span>
                  {locked ? (
                    <span id={`${labelId}-lock`} className="sr-only">
                      {t('a12admin.grid.lockedReason')}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** «كل المشاريع» / «كل الفرق» by default; switched off, the admin picks the ones allowed. */
export function AssistantScopePicker({
  value,
  onChange,
  disabled,
}: {
  value: AssistantScope;
  onChange: (next: AssistantScope) => void;
  disabled?: boolean;
}) {
  const projects = useProjects({});
  const teams = useTeams({});
  const projectData = (projects.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const teamData = (teams.data ?? []).map((tm) => ({ value: tm.id, label: tm.name }));
  const allProjects = value.projectIds === undefined;
  const allTeams = value.teamIds === undefined;
  const patch = (p: Partial<Record<keyof AssistantScope, string[] | undefined>>) => {
    const next: AssistantScope = { ...value, ...p };
    if (next.projectIds === undefined) delete next.projectIds;
    if (next.teamIds === undefined) delete next.teamIds;
    onChange(next);
  };
  return (
    <Stack gap="sm" data-testid="assistant-scope">
      <Text size="sm" fw={600}>
        {t('a12admin.scope.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('a12admin.scope.hint')}
      </Text>
      <Switch
        label={t('a12admin.scope.allProjects')}
        checked={allProjects}
        disabled={disabled}
        onChange={(e) => patch({ projectIds: e.currentTarget.checked ? undefined : [] })}
      />
      {!allProjects ? (
        <MultiSelect
          label={t('a12admin.scope.projects')}
          placeholder={t('a12admin.scope.projectsPlaceholder')}
          data={projectData}
          value={value.projectIds ?? []}
          onChange={(v) => patch({ projectIds: v })}
          searchable
          clearable
          disabled={disabled}
          nothingFoundMessage={t('a12admin.scope.nothing')}
          error={value.projectIds && !value.projectIds.length ? t('a12admin.scope.emptyProjects') : undefined}
          comboboxProps={{ withinPortal: true }}
        />
      ) : null}
      <Switch
        label={t('a12admin.scope.allTeams')}
        checked={allTeams}
        disabled={disabled}
        onChange={(e) => patch({ teamIds: e.currentTarget.checked ? undefined : [] })}
      />
      {!allTeams ? (
        <MultiSelect
          label={t('a12admin.scope.teams')}
          placeholder={t('a12admin.scope.teamsPlaceholder')}
          data={teamData}
          value={value.teamIds ?? []}
          onChange={(v) => patch({ teamIds: v })}
          searchable
          clearable
          disabled={disabled}
          nothingFoundMessage={t('a12admin.scope.nothing')}
          error={value.teamIds && !value.teamIds.length ? t('a12admin.scope.emptyTeams') : undefined}
          comboboxProps={{ withinPortal: true }}
        />
      ) : null}
    </Stack>
  );
}

/** Live «ما سيراه المساعد»: the pages and actions the chosen levels open. */
export function AssistantPreview({ permissions, scope }: { permissions: AssistantPermissions; scope?: AssistantScope }) {
  const { pages, actions } = assistantPreview(permissions);
  return (
    <Box className="nz-apreview" aria-live="polite" data-testid="assistant-preview">
      <Text size="sm" fw={600} mb={6}>
        {t('a12admin.preview.title')}
      </Text>
      {!pages.length && !actions.length ? (
        <Text size="sm" c="dimmed">
          {t('a12admin.preview.nothing')}
        </Text>
      ) : (
        <>
          {pages.length ? (
            <>
              <Text size="xs" c="dimmed" mb={4}>
                {t('a12admin.preview.pages')}
              </Text>
              <ul className="nz-apreview-list">
                {pages.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </>
          ) : null}
          {actions.length ? (
            <>
              <Text size="xs" c="dimmed" mt={8} mb={4}>
                {t('a12admin.preview.actions')}
              </Text>
              <ul className="nz-apreview-list">
                {actions.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
      {scope && (scope.projectIds !== undefined || scope.teamIds !== undefined) ? (
        <Text size="xs" c="dimmed" mt={8}>
          {t('a12admin.preview.scoped')}
        </Text>
      ) : null}
      <Text size="xs" c="dimmed" mt={8}>
        {t('a12admin.preview.never')}
      </Text>
    </Box>
  );
}

/** Grid + scope + preview, as used by every assistant form. */
export function AssistantAccessEditor({
  permissions,
  scope,
  onPermissions,
  onScope,
  disabled,
  withScope = true,
}: {
  permissions: AssistantPermissions;
  scope: AssistantScope;
  onPermissions: (p: AssistantPermissions) => void;
  onScope: (s: AssistantScope) => void;
  disabled?: boolean;
  /** False when the membership is in another workspace than the session's (its lists are not here). */
  withScope?: boolean;
}) {
  return (
    <Stack gap="md">
      <Text size="sm" fw={600}>
        {t('a12admin.grid.title')}
      </Text>
      <AssistantGrid value={permissions} onChange={onPermissions} disabled={disabled} />
      {withScope ? (
        <AssistantScopePicker value={scope} onChange={onScope} disabled={disabled} />
      ) : (
        <Text size="xs" c="dimmed">
          {t('a12admin.scope.otherWorkspace')}
        </Text>
      )}
      <AssistantPreview permissions={permissions} scope={withScope ? scope : undefined} />
    </Stack>
  );
}

/** A scope with an empty list for a module switched to «specific» but nothing picked is invalid. */
export function scopeIncomplete(scope: AssistantScope): boolean {
  return (scope.projectIds !== undefined && !scope.projectIds.length) || (scope.teamIds !== undefined && !scope.teamIds.length);
}
