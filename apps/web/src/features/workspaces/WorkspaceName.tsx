import { Menu } from '@mantine/core';
import { IconBuildingCommunity, IconCheck } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useActiveWorkspace, useAuthStore } from '../../stores/auth';
import { t } from '../../i18n';
import { useWorkspaceSwitch } from './useWorkspaceSwitch';
import './workspaces.css';

/**
 * The active workspace's name under the Nozoly logo (owner A12: «يظهر اسم القسم أسفل شعار نزلي
 * بخط مناسب»), in the display face. The first workspace is «إدارة المشاريع».
 */
export function WorkspaceName({ variant = 'side' }: { variant?: 'side' | 'chip' }) {
  const ws = useActiveWorkspace();
  const single = useAuthStore((s) => s.singleWorkspace);
  if (!ws) return null;
  if (variant === 'chip') {
    // Phones: the drawer head always shows the name under the logo; the top bar adds the chip only
    // when there is more than one workspace (where knowing which one is open matters).
    if (single) return null;
    return (
      <span className="nz-ws-chip" title={t('workspace.current', { name: ws.name })} data-testid="ws-chip">
        <IconBuildingCommunity size={14} stroke={1.8} aria-hidden />
        <span>{ws.name}</span>
      </span>
    );
  }
  return (
    <span className="nz-ws-name" title={t('workspace.current', { name: ws.name })} data-testid="ws-name">
      {ws.name}
    </span>
  );
}

/**
 * The workspace list inside the top-bar user menu (owner A12: «يسمح له بالتبديل من الشريط العلوي
 * عند النقر على اسمه»). Hidden in single-workspace mode or with one workspace. `items` go inside
 * the menu. A12 security review H3: switching never deletes unsynced violations any more (they wait
 * for their workspace), so there is no warning dialog; `dialog` stays for the callers' layout.
 */
export function useWorkspaceMenu() {
  const { workspaces, activeWorkspace, singleWorkspace } = useAuthStore();
  const { enter, busyId } = useWorkspaceSwitch();
  const navigate = useNavigate();
  const visible = !singleWorkspace && workspaces.length > 1;

  const go = async (id: string) => {
    const s = await enter(id);
    if (s) navigate('/', { replace: true });
  };
  const pick = async (id: string) => {
    if (id === activeWorkspace?.id) return;
    await go(id);
  };

  const items = visible ? (
    <>
      <Menu.Label>{t('workspaceSwitch.section')}</Menu.Label>
      {workspaces.map((ws) => {
        const active = ws.id === activeWorkspace?.id;
        return (
          <Menu.Item
            key={ws.id}
            className="nz-ws-menu-item"
            data-active={active}
            aria-current={active ? 'true' : undefined}
            closeMenuOnClick={!active}
            disabled={busyId !== null}
            leftSection={<IconBuildingCommunity size={18} stroke={1.7} />}
            rightSection={active ? <IconCheck size={16} aria-label={t('workspaceSwitch.active')} /> : null}
            onClick={() => void pick(ws.id)}
            data-testid={`ws-switch-${ws.code}`}
          >
            {ws.name}
          </Menu.Item>
        );
      })}
      <Menu.Divider />
    </>
  ) : null;

  const dialog = null;

  return { items, dialog, visible, pick, workspaces, activeId: activeWorkspace?.id ?? null, busyId };
}
