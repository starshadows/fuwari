# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Setup

Requires **Node >=22.22.0** and **pnpm >=9** (project uses `pnpm@9.14.4` via `packageManager`).

## Commands

```sh
# Development
pnpm dev              # Astro dev server at localhost:4321
pnpm build            # Build site + Pagefind search index
pnpm check            # Astro type checking
pnpm preview          # Preview production build locally

# Worker (Cloudflare backend API)
pnpm worker:dev       # Worker dev server at localhost:8787
pnpm worker:deploy    # Build site then deploy Worker
pnpm d1:migrate:local # Run D1 migrations for local dev
pnpm d1:migrate:remote

# Code quality
pnpm format           # Biome format + autofix (writes files)
pnpm lint             # Biome CI check (read-only)
pnpm type-check       # tsc --noEmit
pnpm test             # vitest run (unit tests)
pnpm test:watch       # vitest in watch mode

# Content
pnpm new-post <name>  # Scaffold a new blog post in src/content/posts/
```

For full local development, run both `pnpm dev` (frontend on 4321) and `pnpm worker:dev` (API on 8787) — the deployed site serves both from a single Worker (assets + API), but locally they run on separate ports.

### Path aliases (tsconfig)

```ts
@components/*  → src/components/*
@assets/*      → src/assets/*
@constants/*   → src/constants/*
@utils/*       → src/utils/*
@i18n/*        → src/i18n/*
@layouts/*     → src/layouts/*
@/*            → src/*
```

## Architecture

A static blog built with **Astro 6** + Tailwind CSS (v3), with interactive Svelte 5 components. Serves as a Cloudflare Worker that acts as a backend API alongside the static assets.

### Frontend (static Astro site)

- **`src/config.ts`** — single source of truth for site title, theme color, banner, nav links, profile, license, expressive-code theme. Modify this to customize the blog.
- **`src/content/`** — `posts/` for blog entries (Markdown + frontmatter), `spec/` for the about page.
- **`src/pages/`** — Astro file-based routing: home (`[...page].astro` handles pagination), post detail (`posts/[...slug].astro`), archive, about, friends pages, RSS, robots.txt.
- **`src/layouts/`** — `Layout.astro` (HTML shell with Swup page transitions, theme/color persistence, PhotoSwipe lightbox, native CSS scrollbar with Katex OSB, banner height logic) and `MainGridLayout.astro`.
- **`src/components/`** — organized by domain:
  - `widget/` — Profile, TOC, Tags, Categories, MusicPlayer (Svelte), VisitorStats (Svelte), DisplaySettings (Svelte), SideBar, NavMenuPanel
  - `control/` — BackToTop, Pagination, ButtonLink, ButtonTag
  - `comments/TwikooComments.svelte` — Twikoo-based comment system with ALTCHA challenge
  - `friends/` — FriendLinkPanel (Svelte), FriendAdminPanel (Svelte)
  - `anti-abuse/HumanProof.svelte` — ALTCHA challenge widget
  - `misc/` — ImageWrapper, License, Markdown
- **`src/plugins/`** — remark/rehype plugins: admonitions, GitHub cards, reading time, excerpt, expressive-code customizations (language badges, copy buttons).
- **`src/i18n/`** — 10 languages, driven by `siteConfig.lang` (defaults to zh_CN). Keyed by `I18nKey` enum.
- **`src/styles/`** — global CSS: Tailwind layers, Stylus variables, markdown, scrollbar, expressive-code overrides, transition, photoswipe.
- **`src/constants/`** — page size (8), banner heights (35/30 vh), icon sets, link presets.
- **`src/utils/`** — URL helpers, date formatting, local storage setting utils, content query helpers.
- **`src/types/config.ts`** — TypeScript types for all config interfaces and blog post data.

Key frontend patterns:
- **Swup** handles SPA-like page transitions (no full page reload). Layout.astro hooks into Swup events for scroll position, banner height, TOC visibility, PhotoSwipe re-initialization.
- **Theme persistence**: light/dark/auto mode and hue stored in localStorage, applied before render via inline `<script>` to avoid flash.
- **Custom scrollbar**: native CSS (`scrollbar-width: thin` + `::-webkit-scrollbar` styles), with OverlayScrollbars retained only for Katex formula overflow containers.
- **Post content schema** defined in `src/content.config.ts` with Zod validation (title, published, tags, category, draft, prev/next navigation).
- **Pagefind** indexes `dist/` for full-text search after build.

### Backend (Cloudflare Worker at `src/worker/`)

Runs as a Cloudflare Worker with `ASSETS` binding for static files, `DB` (D1 SQLite) for data, and `MEDIA_BUCKET` (R2) for uploads. Configuration: `wrangler.jsonc`.

### API route map

All routes dispatched in `src/worker/index.ts` → `handleApi()`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/setup/init-db` | Apply pending D1 migrations (requires Bearer auth) |
| `GET` | `/api/anti-abuse/challenge` | Generate an ALTCHA challenge |
| `GET` | `/api/comments/config` | Get comment system settings (5-min cache) |
| `POST` | `/api/comments/session` | Create a Twikoo-compatible session |
| `ANY` | `/api/twikoo` | Twikoo comment CRUD (GET/POST) |
| `GET` | `/api/friends` | List approved friend links (5-min cache) |
| `POST` | `/api/friends` | Submit a friend link (rate-limited, ALTCHA required) |
| `GET` | `/api/music/tracks` | List published music tracks (5-min cache) |
| `GET` | `/api/stats/summary` | Visitor stats (60s cache) |
| `POST` | `/api/stats/visit` | Record a page view |
| `POST` | `/api/stats/heartbeat` | Heartbeat for online-visitor tracking |
| `*` | `/api/admin/*` | Admin CRUD (requires `ADMIN_TOKEN` Bearer auth) |
| `*` | `/media/*` | Serve files from R2 `MEDIA_BUCKET` |

### Backend files

- **`index.ts`** — entry point: `/api/*` → `handleApi()`, `/media/*` → R2, everything else → static assets.
- **`db.ts`** — Versioned D1 migrations (MIGRATIONS array, 0001-0004). Incrementally applies pending migrations at `/api/setup/init-db`, tracks applied version in `app_settings`.
- **`comments.ts`** — Twikoo-compatible comment API with session-based check. Enables/disables comments via admin settings. ALTCHA challenge required for posting. Sends Telegram notification on new comments.
- **`twikoo-adapter.ts`** — Translates Twikoo request/response format to Worker's internal API.
- **`friends.ts`** — Friend link submission with rate limiting, dedup by domain, human proof verification, Telegram notification.
- **`id3.ts`** — Shared ID3v2 tag parser (titles, artists, albums, embedded cover art).
- **`music.ts`** — CRUD for music tracks, R2 object listing with ID3 metadata reading, auto-import from R2 `music/` prefix. Uses in-memory scan cache (5-min TTL) to avoid re-reading metadata on every admin page load.
- **`stats.ts`** — Visitor counting: page views, unique visitors, daily aggregates, real-time online (5-min heartbeat window). Visitor identification via local random ID + SHA-256 (no raw IP storage).
- **`admin.ts`** — Admin API (`/api/admin/*`) for friend management (approve/reject/sort), avatar upload to R2, comments toggle, Telegram settings, music management.
- **`anti-abuse.ts`** — ALTCHA challenge generation/verification for friend submissions and comments.
- **`media.ts`** — Serves files from R2 `MEDIA_BUCKET` at `/media/avatars/*` and `/media/covers/*` with content-type detection.
- **`constants.ts`** — Error code factory (`apiError`) and shared worker constants.
- **`utils.ts`** — Shared utilities: response helpers (json, security headers, server timing, caching), versioned cache invalidation (`cachedResponseV`, `incrementCacheVersion`), input validation, rate limiting (D1-based sliding window), admin token verification (timing-safe via unified rate-limit-first gate), cross-site write protection. Also hosts shared worker helpers: `readMusicMetadataFromR2`, `inferMusicMetadataFromKey`, `getMusicFileNameFromKey`, `embeddedCoverUrlForMusicKey`, `getClientIp`, `getRequestRegion`, `clampInteger`.
- **`types/index.ts`** — `Env` interface with `DB`, `MEDIA_BUCKET`, `ASSETS`, `ADMIN_TOKEN` bindings.

Key backend patterns:
- Admin API uses Bearer token auth with unified rate-limit-first gate (all auth paths hit rate limit before verification, preventing timing-based probing).
- Rate limiting on public write endpoints; cross-site origin check for writes; versioned cached responses for public GET endpoints (`cachedResponseV` with `incrementCacheVersion` on mutations).
- CSP headers on all Worker responses via `withSecurityHeaders()`: `base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; frame-src 'none'; upgrade-insecure-requests`. Do not add `script-src` here — Astro/Swup pages require inline scripts.
- Server timing headers via `withServerTiming()`.
- Graceful 410 on old URL-based setup token pattern.
- Twikoo comments use `sanitize-html` for robust XSS-safe HTML (not hand-rolled regex blacklist).
- Twikoo CORS is same-origin only — Origin header is validated against the request hostname before being reflected with credentials.
- Worker tests in `src/worker/__tests__/` (test file pattern: `src/**/*.test.ts`). `utils.test.ts` covers utility functions; `api.test.ts` covers route dispatch and response shape using mocked D1/R2/ASSETS bindings. Run with `pnpm test`.
- R2 music scan has a 5-minute in-memory result cache; `MUSIC_METADATA_READ_BYTES` is 256 KB.

### Deployment

- Built site goes to `dist/`, deployed as Worker `ASSETS`.
- `wrangler.jsonc` declares bindings but not resource names — D1/R2 resources are bound by name in Cloudflare dashboard. `keep_vars: true` preserves dashboard-set variables across deploys.
- D1 database must be initialized via `GET /api/setup/init-db` with `Authorization: Bearer <token>` after first deploy.
- GitHub auto-deploy build command: `corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm build`
