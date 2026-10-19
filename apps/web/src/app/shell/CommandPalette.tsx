import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@mantine/core';
import {
  IconCamera,
  IconChartArcs,
  IconClock,
  IconCornerDownLeft,
  IconKeyboard,
  IconMoon,
  IconPlus,
  IconSearch,
  IconUsersGroup,
  type Icon,
} from '@tabler/icons-react';
import { useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { can, canAny, type UserDto } from '@nuzli/shared';
import { NAV_GROUPS, navLeaves, type NavNode } from '../nav';
import { t } from '../../i18n';
import { useShellStore, type RecentItem } from './store';

export interface PaletteItem {
  id: string;
  section: 'recent' | 'actions' | 'pages';
  label: string;
  sub?: string;
  icon: Icon;
  /** Navigate here… */
  to?: string;
  /** …or run this. */
  run?: () => void;
  /** Shortcut hint, e.g. «G P». */
  hint?: string;
}

/** Arabic-aware matching: no diacritics or tatweel, one alef, ة = ه, ى = ي. */
export function normalizeAr(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

const groupLabel = (n: NavNode) => t(NAV_GROUPS.find((g) => g.id === n.group)!.label);

/** Pages from the registry the user can see (rule 7 + rule 12), actions and recent items. */
export function paletteItems(
  user: UserDto | null,
  tree: NavNode[],
  recent: RecentItem[],
  extra: { toggleTheme?: () => void; themeLabel?: string; openSheet?: () => void } = {},
): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const r of recent) {
    if (r.kind === 'team' && !can(user, 'teams.readOwn')) continue;
    if (r.kind === 'project' && !can(user, 'projects.readGranted')) continue;
    out.push({
      id: `recent:${r.path}`,
      section: 'recent',
      label: r.name,
      sub: r.kind === 'team' ? t('nav.teams') : t('nav.projects'),
      icon: r.kind === 'team' ? IconUsersGroup : IconChartArcs,
      to: r.path,
    });
  }
  if (can(user, 'violations.create'))
    out.push({ id: 'act:record', section: 'actions', label: t('palette.recordViolation'), icon: IconCamera, to: '/violations/new', hint: 'G R' });
  if (canAny(user, ['teams.create', 'teams.createOwn']))
    out.push({ id: 'act:team', section: 'actions', label: t('palette.createTeam'), icon: IconPlus, to: '/teams?create=1' });
  if (can(user, 'projects.create')) {
    out.push({ id: 'act:project', section: 'actions', label: t('palette.newProject'), icon: IconPlus, to: '/projects?create=1' });
    out.push({ id: 'act:import', section: 'actions', label: t('palette.importProject'), icon: IconPlus, to: '/projects/import' });
  }
  if (extra.toggleTheme)
    out.push({ id: 'act:theme', section: 'actions', label: extra.themeLabel ?? t('shell.darkMode'), icon: IconMoon, run: extra.toggleTheme });
  if (extra.openSheet)
    out.push({ id: 'act:keys', section: 'actions', label: t('shortcuts.title'), icon: IconKeyboard, run: extra.openSheet, hint: '?' });
  // Containers give their name to the sub-line: «الفرق والكروت · الفرق».
  const parentOf = new Map<string, NavNode>();
  for (const n of tree) for (const c of n.children ?? []) parentOf.set(c.id, n);
  for (const l of navLeaves(tree)) {
    const parent = parentOf.get(l.id);
    out.push({
      id: `page:${l.id}`,
      section: 'pages',
      label: t(l.label),
      sub: parent ? `${groupLabel(l)} · ${t(parent.label)}` : groupLabel(l),
      icon: l.icon,
      to: l.path!,
      hint: l.key ? `G ${l.key.toUpperCase()}` : undefined,
    });
  }
  return out;
}

export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const q = normalizeAr(query);
  if (!q) return items;
  const words = q.split(' ');
  return items.filter((i) => {
    const hay = normalizeAr(`${i.label} ${i.sub ?? ''}`);
    return words.every((w) => hay.includes(w));
  });
}

const SECTIONS: { id: PaletteItem['section']; label: 'palette.recent' | 'palette.actions' | 'palette.pages' }[] = [
  { id: 'recent', label: 'palette.recent' },
  { id: 'actions', label: 'palette.actions' },
  { id: 'pages', label: 'palette.pages' },
];

/** Ctrl+K (rule 7): search pages, run actions, reopen recent items — arrows and Enter. */
export function CommandPalette({ user, tree }: { user: UserDto | null; tree: NavNode[] }) {
  const opened = useShellStore((s) => s.palette);
  const setPalette = useShellStore((s) => s.setPalette);
  const setSheet = useShellStore((s) => s.setSheet);
  const recent = useShellStore((s) => s.recent);
  const navigate = useNavigate();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const all = useMemo(
    () =>
      paletteItems(user, tree, recent, {
        toggleTheme: () => setColorScheme(scheme === 'dark' ? 'light' : 'dark'),
        themeLabel: scheme === 'dark' ? t('shell.lightMode') : t('shell.darkMode'),
        openSheet: () => setSheet(true),
      }),
    [user, tree, recent, scheme, setColorScheme, setSheet],
  );
  const results = useMemo(() => filterPalette(all, query), [all, query]);
  const ordered = useMemo(
    () => SECTIONS.flatMap((s) => results.filter((r) => r.section === s.id)),
    [results],
  );

  useEffect(() => {
    if (opened) {
      setQuery('');
      setSel(0);
    }
  }, [opened]);
  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    setPalette(false);
    if (item.run) item.run();
    else if (item.to) navigate(item.to);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => (ordered.length ? (s + 1) % ordered.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => (ordered.length ? (s - 1 + ordered.length) % ordered.length : 0));
    } else if (e.key === 'Home') {
      setSel(0);
    } else if (e.key === 'End') {
      setSel(Math.max(0, ordered.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(ordered[sel]);
    }
  };

  let index = -1;
  return (
    <Modal
      opened={opened}
      onClose={() => setPalette(false)}
      withCloseButton={false}
      padding={0}
      size={620}
      centered={false}
      yOffset="14vh"
      radius="xl"
      classNames={{ content: 'nz-palette' }}
      title={null}
      aria-label={t('palette.title')}
      transitionProps={{ transition: 'pop', duration: 180 }}
    >
      <div className="nz-palette-in">
        <IconSearch size={18} stroke={1.8} aria-hidden className="nz-palette-icon" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKey}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.title')}
          role="combobox"
          aria-expanded="true"
          aria-controls="nz-palette-list"
          aria-activedescendant={ordered[sel] ? `nz-pi-${sel}` : undefined}
          aria-autocomplete="list"
        />
        <kbd className="nz-kbd">{t('kbd.esc')}</kbd>
      </div>
      <div className="nz-palette-res" id="nz-palette-list" role="listbox" aria-label={t('palette.results')} ref={listRef}>
        {ordered.length === 0 ? (
          <div className="nz-palette-empty">{t('palette.empty', { q: query })}</div>
        ) : (
          SECTIONS.map((s) => {
            const rows = ordered.filter((r) => r.section === s.id);
            if (!rows.length) return null;
            return (
              <div key={s.id} role="group" aria-label={t(s.label)}>
                <div className="nz-palette-sec" aria-hidden>
                  {s.id === 'recent' ? <IconClock size={12} stroke={2} /> : null}
                  {t(s.label)}
                </div>
                {rows.map((r) => {
                  index += 1;
                  const i = index;
                  return (
                    <div
                      key={r.id}
                      id={`nz-pi-${i}`}
                      role="option"
                      aria-selected={i === sel}
                      data-sel={i === sel}
                      className="nz-pit"
                      onMouseMove={() => i !== sel && setSel(i)}
                      onClick={() => choose(r)}
                    >
                      <span className="nz-pit-ic">
                        <r.icon size={17} stroke={1.7} aria-hidden />
                      </span>
                      <span className="nz-pit-text">
                        <b>{r.label}</b>
                        {r.sub ? <span>{r.sub}</span> : null}
                      </span>
                      {r.hint ? <kbd className="nz-kbd">{r.hint}</kbd> : null}
                      {i === sel ? <IconCornerDownLeft size={15} stroke={1.8} className="nz-pit-enter mirror-rtl" aria-hidden /> : null}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
      <div className="nz-palette-foot" aria-hidden>
        <span>
          <kbd className="nz-kbd">↑</kbd>
          <kbd className="nz-kbd">↓</kbd> {t('palette.move')}
        </span>
        <span>
          <kbd className="nz-kbd">{t('kbd.enter')}</kbd> {t('palette.go')}
        </span>
        <span>
          <kbd className="nz-kbd">{t('kbd.esc')}</kbd> {t('common.close')}
        </span>
      </div>
    </Modal>
  );
}

