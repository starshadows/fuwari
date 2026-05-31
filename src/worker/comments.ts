import { verifyHumanProof } from "./anti-abuse";
import {
	apiError,
	COMMENTS_ENABLED_SETTING_KEY,
	COMMENTS_SESSION_COOKIE,
	COMMENTS_SESSION_MAX_AGE_SECONDS,
	RATE_LIMITS,
} from "./constants";
import { readTelegramSettings, sendTelegramMessage } from "./friends";
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
	readCookie,
	readHumanProof,
	readJson,
	rejectCrossSiteWrite,
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

		const actorHash = await getActorHash(
			request,
			env,
			"comments-session-cookie",
		);
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
	const salt = await ensureStatsSaltCached(env);
	const userAgent = request.headers.get("user-agent") ?? "";
	return hashToken(
		`${salt}:rate:${scope}:${getClientIp(request)}:${userAgent}`,
	);
}

// ================================================================
// Twikoo proxy
// ================================================================

/** 需要人机验证 session 的 Twikoo 事件
 *
 * 只保护发帖操作。其他事件（登录、管理、只读查询等）
 * 由 twikooWorker 自行鉴权或无需鉴权。
 */
const SESSION_REQUIRED_EVENTS = new Set<string>(["COMMENT_SUBMIT"]);

export async function handleTwikooRequest(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	// 只对发帖等写操作要求人机验证 session
	// 登录、管理、只读查询等由 twikooWorker 自行鉴权或无需鉴权
	const needsSession = await (async (): Promise<boolean> => {
		if (request.method === "OPTIONS") return false;
		try {
			const body = (await request.clone().json()) as { event?: string };
			return SESSION_REQUIRED_EVENTS.has(body.event ?? "");
		} catch {
			return false; // 无法解析 JSON 时放行，交给 twikooWorker 处理
		}
	})();

	if (needsSession && !(await areCommentsEnabled(env))) {
		return json({ error: apiError("COMMENTS_DISABLED") }, 403);
	}

	if (needsSession && !(await hasValidCommentsSession(request, env))) {
		return json({ error: apiError("TWIKOO_SESSION_REQUIRED") }, 401);
	}

	return twikooWorker.fetch(request, {
		DB: env.DB,
		R2: createTwikooR2Binding(env.MEDIA_BUCKET),
		R2_PUBLIC_URL: `${requestUrl.origin}/media/twikoo`,
		onCommentSubmit: async (event) => {
			const settings = await readTelegramSettings(env);
			if (!settings.enabled || !settings.botToken || !settings.chatId) return;

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
				console.warn("Telegram comment notification rejected", result.error);
			}
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
