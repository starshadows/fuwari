import { areCommentsEnabled } from "./comments";
import {
	apiError,
	COMMENTS_ENABLED_SETTING_KEY,
	FRIEND_STATUSES,
	MAX_JSON_BODY_BYTES,
	TELEGRAM_SETTINGS_KEY,
} from "./constants";
import { sendTelegramMessage, writeTelegramSettings } from "./friends";
import {
	createMusicTrack,
	deleteMusicTrack,
	importR2MusicObjects,
	listAdminMusic,
	listR2MusicObjects,
	updateMusicTrack,
} from "./music";
import type { Env } from "./types";
import type { FriendDto, TelegramSettings } from "./types/aliases";
import {
	auditAdminAction,
	getAppSetting,
	incrementCacheVersion,
	isValidAvatarUrl,
	isValidFriendUrl,
	json,
	normalizeFriendHostname,
	readBoolean,
	readInteger,
	readJson,
	readString,
	rejectOversizedBody,
	requireAdmin,
	setAppSetting,
} from "./utils";

// ================================================================
// Admin API dispatcher
// ================================================================

export async function handleAdminApi(
	request: Request,
	env: Env,
	requestUrl: URL,
	ctx: ExecutionContext,
): Promise<Response> {
	const auth = await requireAdmin(request, env);
	if (auth) return auth;

	const segments = requestUrl.pathname.split("/").filter(Boolean);

	// Settings
	if (segments[2] === "settings") {
		if (segments[3] === "comments") {
			if (request.method === "GET") return getAdminCommentsSettings(env);
			if (request.method === "POST")
				return updateAdminCommentsSettings(request, env, ctx);
		}
		if (segments[3] === "telegram") {
			if (!segments[4] && request.method === "GET")
				return getAdminTelegramSettings(env);
			if (!segments[4] && request.method === "POST")
				return updateAdminTelegramSettings(request, env, ctx);
			if (segments[4] === "test" && request.method === "POST")
				return sendAdminTelegramTest(env);
		}
	}

	// Friends
	if (segments[2] === "friends") {
		const id = segments[3] ? Number.parseInt(segments[3], 10) : null;
		if (request.method === "GET" && !id)
			return listAdminFriends(env, requestUrl);
		if (request.method === "PATCH" && id)
			return updateFriend(request, env, id, ctx);
		if (request.method === "DELETE" && id)
			return deleteFriend(request, env, id, ctx);
	}

	// Music
	if (segments[2] === "music") {
		if (segments[3] === "objects" && request.method === "GET")
			return listR2MusicObjects(env);
		if (segments[3] === "import" && request.method === "POST")
			return importR2MusicObjects(request, env, ctx);

		const id = segments[3] ? Number.parseInt(segments[3], 10) : null;
		if (request.method === "GET" && !id) return listAdminMusic(env);
		if (request.method === "POST" && !id)
			return createMusicTrack(request, env, ctx);
		if (request.method === "PATCH" && id)
			return updateMusicTrack(request, env, id, ctx);
		if (request.method === "DELETE" && id)
			return deleteMusicTrack(request, env, id, ctx);
	}

	return json({ error: apiError("NOT_FOUND") }, 404);
}

// ================================================================
// Comments settings
// ================================================================

async function getAdminCommentsSettings(env: Env): Promise<Response> {
	return json({ enabled: await areCommentsEnabled(env) });
}

async function updateAdminCommentsSettings(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const bodyError = rejectOversizedBody(request, MAX_JSON_BODY_BYTES);
	if (bodyError) return bodyError;

	const body = await readJson(request);
	const enabled = readBoolean(body.enabled, true);
	await setAppSetting(
		env,
		COMMENTS_ENABLED_SETTING_KEY,
		enabled ? "true" : "false",
	);
	await incrementCacheVersion(env, "commentsConfig");
	ctx.waitUntil(
		auditAdminAction(
			env,
			request,
			"toggle",
			"comment",
			"",
			JSON.stringify({ enabled }),
		),
	);
	return json({ ok: true, enabled });
}

// ================================================================
// Telegram settings
// ================================================================

async function getAdminTelegramSettings(env: Env): Promise<Response> {
	const settings = await readAdminTelegramSettings(env);
	return json({
		enabled: settings.enabled,
		botTokenConfigured: Boolean(settings.botToken),
		chatId: settings.chatId,
		threadId: settings.threadId,
	});
}

async function updateAdminTelegramSettings(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const current = await readAdminTelegramSettings(env);
	const bodyError = rejectOversizedBody(request, MAX_JSON_BODY_BYTES);
	if (bodyError) return bodyError;

	const body = await readJson(request);
	const botToken = readString(body.botToken, 256);
	const settings: TelegramSettings = {
		enabled: readBoolean(body.enabled, current.enabled),
		botToken:
			botToken ||
			(readBoolean(body.clearBotToken, false) ? "" : current.botToken),
		chatId: readString(body.chatId, 120),
		threadId: readString(body.threadId, 40),
	};

	await writeTelegramSettings(env, settings);
	ctx.waitUntil(
		auditAdminAction(
			env,
			request,
			"update",
			"telegram",
			"",
			JSON.stringify({ enabled: settings.enabled }),
		),
	);
	return json({
		ok: true,
		enabled: settings.enabled,
		botTokenConfigured: Boolean(settings.botToken),
		chatId: settings.chatId,
		threadId: settings.threadId,
	});
}

async function sendAdminTelegramTest(env: Env): Promise<Response> {
	const settings = await readAdminTelegramSettings(env);
	if (!settings.enabled || !settings.botToken || !settings.chatId) {
		return json({ error: apiError("TELEGRAM_INCOMPLETE") }, 400);
	}

	const result = await sendTelegramMessage(
		settings,
		"这是一条来自星影博客后台的 Telegram 测试通知。",
	);
	if (!result.ok) return json({ error: result.error }, 502);
	return json({ ok: true });
}

async function readAdminTelegramSettings(env: Env): Promise<TelegramSettings> {
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

// ================================================================
// Friend management (admin)
// ================================================================

async function listAdminFriends(env: Env, requestUrl: URL): Promise<Response> {
	const status = requestUrl.searchParams.get("status") ?? "pending";
	const includeAll = status === "all";

	if (!includeAll && !FRIEND_STATUSES.has(status)) {
		return json({ error: apiError("FRIEND_STATUS_INVALID") }, 400);
	}

	const result = includeAll
		? await env.DB.prepare(
				`SELECT id, name, description, url, avatar_url AS avatarUrl, status,
                is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
                updated_at AS updatedAt
         FROM friend_links
         ORDER BY created_at DESC`,
			).all()
		: await env.DB.prepare(
				`SELECT id, name, description, url, avatar_url AS avatarUrl, status,
                is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
                updated_at AS updatedAt
         FROM friend_links
         WHERE status = ?
         ORDER BY created_at DESC`,
			)
				.bind(status)
				.all();

	return json({ friends: result.results ?? [] });
}

async function updateFriend(
	request: Request,
	env: Env,
	id: number,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!Number.isInteger(id))
		return json({ error: apiError("FRIEND_ID_INVALID") }, 400);

	const bodyError = rejectOversizedBody(request, MAX_JSON_BODY_BYTES);
	if (bodyError) return bodyError;

	const body = await readJson(request);
	const fields: string[] = [];
	const values: (string | number)[] = [];

	if (typeof body.name === "string") {
		fields.push("name = ?");
		values.push(readString(body.name, 40));
	}
	if (typeof body.description === "string") {
		fields.push("description = ?");
		values.push(readString(body.description, 120));
	}
	let nextNormalizedHost = "";
	if (typeof body.url === "string") {
		const v = readString(body.url, 400);
		if (!isValidFriendUrl(v))
			return json({ error: apiError("FRIEND_URL_INVALID") }, 400);

		nextNormalizedHost = normalizeFriendHostname(v);
		if (!nextNormalizedHost) {
			return json({ error: apiError("FRIEND_URL_INVALID") }, 400);
		}

		const duplicate = await findFriendHostDuplicate(
			env,
			nextNormalizedHost,
			id,
		);
		if (duplicate) {
			return json({ error: apiError("FRIEND_DOMAIN_DUPLICATE") }, 409);
		}

		fields.push("url = ?");
		values.push(v);
		fields.push("normalized_host = ?");
		values.push(nextNormalizedHost);
	}
	if (typeof body.avatarUrl === "string") {
		const v = readString(body.avatarUrl, 600);
		if (!isValidAvatarUrl(v))
			return json({ error: apiError("FRIEND_AVATAR_INVALID") }, 400);
		fields.push("avatar_url = ?");
		values.push(v);
	}
	if (typeof body.status === "string") {
		const status = body.status.trim();
		if (!FRIEND_STATUSES.has(status))
			return json({ error: apiError("FRIEND_STATUS_INVALID") }, 400);

		if (!nextNormalizedHost && status === "approved") {
			const current = await getFriendHost(env, id);
			if (!current) return json({ error: apiError("FRIEND_NOT_FOUND") }, 404);
			nextNormalizedHost =
				current.normalizedHost || normalizeFriendHostname(current.url);
			if (nextNormalizedHost) {
				const duplicate = await findFriendHostDuplicate(
					env,
					nextNormalizedHost,
					id,
				);
				if (duplicate) {
					return json({ error: apiError("FRIEND_DOMAIN_DUPLICATE") }, 409);
				}
				if (!current.normalizedHost) {
					fields.push("normalized_host = ?");
					values.push(nextNormalizedHost);
				}
			}
		}

		fields.push("status = ?");
		values.push(status);
	}
	if (typeof body.isActive === "boolean") {
		fields.push("is_active = ?");
		values.push(body.isActive ? 1 : 0);
	}
	if (
		typeof body.sortOrder === "number" ||
		typeof body.sortOrder === "string"
	) {
		fields.push("sort_order = ?");
		values.push(readInteger(body.sortOrder, 0));
	}

	if (fields.length > 0) {
		await env.DB.prepare(
			`UPDATE friend_links SET ${fields.join(", ")} WHERE id = ?`,
		)
			.bind(...values, id)
			.run();
		ctx.waitUntil(
			auditAdminAction(
				env,
				request,
				"update",
				"friend",
				id,
				JSON.stringify(body),
			),
		);
	}

	const friend = await getFriend(env, id);
	if (!friend) return json({ error: apiError("FRIEND_NOT_FOUND") }, 404);
	return json({ friend });
}

type FriendHostRow = {
	url: string;
	normalizedHost: string;
};

async function getFriendHost(
	env: Env,
	id: number,
): Promise<FriendHostRow | null> {
	const friend = await env.DB.prepare(
		`SELECT url, normalized_host AS normalizedHost
	     FROM friend_links WHERE id = ?`,
	)
		.bind(id)
		.first<FriendHostRow>();
	return friend ?? null;
}

async function findFriendHostDuplicate(
	env: Env,
	normalizedHost: string,
	id: number,
): Promise<{ id: number } | null> {
	const duplicate = await env.DB.prepare(
		`SELECT id FROM friend_links
	     WHERE normalized_host = ?
	       AND id <> ?
	       AND status IN ('pending', 'approved')
	     LIMIT 1`,
	)
		.bind(normalizedHost, id)
		.first<{ id: number }>();
	return duplicate ?? null;
}

async function deleteFriend(
	request: Request,
	env: Env,
	id: number,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!Number.isInteger(id))
		return json({ error: apiError("FRIEND_ID_INVALID") }, 400);
	await env.DB.prepare("DELETE FROM friend_links WHERE id = ?").bind(id).run();
	ctx.waitUntil(auditAdminAction(env, request, "delete", "friend", id));
	return json({ ok: true });
}

async function getFriend(env: Env, id: number): Promise<FriendDto | null> {
	const friend = await env.DB.prepare(
		`SELECT id, name, description, url, avatar_url AS avatarUrl, status,
            is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
            updated_at AS updatedAt
     FROM friend_links WHERE id = ?`,
	)
		.bind(id)
		.first<FriendDto>();
	return friend ?? null;
}
