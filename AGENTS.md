# AGENTS.md

## Runtime And Package Manager
- Use Node `22.22.3` (`.node-version` and `.nvmrc`) and pnpm `9.14.4` (`packageManager` pins pnpm); CI installs with `pnpm install --frozen-lockfile`.
- Production is split: Vercel serves the Astro `dist/` frontend, while Cloudflare Worker `src/worker/index.ts` serves `/api/*`, `/media/*`, and the Access-protected `/friends/admin/` shell.

## Commands
- Frontend dev: `pnpm dev` at `http://localhost:4321`.
- Worker dev: `pnpm worker:dev` at `http://localhost:8787`; full local work usually needs this plus `pnpm dev`.
- Build: `pnpm build` runs `scripts/sync-posts.mjs`, `astro build`, then `pagefind --site dist --force-language zh`. Content sync only runs when `CONTENT_SYNC_ENABLED=true`; set `CONTENT_SYNC_STRICT=true` if sync failures must fail the build.
- Focused tests: `pnpm vitest run src/worker/__tests__/utils.test.ts` or another `src/**/*.test.ts` path. Current tests are Worker-focused and mock D1/R2 bindings.
- Fresh typecheck: run `pnpm astro sync` before `pnpm type-check` if `.astro` generated types may be missing; CI does this explicitly.
- CI also runs `pnpm audit --audit-level=high`; include it when checking dependency/security-sensitive changes.
- Pre-PR verification matching CI scripts: `pnpm lint`, `pnpm format:check`, `pnpm astro check`, `pnpm astro sync && pnpm type-check`, `pnpm test`, `pnpm build`.

## Content
- Create posts with `pnpm new-post <safe-slug>`; the script writes under `src/content/posts/` and rejects unsafe path segments.
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
- Do not commit placeholder Cloudflare resource IDs or secrets. Core secrets include `ADMIN_TOKEN`, `TWIKOO_ADMIN_PASSWORD`, `CONTENT_SYNC_TOKEN`, and `VERCEL_DEPLOY_HOOK_URL`.
- Keep admin protection layered: Cloudflare Access may protect `/friends/admin/` and `/api/admin/*`, but Worker bearer/token auth must remain in code.
- Twikoo admin password is managed through `TWIKOO_ADMIN_PASSWORD`; `SET_PASSWORD` is intentionally a no-op in the adapter/tests.

## Style And Tooling
- Biome is the formatter/linter; it formats with tabs and double quotes, organizes imports, and `pnpm lint:fix` is the write/fix command.
- Biome ignores `src/**/*.css`, `src/public/**/*`, `dist/`, `.astro/`, `.wrangler/`, `public/vendor`, minified files, maps, and `pnpm-lock.yaml`.
- TypeScript uses Astro strict config and path aliases from `tsconfig.json` such as `@/*`, `@components/*`, `@utils/*`, and `@i18n/*`.
