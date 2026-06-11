# AGENTS.md

## Runtime And Package Manager
- Use Node `24.13.1` locally and in CI (`.node-version`, `.nvmrc`, and CI); `package.json#engines.node` is `24.x` for Vercel compatibility. Use pnpm `9.14.4` (`packageManager` pins pnpm); `.npmrc` enables `engine-strict`, and CI installs with `pnpm install --frozen-lockfile`.
- Production is split: Vercel serves the Astro `dist/` frontend, while Cloudflare Worker `src/worker/index.ts` serves `/api/*`, `/media/*`, and the Access-protected `/friends/admin/` shell.

## Commands
- Frontend dev: `pnpm dev` at `http://localhost:4321`.
- Worker dev: `pnpm worker:dev` at `http://localhost:8787`; full local work usually needs this plus `pnpm dev`.
- Build: `pnpm build` runs `scripts/sync-posts.mjs`, `astro build`, then `pagefind --site dist --force-language zh`. The sync script prefers Worker/R2 content and writes an empty posts collection when R2 content/config is absent or non-strict sync fails. Set `CONTENT_SYNC_ENABLED=false` only for local draft builds; set `CONTENT_SYNC_STRICT=true` if sync failures must fail the build.
- Focused tests: `pnpm vitest run src/worker/__tests__/utils.test.ts` or another `src/**/*.test.ts` path. Current tests are Worker-focused and mock D1/R2 bindings.
- Fresh typecheck: run `pnpm astro sync` before `pnpm type-check` if `.astro` generated types may be missing; CI does this explicitly.
- CI also runs `pnpm audit --audit-level=high`; include it when checking dependency/security-sensitive changes.
- Pre-PR verification matching CI scripts: `pnpm lint`, `pnpm format:check`, `pnpm astro check`, `pnpm astro sync && pnpm type-check`, `pnpm test`, `pnpm build`.

## Content
- Production posts live in Worker/D1/R2. `src/content/posts/` is a build-time sync directory and should stay empty in Git except `.gitkeep`; `pnpm new-post <safe-slug>` is only for temporary local drafts and writes under `src/content/posts/`.
- Post schema is in `src/content.config.ts`; required frontmatter is `title` and `published`, with optional/defaulted `updated`, `draft`, `description`, `image`, `tags`, `category`, and `lang`. `prevTitle`/`prevSlug`/`nextTitle`/`nextSlug` are internal defaults.
- `src/content/spec/` is an empty-schema content collection; do not assume all content is under `posts`.
- Site text/config entry points called out by the repo are `src/config.ts`, `src/i18n/`, and `src/content.config.ts`.

## Worker, D1, R2, And Deploy
- Wrangler entrypoint is `src/worker/index.ts`; `wrangler.jsonc` intentionally commits only binding names (`DB`, `MEDIA_BUCKET`) without concrete D1/R2 resource IDs. In Dashboard/Git deployments, preserve the Dashboard bindings. Only CLI/GitHub Actions deployments should use `pnpm worker:deploy`, which generates a temporary config from `D1_DATABASE_ID` and `R2_BUCKET_NAME` and refuses to deploy without them. Do not use raw `wrangler deploy` for production CLI deploys.
- Vercel uses `vercel.json` to run `pnpm build` and publish `dist/`; Vercel Functions under `api/` plus `middleware.js` proxy `/api/*`, `/media/*`, and `/friends/admin/` to the Worker when `CONTENT_SYNC_BASE_URL` is set. `PUBLIC_API_ORIGIN`, `WORKER_ORIGIN`, `FUWARI_WORKER_ORIGIN`, and `FUWARI_CONTENT_API_BASE_URL` are optional aliases.
- The nav item named `管理后台` is an external API Worker URL but sets `openInCurrentTab: true`; do not change other external links when adjusting this behavior.
- `rejectCrossSiteWrite()` permits same-origin writes plus trusted Vercel middleware proxy writes carrying the internal proxy token; keep this in mind when changing comment or CSRF logic.
- D1 migrations live in `migrations/` and the matching `MIGRATIONS` array in `src/worker/db.ts`. The Worker auto-runs migrations through the bound `env.DB`; CLI migration scripts only run when `D1_DATABASE_NAME` or `CLOUDFLARE_D1_DATABASE_NAME` is set.
- Keep D1 migrations in sync in two places: `migrations/*.sql` for Wrangler CLI and the `MIGRATIONS` array in `src/worker/db.ts` for `/api/setup/init-db` runtime migration.
- Do not commit placeholder Cloudflare resource IDs or secrets. Core secrets include `ADMIN_TOKEN`, `CONTENT_SYNC_TOKEN`, and `VERCEL_DEPLOY_HOOK_URL`.
- Keep admin protection layered: Cloudflare Access may protect `/friends/admin/` and `/api/admin/*`, but Worker bearer/token auth must remain in code.
- Twikoo admin password is managed through `ADMIN_TOKEN`; `SET_PASSWORD` is intentionally a no-op in the adapter/tests.

## Style And Tooling
- Biome is the formatter/linter; it formats with tabs and double quotes, organizes imports, and `pnpm lint:fix` is the write/fix command.
- Biome ignores `src/**/*.css`, `src/public/**/*`, `dist/`, `.astro/`, `.wrangler/`, `public/vendor`, minified files, maps, and `pnpm-lock.yaml`.
- TypeScript uses Astro strict config and path aliases from `tsconfig.json` such as `@/*`, `@components/*`, `@utils/*`, and `@i18n/*`.
