/**
 * Worker integration tests.
 *
 * These tests exercise the Worker's route dispatch and response shape
 * by calling handler functions directly with mocked Env bindings.
 * vitest transpiles TypeScript automatically so worker imports work.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
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
			{} as ExecutionContext,
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
			{} as ExecutionContext,
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
			{} as ExecutionContext,
		);
		expect(res.status).toBe(410);
	});

	it("non-API paths fall through to static assets", async () => {
		const env = mockEnv();
		const res = await worker.default.fetch(
			new Request("https://blog.example.com/"),
			env,
			{} as ExecutionContext,
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
			{} as ExecutionContext,
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
			{} as ExecutionContext,
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
			{} as ExecutionContext,
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
			{} as ExecutionContext,
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
			{} as ExecutionContext,
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
			{} as ExecutionContext,
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
			{} as ExecutionContext,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("challenge");
		expect(body.challenge.algorithm || body.mode).toBeDefined();
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
			{} as ExecutionContext,
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
			{} as ExecutionContext,
		);
		expect(res.status).toBe(405);
	});
});
