# C12335 的 Fuwari 博客操作手册

这份文档是给“不懂代码也能维护博客”的自己看的。以后忘了怎么写文章、改主题、部署，就先看这里。

## 1. 项目地图

- `src/config.ts`：博客的总开关。站点标题、语言、主题色、头像、昵称、简介、导航链接都在这里改。
- `src/content/posts/`：文章目录。每一篇文章通常是一个 `.md` 文件。
- `src/content/spec/about.md`：关于页面内容。
- `src/assets/images/`：放会被 Astro 处理的图片，比如头像、banner、文章封面。
- `public/`：放原样复制到网站根目录的静态文件，比如 favicon。
- `src/pages/`：网站路由。一般新手阶段不用动。
- `src/components/`：页面零件。导航栏、文章卡片、侧边栏、搜索等都在这里。
- `src/layouts/`：页面大布局。决定页面整体骨架。
- `src/styles/`：全局样式。想深入改视觉风格时再看。

先记住一句话：日常维护主要改 `src/config.ts`、`src/content/posts/`、`src/content/spec/about.md`。

## 2. 本地运行

在项目根目录运行：

```powershell
corepack pnpm dev
```

然后打开：

```text
http://localhost:4321
```

如果命令提示找不到 `pnpm`，就用 `corepack pnpm ...` 这种写法。

## 3. 新建文章

在项目根目录运行：

```powershell
corepack pnpm new-post my-first-post
```

它会创建：

```text
src/content/posts/my-first-post.md
```

文章开头的 `---` 区域叫 frontmatter，用来告诉博客这篇文章的标题、日期、标签等信息：

```yaml
---
title: 我的第一篇文章
published: 2026-05-06
description: 这是一篇测试文章
image: ''
tags: [博客, Fuwari]
category: 折腾记录
draft: false
lang: ''
---
```

字段含义：

- `title`：文章标题。
- `published`：发布日期，格式是 `YYYY-MM-DD`。
- `description`：文章摘要，会出现在列表和搜索结果里。
- `image`：封面图。没有就写空字符串 `''`。
- `tags`：标签，可以有多个。
- `category`：分类，通常一个就够。
- `draft`：是否草稿。`true` 不发布，`false` 发布。
- `lang`：文章语言和网站默认语言不同时再填；平时留空。

## 4. 写文章的 Markdown 基础

```markdown
# 一级标题

## 二级标题

普通段落直接写。

- 列表项
- 列表项

**加粗**，_斜体_，`行内代码`。

[链接文字](https://example.com)
```

Fuwari 还支持提示块：

```markdown
> [!NOTE]
> 这里是一条提示。
```

也支持 GitHub 仓库卡片：

```markdown
::github{repo="C12335/fuwari"}
```

## 5. 修改主题和个人信息

打开 `src/config.ts`：

- `siteConfig.title`：网站标题。
- `siteConfig.subtitle`：网站副标题。
- `siteConfig.lang`：中文站点用 `zh_CN`。
- `siteConfig.themeColor.hue`：主题色，0 是红色，200 左右偏青色，250 左右偏蓝紫。
- `siteConfig.banner.enable`：是否显示顶部 banner。
- `profileConfig.avatar`：头像路径。
- `profileConfig.name`：侧边栏昵称。
- `profileConfig.bio`：个人简介。
- `profileConfig.links`：社交链接。

头像替换方法：

1. 把头像图片放到 `src/assets/images/`，例如 `avatar.png`。
2. 把 `profileConfig.avatar` 改成 `assets/images/avatar.png`。

Banner 替换方法同理，把图片放到 `src/assets/images/`，再改 `siteConfig.banner.src`。

## 6. 检查和构建

修改完成后先检查：

```powershell
corepack pnpm check
```

再构建：

```powershell
corepack pnpm build
```

构建成功后会生成：

```text
dist/
```

Cloudflare Pages 发布的就是这个目录。

## 7. Cloudflare Pages 发布

在 Cloudflare 控制台：

1. 进入 Workers & Pages。
2. Create application。
3. 选择 Pages。
4. Import an existing Git repository。
5. 选择 `C12335/fuwari`。
6. Production branch 填 `main`。
7. Build command 填 `pnpm build`。
8. Build output directory 填 `dist`。

如果 Cloudflare 没有自动使用 pnpm，先在项目设置里确认 Node 版本至少是 20，并让它按仓库里的 `packageManager: pnpm@9.14.4` 安装。

首次发布后，把 Cloudflare 给你的正式域名写回 `astro.config.mjs` 的 `site` 字段，例如：

```js
site: "https://你的项目名.pages.dev/",
```

## 8. 日常更新流程

每次写完文章或改完主题：

```powershell
git status
git add .
git commit -m "Update blog"
git push
```

推送后 Cloudflare Pages 会自动重新部署。

## 9. 学习顺序

建议按这个顺序学：

1. 会运行：`corepack pnpm dev`。
2. 会发文：新建、编辑、改 `draft`。
3. 会改个人信息：`src/config.ts`。
4. 会换图片：头像、banner、封面。
5. 会发布：`git push` 触发 Cloudflare。
6. 再学源码：`pages -> layouts -> components -> styles`。

慢慢来。博客不是一次性完成的项目，它会跟着你一起长出来。
