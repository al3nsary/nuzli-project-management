import { useCallback, useRef, useState } from 'react';
import { Button, Group, List, Modal, Stack, Text, Tooltip } from '@mantine/core';
import { IconStack2 } from '@tabler/icons-react';
import type { UserRoleEntryDto } from '@nuzli/shared';
import { ApiError } from '../../api/errors';
import { roleLabel } from '../../components/ui';
import { t } from '../../i18n';
import './workspaces.css';

/** A role entry in words: «مشرف — إدارة المشاريع» (or «صفة في قسم آخر» when hidden). */
export function roleEntryText(r: Pick<UserRoleEntryDto, 'role' | 'workspaceName' | 'title'>): string {
  const role = roleLabel(r.role);
  const where = r.workspaceName ?? t('dualRole.otherWorkspace');
  return r.title ? `${role} (${r.title}) — ${where}` : `${role} — ${where}`;
}

/**
 * «صلاحية مزدوجة» (owner A12): a person with more than one live role. A distinct icon, colour
 * and text, used next to the person wherever users appear (lists, avatars, drawers).
 */
export function DualRoleBadge({
  user,
  compact,
}: {
  user: { dualRole?: boolean; allRoles?: UserRoleEntryDto[] } | null | undefined;
  compact?: boolean;
}) {
  if (!user?.dualRole) return null;
  const roles = user.allRoles ?? [];
  const hidden = roles.some((r) => !r.workspaceId);
  const label = roles.length
    ? t('dualRole.tooltip', { roles: roles.map(roleEntryText).join('، ') })
    : t('dualRole.tooltipHidden');
  return (
    <Tooltip label={hidden && !roles.length ? t('dualRole.tooltipHidden') : label} multiline w={280} withArrow>
      <span className={compact ? 'pill dual compact' : 'pill dual'} aria-label={label} data-testid="dual-role-badge">
        <IconStack2 size={13} stroke={2} aria-hidden />
        {compact ? null : t('dualRole.badge')}
      </span>
    </Tooltip>
  );
}

/**
 * The 409 DUAL_ROLE_CONFIRM_REQUIRED flow: `run(send)` calls `send(false)`; when the API asks for
 * a confirmation it shows the warning with the person's current roles, and on «تأكيد» calls
 * `send(true)` (the same request with `confirmDualRole: true`). Resolves undefined when cancelled.
 */
export function useDualRoleConfirm() {
  const [roles, setRoles] = useState<UserRoleEntryDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve: (ok: boolean) => void } | null>(null);

  const ask = (r: UserRoleEntryDto[]) =>
    new Promise<boolean>((resolve) => {
      pending.current = { resolve };
      setRoles(r);
    });

  const close = (ok: boolean) => {
    pending.current?.resolve(ok);
    pending.current = null;
    setRoles(null);
  };

  const run = useCallback(async <T,>(send: (confirmDualRole: boolean) => Promise<T>): Promise<T | undefined> => {
    try {
      return await send(false);
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'DUAL_ROLE_CONFIRM_REQUIRED') throw err;
      const details = (err.details as { roles?: UserRoleEntryDto[] } | undefined)?.roles ?? [];
      const ok = await ask(details);
      if (!ok) return undefined;
      setBusy(true);
      try {
        return await send(true);
      } finally {
        setBusy(false);
      }
    }
  }, []);

  const dialog = (
    <Modal opened={roles !== null} onClose={() => close(false)} title={t('dualRole.dialogTitle')} centered>
      <Stack gap="sm">
        <Group gap={8} wrap="nowrap" align="flex-start">
          <span className="pill dual" aria-hidden>
            <IconStack2 size={13} stroke={2} />
            {t('dualRole.badge')}
          </span>
        </Group>
        <Text size="sm">{t('dualRole.dialogBody')}</Text>
        {roles?.length ? (
          <>
            <Text size="sm" fw={600}>
              {t('dualRole.currentRoles')}
            </Text>
            <List size="sm" spacing={4}>
              {roles.map((r, i) => (
                <List.Item key={`${r.workspaceId ?? 'x'}-${r.role}-${i}`}>{roleEntryText(r)}</List.Item>
              ))}
            </List>
          </>
        ) : null}
        <Group justify="flex-end" gap="sm" mt="xs">
          <Button variant="default" onClick={() => close(false)} disabled={busy}>
            {t('dualRole.cancel')}
          </Button>
          <Button color="signal" onClick={() => close(true)} loading={busy} data-testid="dual-role-confirm">
            {t('dualRole.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );

  return { run, dialog };
}
