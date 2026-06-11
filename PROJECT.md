# 星影博客项目文档

本项目是基于 Astro 6、Svelte 5、Tailwind CSS 和 Cloudflare Workers 的博客系统。当前权威维护说明以 `README.md` 和 `AGENTS.md` 为准。

## 架构原则

- 前端静态站点部署到 Vercel 或任意静态托管平台。
- Worker 负责 `/api/*`、`/media/*` 和 `/friends/admin/`。
- D1 和 R2 不依赖资源名称，只依赖 Worker binding 名称：`DB` 和 `MEDIA_BUCKET`。
- D1 schema 会在 Worker 收到 `/api/*` 请求时通过绑定的 `env.DB` 自动初始化/迁移。
- 域名不写死。分离部署时通过环境变量连接前端和 Worker。

## 必要绑定和变量

- Cloudflare D1 binding：`DB`
- Cloudflare R2 binding：`MEDIA_BUCKET`
- Worker secret：`ADMIN_TOKEN`
- Worker/Vercel shared secret：`CONTENT_SYNC_TOKEN`
- 可选 Worker secret：`VERCEL_DEPLOY_HOOK_URL`
- Vercel：`CONTENT_SYNC_BASE_URL` 指向 Worker origin，`CONTENT_SYNC_TOKEN` 与 Worker 一致。

## 常用环境变量

- `CONTENT_SYNC_BASE_URL` / `FUWARI_CONTENT_API_BASE_URL`：Worker origin，用于 Vercel 内容同步和同源 API 代理。
- `PUBLIC_API_ORIGIN` / `WORKER_ORIGIN` / `FUWARI_WORKER_ORIGIN`：Worker origin 的可选别名，不必和 `CONTENT_SYNC_BASE_URL` 重复设置。
- `PUBLIC_SITE_ORIGIN`：可选，前端 origin，用于 Astro `site` fallback 和更严格的 Worker CORS 判断。
- `D1_DATABASE_ID` / `R2_BUCKET_NAME`：仅 CLI/GitHub Actions 运行 `pnpm worker:deploy` 时需要；Dashboard 管理绑定时不需要。
- `D1_DATABASE_NAME` / `CLOUDFLARE_D1_DATABASE_NAME`：仅手动运行 Wrangler D1 migration 时需要。

## 维护入口

- 本地开发、部署、内容同步、质量检查：见 `README.md`。
- Agent/AI 助手工作约定：见 `AGENTS.md`。
- Worker 入口：`src/worker/index.ts`。
- D1 runtime migrations：`src/worker/db.ts` 中的 `MIGRATIONS`。
- Wrangler CLI migrations：`migrations/*.sql`。
