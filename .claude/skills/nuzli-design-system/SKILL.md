---
name: nuzli-design-system
description: The visual identity of Nuzli (نُزلي) — real Nozoly and Muhsen logos, Muhsen-aligned colour tokens, typefaces, the "vest band" signature, the Muhsen-Control shell (sidebar, rail, top bar, palette), navigation rules and component rules. Load before building or changing any screen, card template, chart or navigation in apps/web or packages/ui-print.
---

# هوية نُزلي البصرية

**Subject:** field operations within the **Muhsen (مُحسن)** hospitality system, built by **Nozoly (نُزلي)**: teams in coloured vests, monitors on site with a phone in the sun, Zebra plastic cards, and a project Gantt at the office.
**The screen's job:** let the user find the right person or task fast and know which team it belongs to at a glance.

Owner request A7 (2026-10-12): use the real Muhsen and Nozoly logos and make every detail of navigation professional. The reference implementation is the owner's own **Muhsen Control** (`Desktop/Muhsen-Control/app/01-style.html`, `04-shell.js`, `07-router.js`) for the desktop shell and the **Muhsen app** (`Desktop/Muhesn-App/app/01-style.html`) for mobile. **Read those files and copy literal values. Never approximate them, and never write into those folders.**

## Logos (`apps/web/public/brand/` — see its README)

| File | Where |
|---|---|
| `muhsen-mark-white.png` | Sidebar head: inside the 42×42 mark tile (radius 13, gold gradient `linear-gradient(150deg,#E7D1A2,#A8875A)`), 23×23 |
| `muhsen-lockup-white.png` | Login hero on the green panel, 168px wide |
| `nozoly-light.png` | Sidebar foot «تطوير نُزلي» on green, 96×26 |
| `nozoly-green.png` | Login footer and light surfaces, 96×26; about dialog |
| `muhsen-mark.png` | Light-surface contexts: print cards default logo, empty states (small, quiet) |
| `muhsen-pattern.png` | The green login panel and the sidebar bottom, opacity ≤ .06 |

Brand text: «نُزلي — إدارة المشاريع والفرق الميدانية», sub-line «منظومة مُحسن». Latin spelling: **Nozoly** / **Muhsen**. The logos are never recoloured, stretched, cropped or redrawn. Their accessible names are «شعار مُحسن» and «شعار نُزلي».

## Colour (literal from Muhsen Control — light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--g` | `#14593F` | `#14593F` | Primary: buttons, links, focus |
| `--g2` | `#0C3A29` | `#0C3A29` | Pressed, deep accents |
| `--g3` | `#1D7452` | `#1D7452` | Hover |
| `--live` | `#0B8A4B` | `#14C273` | Synced, done, online |
| `--gold` | `#A8875A` | `#A8875A` | Brand accent (thin lines, active ring, mark tile) |
| `--gold2` | `#B4935F` | `#C6A86F` | Focus ring (`:focus-visible{outline:2px solid var(--gold2); outline-offset:3px}`) |
| `--gold3` | `#8A6C3C` | `#E7D1A2` | Gold text on light / dark |
| `--amber` | `#B8791A` | `#E5A62F` | Pending, waiting for sync, warnings — sparingly |
| `--red` | `#C0392B` | `#EC4F54` | Violations, destructive, errors |
| `--blue` | `#1B6E9C` | `#3FA3DC` | Info |
| `--ink` | `#0D1A13` | `#EDF5F0` | Text |
| `--dim` | `#4C635A` | `#9FB6A9` | Secondary text |
| `--dim2` | `#7A8F84` | `#6B857A` | Tertiary text, crumbs |
| `--void` | `#EDF4EF` | `#060C09` | Page background |
| `--deep` | `#F7FBF8` | `#0A140F` | Top bar base |
| `--panel` | `#FFFFFF` | `#0F1C16` | Cards, tables, dialogs |
| `--panel2` | `#F2F9F4` | `#14261F` | Zebra/hover rows, inputs |
| `--line` | `#DDE9E1` | `#1C3128` | Borders |
| `--line2` | `#C6DACE` | `#27473A` | Strong borders |

Status pills (background / text), light: live `#E4F2E9/#0B6540`, wait `#FBF1DE/#7F5310`, no `#FBE9E7/#93261C`, blue `#E7EEF6/#2A4A73`, gold `#F5EDDF/#6E5729`, grey `#EFF1ED/#5A6C63`. Dark: copy `--p*B/--p*T` from Muhsen Control lines 42–47.

Shadow (light): `0 1px 2px rgba(11,53,39,.05), 0 4px 10px -4px rgba(11,53,39,.07), 0 18px 34px -22px rgba(11,53,39,.3)`. Lift: `0 2px 6px rgba(11,53,39,.07), 0 18px 34px -14px rgba(11,53,39,.22)`.
Radius: `--r:16px` (cards), `--r2:22px` (dialogs), `--r3:12px` (inputs, buttons), `--r4:9px` (chips). Spacing `4·8·12·16·24·32·48`.
Easing: `--e:cubic-bezier(.22,.7,.2,1)`, `--e2:cubic-bezier(.34,1.4,.44,1)` (playful, mark only), `--e3:cubic-bezier(.16,1,.3,1)`.

Rule: colour is for **state and team identity**, never decoration. A team colour always appears next to the team name.

## Type

- **UI and body:** `IBM Plex Sans Arabic` 400/500/600/700, self-hosted. This is the same as Muhsen Control. Body 14px, line-height 1.75, `font-feature-settings:"tnum" 1`.
- **Display:** `Readex Pro`, used with restraint: page titles in the top bar (16.5px, letter-spacing −.3px), KPI numbers and card names.
- **Data:** `IBM Plex Mono` for national IDs, WBS, coordinates and timestamps, with tabular numbers.

## The signature: the vest band (شريط السترة)

Every team-bound object (team column, member chip, card print strip, Gantt assignee marker, chart legend) carries a **band** on its inline-start edge: 6px of the team colour, crossed by two 1.5px reflective lines at 30% white, like the reflective tape on a high-visibility vest. It is the one bold element; everything around it stays quiet.

## Shell (port of Muhsen Control)

- Grid: `[side | stage]`. Side is 276px open and 74px as a **mini rail**. Fold with the button in the side head or **Ctrl+B**, and remember the state per user in localStorage, wrapped in try/catch.
- **Side** (light): background `linear-gradient(168deg,#1A6B4C 0%,#12513A 52%,#0D3E2C 100%)`. Ink `#F4FAF6`, dim `rgba(244,250,246,.82)`, dim2 `.62`, faint `.44`. Line `rgba(255,255,255,.11)`. A 1px gold hairline on the inline-end edge: `linear-gradient(180deg,transparent,var(--gold2),transparent)` at opacity .55. In dark mode use `linear-gradient(180deg,var(--deep),var(--void))`.
  - Head: the mark tile, then the brand text (b 14px / span 10.5px), then the fold button.
  - Groups: an uppercase-free label of 10.5px plus a fading line. Group by role: «الرئيسية» · «المشاريع» · «الفرق والكروت» · «المخالفات» · «الإدارة».
  - Item: padding 10px 11px, radius 13, icon 18px, label 13px/700, count pill. **Active** (`.on`) uses background `linear-gradient(90deg,rgba(255,255,255,.18),rgba(255,255,255,.03))` and an inset ring `rgba(231,209,162,.55)`, with `aria-current="page"`. Hover nudges the item 2px *toward the reading direction*: physical `translateX` × `dirSign()`, because RTL does not flip it.
  - Sub-items (kids): indented with a 2px gold-fading spine.
  - Foot: the Nozoly logo with «تطوير نُزلي».
  - On the mini rail, a red dot replaces the count, and a tooltip shows the label.
- **Top bar** 66px: `color-mix(in srgb,var(--deep) 78%,transparent)` with a 16px backdrop blur and a bottom line. It gets a deeper shadow once the page scrolls. It holds the page title (h2) and a breadcrumb line under or next to it (11px, `--dim2`), with chips on the end side: offline/sync status, the notification bell with its count, the command palette button (**Ctrl+K**) and the user menu. Titles slide in at 10px over .4s with `--e`, with the direction sign applied.
- **Mobile (<768px):** the side becomes a drawer from the inline-start, with a scrim of `rgba(16,25,20,.42)` and a focus trap; Esc closes it. Monitors get the Muhsen-app **bottom tab bar**: «تسجيل مخالفة · مخالفاتي · بانتظار المزامنة» plus «المزيد». Its shadow is `0 -1px 0 rgba(20,89,63,.07), 0 -16px 34px -26px rgba(11,53,39,.55)`, and it respects `env(safe-area-inset-bottom)`. Supervisors get «الرئيسية · مهامي · فرقي · المزيد».

## Navigation rules (professional details)

1. **One source of truth:** `src/app/nav.ts` holds `{ id, path, label, icon, group, permission, badge?, children? }`. The sidebar, the mobile bar, breadcrumbs, the command palette and document titles all read it.
2. **Active state** matches the deepest route, so a group stays active on its child pages and a parent with children expands automatically.
3. **Breadcrumbs** on every page below the top level, with entity names resolved from data (for example «الفرق › فريق الصقور › السجل»). They are not shown on top-level pages.
4. **Document title** is `«{الصفحة} · نُزلي»`.
5. **Back:** detail pages have a back button (mirrored arrow) that goes to the parent route, not `history.back()`, when there is no in-app history. Browser back and forward must work everywhere, including the formation board, wizards and drawers. A drawer or tab gets a URL (`?tab=…`, `/teams/:id/history`) so it is deep-linkable and closes on back.
6. **Scroll and focus:** a new page scrolls to the top, and focus moves to the page `h1` for screen readers. Back restores the previous scroll position. Skip link «تخطَّ إلى المحتوى».
7. **Command palette (Ctrl+K):** search pages (from the nav registry, filtered by permission), actions («تسجيل مخالفة», «إنشاء فريق», «مشروع جديد»), and recent items. Arrow keys and Enter work, and the result shows the shortcut hints.
8. **Shortcuts:** Ctrl+K palette, Ctrl+B fold the side, `g` then `p`/`t`/`v` to go to projects/teams/violations, `?` for the shortcut sheet. Shortcuts are disabled while typing in inputs.
9. **States:** every list has a skeleton loader that matches its layout (no spinner-only pages), an empty state with one action, an error state that says what happened plus «أعد المحاولة», and an offline banner when there is no network.
10. **Transitions:** page content fades and slides 8px over 180ms with `--e`. Nothing moves when `prefers-reduced-motion` is set.
11. **Badges:** pending registrations, pending teams, unsynced violations and overdue tasks appear as count pills on their nav items, and as the red dot on the rail.
12. **Permissions:** items the user can't use are not rendered (never disabled-and-visible). Typing a forbidden URL shows the «لا تملك صلاحية» page with a way back.

## Components

- Buttons: a verb that says what happens («اعتماد الطلب», «نقل العضو», «طباعة ٥ كروت»), never «إرسال» or «موافق». Primary is `--g` with white text; pressed is `scale(.985)`.
- Empty states give one action. Errors say what happened and how to fix it, with no apology.
- Tables: hover rows `--panel2`, 44px rows (48px on touch).
- Touch targets are at least 44×44px.
- Charts (ECharts): team series use team colours; everything else uses `--g`, `--gold`, `--amber`, `--red` and neutrals.
