---
name: nuzli-design-system
description: The visual identity of Nuzli (نُزلي) — the approved Figma design: white surfaces with Nozoly violet #5030E5 as the one brand colour, the recoloured Nozoly logo (no other brand), colour tokens, typefaces, the "vest band" signature, the shell (white side with projects list, top bar with search, palette), the project page and Kanban board, navigation rules and component rules. Load before building or changing any screen, card template, chart or navigation in apps/web or packages/ui-print.
---

# هوية نُزلي البصرية

**Subject:** field operations and projects, built by **Nozoly (نُزلي)**: teams in coloured vests, monitors on site with a phone in the sun, Zebra plastic cards, and a project Gantt at the office.
**The screen's job:** let the user find the right person or task fast and know which team it belongs to at a glance.

**Owner request A11 (2026-10-19) — current identity, approved:** «اعجبني التصميم اعتمده كرئيسي». The Figma «Project Management Dashboard» (file `AYHpU1YNalsf0TNeYOMKDf`, node `2:163`) is **the** design: **white surfaces, one brand colour, Nozoly violet `#5030E5`; team colours carry identity while browsing.** The system is Nozoly-only: nothing of Muhsen remains. This supersedes the A9 indigo identity and the A7 green one. Values live in `apps/web/src/theme/tokens.css`; the decision is ADR-141 in `docs/DECISIONS.md`. There is no design switch (it existed only during review).

## Logos (`apps/web/public/brand/` — see its README)

The logo is the owner's Nozoly artwork **recoloured once** to `#5030E5` (alpha kept). Never redraw, stretch or edit it; it is **placed**.

| File | Where |
|---|---|
| `nozoly.png` | **The identity.** Sidebar head (124px visible width), login/auth card top (220px desktop, 164px phone), boot loader (132px), PWA icons, print-card default logo |
| `nozoly-light.png` | Same places in **dark mode** (swapped by CSS `.nz-logo-day/.nz-logo-night`) |

Both are 540×156 with transparent margins: the artwork occupies x 14–415, y 44–141 and the mark alone x 14–169. `<NozolyLogo width mark? />` (`src/components/Brand.tsx`) shows the file inside a box sized to the artwork, so `width` is the **visible** width; `mark` shows the mark part only (the folded rail, favicons). Accessible name: «شعار نُزلي». Brand text: «نُزلي — إدارة المشاريع والفرق الميدانية»; Latin spelling **Nozoly**.

## Colour (light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--primary` | `#5030E5` | `#6A4FF0` | Filled buttons, the create button, open view tab (white text ≥ 4.5:1) |
| `--primary-hover` | `#4426CC` | `#7A62F3` | Hover |
| `--primary-press` | `#371DA8` | `#5030E5` | Pressed |
| `--tint` | `#F0EDFD` | `rgba(150,128,255,.16)` | Active nav item, light buttons, selected rows, empty-state icon tile |
| `--tint2` | `#D9D1FA` | `rgba(150,128,255,.3)` | Stronger tint, borders on tinted areas |
| `--focus` | `#7B61F0` | `#9D88FF` | Focus ring `:focus-visible{outline:2px solid var(--focus);outline-offset:3px}` |
| `--accent` | `#5030E5` | `#A592FF` | Violet as text/icons on surfaces |
| `--link` | `var(--accent)` | `#B8A9FF` | Links |
| `--live` | `#2F7D32` | `#81C784` | Done, synced, online |
| `--amber` | `#A35C00` | `#FFB74D` | Waiting, pending sync, warnings — sparingly |
| `--red` | `#C62828` | `#EF6461` | Violations, destructive, errors, overdue |
| `--blue` | `#1565C0` | `#64B5F6` | Info |
| `--ink` | `#0D062D` | `#E7E9EE` | Text |
| `--dim` | `#6A667A` | `#A3A9B6` | Secondary text |
| `--dim2` | `#787486` | `#8A91A0` | Tertiary text, crumbs |
| `--void` / `--deep` / `--panel` | `#FFFFFF` | `#0F1115` / `#14171C` / `#171A21` | Page / top bar / cards, tables, dialogs, side nav |
| `--panel2` | `#F5F5F5` | `#1D2129` | Search field, board columns, zebra rows, quiet fills |
| `--hover` / `--nav-sheen` | `#F6F5F9` | `#1F232C` / `rgba(255,255,255,.05)` | Hover rows and nav items |
| `--line` | `#EBEAF0` | `#2A2F3A` | Borders, hairlines |
| `--line2` | `#D9D7E1` | `#383E4B` | Strong borders, input borders |

Status pills (background / text), light: live `#E8F4EC/#2B7A3D`, wait `#FBEEDF/#A3601A`, no `#FBE9EB/#B9404F`, blue `#E3F0FC/#0B57A4`, **brand** `#F0EDFD/#4426CC` (the old class `.pill.gold` maps to it), grey `#F1F0F5/#55516A`. Dark: tinted 16–18 % backgrounds with light text (`tokens.css`).

Mantine: `field` (the primary colour name kept from phase 1) is the violet ramp, with `--primary` as the main shade; `ok/green`, `signal/yellow`, `breach/red`, `info/blue`, `slate/gray` are the status ramps. **Legacy aliases** keep every older screen correct: `--g/--g3/--g2` → primary/hover/press, `--gold/--gold3` → accent, `--gold2` → focus, `--field` → primary, `--ok/--signal/--breach` → live/amber/red, `--ground/--surface/--muted` → void/panel/dim. New code uses the semantic names.

Shadow: `--shadow: 0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.03)` — cards rely on a 1px `--line` border, not on shadow. `--lift: 0 4px 12px -2px rgba(16,24,40,.08), 0 16px 36px -10px rgba(16,24,40,.14)` for menus and popovers.
Radius: `--r:16px` (cards), `--r2:20px` (dialogs, auth card), `--r3:6px` (inputs, buttons), `--r4:4px` (chips, priority tags). Spacing `4·8·12·16·24·32·48`. Layout: side 250px (`--side-w`), rail 68px, top bar 80px (`--top-h`), page padding 32/48, h1 32px.
Easing: `--e:cubic-bezier(.22,.7,.2,1)`, `--e3:cubic-bezier(.16,1,.3,1)`.

Rule: colour is for **state and team identity**, never decoration. Violet is the one brand colour (primary action, active item, focus, links). A team colour always appears next to the team name. No gradients or gold hairlines in chrome.

## Type

- **UI and body:** `IBM Plex Sans Arabic` 400/500/600/700, self-hosted (replaces the Figma file's Inter: Arabic-first). Body 14px, line-height 1.75, `font-feature-settings:"tnum" 1`.
- **Display:** `Readex Pro`, used with restraint: auth titles (24px), KPI numbers and card names.
- **Data:** `IBM Plex Mono` for national IDs, WBS, coordinates and timestamps, with tabular numbers.

## The signature: the vest band (شريط السترة)

Every team-bound object (team column, member chip, card print strip, Gantt assignee marker, chart legend, the assignee avatar on a board card) carries a **band** on its inline-start edge: 6px of the team colour, crossed by two 1.5px reflective lines at 30% white, like the reflective tape on a high-visibility vest. On the white surfaces it is the colour the user sees while browsing; everything around it stays quiet.

## Shell (Figma node 2:163)

- Grid: `[side | stage]`. Side is **250px** open and **68px** as a mini rail. Fold with the button in the side head or **Ctrl+B**; remembered per user in localStorage (try/catch).
- **Side:** white (`--nav-bg`; dark `#14171C`), a 1px `--line` border on its inline-end edge. No gradient, no pattern.
  - Head: the Nozoly logo (124px visible width; the mark only, 34px, on the rail) linking home, and the fold button, over a hairline.
  - **«+ إنشاء مشروع جديد»**: full-width violet button under the head, for users with `projects.create`; it opens the existing create dialog (`/projects?create=1`). On the rail: a square «+» with a tooltip.
  - Items in the order of `docs/navigation.md`; the first three groups are `quiet` (a hairline separator, no heading), the others get a small `--nav-faint` heading. Supervisors: «مهامي» leads (`lead: ['SUPERVISOR']`) and they see no project management.
  - Item: **44px tall, 22px icons**, radius 6. Hover `--nav-sheen`. **Active** (`.on`, `aria-current="page"`): background `--tint`, violet text and icon, label 600, **no bar**. Sub-items (kids): indented, the same active style.
  - Count pills: red (act) or amber (waiting). On the rail a red dot replaces the count; names in tooltips.
  - **«مشاريعي»** list: one row per project with a colour dot (4 design colours, picked by project id).
  - **Foot:** the «وقت الأفكار» card, linking to `/hub`; hidden on the rail and when the window is shorter than 760px. No brand line.
- **Top bar** 80px: white with a thin `--line` bottom border. On the inline start a grey `--panel2` 44px **search field** that opens the command palette (**Ctrl+K**); then the sync chip, shortcuts help, the bell, and the user block (name + role + chevron). The top-bar h2 is `sr-only` (the page's own h1 is the visible title).
- **Breadcrumbs / Back:** below top-level pages, in a quiet strip under the bar. Not shown on top-level pages.
- **Pages being built** (`soon: true` in the registry): a real route, permission guard and `ComingSoonPage` — the page title, a violet icon tile, a «قيد الإنشاء» brand pill and one line on what the page will do.
- **Mobile (<768px, A12 «كالسيف», `docs/mobile.md`):** the side becomes a drawer from the inline-start (scrim, focus trap, Esc) and a light 56px top bar. A **5-tab bottom bar** (68px above the safe area; icon + label, the active tab filled violet in a light pill; badges red for work, amber for sync), per role (`tabsFor()` in `app/shell/tabs.ts`): owner/admin «الرئيسية · المشاريع · التواصل · الفرق · المزيد»; supervisor «الرئيسية · مهامي · التواصل · فريقي · المزيد»; monitor «الرئيسية · مخالفاتي · **تسجيل مخالفة** (raised round violet button in the middle) · بانتظار المزامنة · المزيد»; assistant and participant «الرئيسية» + the first three destinations their rights open (projects, my tasks, hub, teams, members, violations, cards, users, requests, notifications) + «المزيد». A tab the user lacks is not drawn; the next one takes its place, and «المزيد» (`/more`, a page, not a drawer) carries the sum of the hidden badges. Tablets 768–1023 keep the bottom bar (centred, limited width); 1024–1279 open the side collapsed (68px rail).

## Project page and Kanban board

- **Header:** a big title (h1 32px) with a tinted pencil chip (edit); the member stack with team-colour dots and «+N»; **view tabs as outlined pills** (the open one violet).
- **Board** (`pages/projects/BoardView.tsx`): a grey (`--panel2`) column per status — dot + title + count pill + a **3px state line** (NOT_STARTED violet, IN_PROGRESS `#FFA500`, ON_HOLD `#76A5EA`, DONE `#7AC555`).
- **Card:** white, radius 16. A 4px-radius **priority tag** (LOW orange, MEDIUM violet, HIGH red, URGENT solid red, DONE green «مكتملة»; text colours slightly darkened for contrast), title, description, due date, the assignee avatar with its **vest band** and team name, the chat count and the attachment count. While dragging the card tilts **3°** (the tilt is multiplied by the direction sign in RTL).

## Public pages (login, register, pending, forgot/reset/change password)

`AuthLayout`: a white page. The form card (max 440px, 560 for registration; 1px border, radius 16, padding 40) carries the **Nozoly logo at 220px** centred at its top, then the title (Readex 24px) and a sub-line (14px `--dim`). Login copy: «تسجيل الدخول إلى نُزلي» / «إدارة المشاريع والفرق الميدانية»; labels 13.5px/600; password show/hide; «نسيت كلمة المرور؟» under the password; full-width violet «تسجيل الدخول». Demo quick logins are secondary **outline** buttons in a row under a «حسابات العرض التجريبية» separator. On desktop a **value panel in violet tints** (no illustration) on the inline end: kicker «نُزلي», heading «كل ما يحتاجه فريقك في مكانٍ واحد», and three value lines with violet icon tiles — «خطّط مشاريعك على مخطط جانت» · «تابع فرقك الميدانية» · «سجّل المخالفات حتى دون اتصال». **No footer brand line.** Phones (360px): one column, the card flat on white, logo 164px.

## App icons

`apps/web/scripts/make-pwa-icons.mjs` (headless Chrome): `pwa-192/512` and `apple-touch-icon` are white with the violet Nozoly logo centred; `pwa-maskable-512` is violet `#5030E5` full bleed with a white rounded tile (inside the safe circle) holding the logo; `favicon-32/64` show the mark part on a white rounded tile. Manifest `theme_color #5030E5`, `background_color #FFFFFF`.

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

- Buttons: a verb that says what happens («اعتماد الطلب», «نقل العضو», «طباعة ٥ كروت»), never «إرسال» or «موافق». Primary is `--primary` with white text, 40px, radius 6, weight 600; pressed is `scale(.985)`. Secondary is outline (`variant="default"`), quiet is `light` (violet tint).
- Cards: white, 1px `--line` border, radius 16, the whisper `--shadow`. KPI cards get a solid 3px top bar only when the number is a state (amber wait / red no).
- Empty states give one action; the icon sits on a violet tint tile. Errors say what happened and how to fix it, with no apology.
- Tables: hover rows `--panel2`, 44px rows (48px on touch).
- Touch targets are at least 44×44px.
- Charts (ECharts): team series use team colours; everything else uses `--primary`, `--amber`, `--red`, `--live` and neutrals.
