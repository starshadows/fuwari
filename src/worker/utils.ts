import {
  SECURITY_HEADERS,
  RATE_LIMIT_MAX_AGE_SECONDS,
  STATS_SALT_SETTING_KEY,
  CACHE_VERSION_DOMAINS,
  MUSIC_METADATA_READ_BYTES,
  type CacheDomain,
} from "./constants";
import type { Env } from "./types";
import type {
  JsonRecord,
  RateLimitConfig,
  HumanProof,
  HumanProofContext,
  TelegramSettings,
  MusicMetadata,
  EmbeddedCover,
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
    existing
      ? `${existing}, total;dur=${totalMs}`
      : `total;dur=${totalMs}`,
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
  const row = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = ?",
  )
    .bind(key)
    .first<{ value: string }>();
  return Number(row?.value ?? "1");
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

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function signSessionValue(
  env: Env,
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

export async function readJson(request: Request): Promise<JsonRecord> {
  try {
    const data = await request.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data as JsonRecord;
  } catch {
    return {};
  }
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

export function readBoolean(
  value: unknown,
  fallback: boolean,
): boolean {
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
  return validContexts.has(ctx)
    ? (ctx as HumanProofContext)
    : "friends";
}

// ================================================================
// URL / origin / validation
// ================================================================

export function isSameOrigin(
  value: string,
  requestUrl: string,
): boolean {
  try {
    return new URL(value).origin === new URL(requestUrl).origin;
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
      safeNormalizeMediaKey(
        value.slice("/media/covers/".length),
        "covers",
      ) !== null
    );
  }
  return false;
}

export function rejectCrossSiteWrite(
  request: Request,
): Response | null {
  const origin = request.headers.get("origin");
  if (origin && !isSameOrigin(origin, request.url)) {
    return json({ error: "跨站请求已被拒绝。" }, 403);
  }
  const referer = request.headers.get("referer");
  if (!origin && referer && !isSameOrigin(referer, request.url)) {
    return json({ error: "跨站请求已被拒绝。" }, 403);
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
  if (clean.startsWith(`${prefix}/`)) {
    clean = clean.slice(prefix.length + 1);
  }
  if (!clean || clean.length > 1024 || clean.includes("\0")) return null;
  const parts = clean.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    return null;
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
  return /bot|crawler|spider|slurp|curl|wget|python|go-http-client|headless/.test(
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
  const token = readBearerToken(request);
  if (!token) {
    return json({ error: "Missing admin token." }, 401);
  }

  // Always enforce rate limit before any auth verification.
  // Previously rate-limiting was only applied on some failure paths,
  // which leaked information about whether ADMIN_TOKEN was configured
  // and whether the submitted token was correct (timing / 429 presence).
  // Now every request with a token hits the same rate-limit check first.
  const rl = await enforceRateLimit(
    request,
    env,
    { scope: "admin-auth-fail", limit: 30, windowSeconds: 5 * 60 },
  );
  if (rl) return rl;

  // Verify through environment variable (fast path)
  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) return null;

  // Verify through database-stored hash
  if (env.DB && (await verifyStoredAdminToken(env, token))) return null;

  // Token not yet initialized — guide the operator to set one up
  if (
    !env.ADMIN_TOKEN &&
    env.DB &&
    !(await getStoredAdminTokenHash(env))
  ) {
    return json(
      {
        error:
          "Admin token is not initialized. Call /api/setup/init-db with Authorization: Bearer <token> first.",
      },
      503,
    );
  }

  return json({ error: "Invalid admin token." }, 401);
}

async function verifyStoredAdminToken(
  env: Env,
  token: string,
): Promise<boolean> {
  const storedHash = await getStoredAdminTokenHash(env);
  if (!storedHash) return false;
  return storedHash === (await hashToken(token));
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
  tokenHash: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  )
    .bind("admin_token_sha256", tokenHash)
    .run();
}

// ================================================================
// DB helpers: app_settings
// ================================================================

export async function getAppSetting(
  env: Env,
  key: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = ?",
  )
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
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
) {
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
) {
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
) {
  if (typeof body[fieldName] !== "number" && typeof body[fieldName] !== "string")
    return;
  fields.push(`${columnName} = ?`);
  values.push(readInteger(body[fieldName], 0));
}

// ================================================================
// Rate limiting
// ================================================================

let rateLimitSchemaReady = false;
let statsSaltCache: string | null = null;

const RATE_LIMIT_INIT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    scope TEXT NOT NULL,
    actor_hash TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (scope, actor_hash, window_start)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_updated_at
   ON rate_limits (updated_at)`,
];

async function ensureRateLimitReady(env: Env): Promise<void> {
  if (!rateLimitSchemaReady) {
    await env.DB.batch(
      RATE_LIMIT_INIT_STATEMENTS.map((stmt) => env.DB.prepare(stmt)),
    );
    rateLimitSchemaReady = true;
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

  const response = json({ error: "请求过于频繁，请稍后再试。" }, 429);
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
  const userAgent = request.headers.get("user-agent") ?? "";
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "";
  return hashToken(`${salt}:rate:${scope}:${ip}:${userAgent}`);
}

export async function ensureStatsSaltCached(env: Env): Promise<string> {
  return ensureStatsSalt(env);
}

// ================================================================
// Generic helpers used across modules
// ================================================================

export function clampInteger(
  value: number,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, value));
}

export function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ""
  );
}

export function getRequestRegion(request: Request): string {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
  return `${cf?.country || ""}|0|${cf?.region || ""}|${cf?.city || ""}|`;
}

// ================================================================
// Shared music metadata helpers (used by music.ts and media.ts)
// ================================================================

import {
  parseId3Metadata,
  cleanMetadataText,
  truncateText,
} from "./id3";

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
  const parts = baseName.split(/\s+-\s+/).map(cleanMetadataText).filter(Boolean);
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
