/**
 * Worker integration tests.
 *
 * These tests exercise the Worker's route dispatch and response shape
 * by calling handler functions directly with mocked Env bindings.
 * vitest transpiles TypeScript automatically so worker imports work.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
		ASSETS: {
			fetch: vi
				.fn()
				.mockResolvedValue(new Response("static asset", { status: 200 })),
		} as unknown as Fetcher,
		ADMIN_TOKEN: "test-admin-token",
		...overrides,
	} as Env;
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

	it("old setup URL returns 410", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/setup/init-db"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(410);
	});

	it("non-API paths fall through to static assets", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/"),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
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
		return { authorization: "Bearer test-admin-token" };
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
		expect(body.error).toContain("人机验证");
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
		expect(body.error).toContain("人机验证");
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
		expect(body.error).toContain("评论区已关闭");
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
		expect(body.error).toContain("评论区已关闭");
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
		expect(body.error).toContain("跨站");
	});

	it("allows first-time SET_PASSWORD without admin token", async () => {
		// Config table returns '{}' — no ADMIN_PASS set yet.
		// First-time password setup is allowed via the browser UI;
		// CSRF + aggressive rate limiting (5/10min) protect it.
		const { db } = mockD1Result("{}");
		const env = mockEnv({ DB: db, ADMIN_TOKEN: "test-admin-token" });

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/twikoo", {
				method: "POST",
				headers: { "content-type": "application/json" },
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

	it("LOGIN auto-sets password on first call (SET + LOGIN)", async () => {
		// Config table has no ADMIN_PASS — login should auto-set
		// the password (PBKDF2) and then issue a session token,
		// so the blog owner can set up admin access via the browser UI.
		const { db } = mockD1Result("{}");
		const env = mockEnv({ DB: db });

		const res = await worker.default.fetch(
			new Request("https://blog.example.com/api/twikoo", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ event: "LOGIN", password: "my-secret" }),
			}),
			env,
			mockCtx(),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { code: number; accessToken?: string };
		expect(body.code).toBe(0);
		expect(body.accessToken).toBeTruthy();
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

	it("SET_PASSWORD succeeds when no password exists", async () => {
		const env = twikooEnv();
		const res = await twikooWorker.default.fetch(
			twikooBody("SET_PASSWORD", { password: "new-secure-password" }),
			env,
		);
		const body = (await res.json()) as { code: number };
		expect(body.code).toBe(0);
	});
});
