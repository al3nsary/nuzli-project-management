/**
 * «طلبات العمّال» (A12 round 2) — a supervisor's requests to add a worker to their team or remove
 * one: «بانتظار القرار» and «تمّ القرار» (`?tab=decided`), with the kind, the worker (masked
 * national ID), the team, the date, the status and — when rejected — the reason. The decision is
 * the admin's («الطلبات» › «طلبات العمّال»).
 */
import { useNavigate } from 'react-router-dom';
import { Tabs } from '@mantine/core';
import { can } from '@nuzli/shared';
import { useAuthStore } from '../../stores/auth';
import { PageHeader } from '../../components/ui';
import { t } from '../../i18n';
import { useTabParam } from '../../lib/useUrlState';
import { MemberRequestList } from './MemberRequests';
import './requests.css';

const TABS = ['pending', 'decided'] as const;

export function WorkerRequestsPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [tab, setTab] = useTabParam('tab', TABS, 'pending');
  // A supervisor who is also an approver (dual role) decides here too.
  const approver = can(user, 'registrations.review');
  return (
    <>
      <PageHeader title={t('nav.workerRequests')} lead={t('a12roles.wr.lead')} />
      <Tabs value={tab} onChange={setTab} keepMounted={false} className="nz-req-tabs">
        <Tabs.List>
          <Tabs.Tab value="pending" data-testid="worker-requests-tab-pending">
            {t('a12roles.wr.tab.pending')}
          </Tabs.Tab>
          <Tabs.Tab value="decided" data-testid="worker-requests-tab-decided">
            {t('a12roles.wr.tab.decided')}
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>
      <MemberRequestList
        view={tab}
        approver={approver}
        emptyAction={{ label: t('a12roles.wr.goTeams'), onClick: () => navigate('/teams') }}
      />
    </>
  );
}
