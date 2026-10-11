---
name: nuzli-design-system
description: The visual identity of Nuzli (نزلي) — colour tokens, typefaces, the "vest band" signature, layout, spacing and component rules. Load before building or changing any screen, card template or chart in apps/web or packages/ui-print.
---

# هوية نزلي البصرية

**Subject:** field operations in Saudi Arabia: teams in coloured vests, monitors walking sites with a phone in the sun, Zebra plastic cards, and a project Gantt at the office.
**The screen's job:** let the user find the right person or task fast and know which team it belongs to at a glance.

The values below are the source of truth (`apps/web/src/theme/tokens.css`). Copy them; don't approximate them.

## Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--ink` | `#14232B` | `#E6ECEE` | Text, the sidebar background in light mode |
| `--ground` | `#EEF1F1` | `#0E171C` | Page background (cool concrete, **not** cream) |
| `--surface` | `#FFFFFF` | `#16232A` | Cards, tables, dialogs |
| `--line` | `#D3DBDC` | `#2A3A42` | Borders, grid lines |
| `--field` | `#1D5C63` | `#5FB3B8` | Primary actions, links, focus ring |
| `--signal` | `#E8A317` | `#F2B84B` | Pending, waiting for sync, warnings. **Use sparingly.** |
| `--breach` | `#B42318` | `#F06A5E` | Violations, destructive actions, errors |
| `--ok` | `#2E7D4F` | `#5CC48A` | Synced, approved, done |
| `--muted` | `#5B6B72` | `#93A4AB` | Secondary text |

Rule: colour is for **state and team identity**, never decoration. A team colour always appears next to the team name.

## Type

- **Display:** `Readex Pro` 600/700, self-hosted (`@fontsource-variable/readex-pro`). Only for page titles, KPI numbers and card names. Never for body text.
- **Body / UI:** `IBM Plex Sans Arabic` 400/500/600/700, self-hosted (`@fontsource/ibm-plex-sans-arabic`).
- **Data:** `IBM Plex Mono` 400/500 for national IDs, WBS numbers, coordinates and timestamps, with `font-variant-numeric: tabular-nums`.
- Scale (rem): 0.75 · 0.875 · 1 · 1.125 · 1.375 · 1.75 · 2.25. Body line-height 1.7 (Arabic needs room); headings 1.3.

## The signature: the vest band (شريط السترة)

Every team-bound object (team column, member chip, card print strip, Gantt assignee marker, chart legend) carries a **band** on its inline-start edge: 6px of the team colour, crossed by two 1.5px reflective lines at 30% white, like the reflective tape on a high-visibility vest.

```css
.vest { border-inline-start: 0; position: relative; padding-inline-start: 14px; }
.vest::before {
  content: ""; position: absolute; inset-block: 0; inset-inline-start: 0; width: 6px;
  background:
    linear-gradient(to bottom, transparent 30%, rgb(255 255 255 / .3) 30% 34%, transparent 34% 62%,
                    rgb(255 255 255 / .3) 62% 66%, transparent 66%),
    var(--team);
  border-start-start-radius: inherit; border-end-start-radius: inherit;
}
```

This is the one bold element. Everything around it stays quiet: no gradients, no glows, no decorative illustrations.

## Layout

- Desktop: an `--ink` sidebar on the inline-start (it renders on the right in RTL), 248px wide, and content on `--ground` with a 1200px max width for forms and full width for Gantt, boards and tables.
- Mobile (<768px): the sidebar becomes a drawer. A monitor gets a **bottom bar** with three actions: تسجيل مخالفة · مخالفاتي · بانتظار المزامنة (with a count badge).
- Spacing scale: 4 · 8 · 12 · 16 · 24 · 32 · 48. Radius: 10px on cards, 8px on inputs, 999px on chips.
- Shadows: one level only, `0 1px 2px rgb(20 35 43 / .06), 0 4px 12px rgb(20 35 43 / .05)`.

## Components

- Buttons: a verb that says what happens («اعتماد الطلب», «نقل العضو», «طباعة ٥ كروت»), never «إرسال» or «موافق».
- Empty states give one action. Errors say what happened and how to fix it, with no apology.
- Tables: zebra rows off, hover on, 44px rows (48px on touch).
- Touch targets are at least 44×44px. Focus ring: 2px `--field` + 2px offset.
- Motion: 150ms ease-out for state changes; drag and drop uses dnd-kit defaults. Respect `prefers-reduced-motion`.
- Charts (ECharts): team series use the team colours; everything else uses `--field`, `--signal` and `--breach` plus neutrals.
