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
- Deployment target: Cloudflare Pages

## Important Commands

Use these from the repository root:

```powershell
corepack pnpm install
corepack pnpm dev
corepack pnpm check
corepack pnpm build
corepack pnpm new-post post-file-name
```

Cloudflare Pages should use:

```text
Build command: pnpm build
Build output directory: dist
Root directory: /
Node version: 20
```

## Key Files

- `src/config.ts`: site title, language, theme color, navbar, profile, avatar, banner, social links, license.
- `src/content/posts/`: blog posts. Each post is Markdown or a folder with `index.md`.
- `src/content/spec/about.md`: About page content.
- `src/assets/images/`: committed images used by the site.
- `src/components/misc/ImageWrapper.astro`: image rendering. Banner images use a special two-layer display: blurred cover background plus contained foreground image.
- `src/layouts/Layout.astro`: page title, global layout behavior, banner height behavior.
- `src/plugins/rehype-component-github-card.mjs`: currently keeps GitHub cards static and reliable. Avoid restoring runtime GitHub API fetching unless explicitly requested.
- `BLOG_GUIDE.md`: Chinese beginner guide for maintaining this blog.

## Current Customizations

- Site identity is Chinese, under the name `星影`.
- GitHub repo link is `https://github.com/starshadows/fuwari`.
- Canonical public domain is `https://blog.starshadow.cc/`.
- `astro.config.mjs` `site` must stay set to `https://blog.starshadow.cc/`. This value drives `og:url`, `twitter:url`, RSS, sitemap, and post JSON-LD `author.url`; do not revert it to `fuwari.pages.dev` or the apex domain.
- Contact email is shown as text in the profile bio: `admin@starshadow.cc`.
- The old demo posts were removed.
- The current first post is `src/content/posts/hello-fuwari.md`.
- The active avatar is `src/assets/images/touxiang.png`.
- The active banner is `src/assets/images/beijing1.png`.
- `src/assets/images/beijing2.png` is intentionally ignored for now because it is not used by the site.
- `博客素材/` is local-only source material and should not be committed.

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

This site builds to static HTML/CSS/JS in `dist/`.

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

## Build Pitfalls Seen In Practice

- `pnpm check` can pass while `pnpm build` fails. Always run both before pushing.
- Tailwind `@apply` can fail in production if a CSS file applies a custom component class defined in another CSS file, with errors like `The expand-animation class does not exist` or `The btn-regular-dark class does not exist`. Fix by expanding the needed utilities locally or moving the class into the same visible `@layer`, then rerun `corepack pnpm build`.
- Browserslist age notices, Svelte `experimental_async_ssr` links, and Pagefind's `zh-cn` stemming note have appeared during successful builds and are not blockers by themselves.
- Do not commit generated `dist/`, `.astro/`, or temporary preview/review images.

## Known Design Choices

- GitHub repository cards are static links/cards to avoid gray loading states caused by browser-side GitHub API failures.
- Search shows fake results in `pnpm dev`; this is normal. Real search is generated by Pagefind during `pnpm build`.
- Banner display intentionally uses a blurred background layer and a contained foreground image so more of the chosen artwork is visible without breaking layout.
