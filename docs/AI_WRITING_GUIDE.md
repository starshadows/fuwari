# AI Writing Guide for This Blog

This document tells AI assistants how to create and edit Markdown posts for this Fuwari/Astro blog.

## Goal

Write posts that can be published directly in this project without breaking Astro content validation, search indexing, RSS, or Cloudflare Pages builds.

The blog owner writes in Chinese. Use natural, clear Chinese unless the user explicitly asks for another language.

## Where Posts Live

All posts live under:

```text
src/content/posts/
```

A post can be either:

```text
src/content/posts/my-post.md
```

or a folder post:

```text
src/content/posts/my-post/
├─ index.md
└─ cover.png
```

Use a folder post when the post has local images, screenshots, or diagrams that should stay beside the article. For simple text posts, prefer a single `.md` file.

## Create a New Post

From the repository root:

```powershell
corepack pnpm new-post my-post-name
```

This creates:

```text
src/content/posts/my-post-name.md
```

Then edit the generated Markdown file.

Use lowercase English slugs for filenames, with hyphens:

```text
good:  cloudflare-pages-deploy.md
bad:   我的第一篇文章.md
bad:   My First Post.md
```

Chinese titles belong in frontmatter, not filenames.

## Required Frontmatter

Use this shape:

```yaml
---
title: 文章标题
published: 2026-05-10
description: 简短摘要，说明这篇文章写什么
image: ''
tags: [博客, Fuwari]
category: 折腾记录
draft: false
lang: ''
---
```

Field rules:

- `title`: The display title. Chinese is fine.
- `published`: Date in `YYYY-MM-DD` format.
- `description`: Short summary for post cards, RSS, and search.
- `image`: Cover image path. Use `''` if there is no cover.
- `tags`: Array of tags. Keep them short.
- `category`: One category string.
- `draft`: `true` hides the post from production. `false` publishes it.
- `lang`: Usually leave as `''`. The site default is Chinese.

Do not remove frontmatter.

## Cover Images

For a single-file post, use images from:

```text
src/assets/images/
```

Example:

```yaml
image: 'assets/images/example-cover.png'
```

For a folder post:

```text
src/content/posts/my-post/
├─ index.md
└─ cover.png
```

Use:

```yaml
image: 'cover.png'
```

Avoid adding large unused images. Do not commit local source-material folders.

## Screenshots and Diagrams

For tutorial screenshots:

- Redact emails, domains, API keys, tokens, account avatars, and other identifying details before publishing.
- Use solid blocks or another irreversible mask. Do not rely on blur, low-opacity overlays, or tiny partial masks.
- Visually inspect every screenshot in the rendered article after masking. A mask that looks fine in the source image can still miss text once the page scales it.
- Keep UI labels, buttons, and operation paths readable after redaction.

For tutorials involving multiple services, include a simple original flow or architecture diagram when text alone is hard to follow. Store it beside the folder post, for example:

```text
src/content/posts/my-post/
├─ index.md
├─ cover.png
└─ architecture.svg
```

Do not paste a user-provided review screenshot as the article diagram. Recreate the idea cleanly in the blog's own style.

## Article Style

Write in a direct, readable style:

- Prefer short paragraphs.
- Use headings to divide sections.
- Use lists for steps, commands, and checklists.
- Explain commands before or after showing them.
- Avoid exaggerated marketing language.
- Avoid pretending uncertainty is certainty.
- If the article is a tutorial, include verification steps.
- For technical tutorials, include a short common-issues section when there are likely failure points.
- For email/DNS tutorials, mention authentication and anti-spoofing records where relevant, especially SPF, DKIM, and DMARC.
- When product limits, pricing, or UI names may have changed, verify against official docs before publishing and keep claims dated or cautious.

Recommended structure:

```markdown
## 背景

为什么要做这件事。

## 步骤

1. 第一步
2. 第二步
3. 第三步

## 遇到的问题

记录坑点和解决方式。

## 总结

写下最终结果和下次可以改进的地方。
```

## Markdown Features

Basic Markdown:

```markdown
# 一级标题

## 二级标题

普通段落。

- 列表项
- 列表项

**加粗**，_斜体_，`行内代码`。

[链接文字](https://example.com)
```

Code blocks:

````markdown
```powershell
corepack pnpm build
```
````

Admonitions:

```markdown
> [!NOTE]
> 这里是提示。

> [!WARNING]
> 这里是警告。
```

Images:

```markdown
![图片说明](assets/images/example.png)
```

For folder posts:

```markdown
![图片说明](./example.png)
```

## Links

External links in public posts should open in a new tab. Use HTML anchors with `target="_blank"` and `rel="noopener noreferrer"`:

```html
<a href="https://github.com/starshadows/fuwari" target="_blank" rel="noopener noreferrer">starshadows/fuwari</a>
```

Use normal Markdown links for internal links within the site:

```markdown
[关于我](/about/)
```

When converting draft material or a `.docx` tutorial, replace bare URLs with named links and keep external references in this new-tab format.

## What Not To Do

Do not:

- Put posts outside `src/content/posts/`.
- Commit `dist/`, `.astro/`, or `node_modules/`.
- Reintroduce demo posts unless requested.
- Use GitHub dynamic cards with `::github{repo="..."}` unless the user asks for them. This project removed them because API loading caused gray cards.
- Change theme layout files while only writing an article.
- Add unused images.
- Change `src/config.ts` unless the user asks for site-wide settings.
- Revert `astro.config.mjs` `site` to the upstream Fuwari demo domain or the apex domain. This project uses `https://blog.starshadow.cc/` for canonical URLs, share previews, RSS, sitemap, and author metadata.

## Before Finishing

Run:

```powershell
corepack pnpm check
corepack pnpm build
```

Expected result:

- `astro check` has 0 errors.
- `astro build` succeeds.
- Pagefind generates `dist/pagefind`.

`pnpm check` can pass while `pnpm build` fails, so run both. Tailwind `@apply` can fail in production when a stylesheet applies custom component classes defined elsewhere, for example `expand-animation` or `btn-regular-dark`; expand the needed utilities locally or move the class into a visible `@layer`, then build again.

The Svelte `experimental_async_ssr` note, Browserslist age notice, and Pagefind `zh-cn` stemming note can appear during successful builds and are not usually blockers.

## Publishing Workflow

After writing or editing posts:

```powershell
git status
git add path/to/changed-files
git commit -m "Add new post"
git push
```

Stage only the files that belong to the requested change. Avoid `git add .` when the worktree contains unrelated drafts, generated files, or user changes.

Cloudflare Pages automatically rebuilds after pushing to `main`.
