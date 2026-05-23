# AI Project Context

This repository is a personal Astro blog based on the Fuwari theme.

## Project Goal

The site is Starshadow's personal blog. It is meant to publish notes, project logs, technical learning records, and occasional personal essays.

The owner is not deeply technical, so future AI assistants should keep changes small, explain them clearly, and preserve the simple writing workflow.

## Tech Stack

- Framework: Astro 5
- UI: Astro components plus Svelte components
- Styling: Tailwind CSS, Stylus, and project CSS files
- Package manager: pnpm 9.14.4
- Static search: Pagefind, generated during `pnpm build`
- Deployment target: Cloudflare Workers with Static Assets
- Runtime data: Cloudflare D1 for friend links and music metadata; Cloudflare R2 for avatars and audio files

## Important Commands

Use these from the repository root:

```powershell
corepack pnpm install
corepack pnpm dev
corepack pnpm check
corepack pnpm build
corepack pnpm new-post post-file-name
corepack pnpm d1:migrate:local
corepack pnpm worker:dev
```

Cloudflare Workers local preview should use:

```text
Build first: pnpm build
Apply local D1 migrations: pnpm d1:migrate:local
Run Worker locally: pnpm worker:dev
Local URL: http://localhost:8787
```

## Key Files

- `src/config.ts`: site title, language, theme color, navbar, profile, avatar, banner, social links, license.
- `src/content/posts/`: blog posts. Each post is Markdown or a folder with `index.md`.
- `src/content/spec/about.md`: About page content.
- `src/assets/images/`: committed images used by the site.
- `src/components/misc/ImageWrapper.astro`: image rendering. Banner images use a special two-layer display: blurred cover background plus contained foreground image.
- `src/layouts/Layout.astro`: page title, global layout behavior, banner height behavior.
- `src/worker/index.ts`: Cloudflare Worker API and R2 media routing for `/api/*` and `/media/*`.
- `migrations/`: D1 schema migrations for friend links and music tracks.
- `.dev.vars.example`: local development secret example. Copy to `.dev.vars` or keep the existing ignored `.dev.vars`.
- `src/components/SakanaWidget.astro`: site-wide Sakana/Live2D-style floating widget, including desktop/mobile mounting behavior and the GitHub confirmation dialog.
- `src/components/widget/NavMenuPanel.astro`: mobile navigation menu. It includes the mobile-only Live2D toggle below the About link.
- `src/plugins/rehype-component-github-card.mjs`: currently keeps GitHub cards static and reliable. Avoid restoring runtime GitHub API fetching unless explicitly requested.
- `BLOG_GUIDE.md`: Chinese beginner guide for maintaining this blog.

## Current Customizations

- Site identity is Chinese, under the name `星影`.
- GitHub repo link is `https://github.com/starshadows/fuwari`.
- Canonical public domain is `https://blog.starshadow.cc/`.
- `astro.config.mjs` `site` must stay set to `https://blog.starshadow.cc/`. This value drives `og:url`, `twitter:url`, RSS, sitemap, and post JSON-LD `author.url`; do not revert it to `fuwari.pages.dev` or the apex domain.
- Contact email is shown as text in the profile bio: `admin@starshadow.cc`.
- The navbar includes a hover dropdown under `友链` with `/friends/`, `/friends/apply/`, and `/friends/admin/`. The admin page may also be protected by Cloudflare Access; admin APIs still require `ADMIN_TOKEN`.
- The old demo posts were removed.
- The current first post is `src/content/posts/hello-fuwari.md`.
- The active avatar is `src/assets/images/touxiang.png`.
- The active banner is `src/assets/images/beijing1.png`.
- On the about page, external attribution links such as `Fuwari` should open in a new tab with `target="_blank"` and `rel="noopener noreferrer"` so they do not replace the blog page.
- `src/assets/images/beijing2.png` is intentionally ignored for now because it is not used by the site.
- `博客素材/` is local-only source material and should not be committed.

## Sakana / Live2D Widget

- The blog has a Sakana Widget integration adapted from `Lentinel/plugin-Sakana-widget-Halo` and the upstream `dsrkafuu/sakana-widget`.
- Static widget runtime files live under `public/vendor/sakana/`. The optimized default character image is `public/sakana/starshadow.webp`; the original large source image is kept outside the repo and should not be committed.
- The global integration is `src/components/SakanaWidget.astro`, imported by `src/layouts/Layout.astro`.
- `PUBLIC_SAKANA_WIDGET_ENABLED=false` disables the integration. Any other value, including unset, enables it.
- Desktop behavior: the widget is enabled by default, fixed near the bottom-right, and should not add a desktop navbar toggle.
- Mobile behavior: the widget is disabled by default. The mobile menu has a `Live2D` toggle below About; it stores state in `localStorage` key `sakana-mobile-enabled`.
- The bottom controls are ordered as character, upstream repository, auto mode, close. The repository button must show an in-site confirmation dialog before opening the upstream repo in a new tab.
- The character button is intentionally a no-op while only one custom character exists. Do not let it switch to the bundled Sakana characters; when adding future custom characters, extend the local custom character list first.
- The rod color should stay aligned with the blog theme, currently using a blue/white HSL value derived from `--hue`.

## Friend Links And Music

- Public friend links are shown at `/friends/` and loaded from `GET /api/friends`; submissions live at `/friends/apply/`, call `POST /api/friends`, and are stored as `pending`.
- Admin actions use `Authorization: Bearer <token>` against `/api/admin/*`. Prefer runtime `ADMIN_TOKEN`; if it is missing, the first successful setup request stores a SHA-256 token hash in D1 `app_settings`.
- Approved, active friend links appear immediately without rebuilding the Astro site.
- R2 bucket binding is `MEDIA_BUCKET`; bind it manually in Cloudflare. The bucket can have any Cloudflare-side name.
- D1 binding is `DB`; bind it manually in Cloudflare. The database can have any Cloudflare-side name.
- `wrangler.jsonc` intentionally does not commit D1/R2 resource names or UUIDs. Runtime code only depends on binding variable names.
- Database tables can be initialized after deployment by visiting `GET /api/setup/init-db?token=<token>` or `GET /setup/init-db/<token>`. The setup route is idempotent and keeps existing data. If no runtime `ADMIN_TOKEN` exists, the first setup token becomes the D1-backed admin token.
- Audio objects should be uploaded manually to R2 under `music/`, for example `music/song.mp3`; the music admin page can scan R2 objects, read MP3 ID3 title/artist/album metadata when available, fall back to filename inference, and bulk-import untracked objects into D1.
- Admin music scan API: `GET /api/admin/music/objects`; bulk import API: `POST /api/admin/music/import` with optional `objectKeys`.
- Public media is served by the Worker at `/media/music/<key>` and `/media/avatars/<key>`. Music responses support HTTP Range requests for seeking.
- The sidebar music card is disabled by default in the sense that it never auto-plays; visitors must click play.
- The article TOC now lives in the left sidebar below tags. Keep the `#toc` element present because Swup is configured to replace it.

## Content Rules

For new posts:

1. Run `corepack pnpm new-post my-post-name`.
2. Edit the generated file under `src/content/posts/`.
3. Use this frontmatter shape:

```yaml
---
title: 文章标题
published: 2026-05-10
description: 简短摘要
image: ''
tags: [标签1, 标签2]
category: 分类
draft: false
lang: ''
---
```

`draft: true` hides a post from production builds. `draft: false` publishes it.

## Practical AI Workflow Notes

- Chinese files are UTF-8. PowerShell `Get-Content` output can look garbled in the tool log even when the file is correct. Verify Chinese text with Python, for example `Path(...).read_text(encoding="utf-8")`, before assuming corruption.
- Prefer folder posts for articles with local images: `src/content/posts/post-slug/index.md`, `cover.png`, and nearby step images.
- For public screenshots, use irreversible solid masking for emails, domains, API keys, account avatars, and tokens. Do not rely on blur or partial masks.
- External article links should open in a new tab using HTML anchors with `target="_blank"` and `rel="noopener noreferrer"`.
- For multi-service tutorials, add a simple original flow/architecture diagram when text alone is hard to follow. Store the diagram beside the post; do not paste user-supplied screenshots as the diagram.

## Deployment Notes

This site builds to static HTML/CSS/JS in `dist/`, then Cloudflare Workers serves those assets and handles API/media routes.

Do not commit:

- `node_modules/`
- `dist/`
- `.astro/`
- local source material such as `博客素材/`
- unused large images

Before pushing meaningful changes, run:

```powershell
corepack pnpm check
corepack pnpm build
```

For runtime features, also apply migrations and test through Wrangler:

```powershell
corepack pnpm d1:migrate:local
corepack pnpm worker:dev
```

Dashboard-only production setup is preferred: create D1/R2 resources with any names, bind D1 as `DB`, bind R2 as `MEDIA_BUCKET`, optionally set `ADMIN_TOKEN`, then visit `/api/setup/init-db?token=<token>`. Avoid committing Cloudflare resource names or UUIDs; `wrangler.jsonc` intentionally omits D1/R2 resource names and IDs.

## Build Pitfalls Seen In Practice

- `pnpm check` can pass while `pnpm build` fails. Always run both before pushing.
- Tailwind `@apply` can fail in production if a CSS file applies a custom component class defined in another CSS file, with errors like `The expand-animation class does not exist` or `The btn-regular-dark class does not exist`. Fix by expanding the needed utilities locally or moving the class into the same visible `@layer`, then rerun `corepack pnpm build`.
- Browserslist age notices, Svelte `experimental_async_ssr` links, and Pagefind's `zh-cn` stemming note have appeared during successful builds and are not blockers by themselves.
- Do not commit generated `dist/`, `.astro/`, or temporary preview/review images.

## Known Design Choices

- GitHub repository cards are static links/cards to avoid gray loading states caused by browser-side GitHub API failures.
- Search shows fake results in `pnpm dev`; this is normal. Real search is generated by Pagefind during `pnpm build`.
- Banner display intentionally uses a blurred background layer and a contained foreground image so more of the chosen artwork is visible without breaking layout.
