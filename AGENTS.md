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
- Wrangler entrypoint is `src/worker/index.ts`; `wrangler.jsonc` binds `DB` and `MEDIA_BUCKET` and routes `api.starshadow.cc/*` to the Worker.
- Vercel uses `vercel.json` to run `pnpm build`, publish `dist/`, and rewrite `/api/*` and `/media/*` to `https://api.starshadow.cc`.
- The nav item named `管理后台` is an external API Worker URL but sets `openInCurrentTab: true`; do not change other external links when adjusting this behavior.
- `rejectCrossSiteWrite()` permits same-origin writes plus the production `blog.starshadow.cc` -> `api.starshadow.cc` write path used by comments; keep this pairing in mind when changing comment or CSRF logic.
- D1 migrations live in `migrations/`; apply with `pnpm d1:migrate:local` or `pnpm d1:migrate:remote` against the `fuwari-data` database name from package scripts. Worker deploy CI applies remote migrations before `pnpm worker:deploy` and fails deployment if migrations fail.
- Keep D1 migrations in sync in two places: `migrations/*.sql` for Wrangler CLI and the `MIGRATIONS` array in `src/worker/db.ts` for `/api/setup/init-db` runtime migration.
- Do not commit placeholder Cloudflare resource IDs or secrets. Core secrets include `ADMIN_TOKEN`, `CONTENT_SYNC_TOKEN`, and `VERCEL_DEPLOY_HOOK_URL`; `VERCEL_WEBHOOK_SECRET` is optional for Vercel deployment status webhook signature verification.
- Keep admin protection layered: Cloudflare Access may protect `/friends/admin/` and `/api/admin/*`, but Worker bearer/token auth must remain in code.
- Twikoo admin password is managed through `ADMIN_TOKEN`; `SET_PASSWORD` is intentionally a no-op in the adapter/tests.

## Style And Tooling
- Biome is the formatter/linter; it formats with tabs and double quotes, organizes imports, and `pnpm lint:fix` is the write/fix command.
- Biome ignores `src/**/*.css`, `src/public/**/*`, `dist/`, `.astro/`, `.wrangler/`, `public/vendor`, minified files, maps, and `pnpm-lock.yaml`.
- TypeScript uses Astro strict config and path aliases from `tsconfig.json` such as `@/*`, `@components/*`, `@utils/*`, and `@i18n/*`.
