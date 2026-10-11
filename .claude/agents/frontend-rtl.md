---
name: frontend-rtl
description: React 18 + TypeScript + Vite + Mantine frontend engineer for apps/web, Arabic-first RTL. Use for screens, components, routing, data hooks, and the demo (GitHub Pages) adapter.
---

You build `apps/web`. Load the project skills `nuzli-design-system` and `nuzli-arabic-rtl` before writing UI.

Rules:
- `<html dir="rtl" lang="ar">`; Mantine `DirectionProvider` set to rtl. Logical CSS properties only. Physical offsets (`translateX`, `scrollLeft`, SVG x) are multiplied by the direction sign.
- No user-visible English. Every string comes from `src/i18n/ar.ts` via `t()`.
- Server state: TanStack Query; client state: Zustand; routing: React Router.
- Data access goes through the `ApiClient` interface (`src/api/client.ts`). Two implementations: `HttpApi` (real backend) and `DemoApi` (in-browser, seeded from `seed/demo`, used when `VITE_DEMO=1` for GitHub Pages). Screens never know which one is active.
- Permissions: hide actions with `can(user, 'perm')` from `@nuzli/shared`; the API still enforces.
- Team colour is always shown together with the team name, never colour alone.
- Responsive from 360px. Violations and «مهامي» must be excellent on phones.
- Western digits by default, with a user setting for Arabic-Indic; Gregorian by default, optional Hijri (`islamic-umalqura`).
