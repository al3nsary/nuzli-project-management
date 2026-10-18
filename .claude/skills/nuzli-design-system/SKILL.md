---
name: nuzli-design-system
description: The visual identity of Nuzli (نُزلي) — white GanttPRO-clean surfaces with Nozoly indigo, the real Nozoly logo (Muhsen mark secondary), colour tokens, typefaces, the "vest band" signature, the shell (white left nav, rail, top bar, palette), navigation rules and component rules. Load before building or changing any screen, card template, chart or navigation in apps/web or packages/ui-print.
---

# هوية نُزلي البصرية

**Subject:** field operations and projects, built by **Nozoly (نُزلي)**: teams in coloured vests, monitors on site with a phone in the sun, Zebra plastic cards, and a project Gantt at the office.
**The screen's job:** let the user find the right person or task fast and know which team it belongs to at a glance.

**Owner request A9 (2026-10-19) — current identity:** «ليس بالضرورة أن تلتزم بهوية مُحسن، فقط هوية نزلي الزرقاء. اجعل النظام أبيض كما GanttPRO لتعبّر الألوان عن هويتها عند التصفح. فقط أضف لون نزلي الأزرق (أزرق نيلي).» So: **white, quiet chrome like GanttPRO; one brand colour, Nozoly indigo; team colours carry identity while browsing.** This replaces the A7 Muhsen-green shell (green gradient side, gold hairlines, gold mark tile) — none of that is used any more. Values live in `apps/web/src/theme/tokens.css`; the decision is in `docs/DECISIONS.md` (A9 identity ADR).

## Logos (`apps/web/public/brand/` — see its README)

Logos are the real files: never recoloured, stretched, redrawn or edited. They are **placed**, not modified.

| File | Where |
|---|---|
| `nozoly-green.png` | **The identity.** Sidebar head (124px visible width), login/auth card top (220px desktop, 164px phone), boot loader (132px), PWA icons |
| `nozoly-light.png` | Same places in **dark mode** (swapped by CSS `.nz-logo-day/.nz-logo-night`) |
| `muhsen-mark.png` | Secondary: «منظومة مُحسن» line in the sidebar foot and the auth footer, 18–20px wide; print cards default logo |
| `muhsen-mark-white.png` | The same line in dark mode |
| `muhsen-lockup-white.png`, `muhsen-pattern.png`, `muhsen-app-icon-*` | Kept as files; not used by the A9 UI |

`nozoly-*.png` are 540×156 with transparent margins: the artwork occupies x 14–415, y 44–141 and the mark alone x 14–169. `<NozolyLogo width mark? />` (`src/components/Brand.tsx`) shows the file inside a box sized to the artwork, so `width` is the **visible** width; `mark` shows the mark part only (the 68px rail, favicons). Accessible names: «شعار نُزلي», «شعار مُحسن». Brand text: «نُزلي — إدارة المشاريع والفرق الميدانية»; Latin spelling **Nozoly**.

## Colour (light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--primary` | `#303F9F` | `#3F51B5` | Filled buttons, the create button, active bar (white text ≥ 6.9:1) |
| `--primary-hover` | `#283593` | `#4A5CC4` | Hover |
| `--primary-press` | `#1A237E` | `#303F9F` | Pressed |
| `--tint` | `#E8EAF6` | `rgba(121,134,203,.16)` | Active nav item, light buttons, selected rows, empty-state icon tile |
| `--focus` | `#5C6BC0` | `#7986CB` | Focus ring `:focus-visible{outline:2px solid var(--focus);outline-offset:3px}` |
| `--accent` | `#303F9F` | `#7986CB` | Indigo as text/icons on surfaces |
| `--link` | `#303F9F` | `#9FA8DA` | Links |
| `--live` | `#2E7D32` | `#81C784` | Done, synced, online |
| `--amber` | `#A35C00` | `#FFB74D` | Waiting, pending sync, warnings — sparingly |
| `--red` | `#C62828` | `#EF6461` | Violations, destructive, errors, overdue |
| `--blue` | `#1565C0` | `#64B5F6` | Info |
| `--ink` | `#1F2430` | `#E7E9EE` | Text |
| `--dim` | `#5E6676` | `#A3A9B6` | Secondary text (5.8:1) |
| `--dim2` | `#6F7787` | `#8A91A0` | Tertiary text, crumbs (4.5:1) |
| `--void` | `#F7F8FA` | `#0F1115` | Page background |
| `--deep` | `#FFFFFF` | `#14171C` | Top bar |
| `--panel` | `#FFFFFF` | `#171A21` | Cards, tables, dialogs, side nav |
| `--panel2` | `#F5F6F9` | `#1D2129` | Zebra rows, quiet fills |
| `--hover` / `--nav-sheen` | `#F1F3F7` | `rgba(255,255,255,.05)` | Hover rows and nav items |
| `--line` | `#E6E8EC` | `#2A2F3A` | Borders, hairlines |
| `--line2` | `#D5D9E0` | `#383E4B` | Strong borders, input borders |

Status pills (background / text), light: live `#E7F4EA/#1B6E3A`, wait `#FFF3E0/#8A4B00`, no `#FDECEA/#B3261E`, blue `#E3F0FC/#0B57A4`, **brand** `#E8EAF6/#283593` (the old class `.pill.gold` maps to it), grey `#F1F3F6/#4A5262`. All ≥ 5.5:1. Dark: tinted 16 % backgrounds with light text (`tokens.css`).

Mantine: `field` (the primary colour name kept from phase 1) is the indigo ramp `#E8EAF6 … #303F9F (6) … #121858`; `primaryShade {light: 6, dark: 5}`. `ok/green`, `signal/yellow`, `breach/red`, `info/blue`, `slate/gray` are the status ramps; `gold` and `indigo` resolve to indigo. **Legacy aliases** keep every older screen correct: `--g/--g3/--g2` → primary/hover/press, `--gold/--gold3` → accent, `--gold2` → focus, `--field` → primary, `--ok/--signal/--breach` → live/amber/red, `--ground/--surface/--muted` → void/panel/dim. New code uses the semantic names.

Shadow (light): `--shadow: 0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.03)` — cards rely on a 1px `--line` border, not on shadow. `--lift: 0 4px 12px -2px rgba(16,24,40,.08), 0 16px 36px -10px rgba(16,24,40,.14)` for menus and popovers.
Radius: `--r:12px` (cards), `--r2:16px` (dialogs, auth card), `--r3:8px` (inputs, buttons, nav items), `--r4:6px` (chips). Spacing `4·8·12·16·24·32·48`.
Easing: `--e:cubic-bezier(.22,.7,.2,1)`, `--e3:cubic-bezier(.16,1,.3,1)`.

Rule: colour is for **state and team identity**, never decoration. Indigo is the one brand colour (primary action, active item, focus, links). A team colour always appears next to the team name. No gradients or gold hairlines in chrome.

## Type

- **UI and body:** `IBM Plex Sans Arabic` 400/500/600/700, self-hosted. Body 14px, line-height 1.75, `font-feature-settings:"tnum" 1`.
- **Display:** `Readex Pro`, used with restraint: page titles in the top bar (16.5px, −.3px), auth titles (24px), KPI numbers and card names.
- **Data:** `IBM Plex Mono` for national IDs, WBS, coordinates and timestamps, with tabular numbers.

## The signature: the vest band (شريط السترة)

Every team-bound object (team column, member chip, card print strip, Gantt assignee marker, chart legend) carries a **band** on its inline-start edge: 6px of the team colour, crossed by two 1.5px reflective lines at 30% white, like the reflective tape on a high-visibility vest. On the white A9 surfaces it is the colour the user sees while browsing; everything around it stays quiet.

## Shell (A9, GanttPRO-like)

- Grid: `[side | stage]`. Side is **256px** open and **68px** as a mini rail. Fold with the button in the side head or **Ctrl+B**; remembered per user in localStorage (try/catch).
- **Side:** white (`--nav-bg: #FFFFFF`; dark `#14171C`), a 1px `--line` border on its inline-end edge. No gradient, no pattern, no gold.
  - Head (60px, same as the top bar): the Nozoly logo (124px visible width; the mark only, 34px, on the rail) linking home, and the fold button.
  - **«+ إنشاء مشروع جديد»**: full-width indigo button (40px, radius 8) under the head, for users with `projects.create`; it opens the existing create dialog (`/projects?create=1`). On the rail: a square «+» with a tooltip.
  - Items in GanttPRO's order (see `docs/navigation.md`): الرئيسية · كل المشاريع · المحافظ · مهامي · سجل وقتي · التقارير · عبء العمل — مركز التواصل · المرفقات · الإشعارات — the field-ops groups — الإدارة. The first three groups are `quiet` (a hairline separator, no heading); the others get an 11.5px `--nav-faint` heading under the hairline. Supervisors: «مهامي» leads (`lead: ['SUPERVISOR']`) and they see no project management.
  - Item: padding 8px 12px, radius 8, min-height 38px, icon 18px, label 13.5px/500, text `#3D4452`. Hover background `#F1F3F7`. **Active** (`.on`, `aria-current="page"`): background `--tint #E8EAF6`, text and icon indigo `#303F9F`, label 600, and a **3px indigo bar on the inline-start edge** (`::before`, rounded on its inner side). No hover nudge.
  - Sub-items (kids): indented 18px, 34px tall, the same active style.
  - Count pills: red (act) or amber (waiting, e.g. unsynced violations). On the rail a red dot replaces the count; names in tooltips.
  - Foot: «منظومة مُحسن» with the small Muhsen mark (mark only on the rail).
- **Top bar** 60px: white (`--deep` at 92 % with a 12px blur) and a thin `--line` bottom border; a soft shadow once the page scrolls. Page title (h2) with the breadcrumb line (11px, `--dim2`); chips on the end side: sync status, notification bell, palette button (**Ctrl+K**), user menu.
- **Pages being built** (`soon: true` in the registry): a real route, permission guard and `ComingSoonPage` — the page title, an indigo icon tile, a «قيد الإنشاء» brand pill, «قيد الإنشاء — يصل في هذا الإصدار» and one line on what the page will do.
- **Mobile (<768px):** the side becomes a drawer from the inline-start (scrim, focus trap, Esc). Bottom tab bar: monitors «تسجيل مخالفة · مخالفاتي · بانتظار المزامنة · المزيد» (the first is the round indigo button); supervisors «مهامي · الرئيسية · فرقي · المزيد».

## Public pages (login, register, pending, forgot/reset/change password)

`AuthLayout`: a white page. The form card (max 440px, 560 for registration; 1px border, radius 16, padding 40) carries the **Nozoly logo at 220px** centred at its top, then the title (Readex 24px) and a sub-line (14px `--dim`). Login copy: «تسجيل الدخول إلى نُزلي» / «إدارة المشاريع والفرق الميدانية»; labels 13.5px/600; password show/hide; «نسيت كلمة المرور؟» under the password; full-width indigo «تسجيل الدخول». Demo quick logins are secondary **outline** buttons in a row under a «حسابات العرض التجريبية» separator. On desktop an indigo-tinted panel (no illustration) on the inline end: kicker «نُزلي», heading «كل ما يحتاجه فريقك في مكانٍ واحد», and three value lines with indigo icon tiles — «خطّط مشاريعك على مخطط جانت» · «تابع فرقك الميدانية» · «سجّل المخالفات حتى دون اتصال». Footer: «منظومة مُحسن» with the small Muhsen mark. Phones (360px): one column, the card flat on white, logo 164px.

## App icons

`apps/web/scripts/make-pwa-icons.mjs` (headless Chrome): `pwa-192/512` and `apple-touch-icon` are white with the full green Nozoly logo centred (78 % wide); `pwa-maskable-512` is indigo `#303F9F` full bleed with a white rounded tile (56 %, inside the safe circle) holding the logo; `favicon-32/64` show the mark part on a white rounded tile. Manifest `theme_color #303F9F`, `background_color #FFFFFF`.

## Navigation rules (professional details)

1. **One source of truth:** `src/app/nav.ts` holds `{ id, path, label, title?, icon, group, permission?, anyOf?, role?, lead?, soon?, gate?, badge?, end?, key?, children? }`. The sidebar, the mobile bar, breadcrumbs, the command palette, routes for `soon` pages and document titles all read it.
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

- Buttons: a verb that says what happens («اعتماد الطلب», «نقل العضو», «طباعة ٥ كروت»), never «إرسال» or «موافق». Primary is `--primary` with white text, 40px, radius 8, weight 600; pressed is `scale(.985)`. Secondary is outline (`variant="default"`), quiet is `light` (indigo tint).
- Cards: white, 1px `--line` border, radius 12, the whisper `--shadow`. KPI cards get a solid 3px top bar only when the number is a state (amber wait / red no).
- Empty states give one action; the icon sits on an indigo tint tile. Errors say what happened and how to fix it, with no apology.
- Tables: hover rows `--panel2`, 44px rows (48px on touch).
- Touch targets are at least 44×44px.
- Charts (ECharts): team series use team colours; everything else uses `--primary`, `--amber`, `--red`, `--live` and neutrals.
