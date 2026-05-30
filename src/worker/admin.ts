import type { Env } from "./types";
import type { TelegramSettings } from "./types/aliases";
import {
	json,
	readString,
	readJson,
	readInteger,
	readBoolean,
	rejectCrossSiteWrite,
	requireAdmin,
	getAppSetting,
	setAppSetting,
	incrementCacheVersion,
	isHttpsUrl,
	isAvatarUrl,
	sanitizeFileName,
	stripMediaPrefix,
	maskSecret,
} from "./utils";
import {
	FRIEND_STATUSES,
	ALLOWED_AVATAR_MIME_TYPES,
	MAX_AVATAR_SIZE,
	TELEGRAM_SETTINGS_KEY,
} from "./constants";
import { apiError } from "./constants";
import { getCommentsConfig } from "./comments";
import { writeTelegramSettings, sendTelegramMessage } from "./friends";
import {
	listAdminMusic,
	listR2MusicObjects,
	importR2MusicObjects,
	createMusicTrack,
	updateMusicTrack,
	deleteMusicTrack,
} from "./music";
import type { HumanProofContext } from "./types/aliases";

// ================================================================
// Admin API dispatcher
// ================================================================

export async function handleAdminApi(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	const auth = await requireAdmin(request, env);
	if (auth) return auth;

	const segments = requestUrl.pathname.split("/").filter(Boolean);

	// Avatar upload
	if (
		requestUrl.pathname === "/api/admin/avatar" &&
		request.method === "POST"
	) {
		return uploadAvatar(request, env);
	}

	// Settings
	if (segments[2] === "settings") {
		if (segments[3] === "comments") {
			if (request.method === "GET") return getAdminCommentsSettings(env);
			if (request.method === "POST")
				return updateAdminCommentsSettings(request, env);
		}
		if (segments[3] === "telegram") {
			if (!segments[4] && request.method === "GET")
				return getAdminTelegramSettings(env);
			if (!segments[4] && request.method === "POST")
				return updateAdminTelegramSettings(request, env);
			if (segments[4] === "test" && request.method === "POST")
				return sendAdminTelegramTest(env);
		}
	}

	// Friends
	if (segments[2] === "friends") {
		const id = segments[3] ? Number.parseInt(segments[3], 10) : null;
		if (request.method === "GET" && !id)
			return listAdminFriends(env, requestUrl);
		if (request.method === "PATCH" && id) return updateFriend(request, env, id);
		if (request.method === "DELETE" && id) return deleteFriend(env, id);
	}

	// Music
	if (segments[2] === "music") {
		if (segments[3] === "objects" && request.method === "GET")
			return listR2MusicObjects(env);
		if (segments[3] === "import" && request.method === "POST")
			return importR2MusicObjects(request, env);

		const id = segments[3] ? Number.parseInt(segments[3], 10) : null;
		if (request.method === "GET" && !id) return listAdminMusic(env);
		if (request.method === "POST" && !id) return createMusicTrack(request, env);
		if (request.method === "PATCH" && id)
			return updateMusicTrack(request, env, id);
		if (request.method === "DELETE" && id) return deleteMusicTrack(env, id);
	}

	return json({ error: apiError("NOT_FOUND") }, 404);
}

// ================================================================
// Comments settings
// ================================================================

async function getAdminCommentsSettings(env: Env): Promise<Response> {
	return json({ enabled: await getCommentsConfig(env) });
}

async function updateAdminCommentsSettings(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJson(request);
	const enabled = readBoolean(body.enabled, true);
	await setAppSetting(env, "comments_enabled", enabled ? "true" : "false");
	await incrementCacheVersion(env, "commentsConfig");
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
		botTokenHint: maskSecret(settings.botToken),
		chatId: settings.chatId,
		threadId: settings.threadId,
	});
}

async function updateAdminTelegramSettings(
	request: Request,
	env: Env,
): Promise<Response> {
	const current = await readAdminTelegramSettings(env);
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
	return json({
		ok: true,
		enabled: settings.enabled,
		botTokenConfigured: Boolean(settings.botToken),
		botTokenHint: maskSecret(settings.botToken),
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
): Promise<Response> {
	if (!Number.isInteger(id))
		return json({ error: apiError("FRIEND_ID_INVALID") }, 400);

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
	if (typeof body.url === "string") {
		const v = readString(body.url, 400);
		if (!isHttpsUrl(v))
			return json({ error: apiError("FRIEND_URL_NOT_HTTPS") }, 400);
		fields.push("url = ?");
		values.push(v);
	}
	if (typeof body.avatarUrl === "string") {
		const v = readString(body.avatarUrl, 600);
		if (!isAvatarUrl(v))
			return json({ error: apiError("FRIEND_AVATAR_INVALID") }, 400);
		fields.push("avatar_url = ?");
		values.push(v);
	}
	if (typeof body.status === "string") {
		const status = body.status.trim();
		if (!FRIEND_STATUSES.has(status))
			return json({ error: apiError("FRIEND_STATUS_INVALID") }, 400);
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
	}

	const friend = await getFriend(env, id);
	if (!friend) return json({ error: apiError("FRIEND_NOT_FOUND") }, 404);
	return json({ friend });
}

async function deleteFriend(env: Env, id: number): Promise<Response> {
	if (!Number.isInteger(id))
		return json({ error: apiError("FRIEND_ID_INVALID") }, 400);
	await env.DB.prepare("DELETE FROM friend_links WHERE id = ?").bind(id).run();
	return json({ ok: true });
}

async function getFriend(
	env: Env,
	id: number,
): Promise<Record<string, unknown> | null> {
	const friend = await env.DB.prepare(
		`SELECT id, name, description, url, avatar_url AS avatarUrl, status,
            is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
            updated_at AS updatedAt
     FROM friend_links WHERE id = ?`,
	)
		.bind(id)
		.first<Record<string, unknown>>();
	return friend ?? null;
}

// ================================================================
// Avatar upload
// ================================================================

async function uploadAvatar(request: Request, env: Env): Promise<Response> {
	const form = await request.formData();
	const file = form.get("file");

	if (!(file instanceof File)) {
		return json({ error: apiError("AVATAR_FILE_MISSING") }, 400);
	}

	if (!ALLOWED_AVATAR_MIME_TYPES.has(file.type)) {
		return json({ error: apiError("AVATAR_TYPE_INVALID") }, 400);
	}

	if (file.size > MAX_AVATAR_SIZE) {
		return json({ error: apiError("AVATAR_SIZE_TOO_LARGE") }, 400);
	}

	const key = `avatars/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
	await env.MEDIA_BUCKET.put(key, await file.arrayBuffer(), {
		httpMetadata: { contentType: file.type },
	});

	return json({
		avatarUrl: `/media/avatars/${stripMediaPrefix(key, "avatars")}`,
	});
}
