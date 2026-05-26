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
- `src/worker/index.ts`：Cloudflare Worker 后台接口，负责友链、音乐、访客统计和 R2 文件访问。
- `migrations/`：D1 数据库表结构，友链、音乐列表和访客统计都靠它初始化。

先记住一句话：日常维护主要改 `src/config.ts`、`src/content/posts/`、`src/content/spec/about.md`。关于页里的外部链接用 HTML 写法并加 `target="_blank"`，这样不会覆盖当前博客页面。

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

如果要同时测试友链、音乐、后台这些 Cloudflare 功能，先构建并初始化本地 D1：

```powershell
corepack pnpm build
corepack pnpm d1:migrate:local
corepack pnpm worker:dev
```

然后打开：

```text
http://localhost:8787
```

本地后台口令在 `.dev.vars` 里，当前默认是：

```text
local-admin-token
```

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

## 7. 友链、音乐和统计

顶部导航的 `友链` 会在鼠标悬停时展开三个入口：

```text
/friends/
/friends/apply/
/friends/admin/
```

`/friends/` 只展示已审核的友链，`/friends/apply/` 是访客申请入口。访客提交后不会立刻展示，会进入待审核状态。

友链申请默认使用 ALTCHA 人机验证。前台会从 `/api/anti-abuse/challenge?context=friends` 获取 challenge，并把 `humanProof` 随申请一起提交；Worker 校验通过后才会写入 D1。只有同一 IP/UA 哈希短时间内高频提交、连续验证码失败或明显 bot UA 时，才会升级到 Cloudflare Turnstile。没有配置 Turnstile 时，正常 ALTCHA 提交不受影响，异常流量会收到明确错误。友链地址必须使用 `https://`，头像必须使用 `https://` 或站内 `/media/avatars/`、`/media/covers/` 地址；同一个站点重复申请会被拒绝。

`/friends/admin/` 是友链和音乐后台，可以额外用 Cloudflare Access 保护；后台 API 仍然需要 `ADMIN_TOKEN`。后台可以做这些事：

- 审核、拒绝、删除友链。
- 控制友链是否展示。
- 调整友链排序。
- 上传头像到 R2，得到 `/media/avatars/...` 这样的公开地址。
- 扫描 R2 音乐文件，自动导入和维护音乐列表。
- 开关文章评论区。
- 配置 Telegram Bot 友链申请通知，并发送测试通知。

音乐文件需要你手动上传到 R2 的 `music/` 目录，例如：

```text
music/my-song.mp3
```

进入后台的“音乐”页后点“扫描 R2”，后台会列出 `music/` 下的音频文件，并优先读取 MP3 的 ID3 标题、艺术家、专辑和内嵌封面；读不到时会按文件名推断。点“导入未入库”即可批量写入 D1，封面会存到 R2 的 `covers/` 目录。播放器会显示在左侧个人简介下面，默认不会自动播放，支持拖动进度、音量调节和歌单点击切歌。

Cloudflare R2 控制台上传文件夹不是同步工具；批量上传被浏览器中断、单个文件失败或文件名/网络问题时，可能只成功一部分。上传完建议刷新 R2 的 `music/` 目录确认对象数量，缺的文件直接再次拖入这个目录即可。

左侧侧边栏的“访客统计”来自 Worker + D1，不依赖 GitHub 重新构建。浏览器进入页面时会调用 `POST /api/stats/visit` 记录一次访问，停留时每分钟调用 `POST /api/stats/heartbeat` 更新实时在线人数，不会重复增加 PV。统计卡片展示：

- 总访问、今日访问、总访客。
- 实时在线访客数，按最近 5 分钟有心跳的浏览器计算。
- 本页访问、本页今日、本页访客、本页今日访客。
- 近 7 日 PV 趋势。

访客识别使用本地浏览器随机 ID 加 Worker 里的 D1 随机盐做 SHA-256，只存 hash，不保存原始 IP。统计写入接口会检查同源请求并做 D1 限流，避免被跨站脚本或高频请求刷统计。

## 8. Cloudflare Workers 发布

在 Cloudflare 控制台：

1. 创建一个 D1 数据库，名字随便取。
2. 创建一个 R2 存储桶，名字随便取。
3. 创建或部署 Worker。
4. 在 Worker 的绑定设置里手动绑定：
   - D1 数据库绑定名必须填 `DB`，选择你刚创建的 D1。
   - R2 存储桶绑定名必须填 `MEDIA_BUCKET`，选择你刚创建的 R2。
5. 可选：设置生产后台口令，Secret 名称填 `ADMIN_TOKEN`。
6. 可选：在 Cloudflare Turnstile 创建站点，域名填博客域名；Worker 变量填 `TURNSTILE_SITE_KEY`，Secret 填 `TURNSTILE_SECRET_KEY`。它只用于异常访问升级验证，正常访客默认走 ALTCHA。

仓库里的 `wrangler.jsonc` 不保存 D1/R2 的资源名或 UUID，只声明代码需要的绑定变量名。Cloudflare 里资源叫什么都可以，只要绑定变量名对上，代码就会通过 `env.DB` 和 `env.MEDIA_BUCKET` 使用它们。`wrangler.jsonc` 已设置 `keep_vars: true`，这样下次 `wrangler deploy` 不会删除 Cloudflare 控制台里手动维护的纯文本变量，例如 `TURNSTILE_SITE_KEY`。

Cloudflare Workers 连接 GitHub 自动部署时，表单可以这样填：

```text
Project name: fuwari
Build command: corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm build
Deploy command: corepack pnpm exec wrangler deploy
Root directory: /
```

部署成功并绑定好 `DB` 后，用 `Authorization` 头初始化数据库，不要把口令放在 URL 里。PowerShell 示例：

```powershell
$token = "你的ADMIN_TOKEN"
Invoke-RestMethod `
  -Method GET `
  -Uri "https://你的域名/api/setup/init-db" `
  -Headers @{ Authorization = "Bearer $token" }
```

也可以使用 `POST /api/setup/init-db` 并提交 JSON：`{"token":"你的ADMIN_TOKEN"}`。如果 Worker 里已经设置了 `ADMIN_TOKEN`，这里的 token 必须和 `ADMIN_TOKEN` 一致。如果没有设置 `ADMIN_TOKEN`，第一次初始化会把 token 的 SHA-256 哈希存进 D1，之后后台登录就用这个 token。看到 `ok: true` 就表示友链、音乐、访客统计、限流表和后台设置表已经建好。这个接口是幂等的，重复访问不会清空已有数据。

如果在本地命令行部署，也可以运行：

```powershell
corepack pnpm build
corepack pnpm worker:deploy
```

如果 Cloudflare 没有自动使用 pnpm，先确认 Node 版本至少是 20，并让它按仓库里的 `packageManager: pnpm@9.14.4` 安装。

正式域名仍然要保持写在 `astro.config.mjs` 的 `site` 字段里：

```js
site: "https://blog.starshadow.cc/",
```

## 9. 日常更新流程

每次写完文章或改完主题：

```powershell
git status
git add .
git commit -m "Update blog"
git push
```

如果你配置了 Git 自动部署，推送后 Cloudflare 会自动重新部署。

友链、音乐和访客统计通过 D1/R2 实时生效，不需要为了审核友链、改歌单或更新统计重新构建博客。

## 10. 学习顺序

建议按这个顺序学：

1. 会运行：`corepack pnpm dev`。
2. 会发文：新建、编辑、改 `draft`。
3. 会改个人信息：`src/config.ts`。
4. 会换图片：头像、banner、封面。
5. 会发布：`git push` 触发 Cloudflare。
6. 再学源码：`pages -> layouts -> components -> styles`。

慢慢来。博客不是一次性完成的项目，它会跟着你一起长出来。
