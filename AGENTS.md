# AGENTS.md

## Runtime And Package Manager
- Use Node `>=22.22.0` and pnpm `9.14.4` (`packageManager` pins pnpm); CI installs with `pnpm install --frozen-lockfile`.
- This is not a pure static Astro site: Cloudflare Worker `src/worker/index.ts` serves `/api/*`, `/media/*`, and static assets from `dist/` via the `ASSETS` binding.

## Commands
- Frontend dev: `pnpm dev` at `http://localhost:4321`.
- Worker dev: `pnpm worker:dev` at `http://localhost:8787`; full local work usually needs this plus `pnpm dev`.
- Build with Pagefind index: `pnpm build` (`astro build && pagefind --site dist`). CI's build job only runs `pnpm astro build`, so run `pnpm build` when search output matters.
- Focused tests: `pnpm vitest run src/worker/__tests__/utils.test.ts` or another `src/**/*.test.ts` path. The configured suite is Worker-focused and uses mocked D1/R2 bindings.
- Fresh typecheck: run `pnpm astro sync` before `pnpm type-check` if `.astro` generated types may be missing; CI does this explicitly.
- Pre-PR verification matching scripts: `pnpm lint`, `pnpm format:check`, `pnpm astro check`, `pnpm type-check`, `pnpm test`, `pnpm build`.

## Content
- Create posts with `pnpm new-post <safe-slug>`; the script writes under `src/content/posts/` and rejects unsafe path segments.
- Post schema is in `src/content.config.ts`; required frontmatter includes `title` and `published`, with optional/defaulted `draft`, `description`, `image`, `tags`, `category`, and `lang`.
- Site text/config entry points called out by the repo are `src/config.ts`, `src/i18n/`, and `src/content.config.ts`.

## Worker, D1, And R2
- Wrangler entrypoint is `src/worker/index.ts`; `wrangler.jsonc` binds `DB`, `MEDIA_BUCKET`, and `ASSETS`, and runs the Worker first for `/api/*` and `/media/*`.
- D1 migrations live in `migrations/`; apply with `pnpm d1:migrate:local` or `pnpm d1:migrate:remote` against the `fuwari-data` database name from package scripts.
- Do not commit placeholder Cloudflare resource IDs or secrets. Required secrets are `ADMIN_TOKEN` and `TWIKOO_ADMIN_PASSWORD`.
- Keep admin protection layered: Cloudflare Access may protect `/friends/admin/` and `/api/admin/*`, but Worker bearer/token auth must remain in code.
- Twikoo admin password is managed through `TWIKOO_ADMIN_PASSWORD`; `SET_PASSWORD` is intentionally a no-op in the adapter/tests.

## Style And Tooling
- Biome is the formatter/linter; it formats with tabs and double quotes, and `pnpm lint:fix` is the write/fix command.
- Biome ignores `src/**/*.css`, `src/public/**/*`, `dist/`, `.astro/`, `.wrangler/`, `public/vendor`, minified files, maps, and `pnpm-lock.yaml`.
- TypeScript uses Astro strict config and path aliases from `tsconfig.json` such as `@/*`, `@components/*`, `@utils/*`, and `@i18n/*`.
