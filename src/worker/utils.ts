import {
	ADMIN_AUDIT_SALT_SETTING_KEY,
	apiError,
	CACHE_VERSION_DOMAINS,
	type CacheDomain,
	MAX_JSON_BODY_BYTES,
	MUSIC_METADATA_READ_BYTES,
	RATE_LIMIT_MAX_AGE_SECONDS,
	SECURITY_HEADERS,
} from "./constants";
import { RUNTIME_BOOTSTRAP_STATEMENTS } from "./db-schema";
import type { Env } from "./types";
import type {
	EmbeddedCover,
	HumanProof,
	HumanProofContext,
	JsonRecord,
	MusicMetadata,
	RateLimitConfig,
} from "./types/aliases";

// ================================================================
// Response helpers
// ================================================================

export function json(data: unknown, status = 200): Response {
	return withSecurityHeaders(
		Response.json(data, {
			status,
			headers: { "cache-control": "no-store" },
		}),
	);
}

export function withSecurityHeaders(response: Response): Response {
	const secured = new Response(response.body, response);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		if (!secured.headers.has(name)) {
			secured.headers.set(name, value);
		}
	}
	return secured;
}

export function withServerTiming(
	response: Response,
	startedAt: number,
): Response {
	const timed = new Response(response.body, response);
	const totalMs = Math.max(0, performance.now() - startedAt).toFixed(1);
	const existing = timed.headers.get("server-timing");
	timed.headers.set(
		"server-timing",
		existing ? `${existing}, total;dur=${totalMs}` : `total;dur=${totalMs}`,
	);
	return timed;
}

export async function cachedResponse(
	request: Request,
	ctx: ExecutionContext,
	ttlSeconds: number,
	producer: () => Promise<Response> | Response,
): Promise<Response> {
	if (request.method !== "GET") return producer();

	const cache = (caches as CacheStorage & { readonly default: Cache }).default;
	const cacheKey = new Request(request.url, request);
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const response = await producer();
	const next = new Response(response.body, response);

	if (next.status !== 200 || next.headers.has("set-cookie")) {
		return next;
	}

	next.headers.set(
		"cache-control",
		`public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
	);
	ctx.waitUntil(cache.put(cacheKey, next.clone()));
	return next;
}

// ================================================================
// Cache version (stale-while-revalidate via versioned cache keys)
// ================================================================

/**
 * Read the current cache version for a domain from app_settings.
 * Versions start at "1" and increment atomically on each mutation.
 */
async function getCacheVersion(env: Env, domain: CacheDomain): Promise<number> {
	const key = CACHE_VERSION_DOMAINS[domain];
	try {
		const row = await env.DB.prepare(
			"SELECT value FROM app_settings WHERE key = ?",
		)
			.bind(key)
			.first<{ value: string }>();
		return Number(row?.value ?? "1");
	} catch (error) {
		if (isMissingD1SchemaError(error)) return 1;
		throw error;
	}
}

/**
 * Increment the cache version for a domain, invalidating all cached
 * responses that were keyed under the old version.
 */
export async function incrementCacheVersion(
	env: Env,
	domain: CacheDomain,
): Promise<number> {
	const key = CACHE_VERSION_DOMAINS[domain];
	await env.DB.prepare(
		`INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(key) DO UPDATE SET
       value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
       updated_at = excluded.updated_at`,
	)
		.bind(key)
		.run();
	const row = await env.DB.prepare(
		"SELECT value FROM app_settings WHERE key = ?",
	)
		.bind(key)
		.first<{ value: string }>();
	return Number(row?.value ?? "1");
}

/**
 * Like `cachedResponse`, but scopes the cache key to a version domain.
 * When `incrementCacheVersion()` is called, all cached entries for
 * that domain become stale because subsequent requests use a different `_cv` value.
 */
export async function cachedResponseV(
	request: Request,
	ctx: ExecutionContext,
	ttlSeconds: number,
	env: Env,
	domain: CacheDomain,
	producer: () => Promise<Response> | Response,
): Promise<Response> {
	if (request.method !== "GET") return producer();

	const version = await getCacheVersion(env, domain);
	const cache = (caches as CacheStorage & { readonly default: Cache }).default;
	const versionedUrl = `${request.url}${request.url.includes("?") ? "&" : "?"}_cv=${version}`;
	const cacheKey = new Request(versionedUrl, request);
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const response = await producer();
	const next = new Response(response.body, response);

	if (next.status !== 200 || next.headers.has("set-cookie")) {
		return next;
	}

	next.headers.set(
		"cache-control",
		`public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
	);
	ctx.waitUntil(cache.put(cacheKey, next.clone()));
	return next;
}

// ================================================================
// Crypto / hash helpers
// ================================================================

/**
 * Fast deterministic SHA-256 hash used for rate-limit actor identification
 * and other non-sensitive hashing.  NOT suitable for stored credentials.
 */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Pure-JS MD5 hash (RFC 1321) for Twikoo compatibility.
 * The Twikoo frontend (TkAdmin.vue) imports md5 from blueimp-md5 and
 * sends md5(plaintext) as the password field in LOGIN / SET_PASSWORD.
 * Web Crypto API does not support MD5, so we compute it manually.
 * Returns a 32-char lowercase hex string, matching blueimp-md5 output.
 */
export function md5(text: string): string {
	const bytes = utf8Encode(text);
	const bitLength = bytes.length * 8;

	// Append padding: 0x80, then zeros, then 64-bit length (little-endian)
	const paddedLength = (((bytes.length + 8) >>> 6) + 1) << 6;
	const padded = new Uint8Array(paddedLength);
	padded.set(bytes);
	padded[bytes.length] = 0x80;

	const dataView = new DataView(padded.buffer);
	dataView.setUint32(paddedLength - 8, bitLength, true); // low 32 bits
	dataView.setUint32(
		paddedLength - 4,
		Math.floor(bitLength / 0x100000000),
		true,
	); // high 32 bits

	// MD5 initial state
	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	const S = [
		7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
		9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
		16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
		15, 21,
	];

	const K = new Uint32Array(64);
	for (let i = 0; i < 64; i++) {
		K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);
	}

	for (let offset = 0; offset < paddedLength; offset += 64) {
		const M = new Uint32Array(16);
		for (let i = 0; i < 16; i++) {
			M[i] = dataView.getUint32(offset + i * 4, true);
		}

		let A = a0;
		let B = b0;
		let C = c0;
		let D = d0;

		for (let i = 0; i < 64; i++) {
			let F: number;
			let g: number;
			if (i < 16) {
				F = (B & C) | (~B & D);
				g = i;
			} else if (i < 32) {
				F = (D & B) | (~D & C);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				F = B ^ C ^ D;
				g = (3 * i + 5) % 16;
			} else {
				F = C ^ (B | ~D);
				g = (7 * i) % 16;
			}

			const tempD = D;
			D = C;
			C = B;
			B = (B + leftRotate(A + F + K[i] + M[g], S[i])) >>> 0;
			A = tempD;
		}

		a0 = (a0 + A) >>> 0;
		b0 = (b0 + B) >>> 0;
		c0 = (c0 + C) >>> 0;
		d0 = (d0 + D) >>> 0;
	}

	return toHex32(a0) + toHex32(b0) + toHex32(c0) + toHex32(d0);
}

function utf8Encode(text: string): Uint8Array {
	const result: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) {
			result.push(code);
		} else if (code < 0x800) {
			result.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code < 0xd800 || code >= 0xe000) {
			result.push(
				0xe0 | (code >> 12),
				0x80 | ((code >> 6) & 0x3f),
				0x80 | (code & 0x3f),
			);
		} else {
			// Surrogate pair
			const high = code;
			const low = text.charCodeAt(i + 1);
			if (low < 0xdc00 || low > 0xdfff) {
				result.push(0xef, 0xbf, 0xbd);
				continue;
			}
			i++;
			const combined = 0x10000 + (((high & 0x3ff) << 10) | (low & 0x3ff));
			result.push(
				0xf0 | (combined >> 18),
				0x80 | ((combined >> 12) & 0x3f),
				0x80 | ((combined >> 6) & 0x3f),
				0x80 | (combined & 0x3f),
			);
		}
	}
	return new Uint8Array(result);
}

function leftRotate(value: number, amount: number): number {
	return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function toHex32(value: number): string {
	return [0, 8, 16, 24]
		.map((shift) => ((value >>> shift) & 0xff).toString(16).padStart(2, "0"))
		.join("");
}

/** PBKDF2 iteration count — tuned for Workers CPU (keeps latency ~100-200ms). */
const PBKDF2_ITERATIONS = 100_000;

/**
 * Hash a token with PBKDF2-SHA-256 and a random 128-bit salt.
 * Returns "pbkdf2:<salt_hex>:<hash_hex>" suitable for long-term storage.
 */
export async function hashTokenWithPbkdf2(token: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(token),
		{ name: "PBKDF2" },
		false,
		["deriveBits"],
	);
	const derived = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256",
		},
		keyMaterial,
		256,
	);
	const saltHex = Array.from(salt)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const hashHex = Array.from(new Uint8Array(derived))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `pbkdf2:${saltHex}:${hashHex}`;
}

/**
 * Verify a token against a stored hash (either legacy raw SHA-256 or
 * modern PBKDF2 format).  Automatically upgrades legacy hashes on match.
 * Returns the (possibly upgraded) hash when the token matches, or null.
 */
async function verifyAndMaybeUpgradeTokenHash(
	env: Env,
	token: string,
	storedHash: string,
): Promise<string | null> {
	// Modern PBKDF2 format: "pbkdf2:<salt_hex>:<hash_hex>"
	if (storedHash.startsWith("pbkdf2:")) {
		const parts = storedHash.slice("pbkdf2:".length).split(":");
		if (parts.length !== 2) return null;
		const saltBytes = new Uint8Array(
			(parts[0].match(/.{2}/g) ?? []).map((b) => Number.parseInt(b, 16)),
		);
		if (saltBytes.length !== 16) return null;
		const keyMaterial = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(token),
			{ name: "PBKDF2" },
			false,
			["deriveBits"],
		);
		const derived = await crypto.subtle.deriveBits(
			{
				name: "PBKDF2",
				salt: saltBytes,
				iterations: PBKDF2_ITERATIONS,
				hash: "SHA-256",
			},
			keyMaterial,
			256,
		);
		const hashHex = Array.from(new Uint8Array(derived))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		return timingSafeEqual(hashHex, parts[1]) ? storedHash : null;
	}

	// Legacy raw SHA-256 (64 hex chars) — verify and auto-upgrade.
	const legacyHash = await hashToken(token);
	if (timingSafeEqual(legacyHash, storedHash)) {
		// Compute the PBKDF2 hash and persist it directly so we don't
		// pay for PBKDF2 twice (saveStoredAdminTokenHash also hashes).
		const upgraded = await hashTokenWithPbkdf2(token);
		await env.DB.prepare(
			`INSERT INTO app_settings (key, value, updated_at)
	     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	     ON CONFLICT(key) DO UPDATE SET
	       value = excluded.value,
	       updated_at = excluded.updated_at`,
		)
			.bind("admin_token_sha256", upgraded)
			.run();
		return upgraded;
	}
	return null;
}

export async function signSessionValue(
	_env: Env,
	value: string,
	salt: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(salt),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function timingSafeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) {
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}
	return diff === 0;
}

export function base64UrlEncode(value: string): string {
	return btoa(value)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): string {
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	return atob(padded);
}

export function maskSecret(value: string): string {
	if (!value) return "";
	if (value.length <= 8) return "********";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

// ================================================================
// Request parsing
// ================================================================

class BodyTooLargeError extends Error {
	constructor() {
		super("Request body exceeds the configured limit.");
		this.name = "BodyTooLargeError";
	}
}

async function readLimitedTextBody(
	request: Request,
	maxBytes: number,
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new BodyTooLargeError();
	}

	const reader = request.body?.getReader();
	if (!reader) return "";

	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new BodyTooLargeError();
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} finally {
		reader.releaseLock();
	}
}

export async function readJson(request: Request): Promise<JsonRecord> {
	const result = await readJsonBody(request, MAX_JSON_BODY_BYTES);
	return result instanceof Response ? {} : result;
}

export async function readJsonBody(
	request: Request,
	maxBytes: number,
): Promise<JsonRecord | Response> {
	const lengthError = rejectOversizedBody(request, maxBytes);
	if (lengthError) return lengthError;

	try {
		const text = await readLimitedTextBody(request, maxBytes);
		if (!text.trim()) return {};
		const data = JSON.parse(text);
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			return json({ error: apiError("INVALID_JSON") }, 400);
		}
		return data as JsonRecord;
	} catch (error) {
		if (error instanceof BodyTooLargeError) {
			return json({ error: apiError("BODY_TOO_LARGE") }, 413);
		}
		return json({ error: apiError("INVALID_JSON") }, 400);
	}
}

/**
 * Reject POST/PUT/PATCH/DELETE requests whose Content-Length exceeds maxBytes.
 * Call per-endpoint before reading the body so we bound memory pressure.
 * Returns null when the size is acceptable; a 413 Response otherwise.
 */
export function rejectOversizedBody(
	request: Request,
	maxBytes: number,
	options: { requireContentLength?: boolean } = {},
): Response | null {
	const rawLength = request.headers.get("content-length");
	if (rawLength === null || rawLength.trim() === "") {
		if (options.requireContentLength) {
			return json({ error: apiError("BODY_LENGTH_REQUIRED") }, 411);
		}
		return null;
	}

	if (!/^\d+$/.test(rawLength.trim())) {
		return json({ error: apiError("BODY_TOO_LARGE") }, 413);
	}

	const length = Number(rawLength);
	if (!Number.isSafeInteger(length) || length > maxBytes) {
		return json({ error: apiError("BODY_TOO_LARGE") }, 413);
	}
	return null;
}

export function readString(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maxLength);
}

export function readInteger(value: unknown, fallback: number): number {
	const parsed =
		typeof value === "number"
			? value
			: Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1" || value === "true") return true;
	if (value === 0 || value === "0" || value === "false") return false;
	return fallback;
}

export function readHumanProof(value: unknown): HumanProof | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const proof = value as Record<string, unknown>;
	return {
		type: "altcha",
		payload: readString(proof.payload, 20000),
	};
}

export function readBearerToken(request: Request): string {
	const authorization = request.headers.get("authorization") ?? "";
	return authorization.startsWith("Bearer ")
		? authorization.slice("Bearer ".length).trim()
		: "";
}

export function readAdminToken(request: Request): string {
	return (
		request.headers.get("x-fuwari-admin-token")?.trim() ||
		readBearerToken(request)
	);
}

export function readCookie(request: Request, name: string): string {
	const cookie = request.headers.get("cookie") ?? "";
	for (const part of cookie.split(";")) {
		const [rawKey, ...rawValue] = part.trim().split("=");
		if (rawKey === name) return rawValue.join("=");
	}
	return "";
}

export function normalizeHumanProofContext(
	value: string | null,
	validContexts: Set<string>,
): HumanProofContext {
	const ctx = value?.trim() ?? "";
	return validContexts.has(ctx) ? (ctx as HumanProofContext) : "friends";
}

// ================================================================
// URL / origin / validation
// ================================================================

const TRUSTED_PROXY_TOKEN_HEADER = "x-fuwari-proxy-token";
const TRUSTED_PROXY_ORIGIN_HEADER = "x-fuwari-proxy-origin";
const TRUSTED_PROXY_CLIENT_IP_HEADER = "x-fuwari-client-ip";

export function isSameOrigin(value: string, requestUrl: string): boolean {
	try {
		return new URL(value).origin === new URL(requestUrl).origin;
	} catch {
		return false;
	}
}

function isTrustedProxyRequest(request: Request, env?: Env): boolean {
	const configured = env?.CONTENT_SYNC_TOKEN?.trim();
	if (!configured) return false;
	const token = request.headers.get(TRUSTED_PROXY_TOKEN_HEADER)?.trim() ?? "";
	return Boolean(token && timingSafeEqual(token, configured));
}

function getTrustedProxyOrigin(request: Request, env?: Env): string {
	if (!isTrustedProxyRequest(request, env)) return "";
	const value = request.headers.get(TRUSTED_PROXY_ORIGIN_HEADER) ?? "";
	try {
		return new URL(value).origin;
	} catch {
		return "";
	}
}

function isLocalDevWriteSource(
	sourceOrigin: string,
	targetOrigin: string,
): boolean {
	return (
		sourceOrigin === "http://localhost:4321" &&
		(targetOrigin === "http://localhost:8787" ||
			targetOrigin === "http://127.0.0.1:8787")
	);
}

function isTrustedWriteSource(
	value: string,
	request: Request,
	env?: Env,
): boolean {
	try {
		const sourceOrigin = new URL(value).origin;
		const targetOrigin = new URL(request.url).origin;
		const proxyOrigin = getTrustedProxyOrigin(request, env);
		return (
			sourceOrigin === targetOrigin ||
			Boolean(proxyOrigin && sourceOrigin === proxyOrigin) ||
			isLocalDevWriteSource(sourceOrigin, targetOrigin)
		);
	} catch {
		return false;
	}
}

export function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

export function isAvatarUrl(value: string): boolean {
	if (isHttpsUrl(value)) return true;
	if (value.startsWith("/media/avatars/")) {
		return (
			safeNormalizeMediaKey(
				value.slice("/media/avatars/".length),
				"avatars",
			) !== null
		);
	}
	if (value.startsWith("/media/covers/")) {
		return (
			safeNormalizeMediaKey(value.slice("/media/covers/".length), "covers") !==
			null
		);
	}
	return false;
}

/**
 * Validate a friend link URL with strict rules.
 * Rejects IP addresses, localhost, credentials in URL, and URLs with @ in authority.
 */
export function isValidFriendUrl(value: string): boolean {
	if (!isHttpsUrl(value)) return false;
	try {
		const url = new URL(value);
		// Reject credentials in URL
		if (url.username || url.password) return false;
		// Reject @ in hostname (bypass attempt)
		if (url.hostname.includes("@")) return false;
		// Reject raw IP addresses (IPv4 and IPv6)
		if (/^[\d.]+$/.test(url.hostname)) {
			const parts = url.hostname.split(".");
			if (
				parts.length === 4 &&
				parts.every((p) => {
					const n = Number(p);
					return n >= 0 && n <= 255 && String(n) === p;
				})
			)
				return false;
		}
		if (url.hostname.startsWith("[")) return false; // IPv6
		// Reject localhost and common internal hostnames
		const hostLower = url.hostname.toLowerCase();
		if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostLower))
			return false;
		if (hostLower === "0.0.0.0") return false;
		// Require at least one dot in hostname (reject bare TLD-like names)
		if (!hostLower.includes(".")) return false;
		return true;
	} catch {
		return false;
	}
}

export function normalizeFriendHostname(value: string): string {
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
	} catch {
		return "";
	}
}

/**
 * Validate an avatar URL: only https:// URLs and internal /media/* paths.
 * Blocks data:, javascript:, file:, and other dangerous schemes.
 */
export function isValidAvatarUrl(value: string): boolean {
	if (value.startsWith("/media/")) {
		return isAvatarUrl(value); // delegates to safeNormalizeMediaKey
	}
	if (!isHttpsUrl(value)) return false;
	try {
		const url = new URL(value);
		// Reject credentials
		if (url.username || url.password) return false;
		// Reject @ in hostname
		if (url.hostname.includes("@")) return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate a display name: no HTML tags, no URLs, 1–40 chars after trim.
 */
export function isValidDisplayName(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 40) return false;
	if (/<[^>]*>/.test(trimmed)) return false;
	if (/https?:\/\//.test(trimmed)) return false;
	return true;
}

/**
 * Validate a description: no HTML tags, 1–120 chars after trim.
 */
export function isValidDescription(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 120) return false;
	if (/<[^>]*>/.test(trimmed)) return false;
	return true;
}

export function rejectCrossSiteWrite(
	request: Request,
	env?: Env,
): Response | null {
	const origin = request.headers.get("origin");
	if (origin && !isTrustedWriteSource(origin, request, env)) {
		return json({ error: apiError("CROSS_SITE") }, 403);
	}
	const referer = request.headers.get("referer");
	if (!origin && !referer) {
		return json({ error: apiError("CROSS_SITE") }, 403);
	}
	if (!origin && referer && !isTrustedWriteSource(referer, request, env)) {
		return json({ error: apiError("CROSS_SITE") }, 403);
	}
	return null;
}

export function safeNormalizeMediaKey(
	value: string,
	prefix: string,
): string | null {
	const validPrefixes = new Set(["music", "avatars", "covers", "twikoo"]);
	if (!validPrefixes.has(prefix)) return null;

	let clean = safeDecodeURIComponent(value)
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.trim();
	if (clean === prefix) clean = "";
	if (clean.startsWith(`${prefix}/`)) {
		clean = clean.slice(prefix.length + 1);
	}
	if (!clean || clean.length > 1024 || clean.includes("\0")) return null;
	const parts = clean.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) return null;
	return `${prefix}/${parts.join("/")}`;
}

export function stripMediaPrefix(value: string, prefix: string): string {
	return value.replace(new RegExp(`^${prefix}/`), "");
}

export function sanitizeFileName(value: string): string {
	const clean = value.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
	return clean || "avatar";
}

export function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function embeddedCoverUrlForMusicKey(objectKey: string): string {
	const key = safeNormalizeMediaKey(objectKey, "music");
	if (!key) return "";
	if (!key.toLowerCase().endsWith(".mp3")) return "";
	return `/media/covers/from-music/${stripMediaPrefix(key, "music")}`;
}

// ================================================================
// Bot detection
// ================================================================

export function isLikelyBot(request: Request): boolean {
	const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
	return /bot|crawler|spider|slurp|curl|wget|python|go-http-client|headless|health-check|mozilla\/5\.0 \(compatible\)/.test(
		userAgent,
	);
}

// ================================================================
// Admin auth
// ================================================================

export async function requireAdmin(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const token = readAdminToken(request);
	if (!token) {
		return json({ error: apiError("MISSING_TOKEN") }, 401);
	}

	// Lightweight rate-limit gate on all token-bearing requests to
	// cap total auth attempt volume (success + failure).  This is a
	// generous ceiling for legitimate admin traffic; the tight failure
	// counter below is what actually stops brute-force.
	const rl = await enforceRateLimit(request, env, {
		scope: "admin-auth",
		limit: 30,
		windowSeconds: 5 * 60,
	});
	if (rl) return rl;

	// Verify through environment variable (timing-safe comparison).
	let verified = false;
	if (env.ADMIN_TOKEN) {
		verified = timingSafeEqual(token, env.ADMIN_TOKEN);
	} else if (env.DB) {
		verified = await verifyStoredAdminToken(env, token);
	}

	// Not yet initialized — guide the operator to set one up.
	if (!env.ADMIN_TOKEN && env.DB && !(await getStoredAdminTokenHash(env))) {
		return json(
			{
				error:
					"Admin token is not initialized. Call /api/setup/init-db with Authorization: Bearer <token> first.",
			},
			503,
		);
	}

	// On failure: increment a strict failure counter so brute-force
	// attempts are throttled aggressively without affecting legitimate
	// admin traffic that passes the generous gate above.
	if (!verified) {
		const failRl = await enforceRateLimit(request, env, {
			scope: "admin-auth-fail",
			limit: 6,
			windowSeconds: 5 * 60,
		});
		if (failRl) return failRl;
		return json({ error: apiError("INVALID_TOKEN") }, 401);
	}

	return null;
}

async function verifyStoredAdminToken(
	env: Env,
	token: string,
): Promise<boolean> {
	const storedHash = await getStoredAdminTokenHash(env);
	if (!storedHash) return false;
	return (
		(await verifyAndMaybeUpgradeTokenHash(env, token, storedHash)) !== null
	);
}

export async function getStoredAdminTokenHash(
	env: Env,
): Promise<string | null> {
	try {
		const row = await env.DB.prepare(
			"SELECT value FROM app_settings WHERE key = ?",
		)
			.bind("admin_token_sha256")
			.first<{ value: string }>();
		return row?.value ?? null;
	} catch {
		return null;
	}
}

export async function saveStoredAdminTokenHash(
	env: Env,
	token: string,
): Promise<void> {
	const pbkdf2Hash = await hashTokenWithPbkdf2(token);
	await env.DB.prepare(
		`INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
	)
		.bind("admin_token_sha256", pbkdf2Hash)
		.run();
}

// ================================================================
// DB helpers: app_settings
// ================================================================

export function isMissingD1SchemaError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	const normalized = message.toLowerCase();
	return (
		normalized.includes("no such table") ||
		normalized.includes("no such column") ||
		normalized.includes("no such index")
	);
}

export function isD1ConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	const normalized = message.toLowerCase();
	return (
		normalized.includes("constraint failed") ||
		normalized.includes("unique constraint failed") ||
		normalized.includes("sqlite_constraint")
	);
}

export function schemaNotReadyResponse(): Response {
	return json({ error: apiError("SCHEMA_NOT_READY") }, 503);
}

export async function getAppSetting(
	env: Env,
	key: string,
): Promise<string | null> {
	try {
		const row = await env.DB.prepare(
			"SELECT value FROM app_settings WHERE key = ?",
		)
			.bind(key)
			.first<{ value: string }>();
		return row?.value ?? null;
	} catch (error) {
		if (isMissingD1SchemaError(error)) return null;
		throw error;
	}
}

export async function setAppSetting(
	env: Env,
	key: string,
	value: string,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
	)
		.bind(key, value)
		.run();
}

// ================================================================
// Update helpers for PATCH endpoints
// ================================================================

export function addStringUpdate(
	fields: string[],
	values: (string | number)[],
	body: JsonRecord,
	fieldName: string,
	columnName: string,
	maxLength: number,
): void {
	if (typeof body[fieldName] !== "string") return;
	fields.push(`${columnName} = ?`);
	values.push(readString(body[fieldName], maxLength));
}

export function addBooleanUpdate(
	fields: string[],
	values: (string | number)[],
	body: JsonRecord,
	fieldName: string,
	columnName: string,
): void {
	if (typeof body[fieldName] !== "boolean") return;
	fields.push(`${columnName} = ?`);
	values.push(body[fieldName] ? 1 : 0);
}

export function addNumberUpdate(
	fields: string[],
	values: (string | number)[],
	body: JsonRecord,
	fieldName: string,
	columnName: string,
): void {
	if (
		typeof body[fieldName] !== "number" &&
		typeof body[fieldName] !== "string"
	)
		return;
	fields.push(`${columnName} = ?`);
	values.push(readInteger(body[fieldName], 0));
}

// ================================================================
// Rate limiting
// ================================================================

let statsSaltCache: string | null = null;
let rateLimitSchemaChecksSinceBootstrap = 0;
const RATE_LIMIT_SCHEMA_RECHECK_INTERVAL = 1000;

async function ensureRateLimitReady(env: Env): Promise<void> {
	rateLimitSchemaChecksSinceBootstrap += 1;
	if (
		rateLimitSchemaChecksSinceBootstrap === 1 ||
		rateLimitSchemaChecksSinceBootstrap % RATE_LIMIT_SCHEMA_RECHECK_INTERVAL ===
			0
	) {
		await env.DB.batch(
			RUNTIME_BOOTSTRAP_STATEMENTS.map((stmt) => env.DB.prepare(stmt)),
		);
	}
	await ensureStatsSalt(env);
}

async function ensureStatsSalt(env: Env): Promise<string> {
	if (statsSaltCache) return statsSaltCache;

	const existing = await env.DB.prepare(
		"SELECT value FROM app_settings WHERE key = ?",
	)
		.bind("stats_salt")
		.first<{ value: string }>();
	if (existing?.value) {
		statsSaltCache = existing.value;
		return existing.value;
	}

	const salt = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(key) DO NOTHING`,
	)
		.bind("stats_salt", salt)
		.run();

	const saved = await env.DB.prepare(
		"SELECT value FROM app_settings WHERE key = ?",
	)
		.bind("stats_salt")
		.first<{ value: string }>();
	statsSaltCache = saved?.value ?? salt;
	return statsSaltCache;
}

export async function enforceRateLimit(
	request: Request,
	env: Env,
	config: RateLimitConfig,
): Promise<Response | null> {
	await ensureRateLimitReady(env);

	const nowSeconds = Math.floor(Date.now() / 1000);
	const windowStart =
		Math.floor(nowSeconds / config.windowSeconds) * config.windowSeconds;
	const retryAfterSeconds = Math.max(
		1,
		windowStart + config.windowSeconds - nowSeconds,
	);
	const actorHash = await getRateLimitActorHash(request, env, config.scope);

	await env.DB.prepare(
		`INSERT INTO rate_limits (scope, actor_hash, window_start, count, updated_at)
     VALUES (?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(scope, actor_hash, window_start) DO UPDATE SET
       count = count + 1,
       updated_at = excluded.updated_at`,
	)
		.bind(config.scope, actorHash, windowStart)
		.run();

	const row = await env.DB.prepare(
		`SELECT count FROM rate_limits
     WHERE scope = ? AND actor_hash = ? AND window_start = ?`,
	)
		.bind(config.scope, actorHash, windowStart)
		.first<{ count: number }>();

	await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
		.bind(nowSeconds - RATE_LIMIT_MAX_AGE_SECONDS)
		.run();

	if (Number(row?.count ?? 0) <= config.limit) return null;

	const response = json({ error: apiError("RATE_LIMITED") }, 429);
	response.headers.set("retry-after", String(retryAfterSeconds));
	return response;
}

export async function getRateLimitCount(
	request: Request,
	env: Env,
	config: RateLimitConfig,
): Promise<number> {
	await ensureRateLimitReady(env);

	const nowSeconds = Math.floor(Date.now() / 1000);
	const windowStart =
		Math.floor(nowSeconds / config.windowSeconds) * config.windowSeconds;
	const actorHash = await getRateLimitActorHash(request, env, config.scope);

	const row = await env.DB.prepare(
		`SELECT count FROM rate_limits
     WHERE scope = ? AND actor_hash = ? AND window_start = ?`,
	)
		.bind(config.scope, actorHash, windowStart)
		.first<{ count: number }>();
	return Number(row?.count ?? 0);
}

export async function incrementRateLimitCounter(
	request: Request,
	env: Env,
	config: RateLimitConfig,
): Promise<number> {
	await ensureRateLimitReady(env);

	const nowSeconds = Math.floor(Date.now() / 1000);
	const windowStart =
		Math.floor(nowSeconds / config.windowSeconds) * config.windowSeconds;
	const actorHash = await getRateLimitActorHash(request, env, config.scope);

	await env.DB.prepare(
		`INSERT INTO rate_limits (scope, actor_hash, window_start, count, updated_at)
     VALUES (?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(scope, actor_hash, window_start) DO UPDATE SET
       count = count + 1,
       updated_at = excluded.updated_at`,
	)
		.bind(config.scope, actorHash, windowStart)
		.run();

	const row = await env.DB.prepare(
		`SELECT count FROM rate_limits
     WHERE scope = ? AND actor_hash = ? AND window_start = ?`,
	)
		.bind(config.scope, actorHash, windowStart)
		.first<{ count: number }>();
	return Number(row?.count ?? 0);
}

async function getRateLimitActorHash(
	request: Request,
	env: Env,
	scope: string,
): Promise<string> {
	const salt = await ensureStatsSalt(env);
	// User-Agent is NOT included because it is trivially rotated by attackers.
	const ip = getClientIp(request, env);
	return hashToken(`${salt}:rate:${scope}:${ip}`);
}

export async function ensureStatsSaltCached(env: Env): Promise<string> {
	return ensureStatsSalt(env);
}

// ================================================================
// Generic helpers used across modules
// ================================================================

export function clampInteger(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function getClientIp(request: Request, env?: Env): string {
	const proxyIp = isTrustedProxyRequest(request, env)
		? request.headers.get(TRUSTED_PROXY_CLIENT_IP_HEADER)?.split(",")[0]?.trim()
		: "";
	return (
		proxyIp ||
		(request.headers.get("cf-connecting-ip") ??
			request.headers.get("x-real-ip") ??
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			"")
	);
}

export function getRequestRegion(request: Request): string {
	const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
	return `${cf?.country || ""}|0|${cf?.region || ""}|${cf?.city || ""}|`;
}

// ================================================================
// Admin audit logging
// ================================================================

export async function auditAdminAction(
	env: Env,
	request: Request,
	action: string,
	resource: string,
	resourceId: string | number = "",
	details = "",
): Promise<void> {
	try {
		const token = readAdminToken(request);
		const salt = await ensureAdminAuditSalt(env);
		const actorHash = await hashToken(`${salt}:${token || "unknown"}`);
		const ip = getClientIp(request, env);
		await env.DB.prepare(
			`INSERT INTO admin_audit_log (actor_hash, action, resource, resource_id, details, ip)
	    	 VALUES (?, ?, ?, ?, ?, ?)`,
		)
			.bind(actorHash, action, resource, String(resourceId), details, ip)
			.run();
	} catch {
		// Audit logging failures should never affect the main request.
	}
}

async function ensureAdminAuditSalt(env: Env): Promise<string> {
	const existing = await getAppSetting(env, ADMIN_AUDIT_SALT_SETTING_KEY);
	if (existing) return existing;

	const salt = crypto.randomUUID();
	await setAppSetting(env, ADMIN_AUDIT_SALT_SETTING_KEY, salt);
	return (await getAppSetting(env, ADMIN_AUDIT_SALT_SETTING_KEY)) ?? salt;
}

// ================================================================
// Shared music metadata helpers (used by music.ts and media.ts)
// ================================================================

import { cleanMetadataText, parseId3Metadata, truncateText } from "./id3";

/**
 * Read ID3 metadata from an R2 music object.
 * Returns inferred data from the file name when ID3 parsing fails or the
 * file is not an MP3.
 */
export async function readMusicMetadataFromR2(
	env: Env,
	key: string,
): Promise<MusicMetadata & { cover?: EmbeddedCover }> {
	const fallback = inferMusicMetadataFromKey(key);
	if (!key.toLowerCase().endsWith(".mp3")) return fallback;

	try {
		const object = await env.MEDIA_BUCKET.get(key, {
			range: { offset: 0, length: MUSIC_METADATA_READ_BYTES },
		});
		if (!object) return fallback;

		const bytes = new Uint8Array(await object.arrayBuffer());
		const parsed = parseId3Metadata(bytes);
		return {
			title: truncateText(parsed.title || fallback.title, 80),
			artist: truncateText(parsed.artist || fallback.artist, 80),
			album: truncateText(parsed.album || fallback.album, 80),
			cover: parsed.cover,
		};
	} catch {
		return fallback;
	}
}

/** Derive artist / title from a music R2 object key like "Artist - Title.mp3". */
export function inferMusicMetadataFromKey(key: string): MusicMetadata {
	const fileName = getMusicFileNameFromKey(key);
	const baseName = fileName
		.replace(/\.[^.]+$/, "")
		.replace(/[_]+/g, " ")
		.trim();
	const parts = baseName
		.split(/\s+-\s+/)
		.map(cleanMetadataText)
		.filter(Boolean);
	if (parts.length >= 2) {
		return {
			title: truncateText(parts[0], 80),
			artist: truncateText(parts.slice(1).join(" - "), 80),
			album: "",
		};
	}
	return {
		title: truncateText(cleanMetadataText(baseName) || fileName, 80),
		artist: "",
		album: "",
	};
}

/** Extract the leaf file name from a music R2 object key. */
export function getMusicFileNameFromKey(key: string): string {
	const fileName = stripMediaPrefix(key, "music").split("/").pop() ?? key;
	return safeDecodeURIComponent(fileName);
}
