# Fuwari 博客项目实现原理与技术栈说明

这份文档记录当前博客项目的整体架构、主要技术栈、核心功能实现方式，以及后续维护时需要注意的关键点。它偏向“项目实现说明”，不是普通使用教程：如果以后需要回头理解某个功能为什么这样设计、数据从哪里来、Cloudflare 上需要绑定什么资源，可以从这里快速定位。

## 1. 项目定位

这是一个基于 Fuwari 主题改造的个人博客。文章、归档、关于页、导航、静态样式和大部分页面仍然由 Astro 静态构建生成，保持静态博客访问快、部署简单的优点。

在静态博客之外，项目增加了 Cloudflare Worker 入口，用于处理运行时能力：

- 友链申请、审核和展示。
- 音乐歌单、R2 音频文件代理、MP3 内嵌封面读取。
- 访客统计、实时在线人数和页面访问记录。
- 后台管理接口。
- R2 头像、封面、音乐文件的公开读取。

最终形态是：

- Astro 构建静态站点到 `dist/`。
- Cloudflare Workers Static Assets 托管 `dist/`。
- 同一个 Worker 优先处理 `/api/*` 和 `/media/*`。
- D1 保存友链、音乐元数据、后台 token、访客统计。
- R2 保存头像、音乐、封面等二进制文件。

这样做的核心目标是：博客主体仍然是简单可靠的静态站点，但经常变化的小数据不用每次都改 GitHub、重新构建和重新部署。

## 2. 技术栈

### 前端与静态构建

- **Astro 5**：项目主体框架，负责页面路由、布局、Markdown 内容构建和静态 HTML 输出。
- **Svelte 5**：负责需要浏览器交互的组件，例如音乐播放器、友链面板、友链后台、访客统计。
- **Tailwind CSS 3**：主要样式工具，配合 Fuwari 原有 CSS 变量保持主题一致。
- **Stylus / 全局 CSS**：主题原有样式体系的一部分，用于布局、动画和基础视觉变量。
- **Pagefind**：构建后生成静态搜索索引，输出到 `dist/pagefind`。
- **Swup**：站内页面切换增强，让导航更平滑；多个动态组件都监听 Swup 的 `page:view` 或 `content:replace` 钩子。
- **Iconify / astro-icon**：统一图标来源，用于导航、音乐控制、统计卡片等 UI。
- **Photoswipe**：文章图片预览和缩放。
- **Expressive Code**：文章代码块高亮、行号、折叠和语言标识。

### Cloudflare 运行时

- **Cloudflare Workers**：运行 `src/worker/index.ts`，处理 API、媒体代理和静态资源 fallback。
- **Workers Static Assets**：通过 `wrangler.jsonc` 把 `dist/` 绑定为 `ASSETS`。
- **Cloudflare D1**：SQLite 兼容数据库，用于运行时数据。
- **Cloudflare R2**：对象存储，用于头像、音乐、封面。
- **Wrangler 4**：本地开发、dry-run、部署和 Workers 类型支持。

### 工程工具

- **pnpm**：包管理器。
- **Node.js >= 22**：当前 Wrangler 版本要求 Node 22 以上。
- **TypeScript**：Astro、Svelte 和 Worker 都使用 TypeScript。
- **Biome**：格式化和基础检查工具。
- **@astrojs/check**：Astro/Svelte/TypeScript 检查。

## 3. 关键目录

```text
src/
  components/
    SakanaWidget.astro              摇摇乐 / Sakana Widget 全局挂载组件
    friends/
      FriendLinksPanel.svelte       友链展示与申请组件
      FriendAdminPanel.svelte       友链、音乐后台管理组件
    widget/
      MusicPlayer.svelte            左侧音乐播放器
      VisitorStats.svelte           左侧访客统计卡片
      SideBar.astro                 左侧侧边栏组合入口
      TOC.astro                     文章目录组件
      NavMenuPanel.astro            移动端导航菜单，包含 Live2D 开关
  layouts/
    Layout.astro                    全局页面骨架，挂载 SakanaWidget
    MainGridLayout.astro            主内容 / 侧边栏布局
  pages/
    friends/
      index.astro                   友链展示页
      apply.astro                   友链申请页
      admin.astro                   内容管理后台
    posts/[...slug].astro           文章详情页
  worker/
    index.ts                        Cloudflare Worker API 和媒体路由

public/
  sakana/
    starshadow.webp                 摇摇乐默认角色图
  vendor/
    sakana/
      sakana.min.css                Sakana Widget 样式
      sakana.min.js                 Sakana Widget 运行时
      sakana.min.js.map             运行时 sourcemap

migrations/
  0001_create_social_features.sql   友链、音乐、后台设置表
  0002_create_visitor_stats.sql     访客统计表

docs/
  AI_PROJECT_CONTEXT.md             给协作者 / AI 的项目上下文

wrangler.jsonc                      Worker、Static Assets、D1、R2 绑定配置
BLOG_GUIDE.md                       日常维护指南
PROJECT_IMPLEMENTATION.md           本文档
```

## 4. Cloudflare Worker 架构

Worker 的入口是：

```text
src/worker/index.ts
```

请求处理顺序大致是：

1. 初始化数据库接口：`/api/setup/init-db`，token 通过 `Authorization: Bearer <token>` 或 `POST` JSON body 传递。
2. API 请求：`/api/*`。
3. 媒体请求：`/media/*`。
4. 其他路径交给 `env.ASSETS.fetch(request)`，返回 Astro 构建出的静态文件。

`wrangler.jsonc` 里的关键配置：

```jsonc
{
  "main": "src/worker/index.ts",
  "keep_vars": true,
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*", "/media/*"]
  },
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
}
```

D1 和 R2 的实际资源名称可以在 Cloudflare 控制台随便取，但绑定变量名必须一致。`keep_vars: true` 用来保护控制台里手动维护的纯文本变量，避免后续 `wrangler deploy` 把 `TURNSTILE_SITE_KEY` 这类 Dashboard 变量删除。

```text
DB             D1 数据库绑定
MEDIA_BUCKET   R2 桶绑定
ASSETS         Workers Static Assets 绑定
ADMIN_TOKEN    可选后台管理 token
TURNSTILE_SITE_KEY     Cloudflare Turnstile 站点 key
TURNSTILE_SECRET_KEY   Cloudflare Turnstile 校验 secret
```

`TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` 现在是异常访问升级验证所需的可选配置；正常友链和评论验证默认走 ALTCHA。

## 5. 数据库设计

### 5.1 初始化方式

数据库结构有两套入口：

- 迁移文件：`migrations/0001_create_social_features.sql`、`migrations/0002_create_visitor_stats.sql`、`migrations/0003_create_rate_limits.sql`、`migrations/0004_create_comments_and_notifications.sql`。
- 线上初始化接口：`GET /api/setup/init-db` 搭配 `Authorization: Bearer <token>`，或 `POST /api/setup/init-db` 搭配 JSON `{"token":"..."}`。

线上初始化接口是幂等的，重复访问不会清空已有数据。它主要是为了减少 Cloudflare 控制台里手动粘贴 SQL 的麻烦。

如果 Worker 配置了 `ADMIN_TOKEN`，初始化 token 必须和它一致。如果没有配置 `ADMIN_TOKEN`，初始化接口会把传入 token 的 SHA-256 哈希写入 D1，以后后台登录用同一个 token。旧的 URL query token 和 `/setup/init-db/<token>` 路径会被拒绝，避免口令进入浏览器历史或日志。

### 5.2 friend_links

`friend_links` 保存友链申请和展示数据。

主要字段：

- `id`：自增主键。
- `name`：友链名称。
- `description`：简介。
- `url`：站点链接。
- `avatar_url`：头像地址，可以是外部 URL，也可以是 `/media/avatars/...`。
- `status`：`pending`、`approved`、`rejected`。
- `is_active`：是否展示。
- `sort_order`：排序值。
- `created_at` / `updated_at`：时间戳。

前台只展示：

```sql
status = 'approved' AND is_active = 1
```

### 5.3 music_tracks

`music_tracks` 保存音乐元数据，音频文件本身在 R2。

主要字段：

- `id`：自增主键。
- `title`：歌曲标题。
- `artist`：艺术家。
- `album`：专辑。
- `object_key`：R2 对象 Key，例如 `music/song.mp3`。
- `cover_url`：封面 URL，可为空。
- `is_active`：是否启用。
- `sort_order`：排序值。
- `created_at` / `updated_at`：时间戳。

公开歌单只读取启用歌曲，并按：

```sql
sort_order ASC, created_at DESC
```

排序。

### 5.4 stats 系列表

访客统计由 `0002_create_visitor_stats.sql` 创建，主要表包括：

- `stats_visitors`：全站唯一访客。
- `stats_page_visitors`：每个页面的唯一访客。
- `stats_site_daily`：全站每日 PV / UV。
- `stats_page_daily`：页面每日 PV / UV。
- `stats_daily_visitors`：全站每日唯一访客去重。
- `stats_page_daily_visitors`：页面每日唯一访客去重。
- `stats_active_visitors`：实时在线访客心跳。

访客识别使用浏览器本地随机 ID 加 Worker 侧随机盐做 SHA-256，只保存 hash，不保存原始访客 ID。

## 6. 友链功能

导航栏里的“友链”是悬停下拉菜单，包含三个入口：

```text
/friends/          友链展示
/friends/apply/    友链申请
/friends/admin/    内容管理后台
```

### 前台展示

前台页面调用：

```text
GET /api/friends
```

Worker 从 D1 查询已审核且启用的友链，然后返回给 `FriendLinksPanel.svelte` 展示。

### 友链申请

申请页提交字段：

- 名称
- 简介
- 链接
- 头像 URL

对应接口：

```text
POST /api/friends
```

申请页会先调用：

```text
GET /api/anti-abuse/challenge?context=friends
```

这个接口默认返回 ALTCHA challenge。浏览器完成验证后，会把 `humanProof` 和友链申请一起发给 Worker。

Worker 收到 `POST /api/friends` 后不会直接写库，而是先做 D1 限流、ALTCHA 校验、字段校验和重复 URL 检查。只有同一 IP/UA 哈希短时间内高频提交、连续验证码失败或明显 bot UA 时，才会要求 Cloudflare Turnstile 并调用 Siteverify：

```text
https://challenges.cloudflare.com/turnstile/v0/siteverify
```

升级校验时使用 `TURNSTILE_SECRET_KEY`，并附带 `cf-connecting-ip` 作为可选的 `remoteip`。Turnstile 没配置时，正常 ALTCHA 提交仍可进入 pending，异常访问会收到明确错误。友链链接必须是 `https://`，头像必须是 `https://` 或站内媒体路径，同一个 URL 已经待审核或已通过时会拒绝重复申请。

提交后状态默认为 `pending`，不会立刻出现在友链页面。

### 后台审核

后台页面：

```text
/friends/admin/
```

后台 API 需要：

```text
Authorization: Bearer <token>
```

主要接口：

```text
GET    /api/admin/friends?status=pending|approved|rejected|all
PATCH  /api/admin/friends/:id
DELETE /api/admin/friends/:id
POST   /api/admin/avatar
```

`POST /api/admin/avatar` 会把头像上传到 R2 的 `avatars/` 前缀，并返回站内公开地址。上传只允许 JPG、PNG、WebP、AVIF 和 GIF，拒绝 SVG 等可执行风险更高的图片格式。

## 7. 音乐功能

音乐功能由 R2、D1、Worker 和 Svelte 播放器组成。

### 文件存储

音频文件手动上传到 R2 的 `music/` 目录，例如：

```text
music/One Last Kiss - 宇多田ヒカル.mp3
```

R2 控制台拖拽文件夹上传有时不会完整上传所有文件，需要在对象列表里确认缺失文件，再单独补传。

### 后台扫描和导入

后台音乐页可以扫描 R2：

```text
GET /api/admin/music/objects
```

Worker 会：

1. 使用 `MEDIA_BUCKET.list({ prefix: "music/" })` 列出对象。
2. 过滤常见音频扩展名。
3. 对 MP3 读取文件头部，尝试解析 ID3 标题、艺术家、专辑和内嵌封面。
4. 没有标签时按文件名推断歌曲信息。
5. 对比 D1 里已有 `object_key`，标记是否已入库。

批量导入接口：

```text
POST /api/admin/music/import
```

导入时如果 MP3 有内嵌封面，Worker 会把封面保存到 R2 的 `covers/` 前缀，并把 `/media/covers/...` 写入 D1。

### 前台播放器

播放器组件：

```text
src/components/widget/MusicPlayer.svelte
```

它位于左侧侧边栏，个人简介下面、访客统计和分类上方。播放器调用：

```text
GET /api/music/tracks
```

当前能力：

- 默认不自动播放。
- 支持播放 / 暂停。
- 支持上一首 / 下一首。
- 支持拖动进度条。
- 支持音量调节。
- 支持展开歌单并点击切歌。
- 支持播放模式切换：随机播放、单曲循环、顺序播放。
- 保持方形封面，封面加载失败时显示音乐图标。

音频播放使用浏览器原生 `HTMLAudioElement`。音频文件通过 Worker 的 `/media/music/<key>` 从 R2 读取，并支持 HTTP Range，因此拖动进度条可以正常 seek。

### 封面读取

封面来源有三种：

1. 后台手动填写 `cover_url`。
2. 扫描导入时从 MP3 内嵌封面提取并保存到 R2。
3. 旧数据没有封面时，公开歌单 API 会生成 `/media/covers/from-music/<music-key>`，Worker 动态从 MP3 里解析封面。

## 8. 访客统计

访客统计组件：

```text
src/components/widget/VisitorStats.svelte
```

它显示在左侧侧边栏，用 Worker + D1 实时统计，不依赖 GitHub 重新构建。

页面加载时调用：

```text
POST /api/stats/visit
```

页面停留时每分钟调用：

```text
POST /api/stats/heartbeat
```

统计摘要读取：

```text
GET /api/stats/summary?path=<current-path>
```

当前卡片只保留 6 个指标：

- 当前在线：最近 5 分钟有心跳的访客数。
- 今日访客：今天的全站 UV。
- 今日浏览：今天的全站 PV。
- 昨日浏览：昨天的全站 PV。
- 本月浏览：本月全站 PV。
- 总浏览：全站累计 PV。

Worker 里的 `getStatsSummary` 会计算这些字段，并清理过期的实时在线记录。

## 9. 摇摇乐 / Sakana Widget

博客集成了一个“摇摇乐”插件，实际实现是 Sakana Widget / Live2D 风格悬浮角色组件。

相关文件：

```text
src/components/SakanaWidget.astro
src/components/widget/NavMenuPanel.astro
public/vendor/sakana/sakana.min.css
public/vendor/sakana/sakana.min.js
public/vendor/sakana/sakana.min.js.map
public/sakana/starshadow.webp
```

### 实现来源

项目文档中记录该功能改造自：

- `Lentinel/plugin-Sakana-widget-Halo`
- 上游 `dsrkafuu/sakana-widget`

当前项目没有走外部 CDN，而是把运行时文件放在 `public/vendor/sakana/`，角色图放在 `public/sakana/starshadow.webp`。这样部署到 Cloudflare 后，摇摇乐资源也和站点静态资源一起被托管。

### 挂载方式

`src/layouts/Layout.astro` 在 `<head>` 中引入：

```astro
<SakanaWidget />
```

`SakanaWidget.astro` 内部会：

- 引入本地 `sakana.min.css`。
- 延迟加载本地 `sakana.min.js`。
- 注册自定义角色 `starshadow`。
- 创建固定在右下角的 `#sakana-widget` 容器。
- 使用 `new SakanaWidget({...}).mount("#sakana-widget")` 挂载。

### 桌面与移动端行为

桌面端：

- 默认启用。
- 固定在右下角。
- 尺寸约 190px。
- 用户点击关闭后，当前页面会记住 `window.__sakanaWidgetDismissed`，不再自动挂载。

移动端：

- 默认关闭。
- 移动端导航菜单在“关于”下面插入一个 `Live2D` 开关。
- 开关状态写入 `localStorage`：

```text
sakana-mobile-enabled
```

- 开关通过自定义事件 `sakana-mobile-toggle` 通知 `SakanaWidget.astro` 挂载或卸载。
- 组件也会广播 `sakana-mobile-state`，让按钮状态和实际挂载状态保持一致。

### 控件改造

原始 Sakana Widget 的控制条被项目做了二次处理：

- 调整控制条宽度、圆角、背景、阴影，使其贴近博客卡片风格。
- 重新排序控制按钮。
- 给按钮补充 `aria-label` 和 `title`。
- 角色切换按钮目前是 no-op，因为现在只有一个自定义角色。
- GitHub 按钮不会直接跳转，而是先弹出确认卡片，再新窗口打开上游仓库。
- 关闭按钮在移动端会同步关闭 `sakana-mobile-enabled`，桌面端只临时关闭本次会话。

### Swup 兼容

由于站点使用 Swup 做页面切换，摇摇乐组件会监听：

```text
swup.hooks.on("page:view", scheduleMount)
```

这样页面切换后仍能保持正确挂载状态。组件还监听桌面 / 移动端媒体查询变化，窗口尺寸跨过 769px 时会重新计算模式和尺寸。

### 配置开关

可以通过环境变量关闭该功能：

```text
PUBLIC_SAKANA_WIDGET_ENABLED=false
```

不配置或不是 `false` 时默认启用。

## 10. 媒体文件访问

所有公开媒体都通过 Worker 的 `/media/*` 路由读取 R2：

```text
/media/music/<key>
/media/avatars/<key>
/media/covers/<key>
/media/covers/from-music/<music-key>
```

音频文件支持 HTTP Range 请求。浏览器拖动进度条时会发送 `Range` 头，Worker 解析后只从 R2 读取指定字节范围。

相关 Worker 函数包括：

- `handleMedia`
- `parseRange`
- `mediaHeaders`
- `getEmbeddedCoverResponse`

## 11. 文章目录位置

文章目录原本在右侧浮动区域，在默认浏览器缩放比例下容易显示不全。现在目录移动到左侧侧边栏，顺序大致为：

1. 个人简介
2. 音乐播放器
3. 访客统计
4. 分类
5. 标签
6. 文章目录

文章目录只在文章页显示。非文章页仍保留空的 `#toc` 容器，保证 Swup 替换逻辑稳定。

相关文件：

```text
src/components/widget/SideBar.astro
src/components/widget/TOC.astro
```

Navigation performance note (2026-05):

- Sidebar scroll position is preserved during Swup page switches to avoid visible vertical jumps.
- TOC visibility is synchronized once on the next animation frame; avoid delayed fallback timers that can make the sidebar bounce after article navigation.
- MusicPlayer is hydrated with `client:idle`, so it should not compete with the initial page switch.

## 12. API 总览

### 公开 API

```text
GET  /api/friends
POST /api/friends
GET  /api/anti-abuse/challenge?context=friends|comments
GET  /api/turnstile/config

GET  /api/music/tracks

POST /api/stats/visit
POST /api/stats/heartbeat
GET  /api/stats/summary

GET  /api/comments/config
POST /api/comments/session
POST /api/twikoo

GET  /media/music/<key>
GET  /media/avatars/<key>
GET  /media/covers/<key>
GET  /media/covers/from-music/<music-key>
```

### 后台 API

所有后台 API 都需要：

```text
Authorization: Bearer <token>
```

接口包括：

```text
GET    /api/admin/friends?status=pending|approved|rejected|all
PATCH  /api/admin/friends/:id
DELETE /api/admin/friends/:id
POST   /api/admin/avatar

GET    /api/admin/music
POST   /api/admin/music
PATCH  /api/admin/music/:id
DELETE /api/admin/music/:id
GET    /api/admin/music/objects
POST   /api/admin/music/import

GET    /api/admin/settings/comments
POST   /api/admin/settings/comments
GET    /api/admin/settings/telegram
POST   /api/admin/settings/telegram
POST   /api/admin/settings/telegram/test
```

### 初始化 API

```text
GET  /api/setup/init-db
POST /api/setup/init-db
```

初始化 token 必须通过 `Authorization: Bearer <token>` 或 `POST` JSON body 传递；URL 中的 token 会被拒绝。

用途：

- 创建 D1 表结构。
- 初始化后台 token。
- 创建统计盐和 D1 限流表。
- 避免必须进入 D1 控制台手动粘贴 SQL。

## 13. 构建与部署

常用检查：

```bash
corepack pnpm check
corepack pnpm build
corepack pnpm exec wrangler deploy --dry-run
```

本地开发：

```bash
corepack pnpm dev
```

如果要测试 Worker、D1、R2、API 和 Static Assets：

```bash
corepack pnpm build
corepack pnpm worker:dev
```

Cloudflare 部署命令：

```bash
corepack pnpm exec wrangler deploy
```

Cloudflare 控制台连接 GitHub 自动部署时，建议：

```text
Build command:
corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm build

Deploy command:
corepack pnpm exec wrangler deploy
```

并确保 Node.js 版本至少为 22。

## 14. 安全与边界

当前后台认证是轻量 token 模式，适合个人博客：

- 后台页面可以额外用 Cloudflare Access 保护。
- 后台 API 仍然校验 Bearer token。
- token 不应该写入前端源码或文档。
- 初始化 token 不允许放在 URL query 或路径里，只能放在 Authorization 头或 POST JSON。
- D1 兜底模式保存的是 token 的 SHA-256 哈希，不是明文。

需要注意：

- 友链申请是公开接口，需要保留字段校验、ALTCHA 校验、异常访问 Turnstile 升级、D1 限流和重复 URL 检查。
- 统计写入接口会校验同源 `Origin` / `Referer`，并使用 D1 限流；限流 actor 只存哈希，不保存原始 IP。
- Worker 会给响应附加基础安全头：`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy` 和最小 CSP。
- 头像上传限制为常见位图类型，并限制大小。
- 音乐扫描只读取文件头部，避免把整首歌读进 Worker 内存。
- 音频通过 Range 读取，避免一次性传完整文件。
- 摇摇乐运行时是本地静态文件，升级上游插件时要一起检查控制条 DOM 结构，因为当前代码会重排原插件按钮。

## 15. 架构取舍

这个项目的核心取舍是“静态博客 + 少量运行时能力”。

静态博客负责：

- 文章内容。
- 页面布局。
- 主题样式。
- 搜索索引。
- 大部分展示 UI。

Worker 负责：

- 经常变化的数据。
- 后台审核和维护。
- 媒体文件读取。
- 访客统计。

这样做的好处是：

- 写文章仍然是 Markdown + Git。
- 审核友链不需要重新构建。
- 添加音乐不需要改代码。
- 音频文件不用进入 Git 仓库。
- 访客统计实时生效。
- 摇摇乐等纯前端增强可以跟随静态资源一起部署。
- 整体复杂度仍然集中在一个 Worker 文件和少量 Svelte/Astro 组件内。

## 16. 后续可扩展方向

可以继续考虑：

- 后台增加修改 token 的 UI。
- 音乐导入支持更多格式的内嵌标签，例如 FLAC / Vorbis Comment。
- 给旧音乐数据增加“一键固化封面到 R2”。
- 后台列表增加搜索、批量启用 / 禁用、拖拽排序。
- 访客统计增加更细的文章维度排行，但保持侧边栏 UI 简洁。
- 摇摇乐增加第二个自定义角色后，再启用角色切换按钮。
