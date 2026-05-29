import type { Env } from "./types";
import type { CommentsSessionCookie } from "./types/aliases";
import {
  json,
  readString,
  readJson,
  readHumanProof,
  readCookie,
  cachedResponse,
  rejectCrossSiteWrite,
  enforceRateLimit,
  getAppSetting,
  setAppSetting,
  signSessionValue,
  timingSafeEqual,
  base64UrlEncode,
  base64UrlDecode,
  ensureStatsSaltCached,
} from "./utils";
import { verifyHumanProof } from "./anti-abuse";
import {
  RATE_LIMITS,
  COMMENTS_ENABLED_SETTING_KEY,
  COMMENTS_SESSION_COOKIE,
  COMMENTS_SESSION_MAX_AGE_SECONDS,
} from "./constants";
import { safeNormalizeMediaKey } from "./utils";
import twikooWorker from "./twikoo-adapter.ts";

// ================================================================
// Comments config
// ================================================================

export async function getCommentsConfig(env: Env): Promise<Response> {
  return json({ enabled: await areCommentsEnabled(env) });
}

async function areCommentsEnabled(env: Env): Promise<boolean> {
  const value = await getAppSetting(env, COMMENTS_ENABLED_SETTING_KEY);
  return value !== "false";
}

// ================================================================
// Comments session
// ================================================================

export async function createCommentsSession(
  request: Request,
  env: Env,
): Promise<Response> {
  const originError = rejectCrossSiteWrite(request);
  if (originError) return originError;

  const rateLimit = await enforceRateLimit(
    request,
    env,
    RATE_LIMITS.commentsSession,
  );
  if (rateLimit) return rateLimit;

  if (!(await areCommentsEnabled(env))) {
    return json({ error: "评论区已关闭。" }, 403);
  }

  const body = await readJson(request);
  const proofError = await verifyHumanProof(
    request,
    env,
    "comments",
    readHumanProof(body.humanProof),
  );
  if (proofError) return proofError;

  const requestUrl = new URL(request.url);
  const cookieValue = await createCommentsSessionCookie(request, env);
  const response = json({
    ok: true,
    expiresIn: COMMENTS_SESSION_MAX_AGE_SECONDS,
  });
  response.headers.set(
    "set-cookie",
    `${COMMENTS_SESSION_COOKIE}=${cookieValue}; Path=/api/twikoo; Max-Age=${COMMENTS_SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${requestUrl.protocol === "https:" ? "; Secure" : ""}`,
  );
  return response;
}

async function createCommentsSessionCookie(
  request: Request,
  env: Env,
): Promise<string> {
  const actorHash = await getActorHash(request, env, "comments-session-cookie");
  const expiresAt =
    Math.floor(Date.now() / 1000) + COMMENTS_SESSION_MAX_AGE_SECONDS;
  const salt = await ensureStatsSaltCached(env);
  const signature = await signSessionValue(
    env,
    `comments:${actorHash}:${expiresAt}`,
    salt,
  );
  return base64UrlEncode(
    JSON.stringify({
      context: "comments",
      expiresAt,
      actorHash,
      signature,
    } satisfies CommentsSessionCookie),
  );
}

async function hasValidCommentsSession(
  request: Request,
  env: Env,
): Promise<boolean> {
  const rawCookie = readCookie(request, COMMENTS_SESSION_COOKIE);
  if (!rawCookie) return false;

  try {
    const cookie = JSON.parse(
      base64UrlDecode(rawCookie),
    ) as CommentsSessionCookie;
    if (cookie.context !== "comments") return false;
    if (
      !Number.isFinite(cookie.expiresAt) ||
      cookie.expiresAt < Math.floor(Date.now() / 1000)
    ) {
      return false;
    }

    const actorHash = await getActorHash(request, env, "comments-session-cookie");
    if (cookie.actorHash !== actorHash) return false;

    const salt = await ensureStatsSaltCached(env);
    const expected = await signSessionValue(
      env,
      `comments:${cookie.actorHash}:${cookie.expiresAt}`,
      salt,
    );
    return timingSafeEqual(cookie.signature, expected);
  } catch {
    return false;
  }
}

async function getActorHash(
  request: Request,
  env: Env,
  scope: string,
): Promise<string> {
  const { hashToken } = await import("./utils");
  const salt = await ensureStatsSaltCached(env);
  const userAgent = request.headers.get("user-agent") ?? "";
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return hashToken(`${salt}:rate:${scope}:${ip}:${userAgent}`);
}

// ================================================================
// Twikoo proxy
// ================================================================

export async function handleTwikooRequest(
  request: Request,
  env: Env,
  requestUrl: URL,
): Promise<Response> {
  if (!(await areCommentsEnabled(env))) {
    return json({ error: "评论区已关闭。" }, 403);
  }

  if (
    request.method !== "OPTIONS" &&
    !(await hasValidCommentsSession(request, env))
  ) {
    return json({ error: "请先完成评论区人机验证。" }, 401);
  }

  return twikooWorker.fetch(request, {
    DB: env.DB,
    R2: createTwikooR2Binding(env.MEDIA_BUCKET),
    R2_PUBLIC_URL: `${requestUrl.origin}/media/twikoo`,
  });
}

function createTwikooR2Binding(
  bucket: R2Bucket,
): Pick<R2Bucket, "put" | "delete"> {
  return {
    put: (key, value, options) =>
      bucket.put(normalizeTwikooObjectKey(key), value, options),
    delete: (keys) => {
      if (Array.isArray(keys)) {
        return bucket.delete(keys.map(normalizeTwikooObjectKey));
      }
      return bucket.delete(normalizeTwikooObjectKey(keys));
    },
  };
}

function normalizeTwikooObjectKey(key: string): string {
  const normalized = safeNormalizeMediaKey(key, "twikoo");
  if (!normalized) throw new Error("Invalid Twikoo media key.");
  return normalized;
}
