import { verifyHumanProof } from "./anti-abuse";
import {
	apiError,
	COMMENTS_ENABLED_SETTING_KEY,
	COMMENTS_SESSION_COOKIE,
	COMMENTS_SESSION_MAX_AGE_SECONDS,
	MAX_JSON_BODY_BYTES,
	MAX_TWIKOO_BODY_BYTES,
	RATE_LIMITS,
} from "./constants";
import { resolveTelegramCommentSettings, sendTelegramMessage } from "./friends";
import twikooWorker from "./twikoo-adapter";
import type { Env } from "./types";
import type { CommentsSessionCookie } from "./types/aliases";
import {
	base64UrlDecode,
	base64UrlEncode,
	enforceRateLimit,
	ensureStatsSaltCached,
	getAppSetting,
	getClientIp,
	hashToken,
	json,
	md5,
	readCookie,
	readHumanProof,
	readJson,
	rejectCrossSiteWrite,
	rejectOversizedBody,
	safeNormalizeMediaKey,
	signSessionValue,
	timingSafeEqual,
} from "./utils";

// ================================================================
// Comments config
// ================================================================

export async function getCommentsConfig(env: Env): Promise<Response> {
	return json({ enabled: await areCommentsEnabled(env) });
}

export async function areCommentsEnabled(env: Env): Promise<boolean> {
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
		return json({ error: apiError("COMMENTS_DISABLED") }, 403);
	}

	const bodyError = rejectOversizedBody(request, MAX_JSON_BODY_BYTES);
	if (bodyError) return bodyError;

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
	const nonce = crypto.randomUUID();
	const salt = await ensureStatsSaltCached(env);
	const signature = await signSessionValue(
		env,
		`comments:${actorHash}:${nonce}:${expiresAt}`,
		salt,
	);
	return base64UrlEncode(
		JSON.stringify({
			context: "comments",
			expiresAt,
			actorHash,
			nonce,
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
		if (!cookie.nonce) return false;

		const actorHash = await getActorHash(
			request,
			env,
			"comments-session-cookie",
		);
		if (cookie.actorHash !== actorHash) return false;

		const salt = await ensureStatsSaltCached(env);
		const expected = await signSessionValue(
			env,
			`comments:${cookie.actorHash}:${cookie.nonce}:${cookie.expiresAt}`,
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
	const salt = await ensureStatsSaltCached(env);
	const userAgent = request.headers.get("user-agent") ?? "";
	return hashToken(
		`${salt}:rate:${scope}:${getClientIp(request)}:${userAgent}`,
	);
}

// ================================================================
// Twikoo proxy
// ================================================================

/** Events that write to D1 or R2 — always require CSRF protection. */
const WRITE_EVENTS = new Set<string>([
	"COMMENT_SUBMIT",
	"UPLOAD_IMAGE",
	"COMMENT_LIKE",
	"COUNTER_GET",
	"SET_PASSWORD",
	"LOGIN",
]);

/** Subset of WRITE_EVENTS that require a validated comments session
 * (ALTCHA human proof).  COMMENT_LIKE uses the anonymous accessToken
 * and COUNTER_GET is a page-view counter — they get CSRF + rate-limit
 * but do not need a full session. */
const SESSION_REQUIRED_EVENTS = new Set<string>([
	"COMMENT_SUBMIT",
	"UPLOAD_IMAGE",
]);

const ADMIN_ONLY_EVENTS = new Set<string>([
	"GET_PASSWORD_STATUS",
	"SET_PASSWORD",
	"LOGIN",
	"GET_CONFIG_FOR_ADMIN",
	"SET_CONFIG",
	"COMMENT_GET_FOR_ADMIN",
	"COMMENT_SET_FOR_ADMIN",
	"COMMENT_DELETE_FOR_ADMIN",
	"COMMENT_EXPORT_FOR_ADMIN",
]);

type TwikooRequestOptions = {
	adminEndpoint?: boolean;
};

export async function handleTwikooRequest(
	request: Request,
	env: Env,
	requestUrl: URL,
	ctx: ExecutionContext,
	options: TwikooRequestOptions = {},
): Promise<Response> {
	// Reject oversized bodies before we clone + parse anything.
	const bodyError = rejectOversizedBody(request, MAX_TWIKOO_BODY_BYTES);
	if (bodyError) return bodyError;

	// Determine the Twikoo event type early so we can scope
	// both the disabled check and the session check to write events only.
	// Admin login, moderation, and read-only queries pass through
	// unconditionally — twikooWorker handles its own auth for those.
	// We clone once and keep the parsed body so the adapter doesn't
	// need to re-parse the same JSON.
	let event = "";
	let preParsedBody: Record<string, unknown> | undefined;
	if (request.method !== "OPTIONS") {
		try {
			const cloned = request.clone();
			preParsedBody = (await cloned.json()) as Record<string, unknown>;
			event =
				typeof preParsedBody.event === "string" ? preParsedBody.event : "";
		} catch {
			// Malformed JSON — let the adapter handle the error.
		}
	}

	const isWrite = WRITE_EVENTS.has(event);
	const needsSession = SESSION_REQUIRED_EVENTS.has(event);

	if (!options.adminEndpoint && ADMIN_ONLY_EVENTS.has(event)) {
		return json(
			{
				code: 1024,
				message: "Twikoo admin requests must use the protected admin endpoint.",
			},
			403,
		);
	}

	// All write events require CSRF protection.
	if (isWrite) {
		const csrfError = rejectCrossSiteWrite(request);
		if (csrfError) return csrfError;
	}

	// Only gate session-required events when comments are globally disabled.
	// Admin (login, moderation, get) and read-only queries still work.
	if (needsSession && !(await areCommentsEnabled(env))) {
		return json({ error: apiError("COMMENTS_DISABLED") }, 403);
	}

	if (needsSession && !(await hasValidCommentsSession(request, env))) {
		return json({ error: apiError("TWIKOO_SESSION_REQUIRED") }, 401);
	}

	// Dedicated rate limits per write event type.
	if (event === "UPLOAD_IMAGE") {
		const rl = await enforceRateLimit(request, env, {
			scope: "twikoo-upload",
			limit: 20,
			windowSeconds: 10 * 60,
		});
		if (rl) return rl;
	}
	if (event === "COMMENT_LIKE") {
		const rl = await enforceRateLimit(request, env, {
			scope: "twikoo-like",
			limit: 60,
			windowSeconds: 10 * 60,
		});
		if (rl) return rl;
	}
	if (event === "COUNTER_GET") {
		const rl = await enforceRateLimit(request, env, {
			scope: "twikoo-counter",
			limit: 200,
			windowSeconds: 10 * 60,
		});
		if (rl) return rl;
	}
	if (event === "GET_COMMENTS_COUNT") {
		const rl = await enforceRateLimit(
			request,
			env,
			RATE_LIMITS.twikooCommentsCount,
		);
		if (rl) return rl;
	}
	if (event === "GET_RECENT_COMMENTS") {
		const rl = await enforceRateLimit(
			request,
			env,
			RATE_LIMITS.twikooRecentComments,
		);
		if (rl) return rl;
	}

	// Pre-compute the MD5 hash of TWIKOO_ADMIN_PASSWORD so the
	// Twikoo adapter can verify LOGIN attempts without touching D1 config.
	// The Twikoo frontend sends md5(plaintext) as the password field,
	// so we compute md5(env_var) here and compare directly in login().
	// Trim so a trailing newline / space in the Cloudflare Dashboard
	// secret doesn't cause a permanent lockout.
	const adminPasswordHash = env.TWIKOO_ADMIN_PASSWORD
		? md5(env.TWIKOO_ADMIN_PASSWORD.trim())
		: undefined;

	return twikooWorker.fetch(request, {
		DB: env.DB,
		preParsedBody,
		adminPasswordHash,
		R2: createTwikooR2Binding(env.MEDIA_BUCKET),
		R2_PUBLIC_URL: `${requestUrl.origin}/media/twikoo`,
		onLoginAttempt: () =>
			enforceRateLimit(request, env, {
				scope: "twikoo-login",
				limit: 10,
				windowSeconds: 10 * 60,
			}),
		onCommentSubmit: (event) => {
			ctx.waitUntil(
				(async () => {
					const settings = await resolveTelegramCommentSettings(env);
					if (!settings.enabled || !settings.botToken || !settings.chatId)
						return;

					const pageUrl = event.href || `${requestUrl.origin}${event.url}`;
					const isReply = Boolean(event.pid);
					const title = isReply ? "新的评论回复" : "新的评论";

					const commentExcerpt = event.comment
						.replace(/<\/?[^>]+(>|$)/g, "")
						.replace(/\s+/g, " ")
						.trim()
						.slice(0, 300);

					const text = [
						title,
						"",
						`昵称：${event.nick}`,
						`邮箱：${event.mail}`,
						`页面：${pageUrl}`,
						isReply ? `回复：${event.pid.slice(0, 8)}` : "",
						"",
						commentExcerpt || "(无内容)",
					]
						.filter(Boolean)
						.join("\n");

					const result = await sendTelegramMessage(settings, text);
					if (!result.ok) {
						console.warn(
							"Telegram comment notification rejected",
							result.error,
						);
					}
				})(),
			);
		},
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
