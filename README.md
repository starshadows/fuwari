# 星影的博客

![Node.js >= 22](https://img.shields.io/badge/node.js-%3E%3D22-brightgreen)
![pnpm >= 9](https://img.shields.io/badge/pnpm-%3E%3D9-blue)
![Astro 6](https://img.shields.io/badge/Astro-6-orange)
![Cloudflare Worker](https://img.shields.io/badge/Cloudflare-Worker-f38020)

这里是 **星影** 的个人博客项目，用来记录踩过的坑、学到的东西和一些日常内容。

站点基于 Fuwari 主题二次开发，前端使用 Astro + Svelte + Tailwind CSS，后端通过 Cloudflare Worker 提供 API，并使用 D1 / R2 支撑评论、友链、音乐和访问统计等动态功能。

## ✨ 功能特性

- Astro 静态博客页面，支持文章、归档、关于页、RSS、站点地图。
- Svelte 交互组件，包括搜索、音乐播放器、访客统计、友链申请和后台管理。
- Pagefind 本地全文搜索。
- Twikoo 兼容评论区，支持 ALTCHA 人机验证、评论开关和 Telegram 通知。
- 友链系统，支持公开申请、后台审核和 Telegram 通知。
- 音乐列表，支持从 R2 `music/` 前缀扫描音频并读取 ID3 元数据。
- 访问统计，支持 PV / UV / 今日 / 昨日 / 月访问量和实时在线人数。
- Cloudflare Worker 一体化部署：静态资源、API、R2 媒体访问都由同一个 Worker 提供。
- 安全加固：Origin/Referer 写保护、公开写接口限流、ALTCHA、D1 prepared statements、R2 key 规范化、安全响应头。

## 🧱 技术栈

- **Frontend**: Astro 6, Svelte 5, Tailwind CSS, Pagefind
- **Worker API**: Cloudflare Workers, TypeScript
- **Database**: Cloudflare D1
- **Object Storage**: Cloudflare R2
- **Quality**: Biome, Vitest, TypeScript
- **Package Manager**: pnpm 9

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
wrangler.jsonc         # Cloudflare Worker 配置
```

## 🚀 本地开发

环境要求：

- Node.js `>=22.22.0`
- pnpm `>=9`

安装依赖：

```sh
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

完整本地开发时通常需要同时运行 `pnpm dev` 和 `pnpm worker:dev`。线上部署后，静态资源和 API 会由同一个 Cloudflare Worker 提供。

## ✍️ 写文章

创建新文章：

```sh
pnpm new-post <filename>
```

文章位于：

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
| `pnpm build` | 构建站点并生成 Pagefind 索引 |
| `pnpm preview` | 本地预览构建产物 |
| `pnpm check` | Astro 类型检查 |
| `pnpm type-check` | TypeScript 类型检查 |
| `pnpm lint` | Biome 只读检查 |
| `pnpm format` | Biome 格式化并自动修复 |
| `pnpm test` | 运行 Vitest 测试 |
| `pnpm new-post <name>` | 创建新文章 |
| `pnpm d1:migrate:local` | 执行本地 D1 migrations |
| `pnpm d1:migrate:remote` | 执行远端 D1 migrations |
| `pnpm worker:deploy` | 构建并部署 Cloudflare Worker |

## ☁️ Cloudflare Worker 部署

这个项目不是纯静态 Astro 部署。构建后的 `dist/` 会作为 Worker Assets 发布，同时 Worker 负责处理：

- `/api/*`
- `/media/*`
- 静态页面和资源

### 1. 创建 Cloudflare 资源

需要准备：

- Cloudflare Worker
- D1 数据库，binding 名称必须是 `DB`
- R2 bucket，binding 名称必须是 `MEDIA_BUCKET`
- Worker Assets，binding 名称是 `ASSETS`，目录是 `./dist`

`wrangler.jsonc` 当前声明了 binding 名称和 migrations 目录：

```jsonc
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
wrangler secret put TWIKOO_ADMIN_PASSWORD
```

说明：

- `ADMIN_TOKEN` 用于 `/api/admin/*` 和 `/api/setup/init-db`。
- `TWIKOO_ADMIN_PASSWORD` 用于 Twikoo 管理员登录。
- 不要把 secret 写入 Git、`wrangler.jsonc` 或 GitHub Actions 明文环境变量。

### 3. 初始化 / 迁移 D1

远端迁移：

```sh
pnpm d1:migrate:remote
```

或者部署后调用初始化接口：

```sh
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://<your-domain>/api/setup/init-db
```

初始化接口已经限流，并且不接受 token 放在 URL path / query 中。请使用 `Authorization: Bearer ...` 请求头，或在必要时使用 POST JSON body。

本地迁移：

```sh
pnpm d1:migrate:local
```

### 4. 构建与部署

```sh
pnpm worker:deploy
```

该命令会先执行 `pnpm build`，再执行 `wrangler deploy`。

GitHub 自动部署可使用类似命令：

```sh
corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm build
```

### 5. 部署后检查

部署完成后建议检查：

- `/api/comments/config` 是否返回评论配置。
- `/api/anti-abuse/challenge?context=comments` 是否返回 ALTCHA challenge。
- 评论区是否可以完成人机验证并提交评论。
- Twikoo 管理员是否可以用 `TWIKOO_ADMIN_PASSWORD` 登录。
- `/api/friends` 是否能返回友链列表。
- `/api/music/tracks` 是否能返回音乐列表。
- `/api/stats/summary` 是否能返回访问统计。
- `/media/*` 是否能访问预期 R2 对象。
- `/api/admin/*` 是否必须携带 `Authorization: Bearer <ADMIN_TOKEN>`。

## 🔐 安全说明

项目中的公开写接口会尽量使用：

- Origin / Referer same-origin 检查
- D1 rate limiting
- ALTCHA 人机验证
- JSON body size 限制
- R2 object key 规范化
- D1 prepared statements
- 安全响应头

部署和维护时请注意：

- 使用高强度 `ADMIN_TOKEN` 和 `TWIKOO_ADMIN_PASSWORD`。
- 定期查看 Cloudflare Worker 日志和 GitHub Actions 结果。
- 不要在仓库中提交 `.env`、Cloudflare token、R2/D1 secret 或任何私钥。
- 修改认证、评论、友链、媒体上传相关代码后务必运行测试和线上回归。

## ✅ 质量检查

提交前建议运行：

```sh
pnpm lint
pnpm test
pnpm type-check
pnpm build
git diff --check
```

## 📄 License

本项目基于 Fuwari / Astro 生态二次开发，遵循仓库中的许可证文件。
