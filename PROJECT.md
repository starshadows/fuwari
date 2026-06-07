# 星影博客项目文档

> 本文档是项目的唯一参考文档，同时面向人类维护者和 AI 助手（Claude Code 等）。
> 如果你刚接手这个项目，从头读到尾就能理解全部架构和日常操作。

---

## 1. 项目概述

这是一个基于 **Astro 6** + **Svelte 5** + **Tailwind CSS 3** 的静态博客，当前线上采用 **Vercel 前端 + Cloudflare Workers 后端** 的分离部署。
原始主题是 Fuwari（saicaca/fuwari），经过大量定制后形成当前版本。

博客地址：https://blog.starshadow.cc/
后端地址：https://api.starshadow.cc/

### 核心理念

**静态博客 + 少量运行时能力。**

- **静态部分**（Astro SSG on Vercel）：文章、页面布局、主题样式、搜索索引、RSS。
- **动态部分**（Cloudflare Worker on api.starshadow.cc）：友链审核、音乐管理、文章后台、访客统计、评论系统、文件上传。

这样做的好处：
- 写文章可以继续使用 Markdown + Git Push，也可以通过后台上传文章 ZIP 到 R2。
- 友链审核、添加音乐等频繁变动的内容不需要重新构建站点。
- 后台发布/删除文章时可以通过 Vercel Deploy Hook 触发前端重建。
- 音频和图片存在 R2，不污染 Git 仓库。
- 访客统计数据实时生效。

---

## 2. 技术栈

| 层面 | 技术 | 说明 |
|------|------|------|
| 框架 | Astro 6 | SSG 模式，输出纯静态 HTML |
| 交互组件 | Svelte 5 | 音乐播放器、友链面板、统计卡片、后台管理 |
| 样式 | Tailwind CSS 3 + Stylus | Fuwari 原有的 OKLCH 色彩变量体系 |
| 静态搜索 | Pagefind 1.5 | 构建时生成索引到 dist/pagefind |
| 页面过渡 | Swup | SPA 风格页面切换 |
| 代码高亮 | Expressive Code | 行号、折叠、语言标识、复制按钮 |
| 数学公式 | KaTeX | 服务端渲染 |
| 图片预览 | PhotoSwipe 5 | 文章配图点击放大 |
| 人机验证 | ALTCHA | SHA-256 工作量证明 |
| 评论系统 | Twikoo（自托管） | 适配为 Worker 版本 |
| 图标 | Iconify + astro-icon | Font Awesome 6 + Material Symbols |
| 字体 | Roboto + JetBrains Mono | 正文 + 等宽代码 |
| HTML 净化 | sanitize-html | 评论内容安全过滤 |
||||
| 前端部署 | Vercel | 托管 Astro 静态站点，rewrites 转发 API/media |
| 运行时 | Cloudflare Workers | 处理 api.starshadow.cc 上的 /api/* 和 /media/* |
| 数据库 | Cloudflare D1 | SQLite 兼容，存友链/音乐/评论/统计/配置 |
| 对象存储 | Cloudflare R2 | 存头像/音乐/封面/评论图片 |
| 部署工具 | Wrangler 4 | 本地开发和线上部署 |
||||
| 包管理器 | pnpm 9.14.4 | `packageManager` 和 CI 显式锁定 |
| 语言 | TypeScript 6 | 全栈类型检查 |
| 代码检查 | Biome 2.4 | 格式化和 lint，tab 缩进 |
| 测试 | Vitest 4 | Worker-focused 测试，当前 178 个用例 |
| Node | 24.x | `.node-version`、`.nvmrc` 和 CI 固定 `24.13.1`；`package.json#engines.node` 用 Vercel 兼容的 `24.x`；`.npmrc` 启用 `engine-strict` |

---

## 3. 快速开始

### 本地开发

```bash
# 安装依赖
nvm install
nvm use
corepack enable
corepack pnpm install

# 启动 Astro 开发服务器（纯前端）
corepack pnpm dev
# 访问 http://localhost:4321

# 如果要测试 Worker API：
corepack pnpm build          # 先构建静态站点
corepack pnpm d1:migrate:local  # 初始化本地 D1
corepack pnpm worker:dev     # 启动 Worker
# 访问 http://localhost:8787
```

### 常用命令

```bash
pnpm dev             # Astro 开发服务器
pnpm build           # 构建 + Pagefind 索引
pnpm preview         # 预览构建产物
pnpm check           # Astro 类型检查
pnpm type-check      # tsc 类型检查
pnpm test            # 运行所有测试
pnpm test:watch      # 监听模式测试
pnpm format          # Biome 格式化 + 可自动修复的 lint
pnpm lint            # Biome CI 检查（不改文件）
pnpm new-post <name> # 创建新文章
pnpm worker:dev      # Worker 本地开发
pnpm worker:deploy   # 构建并部署 Worker
```

### 开始写文章前必须执行

```bash
corepack pnpm lint     # 检查格式和 lint
corepack pnpm check    # Astro 检查
corepack pnpm astro sync && corepack pnpm type-check # TypeScript 类型检查
corepack pnpm test     # 确保测试通过
corepack pnpm build    # 确保能正常构建
```

以上命令按本次改动范围选择执行；涉及类型生成时先运行 `pnpm astro sync` 再运行 `pnpm type-check`。

---

## 4. 项目结构

```text
/
├── src/
│   ├── config.ts               # 【总开关】站点标题/主题色/导航/头像/banner
│   ├── content.config.ts       # Zod 校验的文章元数据 schema
│   ├── content/
│   │   ├── posts/              # 文章（Markdown + 本地图片）
│   │   └── spec/about.md       # 关于页面
│   ├── pages/
│   │   ├── [...page].astro     # 首页（分页，8 篇/页）
│   │   ├── posts/[...slug].astro  # 文章详情页
│   │   ├── about.astro         # 关于页
│   │   ├── archive.astro       # 归档页
│   │   ├── friends/            # 友链展示/申请/后台
│   │   ├── robots.txt.ts       # 动态 robots.txt
│   │   └── rss.xml.ts          # RSS 输出（全文）
│   ├── layouts/
│   │   ├── Layout.astro        # 根 HTML 壳（主题初始化/字体/Swup/PhotoSwipe）
│   │   └── MainGridLayout.astro  # 主内容+侧边栏布局
│   ├── components/
│   │   ├── widget/             # 侧边栏组件（Profile/TOC/Categories/Tags/
│   │   │                       #   MusicPlayer/VisitorStats/DisplaySettings/
│   │   │                       #   NavMenuPanel/SideBar）
│   │   ├── control/            # 导航控件（BackToTop/Pagination/ButtonLink）
│   │   ├── comments/           # TwikooComments（Svelte）
│   │   ├── friends/            # FriendLinksPanel/FriendAdminPanel（Svelte）
│   │   ├── anti-abuse/         # HumanProof（ALTCHA）
│   │   ├── misc/               # ImageWrapper/License/Markdown
│   │   └── SakanaWidget.astro  # 摇摇乐挂件
│   ├── plugins/                # remark/rehype 插件
│   │   ├── remark-reading-time.mjs    # 字数+阅读时间
│   │   ├── remark-excerpt.js          # 自动摘要
│   │   ├── remark-directive-rehype.js # 指令转 rehype
│   │   ├── rehype-component-admonition.mjs  # 提示块
│   │   ├── rehype-component-github-card.mjs # GitHub 仓库卡片
│   │   └── expressive-code/           # 代码块自定义
│   ├── i18n/                   # 10 种语言
│   ├── styles/                 # 全局 CSS/Stylus
│   ├── constants/              # 页面宽度/baner高度/图标集
│   ├── utils/                  # URL/日期/设置/内容查询工具
│   ├── types/config.ts         # TypeScript 接口
│   └── worker/
│       ├── index.ts            # Worker 入口 + 路由分发
│       ├── db.ts               # 版本化 D1 迁移
│       ├── utils.ts            # 共享工具（响应/缓存/限流/鉴权/音乐元数据）
│       ├── comments.ts         # 评论会话 + Twikoo 代理
│       ├── twikoo-adapter.ts   # Twikoo 协议适配（sanitize-html 净化）
│       ├── friends.ts          # 友链接口 + Telegram 通知
│       ├── music.ts            # 音乐 CRUD + R2 扫描 + 导入
│       ├── stats.ts            # 访客统计 + 数据清理
│       ├── admin.ts            # 后台管理 API
│       ├── anti-abuse.ts       # ALTCHA 验证码
│       ├── media.ts            # R2 媒体服务（支持 Range）
│       ├── id3.ts              # MP3 ID3v2 标签解析
│       ├── constants.ts        # 所有常量 + API 错误消息
│       ├── types/              # Env + 类型定义
│       └── __tests__/          # 测试文件
│           ├── utils.test.ts   # Worker 工具函数测试（80 个）
│           └── api.test.ts     # Worker API/集成测试（98 个）
├── public/
│   ├── favicon/                # 明暗两套 favicon
│   ├── sakana/starshadow.webp  # 摇摇乐角色图
│   └── vendor/sakana/          # 摇摇乐运行时
├── migrations/                 # D1 SQL 迁移文件
│   ├── 0001_create_social_features.sql
│   ├── 0002_create_visitor_stats.sql
│   ├── 0003_create_rate_limits.sql
│   └── 0004_create_comments_and_notifications.sql
├── astro.config.mjs            # Astro 配置（集成+Markdown 插件）
├── vercel.json                 # Vercel 构建配置 + /api /media rewrites
├── wrangler.jsonc              # Cloudflare Worker 配置
├── vitest.config.ts            # 测试配置
├── biome.json                  # Biome 格式化/lint 配置
├── tailwind.config.cjs         # Tailwind CSS 配置
├── tsconfig.json               # TypeScript 配置
├── svelte.config.js            # Svelte 配置
├── package.json                # 依赖和脚本
├── PROJECT.md                  # 【本文档】项目参考文档
└── AGENTS.md                   # OpenCode/AI 助手专用的高信号指令
```

---

## 5. 架构详解

### 5.1 前端（Astro 静态站点）

**路由系统：** Astro 文件路由。
- `/` → `[...page].astro` 分页首页
- `/posts/<slug>/` → `posts/[...slug].astro` 文章详情
- `/archive/` → 归档（按标签/分类筛选）
- `/about/` → 关于页
- `/friends/` → 友链展示
- `/friends/apply/` → 友链申请
- `/friends/admin/` → 后台管理页；导航里的“管理后台”指向 `https://api.starshadow.cc/friends/admin/` 并覆盖当前标签页打开，以便经过 Cloudflare Access 保护
- `/rss.xml` → RSS 输出
- `/robots.txt` → robots.txt

**文章系统：** Astro Content Collections。
- 文章存放在 `src/content/posts/`
- 支持单文件文章（`hello.md`）和目录文章（`some-post/index.md` + 本地图片）
- Frontmatter 用 Zod schema 校验（title/published/description/tags/category/draft 等）
- `draft: true` 的文章不会出现在生产构建中

**页面过渡：** Swup 实现 SPA 风格切换。
- `Layout.astro` 在 Swup 钩子上处理 baner 高度、TOC 显示、PhotoSwipe 重建
- Swup 容器的 CSS 选择器：`main` 和 `#toc`

**主题系统：**
- 明/暗/自动三种模式，存 localStorage
- 主题色（hue）可用户自定义，存 localStorage
- 内联 `<script>` 在页面渲染前设置，避免闪烁

**滚动条：** 原生 CSS（`scrollbar-width: thin`），KaTeX 公式溢出时用 OverlayScrollbars。

**图片：** `ImageWrapper.astro` 用 Astro Image 组件自动生成 webp + srcset。

**搜索：** Pagefind 在 `pnpm build` 后用 `--force-language zh` 索引 `dist/`。开发模式下搜索返回空结果是正常的。

### 5.2 线上部署与路由

当前生产环境不是 Worker 一体化托管前端，而是拆成两个入口：

```text
blog.starshadow.cc  -> Vercel 前端
api.starshadow.cc   -> Cloudflare Worker 后端
```

`vercel.json` 负责 Vercel 构建和同源转发：

```json
{
  "buildCommand": "pnpm build",
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://api.starshadow.cc/api/:path*"
    },
    {
      "source": "/media/:path*",
      "destination": "https://api.starshadow.cc/media/:path*"
    }
  ]
}
```

这样浏览器仍访问 `https://blog.starshadow.cc/api/*` 和 `https://blog.starshadow.cc/media/*`，但请求会由 Vercel 转发到 Worker 自定义域名，避免跨域问题。

`wrangler.jsonc` 当前 Worker route 是：

```jsonc
"routes": [
  {
    "pattern": "api.starshadow.cc/*",
    "zone_name": "starshadow.cc"
  }
]
```

`api.starshadow.cc` 必须在 Cloudflare 中绑定到 Worker 自定义域名或匹配 Worker route。只创建 route 但未绑定域名时，线上访问不会按预期命中 Worker。

`blog.starshadow.cc` 的 Cloudflare DNS 状态决定前端线路：
- DNS only / 灰云：直连 Vercel，最接近纯 Vercel 线路，但国内可访问性取决于 Vercel 入口 IP。
- Proxied / 橙云：Cloudflare 代理回源 Vercel，可绕开部分 Vercel IP 被墙问题，但不再是纯 Vercel 直连。

### 5.3 后端（Cloudflare Worker）

**入口：** `src/worker/index.ts`

请求路由：
1. `/api/*` → `handleApi()` 动态 API
2. `/media/*` → `handleMedia()` R2 媒体文件
3. `/friends/admin/` → 代理 Vercel 前端里的后台壳，便于 Cloudflare Access 保护
4. 其他路径 → 404（生产前端由 Vercel 提供）

**Worker 绑定：**
```
DB           → D1 数据库
MEDIA_BUCKET → R2 对象存储
ADMIN_TOKEN  → 后台管理口令
CONTENT_SYNC_TOKEN       → Vercel 构建同步 R2 文章用 token
VERCEL_DEPLOY_HOOK_URL   → 后台文章发布/删除后触发 Vercel 重建
TWIKOO_ADMIN_PASSWORD    → Twikoo 管理员密码
```

**关键后端模式：**
- 所有响应走 `withSecurityHeaders()`（CSP/Referrer-Policy/X-Content-Type-Options/Permissions-Policy）
- 所有响应走 `withServerTiming()`（响应耗时）
- 公开 GET 接口用 `cachedResponseV()` 版本化缓存
- Admin 写操作调用 `incrementCacheVersion()` 使缓存失效
- Admin 鉴权：统一先做限流再验证（防止时序侧信道）
- 公开写接口（友链申请/评论/统计）：`rejectCrossSiteWrite()` + ALTCHA + D1 限流；评论支持生产部署中的 `blog.starshadow.cc` 前端写入 `api.starshadow.cc` Worker
- Twikoo CORS 只对同源请求返回 credential 头

### 5.4 数据库设计

通过 `GET /api/setup/init-db` 或 `POST /api/setup/init-db` + `Authorization: Bearer <ADMIN_TOKEN>` 初始化。
迁移是版本化的（`db_migration_version` 字段追踪），只会应用未执行的迁移。

**app_settings** — 键值对配置表
- `admin_token_sha256` — 兼容旧部署的后台 token 存储哈希；生产优先使用 `ADMIN_TOKEN` Secret
- `db_migration_version` — 当前迁移版本号
- `stats_salt` — 访客统计哈希盐
- `comments_enabled` — 评论开关
- `telegram_friend_notification` — Telegram 通知配置 JSON
- `cv_friends` / `cv_comments_config` / `cv_music` — 缓存版本号

**friend_links** — 友链
- 字段：name, description, url, avatar_url, status (pending/approved/rejected), is_active, sort_order

**music_tracks** — 音乐
- 字段：title, artist, album, object_key (R2 key), cover_url, is_active, sort_order

**comment / config / counter** — Twikoo 评论系统（三张表）

**stats_*** — 访客统计（7 张表）
- stats_visitors — 全站唯一访客
- stats_page_visitors — 页面唯一访客
- stats_site_daily — 全站每日 PV/UV
- stats_page_daily — 页面每日 PV/UV
- stats_daily_visitors — 每日唯一访客去重
- stats_page_daily_visitors — 页面每日唯一访客去重
- stats_active_visitors — 实时在线（5 分钟心跳窗口）
- 超过 2 年的数据自动清理

**rate_limits** — 限流（D1 滑动窗口）
- 按 scope + actor_hash + window_start 三元组计数

### 5.5 API 总览

#### 公开 API

```text
# 友链
GET  /api/friends                          → 已审核且启用的友链列表
POST /api/friends                          → 提交友链申请（需要 ALTCHA）

# 反滥用
GET  /api/anti-abuse/challenge?context=    → 获取 ALTCHA challenge

# 音乐
GET  /api/music/tracks                     → 已启用的音乐列表

# 访客统计
POST /api/stats/visit                      → 记录页面访问
POST /api/stats/heartbeat                  → 记录心跳（每分钟）
GET  /api/stats/summary?path=              → 获取统计数据

# 评论
GET  /api/comments/config                  → 评论是否启用
POST /api/comments/session                 → 创建评论 session（需要 ALTCHA）
POST /api/twikoo                           → Twikoo 协议（评论 CRUD）

# 媒体文件
GET  /media/music/<key>                    → R2 音乐文件（支持 Range）
GET  /media/avatars/<key>                  → R2 头像
GET  /media/covers/<key>                   → R2 封面
GET  /media/covers/from-music/<key>        → MP3 内嵌封面
GET  /media/twikoo/<key>                   → Twikoo 上传的图片
```

#### 后台 API（需要 Authorization: Bearer <token>）

```text
# 友链管理
GET    /api/admin/friends?status=          → 列出（可按状态筛选）
PATCH  /api/admin/friends/:id              → 更新
DELETE /api/admin/friends/:id              → 删除
POST   /api/admin/avatar                   → 上传头像到 R2

# 音乐管理
GET    /api/admin/music                    → 列出所有
POST   /api/admin/music                    → 手动添加
PATCH  /api/admin/music/:id                → 更新
DELETE /api/admin/music/:id                → 删除
GET    /api/admin/music/objects            → 扫描 R2 中未入库的音频
POST   /api/admin/music/import             → 批量导入 R2 音频

# 文章内容管理
GET    /api/admin/content                  → 列出 R2/D1 中的文章
POST   /api/admin/content                  → 上传文章 ZIP 为草稿
GET    /api/admin/content/:slug            → 读取文章 Markdown 预览
POST   /api/admin/content/:slug/publish    → 发布文章并触发 Vercel 部署
POST   /api/admin/content/:slug/unpublish  → 取消发布并触发 Vercel 部署
POST   /api/admin/content/:slug/deploy     → 重试指定文章部署
POST   /api/admin/content/deploy           → 触发 Vercel 部署
DELETE /api/admin/content/:slug            → 删除文章并触发 Vercel 部署

# 设置
GET    /api/admin/settings/comments        → 评论开关状态
POST   /api/admin/settings/comments        → 设置评论开关
GET    /api/admin/settings/telegram        → Telegram 通知配置
POST   /api/admin/settings/telegram        → 更新 Telegram 通知配置
POST   /api/admin/settings/telegram/test   → 发送测试通知
```

#### 初始化 API

```text
GET  /api/setup/init-db    → 初始化/升级数据库
POST /api/setup/init-db    → 同上
```

需要通过 `Authorization: Bearer <token>` 头或 POST JSON body 传 token。
URL 参数中的 token 会被拒绝（安全原因）。

#### 内容同步 API（需要 CONTENT_SYNC_TOKEN）

```text
GET /api/content/manifest      → Vercel 构建时读取文章清单
GET /api/content/object?key=   → Vercel 构建时下载文章对象
```

Vercel 构建前会运行 `scripts/sync-posts.mjs`。只有 `CONTENT_SYNC_ENABLED=true` 时才会尝试同步；同步还需要 `CONTENT_SYNC_BASE_URL` 或 `FUWARI_CONTENT_API_BASE_URL`，以及 `CONTENT_SYNC_TOKEN`。启用后会从 Worker 拉取 R2 中的文章到 `src/content/posts/` 再构建；同步失败默认保留本地文章继续构建。需要同步失败直接阻断构建时，设置 `CONTENT_SYNC_STRICT=true`。

---

## 6. 核心功能详解

### 6.1 文章系统

**新建文章：**
```bash
pnpm new-post my-article-name
```

这会创建 `src/content/posts/my-article-name.md`。

**Frontmatter 格式：**
```yaml
---
title: 文章标题
published: 2026-05-30
description: 简短摘要
image: ''                    # 空或相对路径
tags: [标签1, 标签2]
category: 折腾记录
draft: false                  # true=草稿（不发布），false=发布
lang: ''                     # 留空用站点默认语言
---
```

**配图方式：**
- 单文件文章：图片放 `src/assets/images/`，frontmatter 写 `assets/images/xxx.png`
- 目录文章：创建 `src/content/posts/<slug>/index.md` + 图片，frontmatter 写 `cover.png` 或 `./step01.png`

**Markdown 扩展语法：**
- 提示块：`> [!NOTE]`、`> [!WARNING]`、`> [!TIP]`、`> [!IMPORTANT]`、`> [!CAUTION]`
- GitHub 仓库卡片：`::github{repo=user/repo}`（静态渲染）
- 代码块：自动行号、语言标识、复制按钮、折叠

### 6.2 配置文件

`src/config.ts` 是博客总开关：

```ts
siteConfig.title        // 站点标题
siteConfig.lang         // 默认语言（zh_CN）
siteConfig.themeColor   // 主题色 hue + 是否允许用户自选
siteConfig.banner       // 顶部大图
siteConfig.toc          // 文章目录深度
siteConfig.favicon      // 自定义 favicon

navBarConfig.links      // 导航栏链接
profileConfig           // 头像/昵称/简介/社交链接
licenseConfig           // 文章版权声明
```

### 6.3 友链系统

**申请流程：**
1. 访客访问 `/friends/apply/`
2. 填写名称、简介、链接、头像
3. 完成 ALTCHA 人机验证
4. `POST /api/friends` 提交，状态为 `pending`

**审核流程：**
1. 管理员通过导航访问 `https://api.starshadow.cc/friends/admin/`，Worker 代理后台壳并建议开启 Cloudflare Access
2. 输入后台 token 登录
3. 审核（通过/拒绝）、编辑、删除、排序

**安全措施：**
- URL 必须是 https://
- 头像必须是 https:// 或站内 /media/ 路径
- 同一 URL 不能重复提交
- D1 限流 + ALTCHA 验证

### 6.4 音乐系统

**添加音乐：**
1. 将音频文件上传到 R2 的 `music/` 目录
2. 进入后台 → 音乐 → 扫描 R2
3. 系统读取 MP3 ID3 标签（标题/艺术家/专辑/封面）
4. 对非 MP3 文件或缺失标签的，从文件名推断
5. 点击导入入库
6. 内嵌封面自动保存到 R2 `covers/` 目录

**播放器功能：**
- 位于左侧侧边栏，个人简介下方
- 默认不自动播放
- 支持播放/暂停、上一首/下一首、进度拖动、音量调节
- 展开歌单切歌
- 三种播放模式：随机、单曲循环、顺序
- 音频通过 `/media/music/<key>` 获取，支持 HTTP Range 拖动进度

**性能优化：**
- ID3 标签只读取文件前 256 KB
- 扫描结果有 5 分钟内存缓存
- 无需每次请求都重新扫描 R2

### 6.5 访客统计

**数据采集：**
- 页面加载时 `POST /api/stats/visit` 记录一次访问
- 页面停留时每分钟 `POST /api/stats/heartbeat` 更新在线状态
- 不会重复计 PV（每日去重）

**展示指标（侧边栏）：**
- 当前在线：最近 5 分钟有心跳的访客
- 今日访客 / 今日浏览
- 昨日浏览 / 本月浏览
- 总浏览 / 总访客
- 近 7 日趋势图

**隐私保护：**
- 访客识别用浏览器本地随机 ID + Worker D1 随机盐 → SHA-256
- 仅存哈希，不存原始 IP 或原始 visitor ID
- 超过 2 年的统计数据自动清理

### 6.6 评论系统

基于 Twikoo 协议的自托管评论，运行在 Worker 上。

**评论流程：**
1. 页面加载时先展示已有评论列表（只读，无需验证）
2. 发帖前完成 ALTCHA 验证，获取 20 分钟 session cookie
3. 发帖时携带 session cookie，Worker 验证通过后写入 D1
4. 博主评论自动标记（通过邮箱匹配）

评论总开关只拦截 `COMMENT_SUBMIT` 等发帖写入动作。Twikoo 的只读事件和管理端事件仍会交给 Twikoo adapter 处理，避免关闭前台评论时把后台管理、登录和历史评论读取一并锁死。

**安全措施：**
- 发帖需要 ALTCHA + session cookie
- 评论内容用 sanitize-html 白名单净化（只允许 b/i/em/strong/a/code/pre/blockquote/br/p/ul/ol/li）
- 支持屏蔽词过滤（BLOCKED_WORDS）和标记词（FORBIDDEN_WORDS）
- 按 IP 和全站维度限流
- Twikoo CORS 只对同源请求返回 credential 头

### 6.7 摇摇乐（Sakana Widget）

右下角的 Live2D 风格悬浮角色。

**行为：**
- 桌面端默认启用，右下角固定
- 移动端默认关闭，导航菜单有开关
- 点击关闭按钮桌面端临时关闭本次会话，移动端写入 localStorage
- 控件：角色、上游仓库、自动模式、关闭

**技术细节：**
- 运行时文件在 `public/vendor/sakana/`
- 角色图 `public/sakana/starshadow.webp`
- 环境变量 `PUBLIC_SAKANA_WIDGET_ENABLED=false` 可全局禁用
- Swup 兼容：监听 `page:view` 钩子重建

---

## 7. 安全设计

### 7.1 CSP 响应头

所有 Worker 响应都会添加：
```
base-uri 'self'; object-src 'none'; frame-ancestors 'none';
form-action 'self'; frame-src 'none'; upgrade-insecure-requests
```

没有设置 `script-src`，因为 Astro/Swup 的前端页面需要内联脚本。
其他安全头：X-Content-Type-Options: nosniff、Referrer-Policy: strict-origin-when-cross-origin、Permissions-Policy。

### 7.2 鉴权

- Admin token 支持两种模式：环境变量 `ADMIN_TOKEN`（Secret 明文比较，优先）或 D1 存储的兼容哈希
- 所有 auth 路径统一先做限流再验证，防止通过时序/429 存在性探测 auth 配置状态
- Token 不能放在 URL 参数中传递

### 7.3 限流

D1 滑动窗口实现，每个 scope 独立配置：
- 友链申请：5 次 / 10 分钟
- 评论 session：8 次 / 10 分钟
- 统计写入：240 次 / 10 分钟
- Admin 失败：30 次 / 5 分钟

### 7.4 其他

- 公开写接口检查 Origin/Referer（`rejectCrossSiteWrite()`）；除同源外，生产允许 `blog.starshadow.cc` 前端写入 `api.starshadow.cc` Worker
- 头像上传限制 JPG/PNG/WebP/AVIF/GIF，最大 3MB
- 评论 HTML 用 sanitize-html 白名单净化
- 友链 URL 必须 https://
- 访客哈希用 SHA-256 + 随机盐，不存原始 IP

---

## 8. 测试

### 运行测试

```bash
pnpm test           # 运行全部测试
pnpm test:watch     # 监听模式
```

### 测试覆盖

**utils.test.ts（80 个单元测试）：**
- readString / readInteger / readBoolean / clampInteger
- safeNormalizeMediaKey / safeDecodeURIComponent / stripMediaPrefix
- base64UrlEncode / base64UrlDecode
- timingSafeEqual / maskSecret
- isSameOrigin / 可信前端到 API Worker 写入 / isHttpsUrl / isAvatarUrl
- sanitizeFileName / isLikelyBot

**api.test.ts（98 个集成测试）：**
- 路由分发（API/静态/404/410）
- 安全响应头（CSP/nosniff/referrer-policy）
- 跨站请求保护
- Admin 鉴权
- ALTCHA challenge 返回
- 媒体路径校验

---

## 9. 部署

### Vercel 前端配置

Vercel 项目绑定 `blog.starshadow.cc`，构建配置由 `vercel.json` 管理：

```json
{
  "buildCommand": "pnpm build",
  "installCommand": "pnpm install --frozen-lockfile",
  "outputDirectory": "dist"
}
```

Vercel 需要配置：

- 自定义域名：`blog.starshadow.cc`
- 环境变量：`CONTENT_SYNC_BASE_URL=https://api.starshadow.cc`
- 环境变量：`CONTENT_SYNC_TOKEN`，必须与 Worker 的 `CONTENT_SYNC_TOKEN` 一致
- 环境变量：`CONTENT_SYNC_ENABLED=true`，启用构建前从 Worker 同步 R2 文章
- 可选环境变量：`CONTENT_SYNC_STRICT=true`，用于让内容同步失败时直接阻断构建

`blog.starshadow.cc` 在 Cloudflare DNS 中可以使用：

- `CNAME cname.vercel-dns.com` + DNS only：直连 Vercel
- `CNAME cname.vercel-dns.com` + Proxied：Cloudflare 代理回源 Vercel

### Cloudflare 资源配置

在 Cloudflare 控制台：
1. 创建 Worker（通过 GitHub 自动部署或 wrangler deploy）
2. 创建 D1 数据库（名称随意）
3. 创建 R2 存储桶（名称随意）
4. 将 `api.starshadow.cc` 绑定到 Worker 自定义域名或确保 Worker route 生效
5. 在 Worker 设置中绑定：
   - D1 绑定名：`DB`
   - R2 绑定名：`MEDIA_BUCKET`
   - Secret `ADMIN_TOKEN`
   - Secret `TWIKOO_ADMIN_PASSWORD`
   - Secret `CONTENT_SYNC_TOKEN`
   - Secret `VERCEL_DEPLOY_HOOK_URL`

### 初始化数据库

部署完成后，用 `Authorization` 头调用初始化接口：

```bash
curl -H "Authorization: Bearer <你的token>" https://api.starshadow.cc/api/setup/init-db
```

Worker 必须配置 `ADMIN_TOKEN` Secret 后才能初始化数据库；初始化接口不再接受 URL path/query 中的 token。

### GitHub 自动部署

当前有三类 workflow：

- `build.yml`：对 push / PR 运行 audit、Biome、Astro check、type-check、test、build。
- `deploy-worker.yml`：当 Worker、migrations、wrangler 或依赖配置变化时部署 Cloudflare Worker。
- `biome.yml`：使用 Biome 官方 action 做代码质量检查。

`deploy-worker.yml` 会先执行远端 D1 migrations，再执行 `pnpm worker:deploy`。远端迁移失败会阻断 Worker 发布，避免代码和数据库结构不一致。

Vercel 前端部署由 Vercel Git 集成触发，不再使用仓库里的 Vercel deploy hook workflow。

### 手动部署

```bash
pnpm worker:deploy
```

前端手动验证构建：

```bash
pnpm build
```

### wrangler.jsonc 配置要点

- `keep_vars: true` 保留 Dashboard 手动设置的环境变量
- D1/R2 绑定当前采用 Dashboard 管理资源名和 UUID；新环境部署时必须在 Cloudflare 控制台把 `DB`、`MEDIA_BUCKET` 绑定到实际资源，再执行 D1 migration
- `routes` 当前匹配 `api.starshadow.cc/*`，Worker 承载 `/api/*`、`/media/*` 和 Access 保护的 `/friends/admin/` 后台壳

---

## 10. 开发约定

### 提交前检查清单

```bash
pnpm lint        # Biome CI 检查（不改文件）
pnpm format:check # Biome 格式检查
pnpm astro check # Astro 检查
pnpm astro sync && pnpm type-check  # TypeScript 类型检查
pnpm test        # 所有测试
pnpm build       # 生产构建
```

### 代码规范

- Biome 格式化：tab 缩进、双引号
- Biome lint：推荐的规则 + 额外 style 规则
- 格式化命令：`pnpm format`（会写入可自动修复的格式和 lint 变更）
- 检查命令：`pnpm lint`（CI 模式，不写文件）
- Worker API 错误消息集中维护在 `src/worker/constants.ts`，通过 `apiError()` 获取；当前面向站点用户默认返回中文。

### 新增 D1 迁移

1. 创建 `migrations/0005_<description>.sql`
2. 在 `src/worker/db.ts` 的 `MIGRATIONS` 数组中追加一条
3. 版本号递增，描述保持一致

### 安全注意事项

- 不要在前端源码或文档中写 token
- 截图前用实心遮罩覆盖邮箱/域名/API Key/头像等敏感信息
- 外部链接默认用 `target="_blank" rel="noopener noreferrer"`；导航里的“管理后台”例外，使用 `openInCurrentTab: true` 覆盖当前页
- 不要提交 `dist/`、`.astro/`、`node_modules/`、`博客素材/`

### 已知坑点

- `pnpm check` 通过不代表 `pnpm build` 通过（Tailwind `@apply` 跨文件引用问题）
- Pagefind 开发模式下搜索返回空结果是正常的
- R2 控制台拖拽上传文件夹可能不完整，需要确认文件数量
- `astro.config.mjs` 的 `site` 必须是 `https://blog.starshadow.cc/`
- `api.starshadow.cc` 必须绑定到 Worker 自定义域名或 Worker route，否则 Vercel rewrites 会转发失败
- 纯 CNAME 到 Vercel 不能保证解决国内访问 Vercel Anycast IP 被墙的问题；DNS only 是纯 Vercel 线路，Proxied/CDN/反代才会改变入口线路
- `scripts/sync-posts.mjs` 默认不启用同步；设置 `CONTENT_SYNC_ENABLED=true` 后才同步，设置 `CONTENT_SYNC_STRICT=true` 后同步失败才会阻断构建

---

## 11. 已完成的改进

### 2026-06（前后端分离部署 + 中文化）

- 前端改为 Vercel 托管，后端 Worker 绑定 `api.starshadow.cc/*`。
- `vercel.json` 恢复前端构建配置，并通过 rewrites 将 `/api/*` 和 `/media/*` 转发到 `https://api.starshadow.cc`。
- `scripts/sync-posts.mjs` 支持构建前从 Worker 同步 R2 文章；默认同步失败不阻断构建，可通过 `CONTENT_SYNC_STRICT=true` 切换为严格模式。
- Worker 部署 workflow 在执行远端 D1 migrations 后部署 Worker，migration step 允许失败以避免阻断发布。
- 删除独立 Vercel deploy hook workflow，前端部署回到 Vercel Git 集成。
- Worker 代理 `https://api.starshadow.cc/friends/admin/` 后台壳用于 Cloudflare Access 保护；导航里的“管理后台”覆盖当前页打开，其他外链仍新开页。
- `rejectCrossSiteWrite()` 明确允许生产中的 `blog.starshadow.cc` 前端写入 `api.starshadow.cc` Worker，修复评论区 ALTCHA session 被误判跨站的问题。
- 后台内容管理页和 Worker API 错误提示改为中文。
- README 和 PROJECT 文档同步到当前 Vercel + Cloudflare Worker 分离架构。

### 2026-05 第三轮（质量门禁 + 性能）

- 修复 `pnpm type-check` 失败：`anti-abuse.ts` 补齐 Env 类型导入，测试中的 JSON 响应做显式收窄
- 修复后台评论设置接口返回值：`GET /api/admin/settings/comments` 现在返回布尔值 `enabled`
- 调整 Twikoo 评论开关：关闭评论时只阻止发帖，保留只读和后台管理事件
- 新增评论开关与 Twikoo gate 的集成测试，测试总数提升到 63 个
- 收敛 Biome 配置：排除 vendor/minified/map 文件，固定 CRLF 行尾，`lint` 改为只检查不写文件
- CI 改为使用 `.node-version`，并在构建流水线中执行 type-check、test、Astro check 和 build
- 将 4 张文章封面由 PNG 转为 WebP，源图体积从约 31.1 MB 降到约 0.65 MB
- 搜索摘要渲染仅允许 Pagefind 的 `<mark>` 高亮，摇摆挂件确认弹窗改为 DOM API 构建
- 文章 JSON-LD 增加封面图片 `image` 字段

### 2026-05 第二轮（安全 + 重构）

- Admin auth 时序攻击修复：所有 auth 路径统一先限流再验证
- Twikoo CORS 反射修复：Origin 校验 hostname 后才返回 credential 头
- 评论 sanitize：sanitize-html 白名单替代正则黑名单
- 消除 Worker 模块间代码重复：提取 getClientIp、readMusicMetadataFromR2、inferMusicMetadataFromKey、getMusicFileNameFromKey、clampInteger 等共享函数到 utils.ts
- R2 音乐扫描 5 分钟内存缓存
- CSP 硬化：新增 form-action 'self' / frame-src 'none' / upgrade-insecure-requests
- 集中化 API 错误消息：constants.ts 中 API_ERROR 映射 + apiError() 函数
- 清理所有 TODO/死代码
- 恢复字体预加载
- 删除 vercel.json
- Biome 范围扩展到全项目
- 访客统计数据自动清理（超过 2 年的记录）
- 文章 JSON-LD 补全封面图
- Vitest Worker 工具函数测试和 API 集成测试持续补充

### 2026-05 第一轮

- ID3 解析抽取到共享模块
- 原生 CSS 滚动条替代 body OSB
- D1 版本化迁移
- PhotoSwipe 销毁重建防泄漏
- 版本化缓存 + Telegram 通知
- 图片懒加载

---

## 12. 后续可扩展方向

- 后台增加修改 token 的 UI
- FLAC/Vorbis Comment 标签支持
- 音乐拖拽排序
- 文章级访客排行
- 多语言 API 错误消息（基于 Accept-Language）
- Worker 集成测试接入 miniflare 完整环境
- RSS 提供多语言版本

---

> 文档最后更新：2026-06-06
> 项目仓库：https://github.com/starshadows/fuwari
> 博客地址：https://blog.starshadow.cc/
