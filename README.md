# 星影博客

基于 Astro 6、Svelte 5、Tailwind CSS 和 Cloudflare Workers 的个人博客。当前项目从 Fuwari 主题定制而来，静态页面由 Astro 构建，友链、音乐、评论、访客统计和媒体文件由 Worker、D1、R2 承载。

完整维护文档见 [PROJECT.md](./PROJECT.md)。

## 技术栈

- Astro SSG + Svelte 交互组件
- Pagefind 搜索、Expressive Code、PhotoSwipe、Swup
- Cloudflare Workers、D1、R2、Wrangler
- Twikoo 协议评论系统 + ALTCHA 人机验证
- Biome、TypeScript、Vitest

## 本地开发

```bash
corepack enable
corepack pnpm install
corepack pnpm dev
```

需要联调 Worker API 时：

```bash
corepack pnpm build
corepack pnpm d1:migrate:local
corepack pnpm worker:dev
```

## 质量检查

提交前至少运行：

```bash
corepack pnpm lint
corepack pnpm type-check
corepack pnpm check
corepack pnpm test
corepack pnpm build
```

`pnpm lint` 是只读 CI 检查；`pnpm format` 才会写入格式化和可自动修复的 lint 变更。

## 部署

部署目标是 Cloudflare Workers。首次部署前需要在 Cloudflare 控制台创建并绑定：

- D1 binding: `DB`
- R2 binding: `MEDIA_BUCKET`
- 可选 secret: `ADMIN_TOKEN`

首次部署后用 `Authorization: Bearer <token>` 调用 `/api/setup/init-db` 初始化或升级数据库。更多 API、数据表、后台和运维细节见 [PROJECT.md](./PROJECT.md)。
