import { verifyHumanProof } from "./anti-abuse";
import {
	apiError,
	MAX_JSON_BODY_BYTES,
	RATE_LIMITS,
	TELEGRAM_COMMENT_SETTINGS_KEY,
	TELEGRAM_SETTINGS_KEY,
} from "./constants";
import type { Env } from "./types";
import type {
	TelegramCommentSettings,
	TelegramSettings,
} from "./types/aliases";
import {
	enforceRateLimit,
	ensureStatsSaltCached,
	getAppSetting,
	getClientIp,
	hashToken,
	isD1ConstraintError,
	isMissingD1SchemaError,
	isValidAvatarUrl,
	isValidDescription,
	isValidDisplayName,
	isValidFriendUrl,
	json,
	normalizeFriendHostname,
	readBoolean,
	readHumanProof,
	readJsonBody,
	readString,
	rejectCrossSiteWrite,
	rejectOversizedBody,
	schemaNotReadyResponse,
	setAppSetting,
} from "./utils";

// ================================================================
// Public: GET /api/friends
// ================================================================

export async function getApprovedFriends(env: Env): Promise<Response> {
	try {
		const result = await env.DB.prepare(
			`SELECT id, name, description, url, avatar_url AS avatarUrl
     FROM friend_links
     WHERE status = 'approved' AND is_active = 1
     ORDER BY sort_order ASC, created_at DESC`,
		).all();

		return json({ friends: result.results ?? [] });
	} catch (error) {
		if (isMissingD1SchemaError(error)) return json({ friends: [] });
		throw error;
	}
}

// ================================================================
// Public: POST /api/friends
// ================================================================

export async function submitFriendLink(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const originError = rejectCrossSiteWrite(request);
	if (originError) return originError;

	const rateLimit = await enforceRateLimit(
		request,
		env,
		RATE_LIMITS.friendSubmit,
	);
	if (rateLimit) return rateLimit;

	const bodyError = rejectOversizedBody(request, MAX_JSON_BODY_BYTES);
	if (bodyError) return bodyError;

	const body = await readJsonBody(request, MAX_JSON_BODY_BYTES);
	if (body instanceof Response) return body;
	const name = readString(body.name, 40);
	const description = readString(body.description, 120);
	const linkUrl = readString(body.url, 400);
	const avatarUrl = readString(body.avatarUrl, 600);
	const humanProof = readHumanProof(body.humanProof);

	if (!name || !description || !linkUrl || !avatarUrl) {
		return json({ error: apiError("FRIEND_FIELDS_MISSING") }, 400);
	}

	if (!isValidDisplayName(name)) {
		return json({ error: apiError("FRIEND_NAME_INVALID") }, 400);
	}

	if (!isValidDescription(description)) {
		return json({ error: apiError("FRIEND_DESC_INVALID") }, 400);
	}

	if (!isValidFriendUrl(linkUrl)) {
		return json({ error: apiError("FRIEND_URL_INVALID") }, 400);
	}

	if (!isValidAvatarUrl(avatarUrl)) {
		return json({ error: apiError("FRIEND_AVATAR_INVALID") }, 400);
	}

	// Domain-level dedup: prevent the same site from submitting again.
	const normalizedHost = normalizeFriendHostname(linkUrl);
	if (!normalizedHost) {
		return json({ error: apiError("FRIEND_URL_INVALID") }, 400);
	}
	const proofError = await verifyHumanProof(
		request,
		env,
		"friends",
		humanProof,
	);
	if (proofError) return proofError;

	try {
		const submitterHash = await getFriendSubmitterHash(request, env);
		const domainDup = await env.DB.prepare(
			`SELECT id FROM friend_links
	     WHERE normalized_host = ? AND status IN ('pending', 'approved')
	     LIMIT 1`,
		)
			.bind(normalizedHost)
			.first<{ id: number }>();
		if (domainDup) {
			return json({ error: apiError("FRIEND_DOMAIN_DUPLICATE") }, 409);
		}

		// Pending flood protection: limit pending submissions per actor.
		const pendingCount = await env.DB.prepare(
			`SELECT COUNT(*) AS count FROM friend_links
	     WHERE status = 'pending'
	     AND submitter_hash = ?
	     AND created_at > datetime('now', '-1 hour')`,
		)
			.bind(submitterHash)
			.first<{ count: number }>();
		if ((pendingCount?.count ?? 0) >= 10) {
			return json({ error: apiError("FRIEND_PENDING_LIMIT") }, 429);
		}

		const duplicate = await env.DB.prepare(
			`SELECT id, status FROM friend_links
     WHERE url = ? AND status IN ('pending', 'approved')
     LIMIT 1`,
		)
			.bind(linkUrl)
			.first<{ id: number; status: string }>();
		if (duplicate) {
			return json({ error: apiError("FRIEND_DUPLICATE") }, 409);
		}

		const insert = await env.DB.prepare(
			`INSERT INTO friend_links (name, description, url, normalized_host, avatar_url, submitter_hash, status)
	     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
		)
			.bind(
				name,
				description,
				linkUrl,
				normalizedHost,
				avatarUrl,
				submitterHash,
			)
			.run();

		ctx.waitUntil(
			sendTelegramFriendNotification(env, {
				id: Number(insert.meta.last_row_id ?? 0),
				name,
				description,
				url: linkUrl,
				avatarUrl,
			}).catch((error) => {
				console.warn("Telegram friend notification failed", error);
			}),
		);

		return json(
			{ ok: true, message: "申请已提交，审核通过后会自动展示。" },
			201,
		);
	} catch (error) {
		if (isMissingD1SchemaError(error)) return schemaNotReadyResponse();
		if (isD1ConstraintError(error)) {
			return json({ error: apiError("FRIEND_DOMAIN_DUPLICATE") }, 409);
		}
		throw error;
	}
}

async function getFriendSubmitterHash(
	request: Request,
	env: Env,
): Promise<string> {
	const salt = await ensureStatsSaltCached(env);
	const userAgent = request.headers.get("user-agent") ?? "";
	return hashToken(
		`${salt}:friend-submit:${getClientIp(request)}:${userAgent}`,
	);
}

// ================================================================
// Telegram notification helpers
// ================================================================

export async function readTelegramSettings(
	env: Env,
): Promise<TelegramSettings> {
	const stored = await getAppSetting(env, TELEGRAM_SETTINGS_KEY);
	if (!stored) {
		return { enabled: false, botToken: "", chatId: "", threadId: "" };
	}
	try {
		const parsed = JSON.parse(stored) as Partial<TelegramSettings>;
		return {
			enabled: Boolean(parsed.enabled),
			botToken: readString(parsed.botToken, 256),
			chatId: readString(parsed.chatId, 120),
			threadId: readString(parsed.threadId, 40),
		};
	} catch {
		return { enabled: false, botToken: "", chatId: "", threadId: "" };
	}
}

export async function writeTelegramSettings(
	env: Env,
	settings: TelegramSettings,
): Promise<void> {
	await setAppSetting(env, TELEGRAM_SETTINGS_KEY, JSON.stringify(settings));
}

export async function readTelegramCommentSettings(
	env: Env,
): Promise<TelegramCommentSettings> {
	const stored = await getAppSetting(env, TELEGRAM_COMMENT_SETTINGS_KEY);
	if (!stored) {
		const friendSettings = await readTelegramSettings(env);
		return {
			enabled: friendSettings.enabled,
			useFriendSettings: true,
			botToken: "",
			chatId: "",
			threadId: "",
		};
	}
	try {
		const parsed = JSON.parse(stored) as Partial<TelegramCommentSettings>;
		return {
			enabled: Boolean(parsed.enabled),
			useFriendSettings: readBoolean(parsed.useFriendSettings, true),
			botToken: readString(parsed.botToken, 256),
			chatId: readString(parsed.chatId, 120),
			threadId: readString(parsed.threadId, 40),
		};
	} catch {
		return {
			enabled: false,
			useFriendSettings: true,
			botToken: "",
			chatId: "",
			threadId: "",
		};
	}
}

export async function writeTelegramCommentSettings(
	env: Env,
	settings: TelegramCommentSettings,
): Promise<void> {
	await setAppSetting(
		env,
		TELEGRAM_COMMENT_SETTINGS_KEY,
		JSON.stringify(settings),
	);
}

export async function resolveTelegramCommentSettings(
	env: Env,
): Promise<TelegramSettings> {
	const commentSettings = await readTelegramCommentSettings(env);
	if (!commentSettings.enabled) {
		return { enabled: false, botToken: "", chatId: "", threadId: "" };
	}
	if (!commentSettings.useFriendSettings) {
		return {
			enabled: true,
			botToken: commentSettings.botToken,
			chatId: commentSettings.chatId,
			threadId: commentSettings.threadId,
		};
	}

	const friendSettings = await readTelegramSettings(env);
	return {
		enabled: true,
		botToken: friendSettings.botToken,
		chatId: friendSettings.chatId,
		threadId: friendSettings.threadId,
	};
}

export async function readTelegramSettingsPublic(
	env: Env,
): Promise<TelegramSettings> {
	return readTelegramSettings(env);
}

async function sendTelegramFriendNotification(
	env: Env,
	friend: {
		id: number;
		name: string;
		description: string;
		url: string;
		avatarUrl: string;
	},
): Promise<void> {
	const settings = await readTelegramSettings(env);
	if (!settings.enabled || !settings.botToken || !settings.chatId) return;

	const text = [
		"新的友链申请",
		"",
		`ID：${friend.id || "-"}`,
		`名称：${friend.name}`,
		`链接：${friend.url}`,
		`头像：${friend.avatarUrl}`,
		`简介：${friend.description}`,
	].join("\n");

	const result = await sendTelegramMessage(settings, text);
	if (!result.ok) {
		console.warn("Telegram notification rejected", result.error);
	}
}

export async function sendTelegramMessage(
	settings: TelegramSettings,
	text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const payload: Record<string, string | number | boolean> = {
		chat_id: settings.chatId,
		text,
		disable_web_page_preview: true,
	};
	const threadId = Number.parseInt(settings.threadId, 10);
	if (Number.isInteger(threadId) && threadId > 0) {
		payload.message_thread_id = threadId;
	}

	try {
		const response = await fetch(
			`https://api.telegram.org/bot${settings.botToken}/sendMessage`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			},
		);
		const data = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			description?: string;
		};
		if (!response.ok || data.ok === false) {
			return {
				ok: false,
				error: data.description ?? `Telegram API returned ${response.status}.`,
			};
		}
		return { ok: true };
	} catch (error) {
		// Strip bot token from error messages so the token never
		// appears in logs or API responses.
		const message = error instanceof Error ? error.message : "";
		const sanitized = settings.botToken
			? message.replaceAll(settings.botToken, "***")
			: message;
		return {
			ok: false,
			error: sanitized || "Telegram request failed.",
		};
	}
}
