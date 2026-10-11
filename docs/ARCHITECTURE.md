# Architecture

## Repository tree

```
.
├── PROMPT.md                     living brief (§18 = amendments log)
├── CLAUDE.md                     working rules for coding agents
├── docker-compose.yml            proxy · api · db · backup
├── docker-compose.dev.yml        + minio · mailpit · hot reload
├── docker-compose.prod.yml       no minio, limits, restart policies
├── .env.example
├── apps/
│   ├── api/                      NestJS 10 + Prisma 5
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/       generated SQL + raw-SQL constraints
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── common/           error filter, zod pipe, guards, decorators
│   │   │   ├── config/           env schema
│   │   │   ├── prisma/
│   │   │   ├── crypto/           national-ID encryption + blind index
│   │   │   ├── auth/             login, refresh rotation, reset, CSRF
│   │   │   ├── users/            users + registrations + last-admin
│   │   │   ├── audit/
│   │   │   ├── notifications/    in-app + email
│   │   │   ├── settings/
│   │   │   ├── storage/          S3/OCI presign + confirm + magic bytes
│   │   │   ├── teams/ members/ reference/ cards/        (phase 2)
│   │   │   ├── violations/                               (phase 3)
│   │   │   ├── projects/ tasks/ calendars/               (phase 4)
│   │   │   └── seed/
│   │   ├── test/int/             Testcontainers integration tests
│   │   └── Dockerfile
│   └── web/                      React 18 + Vite + Mantine (RTL)
│       ├── src/
│       │   ├── api/              ApiClient · HttpApi · demo/DemoApi
│       │   ├── app/              router, shell, nav registry, guards
│       │   ├── features/         one folder per module
│       │   ├── i18n/             ar.ts (complete) · en.ts (scaffold)
│       │   ├── theme/            tokens.css + Mantine theme
│       │   └── components/       VestBand, TeamBadge, …
│       ├── scripts/check-i18n.mjs
│       └── Dockerfile            builds web, ships nginx
├── packages/
│   ├── shared/                   zod schemas, DTO types, permissions, validators, errors
│   ├── scheduling/               pure TS Gantt engine
│   └── ui-print/                 card templates (mm units)
├── seed/demo/                    demo data only — replaced by the owner's data
├── infra/
│   ├── nginx/                    TLS, SPA, /api proxy, headers
│   ├── backup/                   pg_dump cron + restore.sh
│   └── certs/                    mkcert (dev) / provided certs (prod)
├── e2e/                          Playwright (mobile + desktop)
├── docs/                         ADRs, phases, printing, offline, OCI, backup
└── .github/workflows/            ci.yml · pages.yml
```

## Runtime

```mermaid
flowchart LR
  subgraph Device["Browser / phone (PWA)"]
    UI["React app (RTL)"]
    SW["Service worker"]
    IDB[("IndexedDB\nroster · outbox")]
    UI <--> IDB
    SW -.caches.-> UI
  end

  subgraph Docker["docker compose"]
    NGX["proxy (nginx)\nTLS · static · /api"]
    API["api (NestJS)"]
    DB[("db\nPostgreSQL 16")]
    BK["backup\npg_dump cron"]
    MINIO[("storage\nMinIO — dev only")]
  end

  OCI[("OCI Object Storage\nS3-compatible, private")]
  SMTP["SMTP / mailpit"]

  UI -- HTTPS --> NGX
  NGX -- /api --> API
  API --> DB
  API -- presign --> OCI
  API -- presign --> MINIO
  UI -- "presigned PUT/GET" --> OCI
  API --> SMTP
  BK --> DB
  BK -- encrypted dump --> OCI
```

## Upload flow (brief §3.2)

```mermaid
sequenceDiagram
  participant W as Web
  participant A as API
  participant S as Storage (OCI/MinIO)
  W->>A: POST /files/presign {contentType, sizeBytes}
  A->>A: permission check, files row (PENDING)
  A-->>W: {fileId, url (PUT, ~5 min)}
  W->>S: PUT bytes
  W->>A: POST /files/{id}/confirm
  A->>S: HEAD + GET first 4 KB
  A->>A: size + magic bytes OK → READY
  A-->>W: {status: READY}
```

## Auth flow (ADR-010)

```mermaid
sequenceDiagram
  participant W as Web
  participant A as API
  W->>A: POST /auth/login
  A-->>W: accessToken (body) + nz_rt (httpOnly) + nz_csrf
  Note over W: access token kept in memory only
  W->>A: GET … Authorization: Bearer
  A-->>W: 401 (expired)
  W->>A: POST /auth/refresh + X-CSRF-Token
  A->>A: rotate: revoke old, issue new (same family)
  A-->>W: new accessToken + new nz_rt
  Note over A: an already-revoked token presented again → revoke the whole family
```

## Offline violation sync (brief §7.4)

```mermaid
stateDiagram-v2
  [*] --> pending: saved to outbox (client UUID)
  pending --> uploading: online / focus / timer / background sync
  uploading --> uploading: create (idempotent) → presign → PUT photos → confirm
  uploading --> synced: all photos READY
  uploading --> failed: error (backoff 2 s → 5 min)
  failed --> uploading: retry resumes from the last finished step
  synced --> [*]
```

## The demo build (ADR-020)

GitHub Pages hosts `apps/web` built with `--mode demo`. The `ApiClient` interface is implemented by `DemoApi`, which keeps all data in the browser and applies the same zod schemas, permission matrix and business rules as the API. Nothing leaves the browser.
