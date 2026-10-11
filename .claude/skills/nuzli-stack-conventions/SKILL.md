---
name: nuzli-stack-conventions
description: Languages, frameworks and code conventions for the Nuzli monorepo — TypeScript strict, pnpm workspaces, NestJS module layout, Prisma + raw SQL migrations, zod shared schemas, testing tools, Docker. Load before writing code in any package.
---

# لغات ومعايير الكود في نزلي

## اللغات
| Where | Language |
|---|---|
| All apps and packages | **TypeScript 5, `strict: true`**, ESM in web/packages, CommonJS output for the Nest build |
| Database | **SQL (PostgreSQL 16)** in Prisma migrations, for partial unique indexes, CHECK constraints and triggers |
| Styling | CSS with custom properties (`tokens.css`) + Mantine; CSS Modules for component styles |
| Infra | Dockerfile, docker compose YAML, Nginx conf, POSIX sh for the backup cron |
| CI | GitHub Actions YAML |
| Docs | Markdown + Mermaid |

## المستودع
```
apps/web            React 18 + Vite + Mantine 7 (RTL)
apps/api            NestJS 10 + Prisma 5
packages/shared     @nuzli/shared      zod schemas, types, permissions, validators, i18n error codes
packages/scheduling @nuzli/scheduling  pure TS Gantt engine
packages/ui-print   @nuzli/ui-print    card templates (React, mm units)
seed/demo           demo data only (clearly marked; replaceable)
```

## Conventions
- Naming: DB snake_case (Prisma `@map`), TS camelCase, React components PascalCase, files kebab-case.
- API module layout: `x.module.ts`, `x.controller.ts`, `x.service.ts`, `x.service.spec.ts`. Controllers are thin: they validate (zod pipe), check permissions (guard) and call the service.
- Errors: throw `AppError(code, message_ar, details?)`; a global filter turns it into `{ code, message_ar, details }`.
- Pagination: `?page=1&pageSize=25&sort=field:asc&filter[x]=y` → `{ items, total, page, pageSize }`.
- IDs: UUID (`gen_random_uuid()`), plus a `client_uuid` for offline-created rows.
- Dates on the wire: ISO 8601 UTC for instants; `YYYY-MM-DD` for calendar dates (tasks).
- Tests: Vitest in packages and web; Jest (Nest default) in api; Playwright in `e2e/`.
- Formatting: Prettier (printWidth 100, singleQuote). Lint: ESLint flat config.
- Commits: Conventional Commits (`feat(teams): …`).
