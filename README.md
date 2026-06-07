# 星影的博客

![Node.js 24.x](https://img.shields.io/badge/node.js-24.x-brightgreen)
![pnpm 9.14.4](https://img.shields.io/badge/pnpm-9.14.4-blue)
![Astro 6](https://img.shields.io/badge/Astro-6-orange)
![Cloudflare Worker](https://img.shields.io/badge/Cloudflare-Worker-f38020)

这里是 **星影** 的个人博客项目，用来记录踩过的坑、学到的东西和一些日常内容。

站点基于 Fuwari 主题二次开发。当前线上采用前后端分离部署：前端静态站点部署到 Vercel，后端 API 和媒体访问由 Cloudflare Worker 提供，并使用 D1 / R2 支撑评论、友链、音乐、文章后台和访问统计等动态功能。

## ✨ 功能特性

- Astro 静态博客页面，支持文章、归档、关于页、RSS、站点地图。
- Svelte 交互组件，包括搜索、音乐播放器、访客统计、友链申请和后台管理。
- Pagefind 本地全文搜索。
- Twikoo 兼容评论区，支持 ALTCHA 人机验证、评论开关和 Telegram 通知。
- 友链系统，支持公开申请、后台审核和 Telegram 通知。
- 音乐列表，支持从 R2 `music/` 前缀扫描音频并读取 ID3 元数据。
- 访问统计，支持 PV / UV / 今日 / 昨日 / 月访问量和实时在线人数。
- Vercel + Cloudflare Worker 分离部署：前端走 Vercel，`/api/*` 和 `/media/*` 通过 Vercel rewrites 转发到 Worker 自定义域名；Access 保护的 `/friends/admin/` 壳由 Worker 代理前端页面。
- 内容后台支持上传文章 ZIP 到 R2，并通过 Vercel Deploy Hook 触发前端重新部署。
- 安全加固：Origin/Referer 写保护、公开写接口限流、ALTCHA、D1 prepared statements、R2 key 规范化、安全响应头。

## 🧱 技术栈

- **Frontend**: Astro 6, Svelte 5, Tailwind CSS, Pagefind
- **Runtime**: Node.js 24.x
- **Worker API**: Cloudflare Workers, TypeScript
- **Database**: Cloudflare D1
- **Object Storage**: Cloudflare R2
- **Quality**: Biome, Vitest, TypeScript
- **Package Manager**: pnpm 9.14.4

## 📁 项目结构

```text
src/
  components/          # Astro / Svelte 组件
  content/             # 博客文章与 about 内容
  layouts/             # 页面布局
  pages/               # Astro 路由
  styles/              # 全局样式
  utils/               # 前端工具函数
  worker/              # Cloudflare Worker 后端 API
    admin.ts           # 后台管理 API
    anti-abuse.ts      # ALTCHA challenge / verify
    comments.ts        # 评论配置、评论 session、Twikoo 代理
    twikoo-adapter.ts  # Twikoo 协议兼容层
    friends.ts         # 友链提交与通知
    music.ts           # 音乐管理与 R2 扫描
    stats.ts           # 访问统计
    db.ts              # D1 migration / 初始化
    media.ts           # R2 媒体访问
migrations/            # Wrangler D1 migrations
vercel.json            # Vercel 前端构建与 API/media rewrites
wrangler.jsonc         # Cloudflare Worker 配置
```

## 🚀 本地开发

环境要求：

- Node.js `24.13.1`
- pnpm `9.14.4`

本地和 CI 由 `.node-version`、`.nvmrc` 和 CI `NODE_VERSION` 固定到 Node `24.13.1`；`package.json#engines.node` 使用 Vercel 兼容的 `24.x`，`.npmrc` 启用 `engine-strict`，请先切到 Node 24 再安装依赖。

安装依赖：

```sh
nvm install
nvm use
corepack enable
pnpm install
```

启动前端开发服务器：

```sh
pnpm dev
```

前端默认运行在：

```text
http://localhost:4321
```

启动 Cloudflare Worker 本地开发服务器：

```sh
pnpm worker:dev
```

Worker 默认运行在：

```text
http://localhost:8787
```

完整本地开发时通常需要同时运行 `pnpm dev` 和 `pnpm worker:dev`。线上部署后，前端由 Vercel 提供，API 和媒体路径由 Cloudflare Worker 提供。

## ✍️ 写文章

生产文章以 Worker/D1/R2 内容后台为准，仓库里的 `src/content/posts/` 只保留 `.gitkeep`，Vercel 构建前会从 R2 同步文章到这个目录。

临时创建本地草稿：

```sh
pnpm new-post <filename>
```

本地草稿会写入：

```text
src/content/posts/
```

Frontmatter 示例：

```yaml
---
title: 我的第一篇文章
published: 2026-01-01
description: 文章摘要
tags: [Cloudflare, Astro]
category: 技术
draft: false
---
```

常用配置入口：

- 站点标题、导航、个人资料：`src/config.ts`
- 内容 schema：`src/content.config.ts`
- 国际化文本：`src/i18n/`

## ⚡ 常用命令

| Command | Action |
|:--|:--|
| `pnpm dev` | 启动 Astro 开发服务器 |
| `pnpm worker:dev` | 启动 Cloudflare Worker 本地开发服务器 |
| `pnpm build` | 先同步 R2 文章，再构建站点并生成 Pagefind 索引 |
| `pnpm preview` | 本地预览构建产物 |
| `pnpm check` | Astro 类型检查 |
| `pnpm type-check` | TypeScript 类型检查 |
| `pnpm lint` | Biome 只读检查 |
| `pnpm format` | Biome 格式化并自动修复 |
| `pnpm test` | 运行 Vitest 测试 |
| `pnpm new-post <name>` | 创建新文章 |
| `pnpm d1:migrate:local` | 执行本地 D1 migrations |
| `pnpm d1:migrate:remote` | 执行远端 D1 migrations |
| `pnpm worker:deploy` | 部署 Cloudflare Worker |

## ☁️ 线上部署架构

当前生产环境拆成两个域名：

```text
blog.starshadow.cc  -> Vercel 前端
api.starshadow.cc   -> Cloudflare Worker 后端
```

Vercel 通过 `vercel.json` 构建 Astro 静态站点，并把同源请求转发到 Worker：

```json
{
  "source": "/api/:path*",
  "destination": "https://api.starshadow.cc/api/:path*"
}
```

Worker 通过 `wrangler.jsonc` 绑定到 `api.starshadow.cc/*`，负责处理：

- `/api/*`
- `/media/*`
- `/friends/admin/`，用于在 Cloudflare Access 保护下代理 Vercel 前端里的后台壳；导航里的“管理后台”会在当前标签页打开该地址。

`blog.starshadow.cc` 是否走纯 Vercel 线路取决于 Cloudflare DNS 记录状态：DNS only 会直连 Vercel，Proxied 会由 Cloudflare 代理回源 Vercel。

## ☁️ Cloudflare Worker 部署

Worker 只负责后端 API 和 R2 媒体访问，不再承载前端静态站点。`api.starshadow.cc` 必须在 Cloudflare 中绑定到 Worker 自定义域名或匹配 Worker route，否则 Vercel rewrites 无法正常访问后端。

### 1. 创建 Cloudflare 资源

需要准备：

- Cloudflare Worker
- D1 数据库，binding 名称必须是 `DB`
- R2 bucket，binding 名称必须是 `MEDIA_BUCKET`

`wrangler.jsonc` 当前声明了 Worker 路由、binding 名称和 migrations 目录：

```jsonc
"routes": [
  {
    "pattern": "api.starshadow.cc/*",
    "zone_name": "starshadow.cc"
  }
],
"d1_databases": [
  {
    "binding": "DB",
    "migrations_dir": "./migrations"
  }
],
"r2_buckets": [
  {
    "binding": "MEDIA_BUCKET"
  }
]
```

如果希望部署完全可复现，可以在确认 Cloudflare 资源后补充真实的：

- `database_name`
- `database_id`
- `bucket_name`

不要提交占位 ID 或测试资源 ID。

### 2. 配置 Secrets

必须配置：

```sh
wrangler secret put ADMIN_TOKEN
wrangler secret put CONTENT_SYNC_TOKEN
wrangler secret put VERCEL_DEPLOY_HOOK_URL
```

说明：

- `ADMIN_TOKEN` 用于 `/api/admin/*`、`/api/setup/init-db` 和 Twikoo 管理员登录。
- `CONTENT_SYNC_TOKEN` 用于 Vercel 构建时从 Worker 同步 R2 文章，也用于 Worker 拉取 Vercel 内部后台 shell。
- `VERCEL_DEPLOY_HOOK_URL` 用于后台发布/删除文章后触发 Vercel 重新构建。
- 生产环境建议像当前部署一样，用 Cloudflare Access 额外保护 `/friends/admin/` 和 `/api/admin/*`。
- Cloudflare Access 是边缘层保护，`Authorization: Bearer <ADMIN_TOKEN>` 是应用层保护；不要因为开启 Access 就移除 Worker 内置认证。
- 不要把 secret 写入 Git、`wrangler.jsonc` 或 GitHub Actions 明文环境变量。

### 3. 初始化 / 迁移 D1

远端迁移：

```sh
pnpm d1:migrate:remote
```

或者部署后调用初始化接口：

```sh
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://api.starshadow.cc/api/setup/init-db
```

初始化接口已经限流，并且不接受 token 放在 URL path / query 中。请使用 `Authorization: Bearer ...` 请求头，或在必要时使用 POST JSON body。

本地迁移：

```sh
pnpm d1:migrate:local
```

### 4. 构建与部署

Worker 部署命令：

```sh
pnpm worker:deploy
```

Vercel 前端部署使用 `vercel.json` 中的 `buildCommand`：`pnpm build`。构建前会执行 `scripts/sync-posts.mjs`，优先从 Worker/R2 拉取文章到 `src/content/posts/`。同步需要 `CONTENT_SYNC_BASE_URL` 或 `FUWARI_CONTENT_API_BASE_URL`，以及 `CONTENT_SYNC_TOKEN`。Vercel 的 `CONTENT_SYNC_TOKEN` 还用于保护内部后台 shell，必须与 Worker 的 `CONTENT_SYNC_TOKEN` 一致。如果 R2 文章清单为空、同步配置缺失或同步失败，默认会构建空文章列表；需要让同步失败直接阻断构建时，设置 `CONTENT_SYNC_STRICT=true`。仅本地调试需要保留本地草稿时，可以设置 `CONTENT_SYNC_ENABLED=false` 跳过同步。

GitHub Actions 中 Worker 部署会先尝试执行远端 D1 migrations，再部署 Worker；migration step 允许失败，避免权限或远端状态问题阻断 Worker 发布。

### 5. 部署后检查

部署完成后建议检查：

- `/api/comments/config` 是否返回评论配置。
- `/api/anti-abuse/challenge?context=comments` 是否返回 ALTCHA challenge。
- 评论区是否可以完成人机验证并提交评论；`blog.starshadow.cc` 前端写入 `api.starshadow.cc` Worker 是允许的可信跨域写入。
- Twikoo 管理员是否可以用 `ADMIN_TOKEN` 登录。
- `/api/friends` 是否能返回友链列表。
- `/api/music/tracks` 是否能返回音乐列表。
- `/api/stats/summary` 是否能返回访问统计。
- `https://api.starshadow.cc/media/*` 是否能访问预期 R2 对象。
- `https://blog.starshadow.cc/api/*` 是否经由 Vercel rewrites 正常转发到 Worker。
- `/friends/admin/` 和 `/api/admin/*` 是否被 Cloudflare Access 保护。
- `/api/admin/*` 是否仍必须携带 `Authorization: Bearer <ADMIN_TOKEN>`。

## 🔐 安全说明

项目中的公开写接口会尽量使用：

- Origin / Referer 写保护；同源请求允许，生产中的 `blog.starshadow.cc` 前端写入 `api.starshadow.cc` Worker 也允许
- D1 rate limiting
- ALTCHA 人机验证
- JSON body size 限制
- R2 object key 规范化
- D1 prepared statements
- 安全响应头

部署和维护时请注意：

- 使用高强度 `ADMIN_TOKEN` 和 `CONTENT_SYNC_TOKEN`。
- 对后台路径保留 Cloudflare Access + Worker Bearer token 双层保护。
- 定期查看 Cloudflare Worker 日志和 GitHub Actions 结果。
- 不要在仓库中提交 `.env`、Cloudflare token、R2/D1 secret 或任何私钥。
- 修改认证、评论、友链、媒体上传相关代码后务必运行测试和线上回归。

## ✅ 质量检查

提交前建议运行：

```sh
pnpm lint
pnpm format:check
pnpm test
pnpm astro check
pnpm astro sync && pnpm type-check
pnpm build
git diff --check
```

## 📄 License

本项目基于 Fuwari / Astro 生态二次开发，遵循仓库中的许可证文件。
