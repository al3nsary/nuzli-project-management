import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Tooltip } from '@mantine/core';
import { useFocusTrap, useMergedRef } from '@mantine/hooks';
import {
  IconChevronDown,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconBulb,
  IconPlus,
  IconSquareRoundedPlus,
  IconX,
} from '@tabler/icons-react';
import { can } from '@nuzli/shared';
import { NAV_GROUPS, type BadgeKind, type NavNode } from '../nav';
import { formatNumber, t } from '../../i18n';
import { NozolyLogo } from '../../components/Brand';
import { useAuthStore } from '../../stores/auth';
import { useProjects } from '../../api/projectQueries';
import { useShellStore } from './store';
import { sumBadges } from './useNavModel';
import { dirSign } from '../../lib/direction';

/** Waiting work is amber (sync), work to act on is red (design skill pills). */
const QUIET: BadgeKind[] = ['outbox'];

function Count({ node, n }: { node: NavNode; n: number }) {
  if (!n) return null;
  const quiet = node.badge ? QUIET.includes(node.badge) : node.children?.every((c) => !c.badge || QUIET.includes(c.badge));
  return (
    <span className={quiet ? 'n q' : 'n'} aria-label={t('nav.countAria', { n })}>
      {formatNumber(n)}
    </span>
  );
}

const tipSide = () => (dirSign() < 0 ? 'left' : 'right') as 'left' | 'right';

interface ItemCtx {
  chain: string[];
  badges: Record<BadgeKind, number>;
  mini: boolean;
  onPick(): void;
}

function NavLeaf({ n, kid, ctx }: { n: NavNode; kid?: boolean; ctx: ItemCtx }) {
  const active = ctx.chain[ctx.chain.length - 1] === n.id;
  const count = sumBadges(n, ctx.badges);
  const link = (
    <Link
      to={n.path!}
      className={[kid ? 'nz-kid' : 'nz-nav', active ? 'on' : '', count ? 'hasn' : ''].filter(Boolean).join(' ')}
      aria-current={active ? 'page' : undefined}
      aria-label={ctx.mini ? `${t(n.label)}${count ? ` — ${t('nav.countAria', { n: count })}` : ''}` : undefined}
      onClick={ctx.onPick}
    >
      <n.icon className="ic" size={kid ? 16 : 18} stroke={1.7} aria-hidden />
      <b>{t(n.label)}</b>
      <Count node={n} n={count} />
    </Link>
  );
  return ctx.mini ? (
    <Tooltip label={t(n.label)} position={tipSide()}>
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function NavContainer({
  n,
  ctx,
  isOpen,
  onToggle,
}: {
  n: NavNode;
  ctx: ItemCtx;
  isOpen: boolean;
  onToggle(): void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const inChain = ctx.chain[0] === n.id;
  const count = sumBadges(n, ctx.badges);
  const first = n.children!.find((c) => c.path);
  const btn = (
    <button
      type="button"
      className={['nz-nav', 'nz-parent', inChain ? 'on-parent' : '', count ? 'hasn' : '', ctx.mini && inChain ? 'on' : '']
        .filter(Boolean)
        .join(' ')}
      aria-expanded={ctx.mini ? undefined : isOpen}
      aria-controls={ctx.mini ? undefined : id}
      aria-label={ctx.mini ? t(n.label) : undefined}
      onClick={() => {
        // On the rail a container goes to its first page; on the full side it folds and unfolds.
        if (ctx.mini) {
          if (first?.path) navigate(first.path);
          return;
        }
        onToggle();
      }}
    >
      <n.icon className="ic" size={18} stroke={1.7} aria-hidden />
      <b>{t(n.label)}</b>
      {!isOpen || ctx.mini ? <Count node={n} n={count} /> : null}
      <IconChevronDown className="chev" size={15} stroke={1.8} aria-hidden data-open={isOpen || undefined} />
    </button>
  );
  return (
    <div className="nz-parent-wrap">
      {ctx.mini ? (
        <Tooltip label={t(n.label)} position={tipSide()}>
          {btn}
        </Tooltip>
      ) : (
        btn
      )}
      <div className="nz-kids" id={id} hidden={ctx.mini || !isOpen}>
        {n.children!.map((c) => (
          <NavLeaf key={c.id} n={c} kid ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

/** The four dot colours of the design's project list, picked per project from its id. */
const PROJECT_DOTS = ['#7ac555', '#ffa500', '#a18ff3', '#76a5ea'];
const dotOf = (id: string) => PROJECT_DOTS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % PROJECT_DOTS.length]!;
const SIDE_PROJECTS = 6;

/** «مشاريعي»: the live projects with a colour dot, the open one on the tint (the design's side list). */
function MyProjects({ canCreate, onPick }: { canCreate: boolean; onPick(): void }) {
  const user = useAuthStore((s) => s.user);
  const { pathname } = useLocation();
  const list = useProjects({}, can(user, 'projects.readAll'));
  const projects = (list.data ?? []).filter((p) => !p.isTemplate).slice(0, SIDE_PROJECTS);
  if (!projects.length) return null;
  return (
    <div className="nz-myp" role="group" aria-label={t('nav.myProjects')}>
      <div className="nz-myp-head">
        <span>{t('nav.myProjects')}</span>
        {canCreate ? (
          <Tooltip label={t('nav.newProject')}>
            <Link to="/projects?create=1" aria-label={t('nav.newProject')} onClick={onPick}>
              <IconSquareRoundedPlus size={18} stroke={1.5} aria-hidden />
            </Link>
          </Tooltip>
        ) : null}
      </div>
      {projects.map((p) => {
        const on = pathname === `/projects/${p.id}` || pathname.startsWith(`/projects/${p.id}/`);
        return (
          <Link
            key={p.id}
            to={`/projects/${p.id}`}
            className={on ? 'nz-myp-row on' : 'nz-myp-row'}
            aria-current={on ? 'page' : undefined}
            onClick={onPick}
          >
            <i style={{ background: dotOf(p.id) }} aria-hidden />
            <b>{p.name}</b>
          </Link>
        );
      })}
    </div>
  );
}

/** The design's quiet card at the foot of the side: one line and the way to the communication centre. */
function ThoughtsCard({ onPick }: { onPick(): void }) {
  return (
    <div className="nz-thoughts">
      <span className="nz-thoughts-bulb" aria-hidden>
        <IconBulb size={22} stroke={1.6} />
      </span>
      <b>{t('nav.thoughtsTitle')}</b>
      <p>{t('nav.thoughtsBody')}</p>
      <Link to="/hub" className="nz-thoughts-btn" onClick={onPick}>
        {t('nav.thoughtsAction')}
      </Link>
    </div>
  );
}

/**
 * The side navigation (owner requests A9 and A11, the Figma project dashboard): a white panel with
 * the Nozoly logo and the fold button on top, the «+ إنشاء مشروع جديد» button (admins), the
 * items in order with quiet hairline separators, «مشاريعي» with a colour dot per project, and the
 * «وقت الأفكار» card at the foot. The active item sits on the violet tint.
 * Desktop: 250px or the 68px rail (Ctrl+B). Phones: a drawer from the inline start.
 */
export function Sidebar({
  tree,
  chain,
  badges,
  mobile,
  canCreate = false,
}: {
  tree: NavNode[];
  chain: string[];
  badges: Record<BadgeKind, number>;
  mobile: boolean;
  /** Shows «+ إنشاء مشروع جديد» (opens the existing create-project dialog). */
  canCreate?: boolean;
}) {
  const user = useAuthStore((s) => s.user);
  const mini = useShellStore((s) => s.mini) && !mobile;
  const drawer = useShellStore((s) => s.drawer);
  const setDrawer = useShellStore((s) => s.setDrawer);
  const toggleMini = useShellStore((s) => s.toggleMini);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const navRef = useRef<HTMLElement | null>(null);
  const trapRef = useFocusTrap(mobile && drawer);
  // One stable ref: an inline callback would re-arm the focus trap on every render.
  const sideRef = useMergedRef(navRef, trapRef);

  // A parent with the active child expands automatically (rule 2); the user can still fold it.
  const top = chain.length > 1 ? chain[0] : undefined;
  useEffect(() => {
    if (top) setOpen((o) => ({ ...o, [top]: true }));
  }, [top, chain.join('/')]); // eslint-disable-line react-hooks/exhaustive-deps

  // A closed phone drawer is out of the tab order and the accessibility tree. Open, it takes
  // the focus (the active item, else the close button), Esc closes it from anywhere, and the
  // focus returns to whatever opened it.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const hidden = mobile && !drawer;
    el.toggleAttribute('inert', hidden);
    if (hidden) el.setAttribute('aria-hidden', 'true');
    else el.removeAttribute('aria-hidden');
    if (!(mobile && drawer)) {
      if (opener.current && document.contains(opener.current)) opener.current.focus({ preventScroll: true });
      opener.current = null;
      return;
    }
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // After the focus trap's own first focus (a timeout), so the active item wins.
    const timer = window.setTimeout(() => {
      const target = el.querySelector<HTMLElement>('[aria-current="page"]') ?? el.querySelector<HTMLElement>('.nz-fold');
      target?.focus({ preventScroll: true });
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDrawer(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
    };
  }, [mobile, drawer, setDrawer]);

  const ctx: ItemCtx = { chain, badges, mini, onPick: () => mobile && setDrawer(false) };
  const rtl = dirSign() < 0;
  const FoldIcon = mini
    ? rtl
      ? IconLayoutSidebarRightExpand
      : IconLayoutSidebarLeftExpand
    : rtl
      ? IconLayoutSidebarRightCollapse
      : IconLayoutSidebarLeftCollapse;

  return (
    <nav
      ref={sideRef}
      id="nz-side"
      className={['nz-side', mini ? 'mini' : '', mobile ? 'is-mobile' : '', mobile && drawer ? 'open' : ''].filter(Boolean).join(' ')}
      aria-label={t('nav.main')}
    >
      <div className="nz-side-head">
        <Link to="/" className="nz-logo-link" aria-label={t('nav.homeAria')} onClick={ctx.onPick}>
          <NozolyLogo width={mini ? 34 : 124} mark={mini} decorative />
        </Link>
        {mobile ? (
          <button type="button" className="nz-fold" onClick={() => setDrawer(false)} aria-label={t('common.closeMenu')}>
            <IconX size={18} stroke={1.8} />
          </button>
        ) : (
          <Tooltip label={`${mini ? t('shell.expandSide') : t('shell.foldSide')} · Ctrl+B`} position={tipSide()}>
            <button
              type="button"
              className="nz-fold"
              onClick={toggleMini}
              aria-label={mini ? t('shell.expandSide') : t('shell.foldSide')}
              aria-pressed={mini}
              aria-keyshortcuts="Control+B"
            >
              <FoldIcon size={18} stroke={1.7} />
            </button>
          </Tooltip>
        )}
      </div>

      {canCreate ? (
        <div className="nz-side-cta">
          {mini ? (
            <Tooltip label={t('nav.createProject')} position={tipSide()}>
              <Link to="/projects?create=1" className="nz-create" aria-label={t('nav.createProject')} onClick={ctx.onPick}>
                <IconPlus size={18} stroke={2.2} aria-hidden />
              </Link>
            </Tooltip>
          ) : (
            <Link to="/projects?create=1" className="nz-create" onClick={ctx.onPick}>
              <IconPlus size={18} stroke={2.2} aria-hidden />
              <b>{t('nav.createProject')}</b>
            </Link>
          )}
        </div>
      ) : null}

      <div className="nz-side-scroll">
        {NAV_GROUPS.map((g, gi) => {
          const items = tree.filter((n) => n.group === g.id);
          if (!items.length) return null;
          // No separator above the first group the user sees.
          const first = NAV_GROUPS.slice(0, gi).every((p) => !tree.some((n) => n.group === p.id));
          return (
            <div key={g.id} role="group" aria-label={t(g.label)} className="nz-grp-wrap">
              {first ? null : (
                <div className={g.quiet ? 'nz-grp quiet' : 'nz-grp'} data-label={g.quiet ? undefined : t(g.label)} aria-hidden />
              )}
              {items.map((n) =>
                n.children ? (
                  <NavContainer
                    key={n.id}
                    n={n}
                    ctx={ctx}
                    isOpen={open[n.id] ?? chain[0] === n.id}
                    onToggle={() => setOpen((o) => ({ ...o, [n.id]: !(o[n.id] ?? chain[0] === n.id) }))}
                  />
                ) : (
                  <NavLeaf key={n.id} n={n} ctx={ctx} />
                ),
              )}
            </div>
          );
        })}
        {mini ? null : <MyProjects canCreate={canCreate} onPick={ctx.onPick} />}
      </div>

      {mini || !can(user, 'tasks.comment') ? null : (
        <div className="nz-side-foot">
          <ThoughtsCard onPick={ctx.onPick} />
        </div>
      )}
    </nav>
  );
}
