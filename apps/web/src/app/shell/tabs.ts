import {
  IconCamera,
  IconCategory,
  IconCategoryFilled,
  IconChecklist,
  IconClipboardList,
  IconClipboardListFilled,
  IconCloudUpload,
  IconFolders,
  IconFoldersFilled,
  IconHome,
  IconHomeFilled,
  IconMessages,
  IconMessagesFilled,
  IconUsersGroup,
  type Icon,
} from '@tabler/icons-react';
import type { Role } from '@nuzli/shared';
import type { MessageKey } from '../../i18n';
import { navLeaves, type NavNode } from '../nav';

/*
 * A12 — the five-tab bottom bar of phones and portrait tablets (PROMPT §18 «Mobile & tablet»):
 *
 *   مدير النظام / المالك   الرئيسية · المشاريع · التواصل · الفرق · المزيد
 *   المشرف                الرئيسية · مهامي · التواصل · فريقي · المزيد
 *   مشرف المراقبة          الرئيسية · مخالفاتي · [تسجيل مخالفة] · بانتظار المزامنة · المزيد
 *   مساعد / عضو مشارك      الرئيسية + أول ثلاث وجهات تفتحها صلاحياته + المزيد
 *
 * Tabs are registry leaves (navigation rule 1): a tab the user may not open is never drawn, and its
 * place goes to the next destination they can open. «المزيد» lists everything else.
 */

export interface TabSpec {
  /** Registry id. */
  id: string;
  node: NavNode;
  label: MessageKey;
  icon: Icon;
  /** The filled glyph of the active tab, when the icon set has one (otherwise a tinted capsule). */
  iconOn?: Icon;
  /** The raised centre button (the monitor's «تسجيل مخالفة»). */
  primary?: boolean;
}

type Want = { id: string; label?: MessageKey; primary?: boolean };

const BARS: Partial<Record<Role, Want[]>> = {
  ADMIN: [{ id: 'dashboard' }, { id: 'projects', label: 'nav.projects' }, { id: 'communication', label: 'mobile.tab.chat' }, { id: 'teams', label: 'nav.teams' }],
  SUPERVISOR: [{ id: 'dashboard' }, { id: 'myTasks' }, { id: 'communication', label: 'mobile.tab.chat' }, { id: 'teams', label: 'mobile.tab.myTeam' }],
  MONITOR: [{ id: 'dashboard' }, { id: 'myViolations' }, { id: 'recordViolation', label: 'mobile.tab.record', primary: true }, { id: 'pendingSync', label: 'mobile.tab.pending' }],
};

/** Where an assistant, a participant — or a role missing one of its tabs — goes next, in order. */
const FALLBACK: Want[] = [
  { id: 'projects', label: 'nav.projects' },
  { id: 'myTasks' },
  { id: 'communication', label: 'mobile.tab.chat' },
  { id: 'teams', label: 'nav.teams' },
  { id: 'members' },
  { id: 'violations', label: 'nav.violations' },
  { id: 'myViolations' },
  { id: 'cards', label: 'nav.cards' },
  { id: 'users' },
  { id: 'registrations' },
  { id: 'notifications' },
];

const GLYPHS: Record<string, { icon: Icon; iconOn?: Icon }> = {
  dashboard: { icon: IconHome, iconOn: IconHomeFilled },
  projects: { icon: IconFolders, iconOn: IconFoldersFilled },
  communication: { icon: IconMessages, iconOn: IconMessagesFilled },
  teams: { icon: IconUsersGroup },
  myTasks: { icon: IconChecklist },
  myViolations: { icon: IconClipboardList, iconOn: IconClipboardListFilled },
  pendingSync: { icon: IconCloudUpload },
  recordViolation: { icon: IconCamera },
};

export const MORE_ICON = { icon: IconCategory, iconOn: IconCategoryFilled };

/** The four destination tabs of this user (the fifth, «المزيد», is always added by the bar). */
export function tabsFor(role: Role | null, tree: NavNode[]): TabSpec[] {
  const leaves = navLeaves(tree);
  const byId = new Map(leaves.map((l) => [l.id, l]));
  const out: TabSpec[] = [];
  const add = (w: Want) => {
    const node = byId.get(w.id);
    if (!node || out.some((x) => x.id === w.id) || out.length >= 4) return;
    const g = GLYPHS[w.id] ?? { icon: node.icon };
    out.push({ id: w.id, node, label: w.label ?? node.label, icon: g.icon, iconOn: g.iconOn, primary: w.primary });
  };
  add({ id: 'dashboard' });
  for (const w of (role && BARS[role]) || []) add(w);
  for (const w of FALLBACK) add(w);
  // The monitor's raised button sits in the middle of the five.
  const primary = out.findIndex((x) => x.primary);
  if (primary >= 0 && primary !== 2 && out.length === 4) {
    const [p] = out.splice(primary, 1);
    out.splice(2, 0, p!);
  }
  return out;
}

/** The registry ids the bar already shows (so «المزيد» does not repeat them). */
export function tabIds(tabs: TabSpec[]): Set<string> {
  return new Set(tabs.map((x) => x.id));
}
