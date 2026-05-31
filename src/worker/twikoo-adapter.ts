/*!
 * Twikoo Cloudflare-compatible worker adapter.
 * Inspired by twikoojs/twikoo-cloudflare@64c0048671e1a483d6a056968f08f08407b5bf8a,
 * released under the MIT License.
 *
 * This local adapter keeps the D1/R2 protocol used by the Twikoo browser client,
 * while avoiding Node-only twikoo-func dependencies that cannot be bundled safely
 * for Cloudflare Workers.
 */

import sanitizeHtml from "sanitize-html";
import {
	clampInteger,
	getClientIp,
	hashToken,
	readInteger,
	readString,
} from "./utils";

type CommentSubmittedEvent = {
	id: string;
	nick: string;
	mail: string;
	comment: string;
	url: string;
	href: string;
	pid: string;
	rid: string;
	created: number;
	isBlogger: boolean;
};

type TwikooWorkerEnv = {
	DB: D1Database;
	R2?: Pick<R2Bucket, "put" | "delete">;
	R2_PUBLIC_URL?: string;
	onCommentSubmit?: (event: CommentSubmittedEvent) => void | Promise<void>;
};

type JsonRecord = Record<string, unknown>;

type TwikooConfig = Record<
	string,
	string | number | boolean | null | undefined
>;

type CommentRow = {
	_id: string;
	uid: string;
	nick: string;
	mail: string;
	mailMd5: string;
	link: string;
	ua: string;
	ip: string;
	ipRegion?: string;
	master: number;
	url: string;
	href: string;
	comment: string;
	pid: string;
	rid: string;
	isSpam: number;
	created: number;
	updated: number;
	like: string;
	top: number;
	avatar: string;
};

const RES_CODE = {
	SUCCESS: 0,
	NO_PARAM: 100,
	FAIL: 1000,
	EVENT_NOT_EXIST: 1001,
	PASS_EXIST: 1010,
	CONFIG_NOT_EXIST: 1020,
	PASS_NOT_EXIST: 1022,
	PASS_NOT_MATCH: 1023,
	NEED_LOGIN: 1024,
	UPLOAD_FAILED: 1040,
} as const;

const VERSION = "1.6.44-cloudflare-lite";
const MAX_TIMESTAMP_MILLIS = 41025312000000;
const MAX_QUERY_LIMIT = 500;
const DEFAULT_COMMENT_PAGE_SIZE = 8;
const DEFAULT_LIMIT_PER_MINUTE = 10;
const DEFAULT_LIMIT_LENGTH = 500;

let schemaReady = false;

const twikooWorker = {
	async fetch(request: Request, env: TwikooWorkerEnv): Promise<Response> {
		await ensureTwikooSchema(env.DB);

		let event: JsonRecord = {};
		try {
			event = (await request.json()) as JsonRecord;
		} catch {
			event = {};
		}

		const headers: Record<string, string> = {
			"content-type": "application/json;charset=UTF-8",
		};
		allowCors(request, headers);
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers });
		}

		let responseBody: JsonRecord = {};
		try {
			const config = await readConfig(env.DB);
			const accessToken = getAccessToken(event);
			responseBody = await handleEvent(
				event,
				request,
				env,
				config,
				accessToken,
			);
			if (!event.accessToken && !responseBody.accessToken) {
				responseBody.accessToken = accessToken;
			}
		} catch (error) {
			responseBody = {
				code: RES_CODE.FAIL,
				message:
					error instanceof Error ? error.message : "Twikoo request failed.",
			};
		}

		return new Response(JSON.stringify(responseBody), { headers });
	},
};

export default twikooWorker;

async function handleEvent(
	event: JsonRecord,
	request: Request,
	env: TwikooWorkerEnv,
	config: TwikooConfig,
	accessToken: string,
): Promise<JsonRecord> {
	switch (readString(event.event, 80)) {
		case "GET_FUNC_VERSION":
			return { code: RES_CODE.SUCCESS, version: VERSION };
		case "COMMENT_GET":
			return commentGet(env.DB, event, config, accessToken);
		case "COMMENT_SUBMIT":
			return commentSubmit(env, request, event, config, accessToken);
		case "COMMENT_LIKE":
			return commentLike(env.DB, event, accessToken);
		case "COUNTER_GET":
			return counterGet(env.DB, event);
		case "GET_COMMENTS_COUNT":
			return getCommentsCount(env.DB, event);
		case "GET_RECENT_COMMENTS":
			return getRecentComments(env.DB, event, config);
		case "GET_PASSWORD_STATUS":
			return getPasswordStatus(config);
		case "SET_PASSWORD":
			return setPassword(env.DB, event, config, accessToken);
		case "LOGIN":
			return login(event, config, env.DB);
		case "GET_CONFIG":
			return getPublicConfig(config, accessToken);
		case "GET_CONFIG_FOR_ADMIN":
			return getConfigForAdmin(config, accessToken);
		case "SET_CONFIG":
			return setConfig(env.DB, event, config, accessToken);
		case "COMMENT_GET_FOR_ADMIN":
			return commentGetForAdmin(env.DB, event, config, accessToken);
		case "COMMENT_SET_FOR_ADMIN":
			return commentSetForAdmin(env.DB, event, config, accessToken);
		case "COMMENT_DELETE_FOR_ADMIN":
			return commentDeleteForAdmin(env.DB, event, config, accessToken);
		case "COMMENT_EXPORT_FOR_ADMIN":
			return commentExportForAdmin(env.DB, config, accessToken);
		case "UPLOAD_IMAGE":
			return uploadImageToR2(env, event);
		default:
			if (event.event) {
				return {
					code: RES_CODE.EVENT_NOT_EXIST,
					message: "请更新 Twikoo 云函数至最新版本",
				};
			}
			return {
				code: RES_CODE.NO_PARAM,
				message:
					"Twikoo 云函数运行正常，请参考 https://twikoo.js.org/frontend.html 完成前端的配置",
				version: VERSION,
			};
	}
}

async function ensureTwikooSchema(db: D1Database): Promise<void> {
	if (schemaReady) return;

	await db.batch([
		db.prepare(`CREATE TABLE IF NOT EXISTS comment (
			_id TEXT NOT NULL,
			uid TEXT NOT NULL,
			nick TEXT NOT NULL,
			mail TEXT NOT NULL,
			mailMd5 TEXT NOT NULL,
			link TEXT NOT NULL,
			ua TEXT NOT NULL,
			ip TEXT NOT NULL,
			ipRegion TEXT NOT NULL DEFAULT '',
			master INTEGER NOT NULL,
			url TEXT NOT NULL,
			href TEXT NOT NULL,
			comment TEXT NOT NULL,
			pid TEXT NOT NULL,
			rid TEXT NOT NULL,
			isSpam INTEGER NOT NULL,
			created INTEGER NOT NULL,
			updated INTEGER NOT NULL,
			like TEXT NOT NULL,
			top INTEGER NOT NULL,
			avatar TEXT NOT NULL,
			PRIMARY KEY (url, created DESC)
		)`),
		db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_comment_created ON comment (created DESC)",
		),
		db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_comment_ip_created ON comment (ip, created DESC)",
		),
		db.prepare("CREATE TABLE IF NOT EXISTS config (value TEXT NOT NULL)"),
		db.prepare(
			"INSERT INTO config (value) SELECT '' WHERE NOT EXISTS (SELECT 1 FROM config)",
		),
		db.prepare(`CREATE TABLE IF NOT EXISTS counter (
			url TEXT NOT NULL PRIMARY KEY,
			title TEXT NOT NULL,
			time INTEGER NOT NULL,
			created INTEGER NOT NULL,
			updated INTEGER NOT NULL
		)`),
	]);

	const columns = await db
		.prepare("PRAGMA table_info(comment)")
		.all<{ name: string }>();
	const hasIpRegion = (columns.results ?? []).some(
		(column) => column.name === "ipRegion",
	);
	if (!hasIpRegion) {
		await db
			.prepare(
				"ALTER TABLE comment ADD COLUMN ipRegion TEXT NOT NULL DEFAULT ''",
			)
			.run();
	}

	schemaReady = true;
}

async function commentGet(
	db: D1Database,
	event: JsonRecord,
	config: TwikooConfig,
	accessToken: string,
): Promise<JsonRecord> {
	validate(event, ["url"]);

	const uid = accessToken;
	const admin = isAdmin(config, accessToken);
	const limit = clampInteger(
		readInteger(config.COMMENT_PAGE_SIZE, DEFAULT_COMMENT_PAGE_SIZE),
		1,
		100,
	);
	const before = readInteger(event.before, MAX_TIMESTAMP_MILLIS);
	const visibleSpamValue = admin ? 2 : 1;
	const urlValue = readString(event.url, 500);

	const count = await db
		.prepare(
			"SELECT COUNT(*) AS count FROM comment WHERE url = ? AND rid = '' AND (isSpam != ? OR uid = ?)",
		)
		.bind(urlValue, visibleSpamValue, uid)
		.first<{ count: number }>("count");

	const mainResult = await db
		.prepare(
			`SELECT * FROM comment
		WHERE url = ? AND (isSpam != ? OR uid = ?) AND created < ? AND top = ? AND rid = ''
		ORDER BY created DESC
		LIMIT ?`,
		)
		.bind(urlValue, visibleSpamValue, uid, before, 0, limit + 1)
		.all<CommentRow>();

	const main = [...(mainResult.results ?? [])];
	const more = main.length > limit;
	if (more) main.splice(limit, 1);

	let top: CommentRow[] = [];
	if (!config.TOP_DISABLED && !event.before) {
		const topResult = await db
			.prepare(
				`SELECT * FROM comment
			WHERE url = ? AND (isSpam != ? OR uid = ?) AND created < ? AND top = ? AND rid = ''
			ORDER BY created DESC
			LIMIT ?`,
			)
			.bind(
				urlValue,
				visibleSpamValue,
				uid,
				MAX_TIMESTAMP_MILLIS,
				1,
				MAX_QUERY_LIMIT,
			)
			.all<CommentRow>();
		top = topResult.results ?? [];
	}

	const roots = [...top, ...main];
	const replies = await getReplies(db, roots, visibleSpamValue, uid, urlValue);

	return {
		data: parseComments([...roots, ...replies], uid, config),
		more,
		count: Number(count ?? 0),
	};
}

async function getReplies(
	db: D1Database,
	roots: CommentRow[],
	visibleSpamValue: number,
	uid: string,
	urlValue: string,
): Promise<CommentRow[]> {
	if (roots.length === 0) return [];

	const placeholders = roots.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`SELECT * FROM comment
		WHERE url = ? AND (isSpam != ? OR uid = ?) AND rid IN (${placeholders})
		ORDER BY created ASC`,
		)
		.bind(urlValue, visibleSpamValue, uid, ...roots.map((item) => item._id))
		.all<CommentRow>();
	return result.results ?? [];
}

async function commentSubmit(
	env: TwikooWorkerEnv,
	request: Request,
	event: JsonRecord,
	config: TwikooConfig,
	accessToken: string,
): Promise<JsonRecord> {
	validate(event, ["url", "ua", "comment"]);
	await limitCommentSubmit(env.DB, request, config);

	const comment = readString(event.comment, 10000);
	const nick = readString(event.nick, 80) || "匿名";
	preCheckSpam({ comment, nick }, config);

	const timestamp = Date.now();
	const mail = normalizeMail(readString(event.mail, 160));
	const displayMail = isQQMail(mail) ? addQQMailSuffix(mail) : mail;
	const mailHash = displayMail
		? await hashToken(displayMail)
		: await hashToken(nick);
	const isBlogger =
		Boolean(config.BLOGGER_EMAIL) &&
		normalizeMail(String(config.BLOGGER_EMAIL)) === displayMail;

	if (isBlogger && !isAdmin(config, accessToken)) {
		throw new Error("请先登录管理面板，再使用博主身份发送评论");
	}

	const data = {
		_id: crypto.randomUUID().replace(/-/g, ""),
		uid: accessToken,
		nick,
		mail: displayMail,
		mailMd5: mailHash,
		link: normalizeLink(readString(event.link, 500)),
		ua: readString(event.ua, 600),
		ip: getClientIp(request),
		ipRegion: getRequestRegion(request),
		master: isBlogger ? 1 : 0,
		url: readString(event.url, 500),
		href: readString(event.href, 500) || request.headers.get("referer") || "",
		comment: sanitizeComment(comment),
		pid: readString(event.pid, 80) || readString(event.rid, 80),
		rid: readString(event.rid, 80),
		isSpam: shouldMarkSpam({ comment, nick }, config) ? 1 : 0,
		created: timestamp,
		updated: timestamp,
		like: "[]",
		top: 0,
		avatar: "",
	};

	await env.DB.prepare(
		`INSERT INTO comment (
			_id, uid, nick, mail, mailMd5, link, ua, ip, ipRegion, master,
			url, href, comment, pid, rid, isSpam, created, updated, like, top, avatar
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			data._id,
			data.uid,
			data.nick,
			data.mail,
			data.mailMd5,
			data.link,
			data.ua,
			data.ip,
			data.ipRegion,
			data.master,
			data.url,
			data.href,
			data.comment,
			data.pid,
			data.rid,
			data.isSpam,
			data.created,
			data.updated,
			data.like,
			data.top,
			data.avatar,
		)
		.run();

	return {
		id: data._id,
		code: RES_CODE.SUCCESS,
	};
}

async function commentLike(
	db: D1Database,
	event: JsonRecord,
	accessToken: string,
): Promise<JsonRecord> {
	validate(event, ["id"]);
	const id = readString(event.id, 80);
	const comment = await db
		.prepare("SELECT _id, like FROM comment WHERE _id = ?")
		.bind(id)
		.first<{ _id: string; like: string }>();
	if (!comment) return {};

	const likes = parseLikeArray(comment.like);
	const next = likes.includes(accessToken)
		? likes.filter((item) => item !== accessToken)
		: [...likes, accessToken];

	await db
		.prepare("UPDATE comment SET like = ?, updated = ? WHERE _id = ?")
		.bind(JSON.stringify(next), Date.now(), id)
		.run();
	return {};
}

async function counterGet(
	db: D1Database,
	event: JsonRecord,
): Promise<JsonRecord> {
	validate(event, ["url"]);
	const urlValue = readString(event.url, 500);
	const title = readString(event.title, 200);
	const now = Date.now();

	await db
		.prepare(
			`INSERT INTO counter (url, title, time, created, updated)
		VALUES (?, ?, 1, ?, ?)
		ON CONFLICT(url) DO UPDATE SET
			time = time + 1,
			title = excluded.title,
			updated = excluded.updated`,
		)
		.bind(urlValue, title, now, now)
		.run();

	const time = await db
		.prepare("SELECT time FROM counter WHERE url = ?")
		.bind(urlValue)
		.first<{ time: number }>("time");

	return { time: Number(time ?? 0) };
}

async function getCommentsCount(
	db: D1Database,
	event: JsonRecord,
): Promise<JsonRecord> {
	if (!Array.isArray(event.urls)) throw new Error('参数"urls"不合法');

	const includeReply = Boolean(event.includeReply);
	const data = await Promise.all(
		event.urls.map(async (urlValue) => {
			const urlText = readString(urlValue, 500);
			const count = await db
				.prepare(
					"SELECT COUNT(*) AS count FROM comment WHERE url = ? AND isSpam = 0 AND (? OR rid = '')",
				)
				.bind(urlText, includeReply ? 1 : 0)
				.first<{ count: number }>("count");
			return { url: urlText, count: Number(count ?? 0) };
		}),
	);

	return { data };
}

async function getRecentComments(
	db: D1Database,
	event: JsonRecord,
	config: TwikooConfig,
): Promise<JsonRecord> {
	const includeReply = Boolean(event.includeReply);
	const pageSize = clampInteger(readInteger(event.pageSize, 10), 1, 100);
	const urls = Array.isArray(event.urls)
		? event.urls.map((value) => readString(value, 500)).filter(Boolean)
		: [];

	const comments =
		urls.length > 0
			? (
					await Promise.all(
						urls.map(async (urlValue) => {
							const result = await db
								.prepare(
									`SELECT * FROM comment
					WHERE url = ? AND isSpam = 0 AND (? OR rid = '')
					ORDER BY created DESC
					LIMIT ?`,
								)
								.bind(urlValue, includeReply ? 1 : 0, pageSize)
								.all<CommentRow>();
							return result.results ?? [];
						}),
					)
				).flat()
			: ((
					await db
						.prepare(
							`SELECT * FROM comment
				WHERE isSpam = 0 AND (? OR rid = '')
				ORDER BY created DESC
				LIMIT ?`,
						)
						.bind(includeReply ? 1 : 0, pageSize)
						.all<CommentRow>()
				).results ?? []);

	return {
		data: comments
			.sort((left, right) => right.created - left.created)
			.slice(0, pageSize)
			.map((comment) => ({
				id: comment._id,
				url: comment.url,
				nick: comment.nick,
				avatar: getAvatar(comment, config),
				mailMd5: comment.mailMd5,
				link: comment.link,
				comment: comment.comment,
				commentText: stripTags(comment.comment),
				created: comment.created,
			})),
	};
}

function getPasswordStatus(config: TwikooConfig): JsonRecord {
	return {
		code: RES_CODE.SUCCESS,
		status: Boolean(config.ADMIN_PASS),
		credentials: false,
		version: VERSION,
	};
}

async function setPassword(
	db: D1Database,
	event: JsonRecord,
	config: TwikooConfig,
	accessToken: string,
): Promise<JsonRecord> {
	const admin = isAdmin(config, accessToken);
	if (config.ADMIN_PASS && !admin) {
		return { code: RES_CODE.PASS_EXIST, message: "请先登录再修改密码" };
	}
	const password = readString(event.password, 256);
	if (!password) throw new Error('参数"password"不合法');
	// Clear any active session when the password changes.
	const { ADMIN_SESSION: _, ...rest } = config;
	await writeConfig(db, { ...rest, ADMIN_PASS: await hashToken(password) });
	return { code: RES_CODE.SUCCESS };
}

async function login(
	event: JsonRecord,
	config: TwikooConfig,
	db: D1Database,
): Promise<JsonRecord> {
	if (!config.ADMIN_PASS) {
		return { code: RES_CODE.PASS_NOT_EXIST, message: "未配置管理密码" };
	}
	const password = readString(event.password, 256);
	if (config.ADMIN_PASS !== (await hashToken(password))) {
		return { code: RES_CODE.PASS_NOT_MATCH, message: "密码错误" };
	}
	// Issue a random session token instead of returning the password hash.
	// The session token expires after 24 hours.
	const sessionToken = crypto.randomUUID().replace(/-/g, "");
	const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
	await writeConfig(db, {
		...config,
		ADMIN_SESSION: `${sessionToken}:${expiresAt}`,
	});
	return {
		code: RES_CODE.SUCCESS,
		accessToken: sessionToken,
	};
}

function getPublicConfig(
	config: TwikooConfig,
	accessToken: string,
): JsonRecord {
	return {
		code: RES_CODE.SUCCESS,
		config: {
			VERSION,
			IS_ADMIN: isAdmin(config, accessToken),
			SITE_NAME: config.SITE_NAME,
			SITE_URL: config.SITE_URL,
			MASTER_TAG: config.MASTER_TAG,
			COMMENT_BG_IMG: config.COMMENT_BG_IMG,
			GRAVATAR_CDN: config.GRAVATAR_CDN,
			DEFAULT_GRAVATAR: config.DEFAULT_GRAVATAR,
			SHOW_IMAGE: config.SHOW_IMAGE || "true",
			IMAGE_CDN: config.IMAGE_CDN,
			LIGHTBOX: config.LIGHTBOX || "false",
			SHOW_EMOTION: config.SHOW_EMOTION || "true",
			EMOTION_CDN: config.EMOTION_CDN,
			COMMENT_PLACEHOLDER: config.COMMENT_PLACEHOLDER,
			DISPLAYED_FIELDS: config.DISPLAYED_FIELDS,
			REQUIRED_FIELDS: config.REQUIRED_FIELDS,
			HIDE_ADMIN_CRYPT: config.HIDE_ADMIN_CRYPT,
			HIGHLIGHT: config.HIGHLIGHT || "true",
			HIGHLIGHT_THEME: config.HIGHLIGHT_THEME,
			HIGHLIGHT_PLUGIN: config.HIGHLIGHT_PLUGIN,
			LIMIT_LENGTH: config.LIMIT_LENGTH,
		},
	};
}

function getConfigForAdmin(
	config: TwikooConfig,
	accessToken: string,
): JsonRecord {
	if (!isAdmin(config, accessToken)) {
		return { code: RES_CODE.NEED_LOGIN, message: "请先登录" };
	}
	const {
		ADMIN_PASS: _adminPass,
		ADMIN_SESSION: _adminSession,
		...safeConfig
	} = config;
	return { code: RES_CODE.SUCCESS, config: safeConfig };
}

async function setConfig(
	db: D1Database,
	event: JsonRecord,
	config: TwikooConfig,
	accessToken: string,
): Promise<JsonRecord> {
	if (!isAdmin(config, accessToken)) {
		return { code: RES_CODE.NEED_LOGIN, message: "请先登录" };
	}
	const nextConfig =
		event.config &&
		typeof event.config === "object" &&
		!Array.isArray(event.config)
			? { ...config, ...(event.config as TwikooConfig) }
			: config;
	await writeConfig(db, nextConfig);
	return { code: RES_CODE.SUCCESS };
}

async function commentGetForAdmin(
	db: D1Database,
	event: JsonRecord,
	config: TwikooConfig,
	accessToken: string,
): Promise<JsonRecord> {
	if (!isAdmin(config, accessToken)) {
		return { code: RES_CODE.NEED_LOGIN, message: "请先登录" };
	}
	const per = clampInteger(readInteger(event.per, 20), 1, 100);
	const page = Math.max(1, readInteger(event.page, 1));
	const keyword = `%${readString(event.keyword, 200)}%`;
	const type = readString(event.type, 20);
	const spamValue = type === "VISIBLE" ? 1 : type === "HIDDEN" ? 0 : 2;

	const count = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM comment
		WHERE isSpam != ? AND (
			nick LIKE ? OR mail LIKE ? OR link LIKE ? OR ip LIKE ? OR
			comment LIKE ? OR url LIKE ? OR href LIKE ?
		)`,
		)
		.bind(
			spamValue,
			keyword,
			keyword,
			keyword,
			keyword,
			keyword,
			keyword,
			keyword,
		)
		.first<{ count: number }>("count");

	const data = await db
		.prepare(
			`SELECT * FROM comment
		WHERE isSpam != ? AND (
			nick LIKE ? OR mail LIKE ? OR link LIKE ? OR ip LIKE ? OR
			comment LIKE ? OR url LIKE ? OR href LIKE ?
		)
		ORDER BY created DESC
		LIMIT ? OFFSET ?`,
		)
		.bind(
			spamValue,
			keyword,
			keyword,
			keyword,
			keyword,
			keyword,
			keyword,
			keyword,
			per,
			per * (page - 1),
		)
		.all<CommentRow>();

	return {
		code: RES_CODE.SUCCESS,
		count: Number(count ?? 0),
		data: data.results ?? [],
	};
}

async function commentSetForAdmin(
	db: D1Database,
	event: JsonRecord,
	config: TwikooConfig,
	accessToken: string,
): Promise<JsonRecord> {
	if (!isAdmin(config, accessToken)) {
		return { code: RES_CODE.NEED_LOGIN, message: "请先登录" };
	}
	validate(event, ["id", "set"]);
	if (!event.set || typeof event.set !== "object" || Array.isArray(event.set)) {
		throw new Error('参数"set"不合法');
	}

	const allowedFields = new Set([
		"nick",
		"mail",
		"link",
		"comment",
		"isSpam",
		"top",
	]);
	const fields = Object.keys(event.set)
		.filter((field) => allowedFields.has(field))
		.sort();
	if (fields.length === 0) return { code: RES_CODE.SUCCESS };

	await db
		.prepare(
			`UPDATE comment SET ${fields.map((field) => `${field} = ?`).join(", ")}, updated = ? WHERE _id = ?`,
		)
		.bind(
			...fields.map((field) => (event.set as JsonRecord)[field]),
			Date.now(),
			readString(event.id, 80),
		)
		.run();

	return { code: RES_CODE.SUCCESS };
}

async function commentDeleteForAdmin(
	db: D1Database,
	event: JsonRecord,
	config: TwikooConfig,
	accessToken: string,
): Promise<JsonRecord> {
	if (!isAdmin(config, accessToken)) {
		return { code: RES_CODE.NEED_LOGIN, message: "请先登录" };
	}
	validate(event, ["id"]);
	await db
		.prepare("DELETE FROM comment WHERE _id = ?")
		.bind(readString(event.id, 80))
		.run();
	return { code: RES_CODE.SUCCESS };
}

async function commentExportForAdmin(
	db: D1Database,
	config: TwikooConfig,
	accessToken: string,
): Promise<JsonRecord> {
	if (!isAdmin(config, accessToken)) {
		return { code: RES_CODE.NEED_LOGIN, message: "请先登录" };
	}
	const data = await db
		.prepare("SELECT * FROM comment ORDER BY created DESC")
		.all<CommentRow>();
	return { code: RES_CODE.SUCCESS, data: data.results ?? [] };
}

async function uploadImageToR2(
	env: TwikooWorkerEnv,
	event: JsonRecord,
): Promise<JsonRecord> {
	if (!env.R2 || !env.R2_PUBLIC_URL) {
		return {
			code: RES_CODE.UPLOAD_FAILED,
			message: "R2 storage is not configured.",
		};
	}

	const photo = readString(event.photo, 10 * 1024 * 1024);
	const blob = dataUriToBlob(photo);
	if (!blob) {
		return { code: RES_CODE.UPLOAD_FAILED, message: "图片数据不合法。" };
	}

	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const hash = await hashToken(photo);
	const extension =
		blob.type.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "bin";
	const key = `${now.getFullYear()}/${month}/${hash}.${extension}`;
	const object = await env.R2.put(key, blob);
	const publicBase = env.R2_PUBLIC_URL.replace(/\/+$/g, "");

	return {
		code: RES_CODE.SUCCESS,
		data: {
			name: `${hash}.${extension}`,
			size: object?.size ?? blob.size,
			etag: object?.etag ?? "",
			url: `${publicBase}/${key}`,
		},
	};
}

async function readConfig(db: D1Database): Promise<TwikooConfig> {
	const row = await db
		.prepare("SELECT value FROM config LIMIT 1")
		.first<{ value: string }>();
	if (!row?.value) return {};
	try {
		const parsed = JSON.parse(row.value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as TwikooConfig)
			: {};
	} catch {
		return {};
	}
}

async function writeConfig(
	db: D1Database,
	config: TwikooConfig,
): Promise<void> {
	await db
		.prepare("UPDATE config SET value = ?")
		.bind(JSON.stringify(config))
		.run();
}

async function limitCommentSubmit(
	db: D1Database,
	request: Request,
	config: TwikooConfig,
): Promise<void> {
	const limitPerMinute = readInteger(
		config.LIMIT_PER_MINUTE,
		DEFAULT_LIMIT_PER_MINUTE,
	);
	const limitPerMinuteAll = readInteger(
		config.LIMIT_PER_MINUTE_ALL,
		DEFAULT_LIMIT_PER_MINUTE,
	);
	const since = Date.now() - 600000;
	const ip = getClientIp(request);

	if (limitPerMinute > 0) {
		const countByIp = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM comment WHERE created > ? AND ip = ?",
			)
			.bind(since, ip)
			.first<{ count: number }>("count");
		if (Number(countByIp ?? 0) > limitPerMinute)
			throw new Error("发言频率过高");
	}

	if (limitPerMinuteAll > 0) {
		const count = await db
			.prepare("SELECT COUNT(*) AS count FROM comment WHERE created > ?")
			.bind(since)
			.first<{ count: number }>("count");
		if (Number(count ?? 0) > limitPerMinuteAll) {
			throw new Error("评论太火爆啦 >_< 请稍后再试");
		}
	}
}

function parseComments(
	comments: CommentRow[],
	uid: string,
	config: TwikooConfig,
): JsonRecord[] {
	const roots = comments.filter((comment) => !comment.rid);
	return roots.map((comment) => {
		const replies = comments
			.filter((item) => item.rid === comment._id)
			.map((item) => toCommentDto(item, uid, [], comments, config))
			.sort((left, right) => Number(left.created) - Number(right.created));
		return toCommentDto(comment, uid, replies, [], config);
	});
}

function toCommentDto(
	comment: CommentRow,
	uid: string,
	replies: JsonRecord[],
	comments: CommentRow[],
	config: TwikooConfig,
): JsonRecord {
	const likes = parseLikeArray(comment.like);
	return {
		id: comment._id,
		nick: comment.nick,
		avatar: getAvatar(comment, config),
		mailMd5: comment.mailMd5,
		link: comment.link,
		comment: comment.comment,
		os: "",
		browser: "",
		ipRegion: shouldShowRegion(config)
			? formatIpRegion(comment.ipRegion ?? "")
			: "",
		master: Boolean(comment.master),
		like: likes.length,
		liked: likes.includes(uid),
		replies,
		rid: comment.rid,
		pid: comment.pid,
		ruser: getReplyUser(comment.pid, comments),
		top: Boolean(comment.top),
		isSpam: Boolean(comment.isSpam),
		created: comment.created,
		updated: comment.updated,
	};
}

function preCheckSpam(
	comment: { comment: string; nick: string },
	config: TwikooConfig,
): void {
	const limitLength = readInteger(config.LIMIT_LENGTH, DEFAULT_LIMIT_LENGTH);
	if (limitLength > 0 && comment.comment.length > limitLength) {
		throw new Error("评论内容过长");
	}

	const blockedWords = readString(config.BLOCKED_WORDS, 2000);
	if (containsAnyWord(comment, blockedWords)) {
		throw new Error("包含屏蔽词");
	}
}

function shouldMarkSpam(
	comment: { comment: string; nick: string },
	config: TwikooConfig,
): boolean {
	if (config.AKISMET_KEY === "MANUAL_REVIEW") return true;
	return containsAnyWord(comment, readString(config.FORBIDDEN_WORDS, 2000));
}

function containsAnyWord(
	comment: { comment: string; nick: string },
	words: string,
): boolean {
	if (!words) return false;
	const content = `${comment.comment}\n${comment.nick}`.toLowerCase();
	return words
		.split(",")
		.map((word) => word.trim().toLowerCase())
		.filter(Boolean)
		.some((word) => content.includes(word));
}

function sanitizeComment(value: string): string {
	// Use a proper HTML sanitizer instead of a hand-rolled regex blacklist.
	// The previous regex approach only stripped <script>, <style>, on* event
	// handlers, and javascript: URLs, but missed vectors like <iframe>,
	// <object>, <embed>, <form>, formaction, CSS expression(), etc.
	return sanitizeHtml(value, {
		allowedTags: [
			"b",
			"i",
			"em",
			"strong",
			"a",
			"code",
			"pre",
			"blockquote",
			"br",
			"p",
			"ul",
			"ol",
			"li",
		],
		allowedAttributes: {
			a: ["href", "title", "target"],
		},
		allowedSchemes: ["http", "https", "mailto"],
		disallowedTagsMode: "discard",
	});
}

function getAvatar(comment: CommentRow, config: TwikooConfig): string {
	if (comment.avatar) return comment.avatar;
	const gravatarCdn = readString(config.GRAVATAR_CDN, 100) || "weavatar.com";
	const defaultGravatar =
		readString(config.DEFAULT_GRAVATAR, 200) ||
		`initials&name=${encodeURIComponent(comment.nick)}`;
	return `https://${gravatarCdn}/avatar/${comment.mailMd5}?d=${defaultGravatar}`;
}

function validate(event: JsonRecord, requiredParams: string[]): void {
	for (const param of requiredParams) {
		if (!event[param]) throw new Error(`参数"${param}"不合法`);
	}
}

function isAdmin(config: TwikooConfig, accessToken: string): boolean {
	// Accept the session token issued by login(), or fall back to the
	// legacy ADMIN_PASS-as-token for compatibility during migration.
	if (config.ADMIN_SESSION && typeof config.ADMIN_SESSION === "string") {
		const [token, expiryStr] = config.ADMIN_SESSION.split(":");
		const expiry = Number(expiryStr);
		if (token && Number.isFinite(expiry)) {
			if (expiry < Math.floor(Date.now() / 1000)) return false;
			return token === accessToken;
		}
	}
	// Legacy: accept the stored password hash as the access token.
	return Boolean(config.ADMIN_PASS && config.ADMIN_PASS === accessToken);
}

function getAccessToken(event: JsonRecord): string {
	return (
		readString(event.accessToken, 128) || crypto.randomUUID().replace(/-/g, "")
	);
}

function getRequestRegion(request: Request): string {
	const cf = request.cf as IncomingRequestCfProperties | undefined;
	return `${cf?.country || ""}|0|${cf?.region || ""}|${cf?.city || ""}|`;
}

function formatIpRegion(region: string): string {
	const [country, , province] = region.split("|");
	return [country, province?.replace(/(省|市)$/u, "")]
		.map((part) => part?.trim())
		.filter(Boolean)
		.join(" ");
}

function shouldShowRegion(config: TwikooConfig): boolean {
	return Boolean(config.SHOW_REGION) && config.SHOW_REGION !== "false";
}

function getReplyUser(pid: string, comments: CommentRow[]): string | null {
	return comments.find((comment) => comment._id === pid)?.nick ?? null;
}

function parseLikeArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function normalizeMail(value: string): string {
	return value.trim().toLowerCase();
}

function isQQMail(value: string): boolean {
	return (
		/^[1-9][0-9]{4,10}$/u.test(value) ||
		/^[1-9][0-9]{4,10}@qq\.com$/iu.test(value)
	);
}

function addQQMailSuffix(value: string): string {
	return /^[1-9][0-9]{4,10}$/u.test(value) ? `${value}@qq.com` : value;
}

function normalizeLink(value: string): string {
	if (!value) return "";
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed.href
			: "";
	} catch {
		return "";
	}
}

function dataUriToBlob(value: string): Blob | null {
	const match = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/iu.exec(value);
	if (!match) return null;
	const binary = atob(match[2]);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return new Blob([bytes], { type: match[1] });
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, "");
}
function allowCors(request: Request, headers: Record<string, string>): void {
	const origin = request.headers.get("origin");
	if (!origin) return;

	// Only allow same-origin requests with credentials.
	// Previously the Origin header was reflected verbatim with
	// Access-Control-Allow-Credentials: true, which allowed any
	// third-party site to make authenticated cross-origin requests
	// that included cookies.
	try {
		const originUrl = new URL(origin);
		const requestUrl = new URL(request.url);
		if (originUrl.hostname !== requestUrl.hostname) return;
	} catch {
		return;
	}

	headers["Access-Control-Allow-Credentials"] = "true";
	headers["Access-Control-Allow-Origin"] = origin;
	headers["Access-Control-Allow-Methods"] = "POST";
	headers["Access-Control-Allow-Headers"] =
		"X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version";
	headers["Access-Control-Max-Age"] = "600";
}
