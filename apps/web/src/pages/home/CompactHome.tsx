import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Drawer, Skeleton } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBell,
  IconCamera,
  IconChecklist,
  IconChevronLeft,
  IconClipboardList,
  IconCloudUpload,
  IconFileImport,
  IconFolderPlus,
  IconFolders,
  IconMessages,
  IconPlayerPlay,
  IconPlus,
  IconSearch,
  IconUserCheck,
  IconUserQuestion,
  IconUsers,
  IconUsersGroup,
  IconUsersPlus,
  type Icon,
} from '@tabler/icons-react';
import { can, canAny, type MyTaskDto, type ProjectDto, type Role, type ViolationDto } from '@nuzli/shared';
import { useAuthStore } from '../../stores/auth';
import { useMyViolations, useTeams, useUnreadCount } from '../../api/queries';
import { useMyTasks, useProjects } from '../../api/projectQueries';
import { useMyParticipations } from '../../api/a12Queries';
import { useNavBadges } from '../../app/shell/useNavModel';
import { useShellStore } from '../../app/shell/store';
import { NotificationBell } from '../../app/NotificationBell';
import { InstallCard } from '../../app/pwa/InstallCard';
import { useRosterInfo, useUnsyncedCount } from '../../features/violations/offline/runtime';
import { OutboxElsewhereNotice } from '../violations/MyViolationsPage';
import { ProjectCover } from '../../features/projects/ProjectCover';
import { UserPhotoAvatar } from '../../components/UserAvatar';
import { useActiveWorkspace } from '../../stores/auth';
import { workspaceRoleText } from '../../features/workspaces/roles';
import { GrantsHome } from '../../features/workspaces/GrantsHome';
import { useOnline } from '../../lib/useOnline';
import { formatDate, formatDateTime, formatNumber, riyadhDay, t, type MessageKey } from '../../i18n';
import { projectStatusLabel, taskStatusLabel } from '../projects/parts';

/*
 * A12 — the home of phones and portrait tablets, in the style of the owner's Figma reference
 * (Home 0:1589) in our identity: a greeting header (avatar, «مرحبًا، {الاسم}», the workspace, the
 * bell), four KPI cards for the role (an icon in a soft tinted circle, a label, a big number), a
 * chart card, the recent items with «عرض الكل», and the floating «+» with the role's actions.
 */

type Tone = 'brand' | 'wait' | 'no' | 'ok' | 'blue';

interface Kpi {
  id: string;
  label: MessageKey;
  value: number | undefined;
  icon: Icon;
  tone: Tone;
  to: string;
}

function KpiCard({ k }: { k: Kpi }) {
  return (
    <Link to={k.to} className="nz-k" data-tone={k.tone} data-testid={`kpi-${k.id}`}>
      <span className="nz-k-head">
        <span className="nz-k-ic" aria-hidden>
          <k.icon size={20} stroke={1.8} />
        </span>
        <span className="nz-k-label">{t(k.label)}</span>
      </span>
      {k.value === undefined ? <Skeleton h={30} w={56} radius="sm" /> : <b className="nz-k-n num">{formatNumber(k.value)}</b>}
    </Link>
  );
}

// ---------------------------------------------------------------- charts (inline SVG, token colours)

interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
}

function Donut({ slices, total }: { slices: Slice[]; total: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="nz-donut">
      <svg viewBox="0 0 140 140" role="img" aria-label={slices.map((s) => `${s.label}: ${formatNumber(s.value)}`).join('، ')}>
        <circle cx="70" cy="70" r={r} className="nz-donut-track" />
        {total > 0
          ? slices
              .filter((s) => s.value > 0)
              .map((s) => {
                const len = (s.value / total) * c;
                const gap = slices.filter((x) => x.value > 0).length > 1 ? 2 : 0;
                const el = (
                  <circle
                    key={s.key}
                    cx="70"
                    cy="70"
                    r={r}
                    stroke={s.color}
                    className="nz-donut-seg"
                    strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                    strokeDashoffset={-offset}
                  />
                );
                offset += len;
                return el;
              })
          : null}
      </svg>
      <span className="nz-donut-mid">
        <b className="num">{formatNumber(total)}</b>
        <span>{t('mhome.chart.total')}</span>
      </span>
    </div>
  );
}

function Legend({ slices }: { slices: Slice[] }) {
  return (
    <ul className="nz-legend">
      {slices.map((s) => (
        <li key={s.key}>
          <i style={{ background: s.color }} aria-hidden />
          <span>{s.label}</span>
          <b className="num">{formatNumber(s.value)}</b>
        </li>
      ))}
    </ul>
  );
}

function Bars({ days }: { days: { day: string; label: string; count: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  return (
    <div className="nz-bars" role="img" aria-label={days.map((d) => `${d.label}: ${formatNumber(d.count)}`).join('، ')}>
      {days.map((d) => (
        <span key={d.day} className="nz-bar">
          <b className="num">{d.count ? formatNumber(d.count) : ''}</b>
          <span className="nz-bar-track">
            <span className="nz-bar-fill" style={{ blockSize: `${Math.max(d.count ? 6 : 0, (d.count / max) * 100)}%` }} />
          </span>
          <span className="nz-bar-x">{d.label}</span>
        </span>
      ))}
    </div>
  );
}

function ChartCard({ title, children, loading }: { title: string; children: ReactNode; loading?: boolean }) {
  return (
    <section className="nz-hcard" aria-label={title}>
      <h2 className="nz-hcard-title">{title}</h2>
      {loading ? <Skeleton h={160} radius="md" /> : children}
    </section>
  );
}

const PROJECT_COLORS: Record<string, string> = {
  ACTIVE: 'var(--primary)',
  PLANNING: '#a18ff3',
  ON_HOLD: '#ffa500',
  COMPLETED: '#7ac555',
  ARCHIVED: 'var(--line2)',
};
const TASK_COLORS: Record<string, string> = {
  NOT_STARTED: '#a18ff3',
  IN_PROGRESS: 'var(--primary)',
  ON_HOLD: '#ffa500',
  DONE: '#7ac555',
};

function groupBy<T>(items: T[], key: (x: T) => string, order: string[], colors: Record<string, string>, label: (k: string) => string): Slice[] {
  const counts = new Map<string, number>();
  for (const x of items) counts.set(key(x), (counts.get(key(x)) ?? 0) + 1);
  return order.filter((k) => counts.get(k)).map((k) => ({ key: k, label: label(k), value: counts.get(k) ?? 0, color: colors[k] ?? 'var(--dim2)' }));
}

// ---------------------------------------------------------------- recent rows

function RecentCard({ title, to, children, empty }: { title: string; to?: string; children: ReactNode[]; empty?: boolean }) {
  return (
    <section className="nz-hcard" aria-label={title}>
      <div className="nz-hcard-head">
        <h2 className="nz-hcard-title">{title}</h2>
        {to ? (
          <Link to={to} className="nz-hcard-all">
            {t('mhome.seeAll')}
          </Link>
        ) : null}
      </div>
      {empty ? <p className="nz-hcard-empty">{t('mhome.recent.empty')}</p> : <ul className="nz-rows">{children}</ul>}
    </section>
  );
}

function RecentRow({ to, lead, title, sub, end }: { to: string; lead: ReactNode; title: string; sub?: ReactNode; end?: ReactNode }) {
  return (
    <li>
      <Link to={to} className="nz-row">
        <span className="nz-row-lead">{lead}</span>
        <span className="nz-row-main">
          <b>{title}</b>
          {sub ? <span>{sub}</span> : null}
        </span>
        {end ? <span className="nz-row-end">{end}</span> : null}
      </Link>
    </li>
  );
}

function ProjectRows({ projects }: { projects: ProjectDto[] }) {
  const recent = [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  return (
    <RecentCard title={t('mhome.recent.projects')} to="/projects" empty={!recent.length}>
      {recent.map((p) => (
        <RecentRow
          key={p.id}
          to={`/projects/${p.id}`}
          lead={<ProjectCover project={p} variant="thumb" />}
          title={p.name}
          sub={projectStatusLabel(p.status)}
          end={<span className="nz-row-date">{formatDate(p.startDate)}</span>}
        />
      ))}
    </RecentCard>
  );
}

function TaskRows({ tasks }: { tasks: MyTaskDto[] }) {
  const soon = tasks
    .filter((x) => x.status !== 'DONE')
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.endDate.localeCompare(b.endDate))
    .slice(0, 4);
  return (
    <RecentCard title={t('mhome.recent.tasks')} to="/my-tasks" empty={!soon.length}>
      {soon.map((x) => (
        <RecentRow
          key={x.id}
          to={`/my-tasks/${x.id}`}
          lead={
            <span className="nz-row-ic" data-tone={x.overdue ? 'no' : x.dueSoon ? 'wait' : undefined} aria-hidden>
              <IconChecklist size={20} stroke={1.7} />
            </span>
          }
          title={x.name}
          sub={`${x.project.name} · ${taskStatusLabel(x.status)}`}
          end={<span className={x.overdue ? 'nz-row-date late' : 'nz-row-date'}>{t('mhome.dueOn', { date: formatDate(x.endDate.slice(0, 10)) })}</span>}
        />
      ))}
    </RecentCard>
  );
}

function ViolationRows({ items }: { items: ViolationDto[] }) {
  return (
    <RecentCard title={t('mhome.recent.violations')} to="/violations/mine" empty={!items.length}>
      {items.slice(0, 4).map((v) => (
        <RecentRow
          key={v.id}
          to={`/violations/mine?open=${v.id}`}
          lead={
            <span className="nz-row-ic" data-tone="no" aria-hidden>
              <IconAlertTriangle size={20} stroke={1.7} />
            </span>
          }
          title={v.type.name}
          sub={v.member?.fullName ?? t('mhome.kpi.unassigned')}
          end={<span className="nz-row-date">{formatDateTime(v.capturedAt)}</span>}
        />
      ))}
    </RecentCard>
  );
}

// ---------------------------------------------------------------- per role

function AdminHome() {
  const projects = useProjects({});
  const teams = useTeams({});
  const badges = useNavBadges();
  const list = (projects.data ?? []).filter((p) => !p.isTemplate);
  const pendingTeams = teams.data?.filter((x) => x.status === 'PENDING_APPROVAL').length ?? 0;
  const kpis: Kpi[] = [
    { id: 'projects', label: 'mhome.kpi.projects', value: projects.data ? list.length : undefined, icon: IconFolders, tone: 'brand', to: '/projects' },
    { id: 'active', label: 'mhome.kpi.active', value: projects.data ? list.filter((p) => p.status === 'ACTIVE').length : undefined, icon: IconPlayerPlay, tone: 'ok', to: '/projects' },
    { id: 'teams', label: 'mhome.kpi.teams', value: teams.data ? teams.data.filter((x) => x.status === 'ACTIVE').length : undefined, icon: IconUsersGroup, tone: pendingTeams ? 'wait' : 'blue', to: pendingTeams ? '/teams?status=PENDING_APPROVAL' : '/teams' },
    { id: 'requests', label: 'mhome.kpi.requests', value: badges.registrations, icon: IconUserCheck, tone: badges.registrations ? 'wait' : 'brand', to: '/registrations' },
  ];
  const slices = groupBy(list, (p) => p.status, ['ACTIVE', 'PLANNING', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'], PROJECT_COLORS, projectStatusLabel);
  return (
    <>
      <KpiGrid kpis={kpis} />
      <div className="nz-hgrid">
        <ChartCard title={t('mhome.chart.projects')} loading={projects.isLoading}>
          {list.length ? (
            <div className="nz-chart-donut">
              <Donut slices={slices} total={list.length} />
              <Legend slices={slices} />
            </div>
          ) : (
            <p className="nz-hcard-empty">{t('mhome.chart.empty')}</p>
          )}
        </ChartCard>
        <ProjectRows projects={list} />
      </div>
    </>
  );
}

function SupervisorHome() {
  const tasks = useMyTasks();
  const teams = useTeams({});
  const badges = useNavBadges();
  const list = tasks.data ?? [];
  const open = list.filter((x) => x.status !== 'DONE');
  const overdue = list.filter((x) => x.overdue).length;
  const kpis: Kpi[] = [
    { id: 'myTasks', label: 'mhome.kpi.myTasks', value: tasks.data ? open.length : undefined, icon: IconChecklist, tone: 'brand', to: '/my-tasks' },
    { id: 'overdue', label: 'mhome.kpi.overdue', value: tasks.data ? overdue : undefined, icon: IconAlertTriangle, tone: overdue ? 'no' : 'ok', to: '/my-tasks' },
    { id: 'team', label: 'mhome.kpi.team', value: teams.data ? teams.data.reduce((a, x) => a + x.memberCount, 0) : undefined, icon: IconUsers, tone: 'blue', to: '/teams' },
    { id: 'unread', label: 'mhome.kpi.unread', value: badges.hubUnread, icon: IconMessages, tone: badges.hubUnread ? 'wait' : 'brand', to: '/hub' },
  ];
  const slices = groupBy(list, (x) => x.status, ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'DONE'], TASK_COLORS, taskStatusLabel);
  return (
    <>
      <KpiGrid kpis={kpis} />
      <div className="nz-hgrid">
        <ChartCard title={t('mhome.chart.tasks')} loading={tasks.isLoading}>
          {list.length ? (
            <div className="nz-chart-donut">
              <Donut slices={slices} total={list.length} />
              <Legend slices={slices} />
            </div>
          ) : (
            <p className="nz-hcard-empty">{t('mhome.chart.empty')}</p>
          )}
        </ChartCard>
        <TaskRows tasks={list} />
      </div>
    </>
  );
}

function lastDays(n: number, now = new Date()): { day: string; label: string }[] {
  const fmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { weekday: 'short', timeZone: 'Asia/Riyadh' });
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getTime() - (n - 1 - i) * 86_400_000);
    return { day: riyadhDay(d), label: fmt.format(d) };
  });
}

function MonitorHomeCompact() {
  const user = useAuthStore((s) => s.user);
  const online = useOnline();
  const pending = useUnsyncedCount(user?.id);
  const roster = useRosterInfo();
  const mine = useMyViolations({ pageSize: 50 }, online);
  const unassigned = useMyViolations({ assigned: 'false', pageSize: 1 }, online);
  const items = mine.data?.items ?? [];
  const days = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of items) counts.set(riyadhDay(new Date(v.capturedAt)), (counts.get(riyadhDay(new Date(v.capturedAt))) ?? 0) + 1);
    return lastDays(7).map((d) => ({ ...d, count: counts.get(d.day) ?? 0 }));
  }, [items]);
  const waiting = unassigned.data?.total;
  const kpis: Kpi[] = [
    { id: 'myViolations', label: 'mhome.kpi.myViolations', value: mine.data ? mine.data.total : online ? undefined : 0, icon: IconClipboardList, tone: 'brand', to: '/violations/mine' },
    { id: 'pending', label: 'mhome.kpi.pending', value: pending, icon: IconCloudUpload, tone: pending ? 'wait' : 'ok', to: '/violations/pending' },
    { id: 'unassigned', label: 'mhome.kpi.unassigned', value: waiting ?? (online ? undefined : 0), icon: IconUserQuestion, tone: waiting ? 'wait' : 'brand', to: '/violations/mine' },
    { id: 'roster', label: 'mhome.kpi.roster', value: roster?.count ?? 0, icon: IconUsers, tone: 'blue', to: '/violations/new' },
  ];
  return (
    <>
      {/* A12 security review H3: unsynced violations of another workspace wait on the device. */}
      <OutboxElsewhereNotice />
      <KpiGrid kpis={kpis} />
      <div className="nz-hgrid">
        <ChartCard title={t('mhome.chart.violations')} loading={online && mine.isLoading}>
          <Bars days={days} />
        </ChartCard>
        <ViolationRows items={items} />
      </div>
    </>
  );
}

function OtherHome() {
  const user = useAuthStore((s) => s.user);
  const badges = useNavBadges();
  const unread = useUnreadCount();
  const parts = useMyParticipations();
  const projects = useProjects({}, can(user, 'projects.readAll'));
  const tasks = useMyTasks(can(user, 'tasks.readAssigned'));
  const kpis: Kpi[] = [];
  if (can(user, 'projects.readAll'))
    kpis.push({ id: 'projects', label: 'mhome.kpi.projects', value: projects.data?.filter((p) => !p.isTemplate).length, icon: IconFolders, tone: 'brand', to: '/projects' });
  else if (parts.data?.length)
    kpis.push({ id: 'myProjects', label: 'mhome.kpi.myProjects', value: parts.data.length, icon: IconFolders, tone: 'brand', to: '/projects' });
  if (can(user, 'tasks.readAssigned'))
    kpis.push({ id: 'myTasks', label: 'mhome.kpi.myTasks', value: tasks.data?.filter((x) => x.status !== 'DONE').length, icon: IconChecklist, tone: 'ok', to: '/my-tasks' });
  if (can(user, 'tasks.comment')) kpis.push({ id: 'unread', label: 'mhome.kpi.unread', value: badges.hubUnread, icon: IconMessages, tone: badges.hubUnread ? 'wait' : 'brand', to: '/hub' });
  if (canAny(user, ['registrations.review', 'registrations.read'])) kpis.push({ id: 'requests', label: 'mhome.kpi.requests', value: badges.registrations, icon: IconUserCheck, tone: badges.registrations ? 'wait' : 'brand', to: '/registrations' });
  kpis.push({ id: 'notifications', label: 'mhome.kpi.notifications', value: unread.data?.count ?? (unread.isLoading ? undefined : 0), icon: IconBell, tone: unread.data?.count ? 'wait' : 'blue', to: '/notifications' });
  return (
    <>
      <KpiGrid kpis={kpis.slice(0, 4)} />
      {projects.data?.length ? (
        <div className="nz-hgrid">
          <ProjectRows projects={projects.data.filter((p) => !p.isTemplate)} />
        </div>
      ) : null}
      <div className="nz-home-grants">
        <GrantsHome />
      </div>
    </>
  );
}

function KpiGrid({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="nz-kgrid" data-count={kpis.length}>
      {kpis.map((k) => (
        <KpiCard key={k.id} k={k} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- header, FAB

function Greeting() {
  const user = useAuthStore((s) => s.user)!;
  const ws = useActiveWorkspace();
  const setPalette = useShellStore((s) => s.setPalette);
  const first = user.fullName.split(' ')[0] ?? user.fullName;
  return (
    <header className="nz-hello">
      <Link to="/more" className="nz-hello-av" aria-label={t('nav.more')}>
        <UserPhotoAvatar user={user} self size={52} />
      </Link>
      <div className="nz-hello-text">
        <h1 tabIndex={-1}>{t('mhome.greeting', { name: first })}</h1>
        <span>{ws?.name ?? workspaceRoleText(user)}</span>
      </div>
      <div className="nz-hello-end">
        <button type="button" className="nz-iconbtn nz-round" onClick={() => setPalette(true)} aria-label={t('palette.openAria')}>
          <IconSearch size={20} stroke={1.7} aria-hidden />
        </button>
        <NotificationBell />
      </div>
    </header>
  );
}

interface Action {
  id: string;
  label: MessageKey;
  hint: MessageKey;
  icon: Icon;
  to: string;
}

export function homeActions(user: Parameters<typeof can>[0], role: Role | null): Action[] {
  const out: Action[] = [];
  if (can(user, 'projects.create')) {
    out.push({ id: 'project', label: 'mhome.action.project', hint: 'mhome.action.projectHint', icon: IconFolderPlus, to: '/projects?create=1' });
    out.push({ id: 'import', label: 'mhome.action.import', hint: 'mhome.action.importHint', icon: IconFileImport, to: '/projects/import' });
  }
  if (canAny(user, ['teams.create', 'teams.createOwn'])) out.push({ id: 'team', label: 'mhome.action.team', hint: 'mhome.action.teamHint', icon: IconUsersPlus, to: '/teams?create=1' });
  // The monitor's raised tab already records; the «+» would only repeat it.
  if (can(user, 'violations.create') && role !== 'MONITOR')
    out.push({ id: 'violation', label: 'mhome.action.violation', hint: 'mhome.action.violationHint', icon: IconCamera, to: '/violations/new' });
  return out;
}

/** The floating «+» (bottom-left in RTL, above the bar) and its action sheet. */
export function Fab({ actions }: { actions: Action[] }) {
  const [open, setOpen] = useState(false);
  if (!actions.length) return null;
  return (
    <>
      <button type="button" className="nz-fab" onClick={() => setOpen(true)} aria-label={t('mhome.fab')} aria-haspopup="dialog" aria-expanded={open} data-testid="fab">
        <IconPlus size={28} stroke={2.2} aria-hidden />
      </button>
      <Drawer
        opened={open}
        onClose={() => setOpen(false)}
        position="bottom"
        size="auto"
        title={t('mhome.actionsTitle')}
        classNames={{ content: 'nz-sheet-content', header: 'nz-sheet-header', body: 'nz-sheet-body' }}
      >
        <ul className="nz-actions" data-testid="fab-actions">
          {actions.map((a) => (
            <li key={a.id}>
              <Link to={a.to} className="nz-action" onClick={() => setOpen(false)}>
                <span className="nz-action-ic" aria-hidden>
                  <a.icon size={22} stroke={1.7} />
                </span>
                <span className="nz-action-text">
                  <b>{t(a.label)}</b>
                  <span>{t(a.hint)}</span>
                </span>
                <IconChevronLeft size={18} stroke={1.8} className="nz-more-chev" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </Drawer>
    </>
  );
}

export function CompactHome({ role }: { role: Role | null }) {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;
  return (
    <div className="nz-home">
      <Greeting />
      <InstallCard />
      {role === 'ADMIN' ? <AdminHome /> : role === 'SUPERVISOR' ? <SupervisorHome /> : role === 'MONITOR' ? <MonitorHomeCompact /> : <OtherHome />}
      <Fab actions={homeActions(user, role)} />
    </div>
  );
}
