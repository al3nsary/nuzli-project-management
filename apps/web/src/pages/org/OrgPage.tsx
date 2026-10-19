import { useState } from 'react';
import { Button, SegmentedControl } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconBinaryTree, IconLayoutList, IconPlus, IconSitemap } from '@tabler/icons-react';
import { can } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { useTabParam } from '../../lib/useUrlState';
import { formatNumber, t, tCount } from '../../i18n';
import { LinkTeamDialog, MoveDialog, PositionDialog, UnitDialog } from './dialogs';
import { OrgTree, type TreeIntent } from './OrgTree';
import { OrgChart } from './OrgChart';
import './org.css';

const VIEWS = ['tree', 'chart'] as const;

/**
 * «الهيكل الإداري» (route `/org`, owner request A9, ADR-102): the organisation as a collapsible
 * tree (drag-and-drop for admins, keyboard accessible) or a top-down chart (pan/zoom, PNG).
 * Units (إدارة · قسم · وحدة · مجموعة فرق), positions held by a user or a team member — or
 * «شاغر» — and the teams linked to each unit. Admins edit; supervisors read.
 */
export function OrgPage() {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const canManage = can(user, 'org.manage');
  const [view, setView] = useTabParam('view', VIEWS, 'tree');
  const [intent, setIntent] = useState<TreeIntent | null>(null);
  const tree = useQuery({ queryKey: ['org', 'tree'], queryFn: () => api.org.tree() });
  const units = tree.data?.units ?? [];
  const positions = units.reduce((n, u) => n + u.positions.length, 0);
  const vacant = units.reduce((n, u) => n + u.positions.filter((p) => !p.holder).length, 0);
  const close = () => setIntent(null);

  return (
    <>
      <PageHeader
        title={t('nav.orgStructure')}
        lead={canManage ? t('org.leadAdmin') : t('org.leadReader')}
        actions={
          <>
            {units.length ? (
              <SegmentedControl
                aria-label={t('org.view')}
                value={view}
                onChange={setView}
                data={[
                  { value: 'tree', label: <span className="og-seg"><IconLayoutList size={16} aria-hidden />{t('org.view.tree')}</span> },
                  { value: 'chart', label: <span className="og-seg"><IconBinaryTree size={16} aria-hidden />{t('org.view.chart')}</span> },
                ]}
              />
            ) : null}
            {canManage && units.length ? (
              <Button leftSection={<IconPlus size={18} />} onClick={() => setIntent({ kind: 'addUnit', parentId: null })}>
                {t('org.unit.addRoot')}
              </Button>
            ) : null}
          </>
        }
      />
      {tree.isLoading ? (
        <LoadingBlock variant="list" rows={6} />
      ) : tree.isError ? (
        <ErrorBlock error={tree.error} onRetry={() => void tree.refetch()} />
      ) : !units.length ? (
        <EmptyState
          icon={IconSitemap}
          title={t('org.empty.title')}
          body={canManage ? t('org.empty.bodyAdmin') : t('org.empty.bodyReader')}
          action={canManage ? { label: t('org.empty.action'), onClick: () => setIntent({ kind: 'addUnit', parentId: null }) } : undefined}
        />
      ) : (
        <>
          <p className="og-summary">
            {t('org.summary', { units: tCount('org.units', units.length), positions: tCount('org.tree.positions', positions), vacant: t('org.vacant', { count: vacant }) })}
          </p>
          {view === 'tree' ? (
            <div className="og-card">
              <OrgTree units={units} canManage={canManage} onIntent={setIntent} />
            </div>
          ) : (
            <OrgChart units={units} />
          )}
        </>
      )}

      {canManage ? (
        <>
          <UnitDialog
            opened={intent?.kind === 'addUnit' || intent?.kind === 'editUnit'}
            onClose={close}
            units={units}
            unit={intent?.kind === 'editUnit' ? intent.unit : null}
            parentId={intent?.kind === 'addUnit' ? intent.parentId : null}
          />
          <PositionDialog
            opened={intent?.kind === 'addPosition' || intent?.kind === 'editPosition'}
            onClose={close}
            units={units}
            unitId={intent?.kind === 'addPosition' ? intent.unitId : intent?.kind === 'editPosition' ? intent.position.unitId : null}
            position={intent?.kind === 'editPosition' ? intent.position : null}
          />
          <MoveDialog opened={intent?.kind === 'move'} onClose={close} units={units} subject={intent?.kind === 'move' ? intent.subject : null} />
          <LinkTeamDialog opened={intent?.kind === 'linkTeam'} onClose={close} unit={intent?.kind === 'linkTeam' ? intent.unit : null} />
        </>
      ) : null}
    </>
  );
}
