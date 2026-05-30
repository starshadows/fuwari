# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
pnpm format           # Biome format (tab indent, double quotes)
pnpm lint             # Biome lint + autofix
pnpm type-check       # tsc --noEmit

# Content
pnpm new-post <name>  # Scaffold a new blog post in src/content/posts/
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

- **`index.ts`** — entry point with route dispatch: `/api/*` routes to `handleApi()`, `/media/*` to R2 media handler, everything else serves static assets.
- **`db.ts`** — Versioned D1 migrations (MIGRATIONS array, 0001-0004). Incrementally applies pending migrations at `/api/setup/init-db`, tracks applied version in `app_settings`.
- **`comments.ts`** — Twikoo-compatible comment API with session-based check. Enables/disables comments via admin settings. ALTCHA challenge required for posting. Sends Telegram notification on new comments.
- **`twikoo-adapter.ts`** — Translates Twikoo request/response format to Worker's internal API.
- **`friends.ts`** — `GET /api/friends` returns approved links; `POST /api/friends` submits with rate limiting, dedup by domain, human proof verification, Telegram notification for friends.
- **`id3.ts`** — Shared ID3v2 tag parser (titles, artists, albums, embedded cover art), used by both `media.ts` and `music.ts`.
- **`music.ts`** — CRUD for music tracks, R2 object listing with ID3 metadata reading, auto-import from R2 `music/` prefix.
- **`stats.ts`** — Visitor counting: page views, unique visitors, daily aggregates, real-time online (5-min heartbeat window). Visitor identification via local random ID + SHA-256 (no raw IP storage).
- **`admin.ts`** — Admin API (`/api/admin/*`) for friend management (approve/reject/sort), avatar upload to R2, comments toggle, Telegram settings, music management. All endpoints require `ADMIN_TOKEN` auth.
- **`anti-abuse.ts`** — ALTCHA challenge generation/verification for friend submissions and comments.
- **`media.ts`** — Serves files from R2 `MEDIA_BUCKET` at `/media/avatars/*` and `/media/covers/*` with content-type detection.
- **`utils.ts`** — Shared utilities: response helpers (json, security headers, server timing, caching), versioned cache invalidation (`cachedResponseV`, `incrementCacheVersion`), input validation, rate limiting (D1-based sliding window), admin token verification, cross-site write protection.
- **`types/index.ts`** — `Env` interface with `DB`, `MEDIA_BUCKET`, `ASSETS`, `ADMIN_TOKEN` bindings.

Key backend patterns:
- Admin API uses Bearer token auth; rate limiting on public write endpoints; cross-site origin check for writes; versioned cached responses for public GET endpoints (`cachedResponseV` with `incrementCacheVersion` on mutations).
- AST-based CORS headers on all Worker responses via `withSecurityHeaders()`.
- Server timing headers via `withServerTiming()`.
- Graceful 410 on old URL-based setup token pattern.

### Deployment

- Built site goes to `dist/`, deployed as Worker `ASSETS`.
- `wrangler.jsonc` declares bindings but not resource names — D1/R2 resources are bound by name in Cloudflare dashboard. `keep_vars: true` preserves dashboard-set variables across deploys.
- D1 database must be initialized via `GET /api/setup/init-db` with `Authorization: Bearer <token>` after first deploy.
- GitHub auto-deploy build command: `corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm build`
