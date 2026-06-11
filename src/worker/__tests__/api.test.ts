/**
 * Worker integration tests.
 *
 * These tests exercise the Worker's route dispatch and response shape
 * by calling handler functions directly with mocked Env bindings.
 * vitest transpiles TypeScript automatically so worker imports work.
 */

import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RATE_LIMITS } from "../constants";
import type { Env } from "../types";

// ================================================================
// D1 mock helper that returns a D1Database-like object
// ================================================================
function mockD1Result(returnValue: unknown = null) {
	const stmt = {
		bind: vi.fn().mockReturnThis(),
		first: vi.fn().mockResolvedValue(returnValue),
		all: vi.fn().mockResolvedValue(returnValue ?? { results: [] }),
		run: vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		raw: vi.fn().mockResolvedValue([]),
	} as unknown as D1PreparedStatement;

	const db = {
		prepare: vi.fn().mockReturnValue(stmt),
		batch: vi.fn().mockResolvedValue([]),
		exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
		dump: vi.fn().mockResolvedValue([]),
	} as unknown as D1Database;

	return { db, stmt };
}

function mockR2Bucket(): R2Bucket {
	const bucket = {
		get: vi.fn().mockResolvedValue(null),
		put: vi.fn().mockResolvedValue({ size: 0, etag: "x" } as R2Object),
		delete: vi.fn().mockResolvedValue(undefined),
		head: vi.fn().mockResolvedValue(null),
		list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
		createMultipartUpload: vi.fn(),
		resumeMultipartUpload: vi.fn(),
	} as unknown as R2Bucket;
	return bucket;
}

function mockEnv(overrides: Partial<Env> = {}): Env {
	return {
		DB: mockD1Result().db,
		MEDIA_BUCKET: mockR2Bucket(),
		ADMIN_TOKEN: "test-admin-token",
		CONTENT_SYNC_TOKEN: "test-sync-token",
		PUBLIC_SITE_ORIGIN: "https://frontend.example.com",
		PUBLIC_API_ORIGIN: "https://api.example.com",
		VERCEL_DEPLOY_HOOK_URL: "https://vercel.example.com/deploy",
		...overrides,
	} as Env;
}

function mockSettingsDb(
	values: Record<string, string | undefined>,
): D1Database {
	const selectStmt = {
		key: "",
		bind: vi.fn((key: string) => {
			selectStmt.key = key;
			return selectStmt;
		}),
		first: vi.fn(async () => {
			const value = values[selectStmt.key];
			return value === undefined ? null : { value };
		}),
		all: vi.fn().mockResolvedValue({ results: [] }),
		run: vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
	};
	const genericStmt = {
		bind: vi.fn().mockReturnThis(),
		first: vi.fn().mockResolvedValue(null),
		all: vi.fn().mockResolvedValue({ results: [] }),
		run: vi.fn().mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
	};
	return {
		prepare: vi.fn((sql: string) =>
			sql.includes("SELECT value FROM app_settings") ? selectStmt : genericStmt,
		),
		batch: vi.fn().mockResolvedValue([]),
		exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
		dump: vi.fn().mockResolvedValue([]),
	} as unknown as D1Database;
}

function mockCtx(): ExecutionContext {
	return {
		waitUntil: vi.fn().mockResolvedValue(undefined),
		passThroughOnException: vi.fn(),
		props: {},
	} as unknown as ExecutionContext;
}

// ================================================================
// Route dispatch tests
// ================================================================
describe("Route dispatch", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	it("API paths are routed to handleApi (non-404)", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request(
				"https://blog.example.com/api/anti-abuse/challenge?context=friends",
			),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("challenge");
	});

	it("unknown API endpoints return 404", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/nonexistent"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toHaveProperty("error");
	});

	it("adds CORS headers for trusted public API origins", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://api.example.com/api/anti-abuse/challenge", {
				headers: { origin: "https://frontend.example.com" },
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe(
			"https://frontend.example.com",
		);
		expect(res.headers.get("access-control-allow-credentials")).toBe("true");
		expect(res.headers.get("vary")).toContain("Origin");
	});

	it("handles public API CORS preflight", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://api.example.com/api/comments/session", {
				method: "OPTIONS",
				headers: { origin: "https://frontend.example.com" },
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe(
			"https://frontend.example.com",
		);
		expect(res.headers.get("access-control-allow-methods")).toContain("POST");
	});

	it("does not add public API CORS headers for untrusted origins", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://api.example.com/api/anti-abuse/challenge", {
				headers: { origin: "https://attacker.example" },
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("old setup URL returns 410", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/setup/init-db"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(410);
	});

	it("non-API paths return 404 after static assets move to Vercel", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(404);
	});

	it("serves only the Access-protected admin shell from the API Worker", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const upstreamFetch = vi
			.fn()
			.mockResolvedValue(
				new Response(
					[
						'<link rel="stylesheet" href="/_astro/admin.css">',
						"<link rel='preload' href='/_astro/preload.js'>",
						'<script type="module" src="/_astro/admin.js"></script>',
						'<astro-island component-url="/_astro/FriendAdminPanel.js" renderer-url="/_astro/client.svelte.js">',
						"<astro-island component-url='/_astro/SingleQuotePanel.js'>",
						'<img srcset="/_astro/small.webp 640w, /_astro/large.webp 1280w">',
						'<meta property="og:image" content="/sakana/starshadow.webp">',
						'<a href="/">Home</a>',
						'<a href="//cdn.example.com/app.js">CDN</a>',
						'<a href="/archive/">Archive</a>',
						'<script>const pagefind = "/pagefind/pagefind.js"</script>',
						'<script>const image = "/sakana/starshadow.webp"</script>',
						'<script>fetch("/api/admin/friends")</script>',
					].join(""),
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				),
			);
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", upstreamFetch);
		const env = mockEnv();
		try {
			const res = await worker.default.fetch(
				new Request("https://api.example.com/friends/admin/"),
				env,
				mockCtx(),
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(res.headers.get("x-robots-tag")).toBe("noindex,nofollow");
			expect(upstreamFetch).toHaveBeenCalledOnce();
			expect(String(upstreamFetch.mock.calls[0]?.[0])).toBe(
				"https://frontend.example.com/worker-admin-shell/friends-admin/",
			);
			expect(upstreamFetch.mock.calls[0]?.[1]).toMatchObject({
				headers: expect.objectContaining({
					"x-fuwari-admin-shell-token": "test-sync-token",
				}),
			});
			const html = await res.text();
			expect(html).toContain(
				'src="https://frontend.example.com/_astro/admin.js"',
			);
			expect(html).toContain(
				'component-url="https://frontend.example.com/_astro/FriendAdminPanel.js"',
			);
			expect(html).toContain(
				"component-url='https://frontend.example.com/_astro/SingleQuotePanel.js'",
			);
			expect(html).toContain(
				'srcset="https://frontend.example.com/_astro/small.webp 640w, https://frontend.example.com/_astro/large.webp 1280w"',
			);
			expect(html).toContain(
				"href='https://frontend.example.com/_astro/preload.js'",
			);
			expect(html).toContain(
				'content="https://frontend.example.com/sakana/starshadow.webp"',
			);
			expect(html).toContain('href="https://frontend.example.com/"');
			expect(html).toContain('href="//cdn.example.com/app.js"');
			expect(html).toContain('href="https://frontend.example.com/archive/"');
			expect(html).toContain(
				'const pagefind = "https://frontend.example.com/pagefind/pagefind.js"',
			);
			expect(html).toContain(
				'const image = "https://frontend.example.com/sakana/starshadow.webp"',
			);
			expect(html).toContain('fetch("/api/admin/friends")');
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("warns when the admin shell still contains relative asset references", async () => {
		const upstreamFetch = vi.fn().mockResolvedValue(
			new Response("<script type=module src=/_astro/admin.js></script>", {
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", upstreamFetch);
		const env = mockEnv();
		try {
			const res = await worker.default.fetch(
				new Request("https://api.example.com/friends/admin/"),
				env,
				mockCtx(),
			);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain("src=/_astro/admin.js");
			expect(warnSpy).toHaveBeenCalledWith(
				"Admin shell contains unrewritten relative asset reference",
				expect.objectContaining({ reference: "src=/_astro/admin.js" }),
			);
		} finally {
			warnSpy.mockRestore();
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("fails closed when the content sync token is not configured", async () => {
		const upstreamFetch = vi.fn();
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", upstreamFetch);
		const env = mockEnv({ CONTENT_SYNC_TOKEN: undefined });
		try {
			const res = await worker.default.fetch(
				new Request("https://api.example.com/friends/admin/"),
				env,
				mockCtx(),
			);
			expect(res.status).toBe(503);
			expect(upstreamFetch).not.toHaveBeenCalled();
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("redirects admin shell path to trailing slash", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://api.example.com/friends/admin"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(308);
		expect(res.headers.get("location")).toBe(
			"https://api.example.com/friends/admin/",
		);
	});

	it("does not serve admin subpaths from the API Worker", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://api.example.com/friends/admin/anything"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(404);
	});

	it("does not serve frontend asset proxy paths from the API Worker", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request(
				"https://api.example.com/friends/admin/_asset/_astro/admin.js",
			),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(404);
	});

	it("proxies Astro static assets needed by the admin shell", async () => {
		const upstreamFetch = vi.fn().mockResolvedValue(
			new Response(".twikoo{}", {
				headers: {
					"cache-control": "public, max-age=31536000, immutable",
					"content-type": "text/css",
					"set-cookie": "should-not-forward=1",
				},
			}),
		);
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", upstreamFetch);
		const env = mockEnv();
		try {
			const res = await worker.default.fetch(
				new Request("https://api.example.com/_astro/twikoo.BipqqlPV.css"),
				env,
				mockCtx(),
			);
			expect(res.status).toBe(200);
			expect(String(upstreamFetch.mock.calls[0]?.[0])).toBe(
				"https://frontend.example.com/_astro/twikoo.BipqqlPV.css",
			);
			expect(res.headers.get("content-type")).toBe("text/css");
			expect(res.headers.get("set-cookie")).toBeNull();
			expect(await res.text()).toBe(".twikoo{}");
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});
});

// ================================================================
// Content ZIP validation
// ================================================================
describe("Content ZIP validation", () => {
	let content: Awaited<typeof import("../content")>;

	beforeAll(async () => {
		content = await import("../content");
	});

	function articleZip(entries: Record<string, string>): ArrayBuffer {
		const zipped = zipSync(
			Object.fromEntries(
				Object.entries(entries).map(([name, value]) => [name, strToU8(value)]),
			),
		);
		return zipped.buffer.slice(
			zipped.byteOffset,
			zipped.byteOffset + zipped.byteLength,
		);
	}

	it("accepts a directory article with one index.md and assets", async () => {
		const parsed = await content.parsePostZip(
			articleZip({
				"hello/index.md": `---
title: Hello
published: 2026-01-01
tags: [Astro, R2]
---
# Hello`,
				"hello/cover.webp": "fake-image",
			}),
		);
		expect(parsed).not.toBeInstanceOf(Response);
		if (parsed instanceof Response) return;
		expect(parsed.slug).toBe("hello");
		expect(parsed.sourceKey).toBe("posts/hello/index.md");
		expect(parsed.frontmatter.tags).toEqual(["Astro", "R2"]);
		expect(parsed.files).toHaveLength(2);
	});

	it("parses standard YAML frontmatter shapes", async () => {
		const parsed = await content.parsePostZip(
			articleZip({
				"hello/index.md": `---
title: "Hello: With Colon"
published: 2026-01-01
description: |
  First line
  Second line
tags:
  - Astro
  - R2:Storage
category: Notes
lang: zh-CN
---
# Hello`,
			}),
		);
		expect(parsed).not.toBeInstanceOf(Response);
		if (parsed instanceof Response) return;
		expect(parsed.frontmatter.title).toBe("Hello: With Colon");
		expect(parsed.frontmatter.description).toBe("First line\nSecond line");
		expect(parsed.frontmatter.tags).toEqual(["Astro", "R2:Storage"]);
		expect(parsed.frontmatter.category).toBe("Notes");
		expect(parsed.frontmatter.lang).toBe("zh-CN");
	});

	it("accepts a full posts archive and ignores .gitkeep", async () => {
		const parsed = await content.parsePostArchive(
			articleZip({
				"posts/.gitkeep": "",
				"posts/hello-fuwari.md": `---
title: Hello Fuwari
published: 2026-01-01
---
# Hello`,
				"posts/cloudflare-origin-protection/index.md": `---
title: Origin Protection
published: 2026-01-02
---
# Origin`,
				"posts/cloudflare-origin-protection/aop-direct-test.png": "image",
			}),
		);
		expect(parsed).not.toBeInstanceOf(Response);
		if (parsed instanceof Response) return;
		expect(parsed.map((post) => post.slug).sort()).toEqual([
			"cloudflare-origin-protection",
			"hello-fuwari",
		]);
		const hello = parsed.find((post) => post.slug === "hello-fuwari");
		expect(hello?.sourceKey).toBe("posts/hello-fuwari/index.md");
		const origin = parsed.find(
			(post) => post.slug === "cloudflare-origin-protection",
		);
		expect(origin?.files.map((file) => file.path).sort()).toEqual([
			"aop-direct-test.png",
			"index.md",
		]);
	});

	it("rejects path traversal entries", async () => {
		const parsed = await content.parsePostZip(
			articleZip({
				"hello/index.md": "---\ntitle: Hello\npublished: 2026-01-01\n---",
				"hello/../evil.png": "x",
			}),
		);
		expect(parsed).toBeInstanceOf(Response);
		if (parsed instanceof Response) expect(parsed.status).toBe(400);
	});

	it("rejects unsupported asset extensions", async () => {
		const parsed = await content.parsePostZip(
			articleZip({
				"hello/index.md": "---\ntitle: Hello\npublished: 2026-01-01\n---",
				"hello/script.html": "<script></script>",
			}),
		);
		expect(parsed).toBeInstanceOf(Response);
		if (parsed instanceof Response) expect(parsed.status).toBe(400);
	});

	it("rejects malformed YAML frontmatter", async () => {
		const parsed = await content.parsePostZip(
			articleZip({
				"hello/index.md": `---
title: [unterminated
published: 2026-01-01
---
# Hello`,
			}),
		);
		expect(parsed).toBeInstanceOf(Response);
		if (parsed instanceof Response) {
			expect(parsed.status).toBe(400);
			expect(await parsed.json()).toEqual({
				error: "文章 frontmatter YAML 语法无效。",
			});
		}
	});

	it("rejects SVG article assets", async () => {
		const parsed = await content.parsePostZip(
			articleZip({
				"hello/index.md": "---\ntitle: Hello\npublished: 2026-01-01\n---",
				"hello/icon.svg": "<svg><script>alert(1)</script></svg>",
			}),
		);
		expect(parsed).toBeInstanceOf(Response);
		if (parsed instanceof Response) expect(parsed.status).toBe(400);
	});

	it("rejects MDX index files until MDX is configured", async () => {
		const parsed = await content.parsePostZip(
			articleZip({
				"hello/index.mdx": "---\ntitle: Hello\npublished: 2026-01-01\n---",
			}),
		);
		expect(parsed).toBeInstanceOf(Response);
		if (parsed instanceof Response) expect(parsed.status).toBe(400);
	});

	it("rejects missing local frontmatter images", async () => {
		const parsed = await content.parsePostZip(
			articleZip({
				"hello/index.md": `---
title: Hello
published: 2026-01-01
image: cover.webp
---`,
			}),
		);
		expect(parsed).toBeInstanceOf(Response);
		if (parsed instanceof Response) expect(parsed.status).toBe(400);
	});

	it("rejects ZIPs with more than one index document", async () => {
		const parsed = await content.parsePostZip(
			articleZip({
				"hello/index.md": "---\ntitle: Hello\npublished: 2026-01-01\n---",
				"other/index.md": "---\ntitle: Other\npublished: 2026-01-02\n---",
			}),
		);
		expect(parsed).toBeInstanceOf(Response);
		if (parsed instanceof Response) expect(parsed.status).toBe(400);
	});
});

// ================================================================
// Content sync API
// ================================================================
describe("Content sync API", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	function mockContentDb(
		rows = [
			{
				id: 1,
				slug: "published-post",
				sourceKey: "posts/published-post/index.md",
				format: "md",
				title: "Published",
				description: "",
				image: "",
				tagsJson: "[]",
				category: "",
				lang: "",
				published: "2026-01-01",
				updated: "",
				status: "published",
				contentHash: "abc",
				assetsManifest: JSON.stringify([
					{
						path: "index.md",
						key: "posts/published-post/index.md",
						size: 42,
						contentType: "text/markdown; charset=utf-8",
					},
				]),
				deployStatus: "triggered",
				deploymentError: "",
				lastDeployTriggeredAt: "",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	): D1Database {
		const stmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(rows[0]),
			all: vi.fn().mockResolvedValue({ results: rows }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		return {
			prepare: vi.fn().mockReturnValue(stmt),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
	}

	function mockContentBucket(): R2Bucket {
		return {
			get: vi.fn().mockResolvedValue({
				body: new Response("body").body,
				httpEtag: '"etag"',
				writeHttpMetadata(headers: Headers) {
					headers.set("content-type", "text/markdown; charset=utf-8");
				},
			}),
			put: vi.fn(),
			delete: vi.fn(),
			head: vi.fn(),
			list: vi.fn(),
			createMultipartUpload: vi.fn(),
			resumeMultipartUpload: vi.fn(),
		} as unknown as R2Bucket;
	}

	function rateLimitedContentSyncDb(): D1Database {
		const saltStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ value: "stable-salt" }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const countStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi
				.fn()
				.mockResolvedValue({ count: RATE_LIMITS.contentSyncAuth.limit + 1 }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		return {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("SELECT value FROM app_settings")) return saltStmt;
				if (sql.includes("SELECT count FROM rate_limits")) return countStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
	}

	it("rejects manifest requests without the content sync token", async () => {
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/content/manifest"),
			mockEnv(),
			mockCtx(),
		);
		expect(res.status).toBe(401);
	});

	it("rate-limits content sync auth attempts before token errors", async () => {
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/content/manifest"),
			mockEnv({ DB: rateLimitedContentSyncDb() }),
			mockCtx(),
		);

		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBeTruthy();
	});

	it("returns the published manifest with a valid token", async () => {
		const env = mockEnv({ DB: mockContentDb() });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/content/manifest", {
				headers: { authorization: "Bearer test-sync-token" },
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { posts: Array<{ slug: string }> };
		expect(body.posts).toHaveLength(1);
		expect(body.posts[0].slug).toBe("published-post");
	});

	it("downloads only published content objects with a valid token", async () => {
		const bucket = mockContentBucket();
		const env = mockEnv({ DB: mockContentDb(), MEDIA_BUCKET: bucket });
		const res = await worker.default.fetch(
			new Request(
				"https://blog.example.com/api/content/object?key=posts%2Fpublished-post%2Findex.md",
				{ headers: { authorization: "Bearer test-sync-token" } },
			),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("body");
		expect(vi.mocked(bucket.get)).toHaveBeenCalledWith(
			"posts/published-post/index.md",
		);
	});

	it("rejects invalid content object keys before R2 lookup", async () => {
		const bucket = mockContentBucket();
		const env = mockEnv({ DB: mockContentDb(), MEDIA_BUCKET: bucket });
		const res = await worker.default.fetch(
			new Request(
				"https://blog.example.com/api/content/object?key=media%2Favatars%2Favatar.png",
				{ headers: { authorization: "Bearer test-sync-token" } },
			),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(400);
		expect(bucket.get).not.toHaveBeenCalled();
	});

	it("rejects content objects that are not in the published manifest", async () => {
		const bucket = mockContentBucket();
		const env = mockEnv({ DB: mockContentDb(), MEDIA_BUCKET: bucket });
		const res = await worker.default.fetch(
			new Request(
				"https://blog.example.com/api/content/object?key=posts%2Fpublished-post%2Funlisted.png",
				{ headers: { authorization: "Bearer test-sync-token" } },
			),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(404);
		expect(bucket.get).not.toHaveBeenCalled();
	});
});

// ================================================================
// Admin content management
// ================================================================
describe("Admin content management", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	function articleZip(entries: Record<string, string>): ArrayBuffer {
		const zipped = zipSync(
			Object.fromEntries(
				Object.entries(entries).map(([name, value]) => [name, strToU8(value)]),
			),
		);
		return zipped.buffer.slice(
			zipped.byteOffset,
			zipped.byteOffset + zipped.byteLength,
		);
	}

	function contentInsertFailureDb(): D1Database {
		const saltStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ value: "stable-salt" }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const countStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ count: 1 }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const contentTableStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ name: "content_posts" }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const existingPostStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const insertStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockRejectedValue(
					new Error("UNIQUE constraint failed: content_posts.slug"),
				),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		return {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("SELECT value FROM app_settings")) return saltStmt;
				if (sql.includes("SELECT count FROM rate_limits")) return countStmt;
				if (sql.includes("sqlite_master") && sql.includes("content_posts")) {
					return contentTableStmt;
				}
				if (sql.includes("FROM content_posts WHERE slug = ?")) {
					return existingPostStmt;
				}
				if (sql.includes("INSERT INTO content_posts")) return insertStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
	}

	function contentAdminDb(): D1Database {
		const contentRow = {
			id: 1,
			slug: "published-post",
			sourceKey: "posts/published-post/index.md",
			format: "md",
			title: "Published",
			description: "",
			image: "",
			tagsJson: "[]",
			category: "",
			lang: "",
			published: "2026-01-01",
			updated: "",
			status: "published",
			contentHash: "abc",
			assetsManifest: "[]",
			deployStatus: "triggered",
			deploymentError: "",
			lastDeployTriggeredAt: "",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const stmt = (firstValue: unknown = null) => ({
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(firstValue),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
		});
		const contentTableStmt = stmt({ name: "content_posts" });
		const contentRowStmt = stmt(contentRow);
		const appSettingStmt = stmt({ value: "stable-salt" });
		const rateCountStmt = stmt({ count: 1 });
		const genericStmt = stmt();
		return {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("sqlite_master") && sql.includes("content_posts")) {
					return contentTableStmt;
				}
				if (sql.includes("FROM content_posts WHERE slug = ?")) {
					return contentRowStmt;
				}
				if (sql.includes("SELECT value FROM app_settings"))
					return appSettingStmt;
				if (sql.includes("SELECT count FROM rate_limits")) return rateCountStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
	}

	function contentDeleteCleanupFailureDb() {
		const contentRow = {
			id: 1,
			slug: "published-post",
			sourceKey: "posts/published-post/index.md",
			format: "md",
			title: "Published",
			description: "",
			image: "",
			tagsJson: "[]",
			category: "",
			lang: "",
			published: "2026-01-01",
			updated: "",
			status: "published",
			contentHash: "abc",
			assetsManifest: JSON.stringify([
				{
					path: "index.md",
					key: "posts/published-post/index.md",
					size: 42,
					contentType: "text/markdown; charset=utf-8",
				},
			]),
			deployStatus: "triggered",
			deploymentError: "",
			lastDeployTriggeredAt: "",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const stmt = (firstValue: unknown = null) => ({
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(firstValue),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
		});
		const contentTableStmt = stmt({ name: "content_posts" });
		const contentRowStmt = stmt(contentRow);
		const appSettingStmt = stmt({ value: "stable-salt" });
		const rateCountStmt = stmt({ count: 1 });
		const draftStmt = stmt();
		const pendingStmt = stmt();
		const triggeredStmt = stmt();
		const failedStmt = stmt();
		const genericStmt = stmt();
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("sqlite_master") && sql.includes("content_posts")) {
					return contentTableStmt;
				}
				if (sql.includes("FROM content_posts WHERE slug = ?")) {
					return contentRowStmt;
				}
				if (sql.includes("SELECT value FROM app_settings")) {
					return appSettingStmt;
				}
				if (sql.includes("SELECT count FROM rate_limits")) return rateCountStmt;
				if (sql.includes("SET status = 'draft'")) return draftStmt;
				if (sql.includes("SET deploy_status = 'pending'")) return pendingStmt;
				if (sql.includes("SET deploy_status = 'triggered'"))
					return triggeredStmt;
				if (sql.includes("SET deploy_status = 'failed'")) return failedStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		return { db, failedStmt };
	}

	it("rejects content upload without content-length", async () => {
		const bucket = mockR2Bucket();
		const formData = new FormData();
		formData.append(
			"file",
			new File(
				[
					articleZip({
						"hello/index.md": `---
title: Hello
published: 2026-01-01
---
# Hello`,
					}),
				],
				"hello.zip",
				{ type: "application/zip" },
			),
		);

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/content", {
				method: "POST",
				headers: {
					origin: "https://blog.example.com",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: formData,
			}),
			mockEnv({ DB: contentAdminDb(), MEDIA_BUCKET: bucket }),
			mockCtx(),
		);

		expect(res.status).toBe(411);
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it("does not write R2 objects when the D1 insert fails", async () => {
		const bucket = mockR2Bucket();
		const formData = new FormData();
		formData.append(
			"file",
			new File(
				[
					articleZip({
						"hello/index.md": `---
title: Hello
published: 2026-01-01
---
# Hello`,
						"hello/cover.webp": "image",
					}),
				],
				"hello.zip",
				{ type: "application/zip" },
			),
		);

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/content", {
				method: "POST",
				headers: {
					origin: "https://blog.example.com",
					"content-length": "1024",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: formData,
			}),
			mockEnv({ DB: contentInsertFailureDb(), MEDIA_BUCKET: bucket }),
			mockCtx(),
		);

		expect(res.status).toBe(409);
		expect(bucket.put).not.toHaveBeenCalled();
		expect(bucket.delete).not.toHaveBeenCalled();
	});

	it("cleans up the draft row when R2 upload fails", async () => {
		const bucket = mockR2Bucket();
		vi.mocked(bucket.put).mockRejectedValue(new Error("R2 unavailable"));
		const deleteStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const contentTableStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ name: "content_posts" }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const existingPostStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 7 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("sqlite_master") && sql.includes("content_posts")) {
					return contentTableStmt;
				}
				if (sql.includes("FROM content_posts WHERE slug = ?")) {
					return existingPostStmt;
				}
				if (sql.includes("DELETE FROM content_posts WHERE id = ?")) {
					return deleteStmt;
				}
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const formData = new FormData();
		formData.append(
			"file",
			new File(
				[
					articleZip({
						"hello/index.md": `---
title: Hello
published: 2026-01-01
---
# Hello`,
					}),
				],
				"hello.zip",
				{ type: "application/zip" },
			),
		);

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/content", {
				method: "POST",
				headers: {
					origin: "https://blog.example.com",
					"content-length": "1024",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: formData,
			}),
			mockEnv({ DB: db, MEDIA_BUCKET: bucket }),
			mockCtx(),
		);

		expect(res.status).toBe(500);
		expect(deleteStmt.bind).toHaveBeenCalledWith(7);
	});

	it("unpublishes content without triggering Vercel until deploy is requested", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", fetchSpy);
		try {
			const env = mockEnv({ DB: contentAdminDb() });
			const unpublishRes = await worker.default.fetch(
				new Request(
					"https://blog.example.com/api/admin/content/published-post/unpublish",
					{
						method: "POST",
						headers: {
							origin: "https://blog.example.com",
							"x-fuwari-admin-token": "test-admin-token",
						},
					},
				),
				env,
				mockCtx(),
			);
			expect(unpublishRes.status).toBe(200);
			expect(await unpublishRes.json()).toMatchObject({
				ok: true,
				deployStatus: "pending",
			});
			expect(fetchSpy).not.toHaveBeenCalled();

			const deployRes = await worker.default.fetch(
				new Request(
					"https://blog.example.com/api/admin/content/published-post/deploy",
					{
						method: "POST",
						headers: {
							origin: "https://blog.example.com",
							"x-fuwari-admin-token": "test-admin-token",
						},
					},
				),
				env,
				mockCtx(),
			);
			expect(deployRes.status).toBe(200);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("marks content delete cleanup failures as failed", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", fetchSpy);
		try {
			const bucket = mockR2Bucket();
			vi.mocked(bucket.delete).mockRejectedValue(new Error("R2 unavailable"));
			const { db, failedStmt } = contentDeleteCleanupFailureDb();
			const res = await worker.default.fetch(
				new Request(
					"https://blog.example.com/api/admin/content/published-post",
					{
						method: "DELETE",
						headers: {
							origin: "https://blog.example.com",
							"x-fuwari-admin-token": "test-admin-token",
						},
					},
				),
				mockEnv({ DB: db, MEDIA_BUCKET: bucket }),
				mockCtx(),
			);

			expect(res.status).toBe(500);
			expect(await res.json()).toMatchObject({
				detail: "R2 unavailable",
			});
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(bucket.delete).toHaveBeenCalledWith(
				"posts/published-post/index.md",
			);
			expect(failedStmt.bind).toHaveBeenCalledWith(
				"R2 unavailable",
				"published-post",
			);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});
});

// ================================================================
// Security header tests
// ================================================================
describe("Security headers", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	it("all API responses carry CSP with key directives", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request(
				"https://blog.example.com/api/anti-abuse/challenge?context=friends",
			),
			env,
			mockCtx(),
		);
		const csp = res.headers.get("content-security-policy");
		expect(csp).toBeTruthy();
		expect(csp).toContain("base-uri 'self'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("form-action 'self'");
		expect(csp).toContain("frame-src 'none'");
	});

	it("API responses include nosniff and referrer-policy", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request(
				"https://blog.example.com/api/anti-abuse/challenge?context=friends",
			),
			env,
			mockCtx(),
		);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe(
			"strict-origin-when-cross-origin",
		);
	});
});

// ================================================================
// Cross-site write protection
// ================================================================
describe("Cross-site protection", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	it("rejects POST from foreign origin", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/friends", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://evil.example.com",
				},
				body: JSON.stringify({}),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(403);
	});

	it("rejects POST without origin or referer", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/friends", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({}),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(403);
	});

	it("allows same-origin POSTs through validation", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/friends", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://blog.example.com",
				},
				body: JSON.stringify({}),
			}),
			env,
			mockCtx(),
		);
		// Should be 400 (missing required fields passed through validation),
		// NOT 403 (cross-site rejection)
		expect(res.status).toBe(400);
	});

	it("rejects admin writes from a foreign origin", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/settings/comments", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://evil.example.com",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: JSON.stringify({ enabled: false }),
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(403);
	});

	it("allows non-browser admin writes with bearer auth", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/settings/comments", {
				method: "POST",
				headers: {
					authorization: "Bearer test-admin-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ enabled: false }),
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(200);
	});
});

// ================================================================
// JSON body size limits
// ================================================================
describe("JSON body size limits", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		vi.stubGlobal("caches", {
			default: {
				match: vi.fn().mockResolvedValue(undefined),
				put: vi.fn().mockResolvedValue(undefined),
			},
		});
		worker = await import("../index");
	});

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	function oversizedJsonRequest(
		path: string,
		headers: HeadersInit = {},
	): Request {
		const body = JSON.stringify({ value: "x".repeat(70 * 1024) });
		return new Request(`https://blog.example.com${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": String(body.length),
				origin: "https://blog.example.com",
				...headers,
			},
			body,
		});
	}

	it("rejects oversized comment session JSON bodies", async () => {
		const { db } = mockD1Result("true");
		const env = mockEnv({ DB: db });
		const res = await worker.default.fetch(
			oversizedJsonRequest("/api/comments/session"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(413);
	});

	it("rejects oversized friend submission JSON bodies", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			oversizedJsonRequest("/api/friends"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(413);
	});

	it("rejects oversized authorized admin JSON bodies", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			oversizedJsonRequest("/api/admin/settings/comments", {
				authorization: "Bearer test-admin-token",
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(413);
	});

	it("rejects oversized setup POST JSON bodies", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			oversizedJsonRequest("/api/setup/init-db", {
				authorization: "",
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(413);
	});

	it("rejects oversized JSON bodies without content-length", async () => {
		const env = mockEnv();
		const body = JSON.stringify({ value: "x".repeat(70 * 1024) });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/friends", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://blog.example.com",
				},
				body,
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(413);
	});
});

// ================================================================
// Public API schema fallback
// ================================================================
describe("Public API schema fallback", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		vi.stubGlobal("caches", {
			default: {
				match: vi.fn().mockResolvedValue(undefined),
				put: vi.fn().mockResolvedValue(undefined),
			},
		});
		worker = await import("../index");
	});

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	function missingSchemaDb(table: string): D1Database {
		const missingStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi
				.fn()
				.mockRejectedValue(new Error("no such table: app_settings")),
			all: vi.fn().mockRejectedValue(new Error(`no such table: ${table}`)),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		return {
			prepare: vi.fn().mockReturnValue(missingStmt),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
	}

	it("returns an empty friends list when friend_links is missing", async () => {
		const env = mockEnv({ DB: missingSchemaDb("friend_links") });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/friends"),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ friends: [] });
	});

	it("returns an empty music list when music_tracks is missing", async () => {
		const env = mockEnv({ DB: missingSchemaDb("music_tracks") });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/music/tracks"),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({ tracks: [] });
	});
});

// ================================================================
// Database initialization
// ================================================================
describe("Database initialization", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	it("syncs migration version when Wrangler migrations already applied", async () => {
		const tables = new Set([
			"app_settings",
			"friend_links",
			"music_tracks",
			"stats_visitors",
			"stats_page_daily",
			"rate_limits",
			"comment",
			"config",
			"counter",
			"admin_audit_log",
			"content_posts",
		]);
		const preparedSql: string[] = [];
		const versionWrites: unknown[][] = [];

		const appSettingSelectStmt = {
			key: "",
			bind: vi.fn((key: string) => {
				appSettingSelectStmt.key = key;
				return appSettingSelectStmt;
			}),
			first: vi.fn(async () =>
				appSettingSelectStmt.key === "stats_salt"
					? { value: "stable-salt" }
					: null,
			),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const appSettingWriteStmt = {
			bind: vi.fn((...values: unknown[]) => {
				versionWrites.push(values);
				return appSettingWriteStmt;
			}),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const tableStmt = {
			table: "",
			bind: vi.fn((table: string) => {
				tableStmt.table = table;
				return tableStmt;
			}),
			first: vi.fn(async () =>
				tables.has(tableStmt.table) ? { name: tableStmt.table } : null,
			),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const indexNames = new Set([
			"idx_friend_links_normalized_host_pending_approved_unique",
			"idx_friend_links_submitter_pending_created",
			"idx_music_tracks_object_key_unique",
			"idx_music_tracks_content_hash_unique",
			"idx_content_posts_status_published",
		]);
		const auditLogSql =
			"CREATE TABLE admin_audit_log (resource TEXT NOT NULL CHECK (resource IN ('friend', 'music', 'comment', 'telegram', 'init-db', 'content')))";
		const indexStmt = {
			index: "",
			bind: vi.fn((index: string) => {
				indexStmt.index = index;
				return indexStmt;
			}),
			first: vi.fn(async () =>
				indexNames.has(indexStmt.index) ? { name: indexStmt.index } : null,
			),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const auditSqlStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ sql: auditLogSql }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const friendColumnsStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({
				results: [
					{ name: "id" },
					{ name: "normalized_host" },
					{ name: "submitter_hash" },
				],
			}),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const musicColumnsStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({
				results: [{ name: "id" }, { name: "content_hash" }],
			}),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const commentColumnsStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({
				results: [{ name: "_id", pk: 1 }],
			}),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ count: 1 }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				preparedSql.push(sql);
				if (sql.includes("SELECT value FROM app_settings")) {
					return appSettingSelectStmt;
				}
				if (sql.includes("INSERT INTO app_settings")) {
					return appSettingWriteStmt;
				}
				if (sql.includes("SELECT sql FROM sqlite_master")) {
					return auditSqlStmt;
				}
				if (sql.includes("sqlite_master") && sql.includes("type = 'index'")) {
					return indexStmt;
				}
				if (sql.includes("sqlite_master")) return tableStmt;
				if (sql.includes("PRAGMA table_info(comment)")) {
					return commentColumnsStmt;
				}
				if (sql.includes("PRAGMA table_info(friend_links)")) {
					return friendColumnsStmt;
				}
				if (sql.includes("PRAGMA table_info(music_tracks)")) {
					return musicColumnsStmt;
				}
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/setup/init-db", {
				method: "POST",
				headers: {
					authorization: "Bearer test-admin-token",
					"content-type": "application/json",
				},
				body: "{}",
			}),
			mockEnv({ DB: db }),
			mockCtx(),
		);

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			ok: true,
			applied: [],
			version: "0010",
		});
		expect(versionWrites).toContainEqual(["db_migration_version", "0010"]);
		expect(preparedSql.some((sql) => sql.startsWith("ALTER TABLE"))).toBe(
			false,
		);
	});

	it("repairs migration 0010 when content table exists but audit log is old", async () => {
		const preparedSql: string[] = [];
		const versionWrites: unknown[][] = [];
		const tables = new Set([
			"app_settings",
			"friend_links",
			"music_tracks",
			"stats_visitors",
			"stats_page_daily",
			"rate_limits",
			"comment",
			"config",
			"counter",
			"admin_audit_log",
			"content_posts",
		]);
		const indexes = new Set([
			"idx_friend_links_normalized_host_pending_approved_unique",
			"idx_friend_links_submitter_pending_created",
			"idx_music_tracks_object_key_unique",
			"idx_music_tracks_content_hash_unique",
			"idx_content_posts_status_published",
		]);
		const auditLogSql =
			"CREATE TABLE admin_audit_log (resource TEXT NOT NULL CHECK (resource IN ('friend', 'music', 'comment', 'telegram', 'init-db')))";
		const tableStmt = {
			table: "",
			bind: vi.fn((table: string) => {
				tableStmt.table = table;
				return tableStmt;
			}),
			first: vi.fn(async () =>
				tables.has(tableStmt.table) ? { name: tableStmt.table } : null,
			),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const indexStmt = {
			index: "",
			bind: vi.fn((index: string) => {
				indexStmt.index = index;
				return indexStmt;
			}),
			first: vi.fn(async () =>
				indexes.has(indexStmt.index) ? { name: indexStmt.index } : null,
			),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const auditSqlStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ sql: auditLogSql }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const appSettingSelectStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ value: "0010" }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const appSettingWriteStmt = {
			bind: vi.fn((...values: unknown[]) => {
				versionWrites.push(values);
				return appSettingWriteStmt;
			}),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const friendColumnsStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({
				results: [
					{ name: "id" },
					{ name: "normalized_host" },
					{ name: "submitter_hash" },
				],
			}),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const musicColumnsStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({
				results: [{ name: "id" }, { name: "content_hash" }],
			}),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const commentColumnsStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [{ name: "_id", pk: 1 }] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ count: 1 }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				preparedSql.push(sql);
				if (sql.includes("SELECT value FROM app_settings")) {
					return appSettingSelectStmt;
				}
				if (sql.includes("INSERT INTO app_settings")) {
					return appSettingWriteStmt;
				}
				if (sql.includes("SELECT sql FROM sqlite_master")) {
					return auditSqlStmt;
				}
				if (sql.includes("sqlite_master") && sql.includes("type = 'index'")) {
					return indexStmt;
				}
				if (sql.includes("sqlite_master")) return tableStmt;
				if (sql.includes("PRAGMA table_info(comment)"))
					return commentColumnsStmt;
				if (sql.includes("PRAGMA table_info(friend_links)")) {
					return friendColumnsStmt;
				}
				if (sql.includes("PRAGMA table_info(music_tracks)")) {
					return musicColumnsStmt;
				}
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/setup/init-db", {
				method: "POST",
				headers: {
					authorization: "Bearer test-admin-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ versions: ["0010"] }),
			}),
			mockEnv({ DB: db }),
			mockCtx(),
		);

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			ok: true,
			applied: ["0010"],
			version: "0010",
		});
		expect(preparedSql).toContain(
			"ALTER TABLE admin_audit_log_new RENAME TO admin_audit_log",
		);
		expect(preparedSql).toContain(
			`INSERT INTO admin_audit_log_new (
				id, actor_hash, action, resource, resource_id, details, ip, created_at
			)
			SELECT id, actor_hash, action, resource, resource_id, details, ip, created_at
			FROM admin_audit_log`,
		);
		expect(versionWrites).toContainEqual(["db_migration_version", "0010"]);
	});
});

// ================================================================
// Admin auth
// ================================================================
describe("Admin auth", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	it("rejects admin endpoint without token", async () => {
		const env = mockEnv({ ADMIN_TOKEN: undefined });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/friends"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(401);
	});

	it("accepts valid bearer token for admin endpoint", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/friends", {
				headers: { authorization: "Bearer test-admin-token" },
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
	});

	it("accepts custom admin token header before bearer authorization", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/friends", {
				headers: {
					authorization: "Bearer not-the-admin-token",
					"x-fuwari-admin-token": "test-admin-token",
				},
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
	});

	it("accepts a stored admin token hash when ADMIN_TOKEN is unset", async () => {
		const { hashTokenWithPbkdf2 } = await import("../utils");
		const token = "stored-admin-token";
		const storedHash = await hashTokenWithPbkdf2(token);
		const env = mockEnv({
			ADMIN_TOKEN: undefined,
			DB: mockSettingsDb({
				admin_token_sha256: storedHash,
				stats_salt: "stable-test-salt",
			}),
		});

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/friends", {
				headers: { "x-fuwari-admin-token": token },
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(200);
	});

	it("rejects malformed admin route ids", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/friends/1abc", {
				method: "DELETE",
				headers: {
					origin: "https://blog.example.com",
					"x-fuwari-admin-token": "test-admin-token",
				},
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(400);
	});
});

// ================================================================
// Public stats rate limiting
// ================================================================
describe("Stats API", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	it("rate-limits public stats summary reads", async () => {
		const saltStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ value: "stable-salt" }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const countStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi
				.fn()
				.mockResolvedValue({ count: RATE_LIMITS.statsSummary.limit + 1 }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("SELECT value FROM app_settings")) return saltStmt;
				if (sql.includes("SELECT count FROM rate_limits")) return countStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/stats/summary"),
			mockEnv({ DB: db }),
			mockCtx(),
		);

		expect(res.status).toBe(429);
	});
});

// ================================================================
// ALTCHA challenge return
// ================================================================
describe("Anti-abuse challenge", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	it("returns SHA-256 ALTCHA challenge", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request(
				"https://blog.example.com/api/anti-abuse/challenge?context=friends",
			),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toHaveProperty("challenge");
		const challenge = body.challenge as Record<string, unknown> | undefined;
		expect(challenge?.algorithm || body.mode).toBeDefined();
	});
});

// ================================================================
// Media path validation
// ================================================================
describe("Media path validation", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	it("rejects unknown media types", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/media/unknown/file.txt"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(404);
	});

	it("path traversal is caught at utils level", async () => {
		// The Request constructor normalizes encoded dots in URLs,
		// so path traversal cannot be tested through HTTP routing.
		// safeNormalizeMediaKey is tested in utils.test.ts (5 cases).
		const { safeNormalizeMediaKey } = await import("../utils");
		expect(safeNormalizeMediaKey("../../etc/passwd", "avatars")).toBeNull();
		expect(safeNormalizeMediaKey("music//song.mp3", "music")).toBeNull();
		expect(safeNormalizeMediaKey("song.mp3", "music")).toBe("music/song.mp3");
	});

	it("rejects invalid HTTP methods on media", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/media/music/song.mp3", {
				method: "POST",
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(405);
	});

	it("redirects missing embedded music covers to the default cover", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/media/covers/from-music/song.mp3"),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(
			"https://blog.example.com/favicon/favicon-light-192.png",
		);
	});
});

// ================================================================
// Friend link hostname deduplication
// ================================================================
describe("Friend link hostname deduplication", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	function jsonRequest(path: string, body: unknown, headers: HeadersInit = {}) {
		return new Request(`https://blog.example.com${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://blog.example.com",
				...headers,
			},
			body: JSON.stringify(body),
		});
	}

	it("requires human proof before public duplicate checks", async () => {
		const duplicateStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ id: 1 }),
		};
		const emptyStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) =>
				sql.includes("normalized_host = ?") ? duplicateStmt : emptyStmt,
			),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const env = mockEnv({ DB: db });

		const res = await worker.default.fetch(
			jsonRequest("/api/friends", {
				name: "Example",
				description: "A friendly blog",
				url: "https://www.Example.com/about",
				avatarUrl: "https://example.com/avatar.png",
				humanProof: { type: "altcha", payload: "invalid-but-not-used" },
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(400);
		expect(duplicateStmt.bind).not.toHaveBeenCalled();
	});

	it("rejects admin URL updates for an existing normalized host", async () => {
		const duplicateStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ id: 2 }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) =>
				sql.includes("normalized_host = ?") && sql.includes("id <>")
					? duplicateStmt
					: genericStmt,
			),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const env = mockEnv({ DB: db });

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/friends/1", {
				method: "PATCH",
				headers: {
					authorization: "Bearer test-admin-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ url: "https://www.Example.com/about" }),
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(409);
		expect(duplicateStmt.bind).toHaveBeenCalledWith("example.com", 1);
	});

	it("maps admin friend update unique constraint races to 409", async () => {
		const duplicateStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
		};
		const updateStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi
				.fn()
				.mockRejectedValue(
					new Error("UNIQUE constraint failed: friend_links.normalized_host"),
				),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("normalized_host = ?") && sql.includes("id <>")) {
					return duplicateStmt;
				}
				if (
					sql.includes("UPDATE friend_links SET") &&
					sql.includes("WHERE id = ?")
				)
					return updateStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/friends/1", {
				method: "PATCH",
				headers: {
					authorization: "Bearer test-admin-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ url: "https://www.example.com/about" }),
			}),
			mockEnv({ DB: db }),
			mockCtx(),
		);

		expect(res.status).toBe(409);
	});

	it("updates normalized host when admin changes a friend URL", async () => {
		const duplicateStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
		};
		const updateStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const getStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({
				id: 1,
				name: "Example",
				description: "A friendly blog",
				url: "https://www.Example.com/about",
				avatarUrl: "https://example.com/avatar.png",
				status: "pending",
				isActive: 1,
				sortOrder: 0,
			}),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("normalized_host = ?") && sql.includes("id <>")) {
					return duplicateStmt;
				}
				if (sql.includes("UPDATE friend_links SET")) return updateStmt;
				if (sql.includes("FROM friend_links WHERE id = ?")) return getStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const env = mockEnv({ DB: db });

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/friends/1", {
				method: "PATCH",
				headers: {
					authorization: "Bearer test-admin-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ url: "https://www.Example.com/about" }),
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(200);
		expect(updateStmt.bind).toHaveBeenCalledWith(
			"https://www.Example.com/about",
			"example.com",
			1,
		);
	});

	it("returns 404 when deleting a missing friend", async () => {
		const deleteStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) =>
				sql.includes("DELETE FROM friend_links") ? deleteStmt : genericStmt,
			),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/friends/99", {
				method: "DELETE",
				headers: { authorization: "Bearer test-admin-token" },
			}),
			mockEnv({ DB: db }),
			mockCtx(),
		);

		expect(res.status).toBe(404);
	});
});

// ================================================================
// Admin music management
// ================================================================
describe("Admin music management", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		vi.stubGlobal("caches", {
			default: {
				match: vi.fn().mockResolvedValue(undefined),
				put: vi.fn().mockResolvedValue(undefined),
			},
		});
		worker = await import("../index");
	});

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	function adminHeaders(): HeadersInit {
		return {
			origin: "https://blog.example.com",
			"x-fuwari-admin-token": "test-admin-token",
		};
	}

	it("rejects manual music creation when the R2 object is missing", async () => {
		const insertStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) =>
				sql.includes("INSERT INTO music_tracks") ? insertStmt : genericStmt,
			),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;

		const bucket = mockR2Bucket();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music", {
				method: "POST",
				headers: {
					...adminHeaders(),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					title: "Missing Song",
					objectKey: "music/missing.mp3",
					coverUrl: "/favicon/favicon-light-192.png",
				}),
			}),
			mockEnv({ DB: db, MEDIA_BUCKET: bucket }),
			mockCtx(),
		);

		expect(res.status).toBe(404);
		expect(bucket.head).toHaveBeenCalledWith("music/missing.mp3");
		expect(insertStmt.run).not.toHaveBeenCalled();
	});

	it("maps duplicate music object key constraints to 409 on create", async () => {
		const insertStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi
				.fn()
				.mockRejectedValue(
					new Error("UNIQUE constraint failed: music_tracks.object_key"),
				),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) =>
				sql.includes("INSERT INTO music_tracks") ? insertStmt : genericStmt,
			),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;

		const bucket = mockR2Bucket();
		vi.mocked(bucket.head).mockResolvedValue({} as R2Object);
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music", {
				method: "POST",
				headers: {
					...adminHeaders(),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					title: "Song",
					objectKey: "music/song.mp3",
					coverUrl: "/favicon/favicon-light-192.png",
				}),
			}),
			mockEnv({ DB: db, MEDIA_BUCKET: bucket }),
			mockCtx(),
		);

		expect(res.status).toBe(409);
	});

	it("rejects music object key updates when the R2 object is missing", async () => {
		const updateStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) =>
				sql.includes("UPDATE music_tracks SET") && sql.includes("WHERE id = ?")
					? updateStmt
					: genericStmt,
			),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const bucket = mockR2Bucket();

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/1", {
				method: "PATCH",
				headers: {
					...adminHeaders(),
					"content-type": "application/json",
				},
				body: JSON.stringify({ objectKey: "music/missing.mp3" }),
			}),
			mockEnv({ DB: db, MEDIA_BUCKET: bucket }),
			mockCtx(),
		);

		expect(res.status).toBe(404);
		expect(bucket.head).toHaveBeenCalledWith("music/missing.mp3");
		expect(updateStmt.run).not.toHaveBeenCalled();
	});

	it("returns 404 when deleting a missing music track", async () => {
		const deleteStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) =>
				sql.includes("DELETE FROM music_tracks") ? deleteStmt : genericStmt,
			),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/99", {
				method: "DELETE",
				headers: adminHeaders(),
			}),
			mockEnv({ DB: db }),
			mockCtx(),
		);

		expect(res.status).toBe(404);
	});

	it("preserves embedded cover URLs for tracks with blank stored covers", async () => {
		const listStmt = {
			all: vi.fn().mockResolvedValue({
				results: [
					{
						id: 1,
						title: "No Cover",
						artist: "Artist",
						album: "",
						objectKey: "music/no-cover.mp3",
						coverUrl: "",
						isActive: 1,
						sortOrder: 1,
					},
				],
			}),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) =>
				sql.includes("FROM music_tracks") ? listStmt : genericStmt,
			),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const env = mockEnv({ DB: db });

		const adminRes = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music", {
				headers: { "x-fuwari-admin-token": "test-admin-token" },
			}),
			env,
			mockCtx(),
		);
		const adminBody = (await adminRes.json()) as {
			tracks: Array<{ coverUrl: string }>;
		};
		expect(adminBody.tracks[0].coverUrl).toBe(
			"/media/covers/from-music/no-cover.mp3",
		);

		const publicRes = await worker.default.fetch(
			new Request("https://blog.example.com/api/music/tracks"),
			env,
			mockCtx(),
		);
		const publicBody = (await publicRes.json()) as {
			tracks: Array<{ coverUrl: string }>;
		};
		expect(publicBody.tracks[0].coverUrl).toBe(
			"/media/covers/from-music/no-cover.mp3",
		);
	});

	it("normalizes music sort order in one admin API call", async () => {
		const listStmt = {
			all: vi.fn().mockResolvedValue({ results: [{ id: 9 }, { id: 3 }] }),
		};
		const updateStmt = {
			bind: vi.fn().mockReturnThis(),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("SELECT id") && sql.includes("FROM music_tracks")) {
					return listStmt;
				}
				if (sql.includes("UPDATE music_tracks SET sort_order")) {
					return updateStmt;
				}
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([{ success: true }, { success: true }]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const env = mockEnv({ DB: db });

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/normalize-sort", {
				method: "POST",
				headers: adminHeaders(),
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; updated: number };
		expect(body).toEqual({ ok: true, updated: 2 });
		expect(updateStmt.bind).toHaveBeenCalledWith(1, 9);
		expect(updateStmt.bind).toHaveBeenCalledWith(2, 3);
		expect(db.batch).toHaveBeenCalledTimes(1);
	});

	it("rejects music upload without admin token", async () => {
		const env = mockEnv();
		const formData = new FormData();
		formData.append(
			"files",
			new File(["audio"], "song.mp3", { type: "audio/mpeg" }),
		);

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/upload", {
				method: "POST",
				body: formData,
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(401);
	});

	it("rejects authorized music upload without content-length", async () => {
		const env = mockEnv();
		const formData = new FormData();
		formData.append(
			"files",
			new File(["audio"], "song.mp3", { type: "audio/mpeg" }),
		);

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/upload", {
				method: "POST",
				headers: {
					origin: "https://blog.example.com",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: formData,
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(411);
	});

	it("returns duplicate result for uploaded music with an existing content hash", async () => {
		const bytes = new TextEncoder().encode("same audio");
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		const hash = Array.from(new Uint8Array(digest))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		const maxSortStmt = {
			first: vi.fn().mockResolvedValue({ maxSort: 5 }),
		};
		const hashStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi
				.fn()
				.mockResolvedValue({ id: 7, objectKey: "music/existing.mp3" }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("MAX(sort_order)")) return maxSortStmt;
				if (sql.includes("content_hash = ?")) return hashStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const bucket = mockR2Bucket();
		vi.mocked(bucket.head).mockResolvedValue({} as R2Object);
		const env = mockEnv({ DB: db, MEDIA_BUCKET: bucket });
		const formData = new FormData();
		formData.append(
			"files",
			new File([bytes], "song.mp3", { type: "audio/mpeg" }),
		);

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/upload", {
				method: "POST",
				headers: {
					origin: "https://blog.example.com",
					"content-length": "1024",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: formData,
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			duplicates: Array<{ hash: string; trackId: number; objectKey: string }>;
			uploaded: unknown[];
		};
		expect(body.uploaded).toHaveLength(0);
		expect(body.duplicates).toHaveLength(1);
		expect(body.duplicates[0]).toMatchObject({
			hash,
			trackId: 7,
			objectKey: "music/existing.mp3",
		});
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it("reuploads music when the matching D1 track points to a missing R2 object", async () => {
		const bytes = new TextEncoder().encode("same audio");
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		const hash = Array.from(new Uint8Array(digest))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		const schemaStmt = {
			all: vi.fn().mockResolvedValue({ results: [{ name: "content_hash" }] }),
		};
		const maxSortStmt = {
			first: vi.fn().mockResolvedValue({ maxSort: 5 }),
		};
		const hashStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({
				id: 7,
				objectKey: "music/stale.mp3",
				coverUrl: "/media/covers/stale.jpg",
			}),
		};
		const objectKeyStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
		};
		const deleteStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
		};
		const insertStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 12 } }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("PRAGMA table_info(music_tracks)")) return schemaStmt;
				if (sql.includes("MAX(sort_order)")) return maxSortStmt;
				if (sql.includes("content_hash = ?")) return hashStmt;
				if (sql.includes("WHERE object_key = ?")) return objectKeyStmt;
				if (sql.includes("DELETE FROM music_tracks")) return deleteStmt;
				if (sql.includes("INSERT INTO music_tracks")) return insertStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const bucket = mockR2Bucket();
		const env = mockEnv({ DB: db, MEDIA_BUCKET: bucket });
		const formData = new FormData();
		formData.append(
			"files",
			new File([bytes], "song.mp3", { type: "audio/mpeg" }),
		);

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/upload", {
				method: "POST",
				headers: {
					origin: "https://blog.example.com",
					"content-length": "1024",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: formData,
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			uploaded: Array<{ hash: string; trackId: number; objectKey: string }>;
			duplicates: unknown[];
			failed: unknown[];
		};
		expect(body.uploaded).toHaveLength(1);
		expect(body.uploaded[0]).toMatchObject({ hash, trackId: 12 });
		expect(body.duplicates).toHaveLength(0);
		expect(body.failed).toHaveLength(0);
		expect(deleteStmt.bind).toHaveBeenCalledWith(7);
		expect(bucket.delete).toHaveBeenCalledWith("music/stale.mp3");
		expect(bucket.delete).toHaveBeenCalledWith("covers/stale.jpg");
		expect(bucket.put).toHaveBeenCalledTimes(1);
	});

	it("deletes stored music objects when deleting an admin music track", async () => {
		const selectStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({
				id: 3,
				objectKey: "music/song.mp3",
				coverUrl: "/media/covers/song.jpg",
			}),
		};
		const deleteStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("SELECT id, object_key")) return selectStmt;
				if (sql.includes("DELETE FROM music_tracks")) return deleteStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const bucket = mockR2Bucket();

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/3", {
				method: "DELETE",
				headers: adminHeaders(),
			}),
			mockEnv({ DB: db, MEDIA_BUCKET: bucket }),
			mockCtx(),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { deletedObjects: string[] };
		expect(body.deletedObjects).toEqual(["music/song.mp3", "covers/song.jpg"]);
		expect(bucket.delete).toHaveBeenCalledWith("music/song.mp3");
		expect(bucket.delete).toHaveBeenCalledWith("covers/song.jpg");
	});

	it("accepts more than 10 files and processes them in backend batches", async () => {
		const maxSortStmt = {
			first: vi.fn().mockResolvedValue({ maxSort: 0 }),
		};
		const hashStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
		};
		const objectKeyStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
		};
		const insertStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 21 } }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("MAX(sort_order)")) return maxSortStmt;
				if (sql.includes("content_hash = ?")) return hashStmt;
				if (sql.includes("WHERE object_key = ?")) return objectKeyStmt;
				if (sql.includes("INSERT INTO music_tracks")) return insertStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const bucket = mockR2Bucket();
		const env = mockEnv({ DB: db, MEDIA_BUCKET: bucket });
		const formData = new FormData();
		for (let index = 0; index < 12; index += 1) {
			formData.append(
				"files",
				new File([`audio ${index}`], `Batch ${index}.mp3`, {
					type: "audio/mpeg",
				}),
			);
		}

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/upload", {
				method: "POST",
				headers: {
					origin: "https://blog.example.com",
					"content-length": "4096",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: formData,
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			uploaded: unknown[];
			duplicates: unknown[];
			failed: unknown[];
		};
		expect(body.uploaded).toHaveLength(12);
		expect(body.duplicates).toHaveLength(0);
		expect(body.failed).toHaveLength(0);
		expect(bucket.put).toHaveBeenCalledTimes(12);
		expect(insertStmt.run).toHaveBeenCalledTimes(12);
	});

	it("uploads new music to R2 and inserts a track", async () => {
		const maxSortStmt = {
			first: vi.fn().mockResolvedValue({ maxSort: 2 }),
		};
		const hashStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
		};
		const objectKeyStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
		};
		const insertStmt = {
			bind: vi.fn().mockReturnThis(),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 11 } }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("MAX(sort_order)")) return maxSortStmt;
				if (sql.includes("content_hash = ?")) return hashStmt;
				if (sql.includes("WHERE object_key = ?")) return objectKeyStmt;
				if (sql.includes("INSERT INTO music_tracks")) return insertStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;
		const bucket = mockR2Bucket();
		const env = mockEnv({ DB: db, MEDIA_BUCKET: bucket });
		const formData = new FormData();
		formData.append(
			"files",
			new File(["new audio"], "Artist - Title.mp3", { type: "audio/mpeg" }),
		);

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/upload", {
				method: "POST",
				headers: {
					origin: "https://blog.example.com",
					"content-length": "1024",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: formData,
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			uploaded: Array<{ objectKey: string; trackId: number }>;
			duplicates: unknown[];
			failed: unknown[];
		};
		expect(body.uploaded).toHaveLength(1);
		expect(body.duplicates).toHaveLength(0);
		expect(body.failed).toHaveLength(0);
		expect(body.uploaded[0].objectKey).toMatch(
			/^music\/Artist---Title-[a-f0-9]{12}\.mp3$/,
		);
		expect(body.uploaded[0].trackId).toBe(11);
		expect(bucket.put).toHaveBeenCalledTimes(1);
		expect(insertStmt.bind).toHaveBeenCalledWith(
			"Artist",
			"Title",
			"",
			expect.stringMatching(/^music\/Artist---Title-[a-f0-9]{12}\.mp3$/),
			"/favicon/favicon-light-192.png",
			1,
			3,
			expect.stringMatching(/^[a-f0-9]{64}$/),
		);
	});
});

// ================================================================
// Admin comments settings
// ================================================================
describe("Admin comments settings", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		vi.stubGlobal("caches", {
			default: {
				match: vi.fn().mockResolvedValue(undefined),
				put: vi.fn().mockResolvedValue(undefined),
			},
		});
		worker = await import("../index");
	});

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	function adminHeaders(): HeadersInit {
		return {
			origin: "https://blog.example.com",
			"x-fuwari-admin-token": "test-admin-token",
		};
	}

	it("GET returns current comments enabled status", async () => {
		const { db } = mockD1Result("true");
		const env = mockEnv({ DB: db });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/settings/comments", {
				headers: adminHeaders(),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { enabled: boolean };
		expect(body.enabled).toBe(true);
	});

	it("POST updates comments enabled status", async () => {
		const { db } = mockD1Result("false");
		const env = mockEnv({ DB: db });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/settings/comments", {
				method: "POST",
				headers: { ...adminHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; enabled: boolean };
		expect(body.ok).toBe(true);
		expect(body.enabled).toBe(false);
	});

	it("rejects admin comments endpoint without token", async () => {
		const env = mockEnv({ ADMIN_TOKEN: undefined });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/settings/comments"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(401);
	});

	it("areCommentsEnabled reads value from DB correctly", async () => {
		const { db } = mockD1Result("true");
		const env = mockEnv({ DB: db });
		const { areCommentsEnabled } = await import("../comments");
		expect(await areCommentsEnabled(env)).toBe(true);
	});
});

// ================================================================
// Admin Telegram notification settings
// ================================================================
describe("Admin Telegram notification settings", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		worker = await import("../index");
	});

	function adminHeaders(): HeadersInit {
		return {
			origin: "https://blog.example.com",
			"x-fuwari-admin-token": "test-admin-token",
		};
	}

	function writableSettingsDb(values: Record<string, string | undefined>) {
		const writes: Array<{ key: string; value: string }> = [];
		const selectStmt = {
			key: "",
			bind: vi.fn((key: string) => {
				selectStmt.key = key;
				return selectStmt;
			}),
			first: vi.fn(async () => {
				const value = values[selectStmt.key];
				return value === undefined ? null : { value };
			}),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const writeStmt = {
			bind: vi.fn((key: string, value: string) => {
				writes.push({ key, value });
				return writeStmt;
			}),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi
				.fn()
				.mockResolvedValue({ success: true, meta: { last_row_id: 1 } }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("SELECT value FROM app_settings")) return selectStmt;
				if (sql.includes("INSERT INTO app_settings")) return writeStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;

		return { db, writes };
	}

	it("preserves Telegram chatId and threadId on partial friend settings updates", async () => {
		const { db, writes } = writableSettingsDb({
			telegram_friend_notification: JSON.stringify({
				enabled: true,
				botToken: "old-token",
				chatId: "old-chat",
				threadId: "99",
			}),
		});

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/settings/telegram", {
				method: "POST",
				headers: {
					...adminHeaders(),
					"content-type": "application/json",
				},
				body: JSON.stringify({ enabled: false }),
			}),
			mockEnv({ DB: db }),
			mockCtx(),
		);

		expect(res.status).toBe(200);
		const saved = JSON.parse(
			writes.find((write) => write.key === "telegram_friend_notification")
				?.value ?? "{}",
		);
		expect(saved).toMatchObject({
			enabled: false,
			botToken: "old-token",
			chatId: "old-chat",
			threadId: "99",
		});
	});

	it("preserves Telegram chatId and threadId on partial comment settings updates", async () => {
		const { db, writes } = writableSettingsDb({
			telegram_comment_notification: JSON.stringify({
				enabled: true,
				useFriendSettings: false,
				botToken: "comment-token",
				chatId: "comment-chat",
				threadId: "34",
			}),
		});

		const res = await worker.default.fetch(
			new Request(
				"https://blog.example.com/api/admin/settings/telegram/comments",
				{
					method: "POST",
					headers: {
						...adminHeaders(),
						"content-type": "application/json",
					},
					body: JSON.stringify({ enabled: false }),
				},
			),
			mockEnv({ DB: db }),
			mockCtx(),
		);

		expect(res.status).toBe(200);
		const saved = JSON.parse(
			writes.find((write) => write.key === "telegram_comment_notification")
				?.value ?? "{}",
		);
		expect(saved).toMatchObject({
			enabled: false,
			useFriendSettings: false,
			botToken: "comment-token",
			chatId: "comment-chat",
			threadId: "34",
		});
	});

	it("sends comment test notifications through shared friend settings", async () => {
		const db = mockSettingsDb({
			telegram_friend_notification: JSON.stringify({
				enabled: false,
				botToken: "friend-token",
				chatId: "friend-chat",
				threadId: "12",
			}),
			telegram_comment_notification: JSON.stringify({
				enabled: true,
				useFriendSettings: true,
				botToken: "",
				chatId: "",
				threadId: "",
			}),
		});
		const telegramFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
			}),
		);
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", telegramFetch);
		try {
			const res = await worker.default.fetch(
				new Request(
					"https://blog.example.com/api/admin/settings/telegram/comments/test",
					{
						method: "POST",
						headers: adminHeaders(),
					},
				),
				mockEnv({ DB: db }),
				mockCtx(),
			);

			expect(res.status).toBe(200);
			expect(telegramFetch).toHaveBeenCalledTimes(1);
			expect(String(telegramFetch.mock.calls[0][0])).toContain(
				"botfriend-token/sendMessage",
			);
			const payload = JSON.parse(
				String(telegramFetch.mock.calls[0][1]?.body),
			) as Record<string, unknown>;
			expect(payload.chat_id).toBe("friend-chat");
			expect(payload.message_thread_id).toBe(12);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
		}
	});

	it("saves independent comment notification settings", async () => {
		const db = mockSettingsDb({
			telegram_comment_notification: JSON.stringify({
				enabled: true,
				useFriendSettings: true,
				botToken: "",
				chatId: "",
				threadId: "",
			}),
		});
		const res = await worker.default.fetch(
			new Request(
				"https://blog.example.com/api/admin/settings/telegram/comments",
				{
					method: "POST",
					headers: {
						...adminHeaders(),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						enabled: true,
						useFriendSettings: false,
						botToken: "comment-token",
						chatId: "comment-chat",
						threadId: "34",
					}),
				},
			),
			mockEnv({ DB: db }),
			mockCtx(),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			enabled: boolean;
			useFriendSettings: boolean;
			botTokenConfigured: boolean;
			chatId: string;
			threadId: string;
		};
		expect(body).toMatchObject({
			enabled: true,
			useFriendSettings: false,
			botTokenConfigured: true,
			chatId: "comment-chat",
			threadId: "34",
		});
	});
});

// ================================================================
// Twikoo security — session, upload, and auth guards
// ================================================================
describe("Twikoo security", () => {
	let worker: Awaited<typeof import("../index")>;

	beforeAll(async () => {
		vi.stubGlobal("caches", {
			default: {
				match: vi.fn().mockResolvedValue(undefined),
				put: vi.fn().mockResolvedValue(undefined),
			},
		});
		worker = await import("../index");
	});

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	/**
	 * Helper: make a Twikoo JSON-RPC style POST to /api/twikoo.
	 */
	function twikooRequest(
		event: string,
		extra: Record<string, unknown> = {},
		headers: Record<string, string> = {},
	): Request {
		return new Request("https://blog.example.com/api/twikoo", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://blog.example.com",
				...headers,
			},
			body: JSON.stringify({ event, ...extra }),
		});
	}

	it("rejects COMMENT_SUBMIT without a valid comments session", async () => {
		const { db } = mockD1Result("true");
		const env = mockEnv({ DB: db });
		const res = await worker.default.fetch(
			twikooRequest("COMMENT_SUBMIT", {
				url: "/post/test",
				ua: "test-agent",
				comment: "hello",
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("评论人机验证");
	});

	it("rejects UPLOAD_IMAGE without a valid comments session", async () => {
		const { db } = mockD1Result("true");
		const env = mockEnv({ DB: db });
		const res = await worker.default.fetch(
			twikooRequest("UPLOAD_IMAGE", {
				photo: "data:image/png;base64,iVBORw0KGgo=",
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("评论人机验证");
	});

	it("blocks COMMENT_SUBMIT when comments are globally disabled", async () => {
		const { db } = mockD1Result({ value: "false" });
		const env = mockEnv({ DB: db });
		const res = await worker.default.fetch(
			twikooRequest("COMMENT_SUBMIT", {
				url: "/post/test",
				ua: "test-agent",
				comment: "hello",
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("评论功能已关闭");
	});

	it("blocks UPLOAD_IMAGE when comments are globally disabled", async () => {
		const { db } = mockD1Result({ value: "false" });
		const env = mockEnv({ DB: db });
		const res = await worker.default.fetch(
			twikooRequest("UPLOAD_IMAGE", {
				photo: "data:image/png;base64,iVBORw0KGgo=",
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("评论功能已关闭");
	});

	it("rejects cross-site Twikoo write from foreign origin", async () => {
		const { db } = mockD1Result("true");
		const env = mockEnv({ DB: db });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/twikoo", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://evil.example.com",
				},
				body: JSON.stringify({
					event: "COMMENT_SUBMIT",
					url: "/post/test",
					ua: "test",
					comment: "x",
				}),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("跨站请求");
	});

	it("SET_PASSWORD succeeds as no-op (password managed via env var)", async () => {
		// SET_PASSWORD is accepted (code 0) but does nothing — the actual
		// admin password is managed via ADMIN_TOKEN Cloudflare secret.
		const { db } = mockD1Result("{}");
		const env = mockEnv({ DB: db });

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/twikoo", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://blog.example.com",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: JSON.stringify({
					event: "SET_PASSWORD",
					password: "hunter2",
				}),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { code?: number };
		expect(body.code).toBe(0);
	});

	it("rejects cross-site Twikoo admin writes without origin or referer", async () => {
		const { db } = mockD1Result("{}");
		const env = mockEnv({ DB: db });

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/twikoo", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: JSON.stringify({
					event: "SET_CONFIG",
				}),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(403);
	});

	it("rejects oversized aggregate music upload payloads", async () => {
		const env = mockEnv();
		const formData = new FormData();
		formData.append(
			"files",
			new File([new Uint8Array(25 * 1024 * 1024)], "song-a.mp3", {
				type: "audio/mpeg",
			}),
		);
		formData.append(
			"files",
			new File([new Uint8Array(25 * 1024 * 1024 + 1)], "song-b.mp3", {
				type: "audio/mpeg",
			}),
		);

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/music/upload", {
				method: "POST",
				headers: {
					origin: "https://blog.example.com",
					"content-length": String(50 * 1024 * 1024 + 1),
					"x-fuwari-admin-token": "test-admin-token",
				},
				body: formData,
			}),
			env,
			mockCtx(),
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("上传总大小");
	});

	it("allows read-only Twikoo events without a session", async () => {
		const { db } = mockD1Result("{}");
		const env = mockEnv({ DB: db });
		// GET_FUNC_VERSION is a read-only event that does not need a session.
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/twikoo", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ event: "GET_FUNC_VERSION" }),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { version: string };
		expect(body).toHaveProperty("version");
	});

	it("rate-limits public COMMENT_GET reads", async () => {
		const saltStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue({ value: "stable-salt" }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const countStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi
				.fn()
				.mockResolvedValue({ count: RATE_LIMITS.twikooCommentGet.limit + 1 }),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const genericStmt = {
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			all: vi.fn().mockResolvedValue({ results: [] }),
			run: vi.fn().mockResolvedValue({ success: true }),
		};
		const db = {
			prepare: vi.fn((sql: string) => {
				if (sql.includes("SELECT value FROM app_settings")) return saltStmt;
				if (sql.includes("SELECT count FROM rate_limits")) return countStmt;
				return genericStmt;
			}),
			batch: vi.fn().mockResolvedValue([]),
			exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
			dump: vi.fn().mockResolvedValue([]),
		} as unknown as D1Database;

		const res = await worker.default.fetch(
			twikooRequest("COMMENT_GET", { url: "/posts/test/" }),
			mockEnv({ DB: db }),
			mockCtx(),
		);

		expect(res.status).toBe(429);
	});

	it("rejects Twikoo admin login on the public comments endpoint", async () => {
		const plaintext = "my-secret";
		const { md5 } = await import("../utils");
		const { db } = mockD1Result("{}");
		const env = mockEnv({ DB: db, ADMIN_TOKEN: plaintext });
		const res = await worker.default.fetch(
			twikooRequest("LOGIN", { password: md5(plaintext) }),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code?: number; message?: string };
		expect(body.code).toBe(1024);
		expect(body.message).toContain("protected admin endpoint");
	});

	it("rejects Twikoo admin config writes on the public comments endpoint", async () => {
		const { db } = mockD1Result("{}");
		const env = mockEnv({ DB: db });
		const res = await worker.default.fetch(
			twikooRequest("SET_CONFIG", { config: { private: true } }),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code?: number; message?: string };
		expect(body.code).toBe(1024);
		expect(body.message).toContain("protected admin endpoint");
	});

	it("rejects Twikoo admin endpoint without the site admin token", async () => {
		const plaintext = "my-secret";
		const { md5 } = await import("../utils");
		const { db } = mockD1Result("{}");
		const env = mockEnv({ DB: db, ADMIN_TOKEN: plaintext });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/twikoo", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://blog.example.com",
				},
				body: JSON.stringify({
					event: "LOGIN",
					password: md5(plaintext),
				}),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(401);
	});

	it("allows Twikoo admin login on the protected admin endpoint", async () => {
		const plaintext = "my-secret";
		const { md5 } = await import("../utils");
		const { db } = mockD1Result("{}");
		const env = mockEnv({ DB: db, ADMIN_TOKEN: plaintext });
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/admin/twikoo", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://blog.example.com",
					"x-fuwari-admin-token": plaintext,
				},
				body: JSON.stringify({
					event: "LOGIN",
					password: md5(plaintext),
				}),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { code?: number; accessToken?: string };
		expect(body.code).toBe(0);
		expect(body.accessToken).toBe(md5(plaintext));
	});
});

// ================================================================
// Twikoo adapter — upload validation and SET_PASSWORD
// ================================================================
describe("Twikoo adapter upload validation", () => {
	let twikooWorker: Awaited<typeof import("../twikoo-adapter")>;

	beforeAll(async () => {
		twikooWorker = await import("../twikoo-adapter");
	});

	/**
	 * Build a minimal TwikooWorkerEnv for testing upload / password flows.
	 * These tests bypass the comments.ts session gate and exercise the
	 * adapter's internal validation directly.
	 */
	function twikooEnv(overrides: Record<string, unknown> = {}) {
		const { db } = mockD1Result("{}");
		return {
			DB: db,
			R2: undefined as R2Bucket | undefined,
			R2_PUBLIC_URL: undefined as string | undefined,
			...overrides,
		};
	}

	function twikooBody(
		event: string,
		extra: Record<string, unknown> = {},
	): Request {
		return new Request("https://blog.example.com/api/twikoo", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ event, ...extra }),
		});
	}

	it("rejects SVG upload as unsupported format", async () => {
		const env = twikooEnv({
			R2: mockR2Bucket(),
			R2_PUBLIC_URL: "https://blog.example.com/media/twikoo",
		});
		const res = await twikooWorker.default.fetch(
			twikooBody("UPLOAD_IMAGE", {
				photo:
					"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==",
			}),
			env,
		);
		const body = (await res.json()) as { code: number; message: string };
		expect(body.code).toBe(1040);
		expect(body.message).toContain("不支持的图片格式");
	});

	it("rejects upload exceeding 5 MB size cap", async () => {
		const env = twikooEnv({
			R2: mockR2Bucket(),
			R2_PUBLIC_URL: "https://blog.example.com/media/twikoo",
		});
		// Build a base64 payload that decodes to >5 MB.
		// 1 base64 char = 6 bits, so ~1.37 MB per 1M base64 chars.
		// 8M base64 chars → ~6 MB decoded.
		const largePayload = "A".repeat(8 * 1024 * 1024);
		const res = await twikooWorker.default.fetch(
			twikooBody("UPLOAD_IMAGE", {
				photo: `data:image/png;base64,${largePayload}`,
			}),
			env,
		);
		const body = (await res.json()) as { code: number; message: string };
		expect(body.code).toBe(1040);
		expect(body.message).toContain("5 MB");
	});

	it("rejects upload without R2 configured", async () => {
		const env = twikooEnv();
		const res = await twikooWorker.default.fetch(
			twikooBody("UPLOAD_IMAGE", {
				photo: "data:image/png;base64,iVBORw0KGgo=",
			}),
			env,
		);
		const body = (await res.json()) as { code: number; message: string };
		expect(body.code).toBe(1040);
		expect(body.message).toContain("R2");
	});

	it("accepts valid PNG upload", async () => {
		const env = twikooEnv({
			R2: mockR2Bucket(),
			R2_PUBLIC_URL: "https://blog.example.com/media/twikoo",
		});
		// Minimal valid base64-encoded PNG (1×1 pixel).
		const res = await twikooWorker.default.fetch(
			twikooBody("UPLOAD_IMAGE", {
				photo:
					"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			}),
			env,
		);
		const body = (await res.json()) as {
			code: number;
			data?: { url: string };
		};
		expect(body.code).toBe(0);
		expect(body.data).toBeDefined();
		expect(body.data?.url).toContain("/media/twikoo/");
	});

	it("SET_PASSWORD succeeds as no-op", async () => {
		const env = twikooEnv();
		const res = await twikooWorker.default.fetch(
			twikooBody("SET_PASSWORD", { password: "new-secure-password" }),
			env,
		);
		const body = (await res.json()) as { code: number };
		expect(body.code).toBe(0);
	});

	it("GET_COMMENTS_COUNT rejects too many urls", async () => {
		const env = twikooEnv();
		const res = await twikooWorker.default.fetch(
			twikooBody("GET_COMMENTS_COUNT", {
				urls: Array.from({ length: 101 }, (_, index) => `/post/${index}`),
			}),
			env,
		);
		const body = (await res.json()) as { code: number; message: string };
		expect(body.code).toBe(1000);
		expect(body.message).toContain("urls");
	});

	it("GET_RECENT_COMMENTS rejects too many urls", async () => {
		const env = twikooEnv();
		const res = await twikooWorker.default.fetch(
			twikooBody("GET_RECENT_COMMENTS", {
				urls: Array.from({ length: 101 }, (_, index) => `/post/${index}`),
			}),
			env,
		);
		const body = (await res.json()) as { code: number; message: string };
		expect(body.code).toBe(1000);
		expect(body.message).toContain("urls");
	});

	it("LOGIN succeeds with correct ADMIN_TOKEN-derived password", async () => {
		// The Twikoo frontend (TkAdmin.vue) pre-hashes the password with
		// MD5 before sending LOGIN.  The password field in the request is a
		// 32-char MD5 hex string, NOT the plaintext password.
		const plaintext = "my-secret";
		const { md5 } = await import("../utils");
		const adminPasswordHash = md5(plaintext);
		const env = twikooEnv({ adminPasswordHash });
		const res = await twikooWorker.default.fetch(
			twikooBody("LOGIN", { password: md5(plaintext) }),
			env,
		);
		const body = (await res.json()) as { code: number; accessToken?: string };
		expect(body.code).toBe(0);
		expect(body.accessToken).toBe(md5(plaintext));
	});

	it("LOGIN with wrong password returns PASS_NOT_MATCH", async () => {
		const plaintext = "correct-password";
		const { md5 } = await import("../utils");
		const adminPasswordHash = md5(plaintext);
		const env = twikooEnv({ adminPasswordHash });
		// Frontend sends md5(wrong-input) vs backend md5(correct-password).
		const res = await twikooWorker.default.fetch(
			twikooBody("LOGIN", {
				password: md5("wrong-password"),
			}),
			env,
		);
		const body = (await res.json()) as { code: number };
		expect(body.code).toBe(1023); // PASS_NOT_MATCH
	});

	it("LOGIN without configured env var returns PASS_NOT_EXIST", async () => {
		const env = twikooEnv();
		const res = await twikooWorker.default.fetch(
			twikooBody("LOGIN", { password: "guess" }),
			env,
		);
		const body = (await res.json()) as { code: number };
		expect(body.code).toBe(1022); // PASS_NOT_EXIST
	});
});
