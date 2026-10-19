import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ActionIcon, Button, Group, Menu, Modal, Select, Skeleton, Stack, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconBriefcase,
  IconCalendarEvent,
  IconChartDonut,
  IconCoin,
  IconDots,
  IconFolders,
  IconPencil,
  IconPlus,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { can, type PortfolioDto, type PortfolioSummaryDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { qkA9, usePortfolio, usePortfolios } from '../../api/a9Queries';
import { useProjects } from '../../api/projectQueries';
import { ApiError, errorMessage } from '../../api/errors';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDate, formatNumber, t } from '../../i18n';
import { BudgetTotals, Kpi, ReportCard, CardEmpty } from '../../features/reports/parts';
import { formatPct } from '../../features/reports/budget';
import { ProgressLine, ProjectStatusBadge, projectStatusLabel } from '../projects/parts';

/** `?portfolio=<id>` — the selected portfolio is deep-linkable; switching replaces the entry. */
function useSelected(): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get('portfolio');
  const set = (id: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('portfolio', id);
        else next.delete('portfolio');
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  return [value, set];
}

/**
 * «المحافظ» (route `/portfolios`): portfolios on the inline-start side, the selected one's
 * summary beside it (weighted progress, budget / planned / actual, date span, overdue, status
 * mix, and one row per project). Users with `projects.manage` create, rename, delete and add or
 * remove projects.
 */
export function PortfoliosPage() {
  const user = useAuthStore((s) => s.user);
  const manage = can(user, 'projects.manage');
  const list = usePortfolios();
  const [selected, setSelected] = useSelected();
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; portfolio: PortfolioDto } | null>(null);
  const api = useApi();
  const qc = useQueryClient();

  const portfolios = useMemo(() => [...(list.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'ar')), [list.data]);
  const current = portfolios.find((p) => p.id === selected) ?? portfolios[0] ?? null;

  // Keep the URL on a real portfolio (first one by default, or after a delete).
  useEffect(() => {
    if (!list.data) return;
    if (current && current.id !== selected) setSelected(current.id);
    if (!current && selected) setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, current?.id, selected]);

  // A local confirm dialog (no ModalsProvider dependency).
  const [confirmDelete, setConfirmDelete] = useState<PortfolioDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const remove = (pf: PortfolioDto) => setConfirmDelete(pf);
  const doDelete = async () => {
    const pf = confirmDelete;
    if (!pf) return;
    setDeleting(true);
    try {
      await api.portfolios.remove(pf.id);
      qc.removeQueries({ queryKey: qkA9.portfolio(pf.id) });
      await qc.invalidateQueries({ queryKey: qkA9.portfolios });
      notifications.show({ color: 'ok', message: t('a9r.pf.deleted', { name: pf.name }) });
      setConfirmDelete(null);
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('nav.portfolios')}
        lead={t('a9r.pf.lead')}
        actions={
          manage ? (
            <Button leftSection={<IconPlus size={18} />} onClick={() => setForm({ mode: 'create' })}>
              {t('a9r.pf.create')}
            </Button>
          ) : null
        }
      />
      {list.isLoading ? (
        <LoadingBlock variant="cards" rows={3} />
      ) : list.error ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !portfolios.length ? (
        <EmptyState
          icon={IconBriefcase}
          title={t('a9r.pf.emptyTitle')}
          body={t('a9r.pf.emptyBody')}
          action={manage ? { label: t('a9r.pf.create'), onClick: () => setForm({ mode: 'create' }) } : undefined}
        />
      ) : (
        <div className="rp-split">
          <nav className="rp-card rp-card--flush" aria-label={t('a9r.pf.listAria')}>
            <ul className="rp-pf-list">
              {portfolios.map((pf) => (
                <li key={pf.id} className="rp-pf-item" data-active={pf.id === current?.id || undefined}>
                  <button type="button" className="rp-pf-btn" onClick={() => setSelected(pf.id)} aria-current={pf.id === current?.id ? 'true' : undefined}>
                    <span className="rp-pf-name">{pf.name}</span>
                    <span className="rp-pf-meta">{t('a9r.pf.projectCount', { n: pf.projectIds.length })}</span>
                  </button>
                  {manage ? (
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon variant="subtle" color="gray" size={40} aria-label={t('a9r.pf.actionsFor', { name: pf.name })} style={{ marginInlineEnd: 4 }}>
                          <IconDots size={18} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item leftSection={<IconPencil size={16} />} onClick={() => setForm({ mode: 'edit', portfolio: pf })}>
                          {t('a9r.pf.rename')}
                        </Menu.Item>
                        <Menu.Item color="breach" leftSection={<IconTrash size={16} />} onClick={() => remove(pf)}>
                          {t('a9r.pf.delete')}
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  ) : null}
                </li>
              ))}
            </ul>
          </nav>
          {current ? <PortfolioPanel key={current.id} portfolio={current} manage={manage} /> : null}
        </div>
      )}
      <Modal opened={confirmDelete !== null} onClose={() => setConfirmDelete(null)} title={t('a9r.pf.deleteTitle')} centered radius="lg">
        <Text size="sm">{confirmDelete ? t('a9r.pf.deleteBody', { name: confirmDelete.name }) : ''}</Text>
        <Group justify="flex-end" gap="sm" mt="lg">
          <Button variant="default" onClick={() => setConfirmDelete(null)}>
            {t('common.cancel')}
          </Button>
          <Button color="breach" loading={deleting} onClick={() => void doDelete()}>
            {t('a9r.pf.deleteConfirm')}
          </Button>
        </Group>
      </Modal>
      <PortfolioForm
        state={form}
        onClose={() => setForm(null)}
        onSaved={(pf) => {
          setForm(null);
          setSelected(pf.id);
        }}
      />
    </>
  );
}

function PortfolioForm({
  state,
  onClose,
  onSaved,
}: {
  state: { mode: 'create' } | { mode: 'edit'; portfolio: PortfolioDto } | null;
  onClose(): void;
  onSaved(pf: PortfolioDto): void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!state) return;
    setName(state.mode === 'edit' ? state.portfolio.name : '');
    setDescription(state.mode === 'edit' ? (state.portfolio.description ?? '') : '');
    setNameError(null);
    setError(null);
  }, [state]);

  const submit = async () => {
    if (!state) return;
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setNameError(t('a9r.pf.nameShort'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = { name: trimmed, description: description.trim() };
      const pf = state.mode === 'create' ? await api.portfolios.create(input) : await api.portfolios.update(state.portfolio.id, input);
      await qc.invalidateQueries({ queryKey: qkA9.portfolios });
      notifications.show({ color: 'ok', message: state.mode === 'create' ? t('a9r.pf.created', { name: pf.name }) : t('a9r.pf.renamed') });
      onSaved(pf);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NAME_TAKEN') setNameError(err.message_ar);
      else if (err instanceof ApiError && err.fieldErrors.name) setNameError(err.fieldErrors.name);
      else setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      opened={state !== null}
      onClose={onClose}
      title={state?.mode === 'edit' ? t('a9r.pf.editTitle') : t('a9r.pf.createTitle')}
      centered
      radius="lg"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="md">
          <TextInput
            label={t('a9r.pf.name')}
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
              setNameError(null);
            }}
            error={nameError}
            required
            maxLength={120}
            data-autofocus
          />
          <Textarea
            label={t('a9r.pf.description')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            autosize
            minRows={2}
            maxRows={5}
            maxLength={2000}
          />
          {error ? (
            <Text size="sm" c="var(--red)" role="alert">
              {error}
            </Text>
          ) : null}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={saving}>
              {state?.mode === 'edit' ? t('a9r.pf.saveEdit') : t('a9r.pf.saveCreate')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function PortfolioPanel({ portfolio, manage }: { portfolio: PortfolioDto; manage: boolean }) {
  const q = usePortfolio(portfolio.id);
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const projects = useProjects({}, manage);
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(
    () =>
      (projects.data ?? [])
        .filter((p) => !p.isTemplate && !portfolio.projectIds.includes(p.id))
        .map((p) => ({ value: p.id, label: p.name })),
    [projects.data, portfolio.projectIds],
  );

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: qkA9.portfolios }), qc.invalidateQueries({ queryKey: qkA9.portfolio(portfolio.id) })]);
  };
  const add = async (projectId: string | null) => {
    if (!projectId) return;
    setBusy(true);
    try {
      await api.portfolios.addProject(portfolio.id, projectId);
      await refresh();
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  const removeProject = async (projectId: string, name: string) => {
    setBusy(true);
    try {
      await api.portfolios.removeProject(portfolio.id, projectId);
      await refresh();
      notifications.show({ color: 'ok', message: t('a9r.pf.removed', { name }) });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  if (q.isLoading) {
    return (
      <div className="rp-stack" aria-busy="true">
        <Skeleton h={90} radius="lg" />
        <Skeleton h={220} radius="lg" />
      </div>
    );
  }
  if (q.error || !q.data) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
  const s: PortfolioSummaryDto = q.data;
  const tt = s.totals;
  const currency = s.projects[0]?.project.currency ?? 'SAR';

  return (
    <div className="rp-stack" data-testid="portfolio-panel">
      <div className="rp-card">
        <h2 className="rp-section-title" style={{ marginBlockStart: 0 }}>
          <IconBriefcase size={20} stroke={1.8} aria-hidden />
          {s.name}
        </h2>
        {s.description ? (
          <Text size="sm" c="dimmed" mt={4}>
            {s.description}
          </Text>
        ) : null}
        {Object.keys(tt.byStatus).length ? (
          <div className="rp-chips" style={{ marginBlockStart: 12 }}>
            {Object.entries(tt.byStatus).map(([st, n]) => (
              <span key={st} className="pill grey" style={{ fontSize: 'var(--fs-xs)' }}>
                {t('a9r.pf.statusChip', { status: projectStatusLabel(st), n })}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="rp-kpis">
        <Kpi icon={IconFolders} label={t('a9r.pf.kpiProjects')} value={formatNumber(tt.projectCount)} />
        <Kpi icon={IconChartDonut} label={t('a9r.pf.kpiProgress')} value={formatPct(tt.progress, 0)} foot={t('a9r.pf.kpiProgressFoot')} />
        <Kpi icon={IconAlertTriangle} label={t('a9r.pf.kpiOverdue')} value={formatNumber(tt.overdueCount)} tone={tt.overdueCount ? 'no' : undefined} />
        <Kpi
          icon={IconCalendarEvent}
          small
          label={t('a9r.pf.kpiSpan')}
          value={tt.startDate ? formatDate(tt.startDate.slice(0, 10)) : t('common.none')}
          foot={tt.endDate ? t('a9r.pf.until', { date: formatDate(tt.endDate.slice(0, 10)) }) : undefined}
        />
      </div>

      <ReportCard title={t('a9r.pf.budgetTitle')} sub={t('a9r.pf.budgetSub')}>
        <Group gap={6} mb="sm" c="dimmed" fz="xs">
          <IconCoin size={14} aria-hidden />
          <span>{t('a9r.pf.currencyNote')}</span>
        </Group>
        <BudgetTotals budget={tt.budget} planned={tt.plannedCost} actual={tt.actualCost} currency={currency} />
      </ReportCard>

      <ReportCard
        flush
        title={t('a9r.pf.projectsTitle')}
        actions={
          manage ? (
            <Select
              placeholder={t('a9r.pf.addProject')}
              aria-label={t('a9r.pf.addProject')}
              data={candidates}
              value={null}
              onChange={(v) => void add(v)}
              searchable
              nothingFoundMessage={t('a9r.pf.noCandidates')}
              disabled={busy || projects.isLoading}
              leftSection={<IconPlus size={16} />}
              w={260}
              maw="100%"
              comboboxProps={{ withinPortal: true }}
            />
          ) : null
        }
      >
        {s.projects.length ? (
          <div className="rp-table-scroll">
            <table className="rp-table">
              <thead>
                <tr>
                  <th>{t('a9r.col.project')}</th>
                  <th>{t('a9r.col.status')}</th>
                  <th style={{ minWidth: 140 }}>{t('a9r.col.progress')}</th>
                  <th className="num">{t('a9r.col.leaf')}</th>
                  <th className="num">{t('a9r.col.done')}</th>
                  <th className="num">{t('a9r.col.overdue')}</th>
                  {manage ? <th aria-label={t('common.actions')} /> : null}
                </tr>
              </thead>
              <tbody>
                {s.projects.map(({ project: pr, leafCount, doneCount, overdueCount }) => (
                  <tr key={pr.id}>
                    <td style={{ minWidth: 200 }}>
                      <Link to={`/projects/${pr.id}`} className="rp-link">
                        {pr.name}
                      </Link>
                    </td>
                    <td>
                      <ProjectStatusBadge status={pr.status} />
                    </td>
                    <td>
                      <ProgressLine value={pr.progress} label={t('a9r.rep.progressOf', { name: pr.name })} />
                    </td>
                    <td className="num">{formatNumber(leafCount)}</td>
                    <td className="num">{formatNumber(doneCount)}</td>
                    <td className={overdueCount ? 'num rp-red' : 'num rp-dim'}>{formatNumber(overdueCount)}</td>
                    {manage ? (
                      <td style={{ width: 52 }}>
                        <Tooltip label={t('a9r.pf.removeProject')} withinPortal>
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            size={40}
                            disabled={busy}
                            onClick={() => void removeProject(pr.id, pr.name)}
                            aria-label={t('a9r.pf.removeProjectNamed', { name: pr.name })}
                          >
                            <IconX size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 16 }}>
            <CardEmpty>{manage ? t('a9r.pf.noProjectsManage') : t('a9r.pf.noProjects')}</CardEmpty>
            {!manage ? null : (
              <Group justify="center">
                <Button variant="light" onClick={() => navigate('/projects')}>
                  {t('a9r.rep.openProjects')}
                </Button>
              </Group>
            )}
          </div>
        )}
      </ReportCard>
    </div>
  );
}
