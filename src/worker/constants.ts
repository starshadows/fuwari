// ----------------------------------------------------------------
// Environment variable & settings keys
// ----------------------------------------------------------------
export const ADMIN_TOKEN_SETTING_KEY = "admin_token_sha256";
export const ADMIN_AUDIT_SALT_SETTING_KEY = "admin_audit_salt";
export const STATS_SALT_SETTING_KEY = "stats_salt";
export const COMMENTS_ENABLED_SETTING_KEY = "comments_enabled";
export const TELEGRAM_SETTINGS_KEY = "telegram_friend_notification";
export const TELEGRAM_COMMENT_SETTINGS_KEY = "telegram_comment_notification";
export const COMMENTS_SESSION_COOKIE = "fuwari_comments_session";

// ----------------------------------------------------------------
// Time / duration constants
// ----------------------------------------------------------------
export const COMMENTS_SESSION_MAX_AGE_SECONDS: number = 20 * 60;
export const ALTCHA_CHALLENGE_TTL_SECONDS: number = 10 * 60;
export const ALTCHA_COST: number = 800;
export const STATS_ACTIVE_WINDOW_MS: number = 5 * 60 * 1000;
export const STATS_TIMEZONE_OFFSET_MINUTES: number = 8 * 60;
export const RATE_LIMIT_MAX_AGE_SECONDS: number = 24 * 60 * 60;
export const MAX_JSON_BODY_BYTES: number = 64 * 1024; // 64 KB — general JSON endpoints
export const MAX_TWIKOO_BODY_BYTES: number = 10 * 1024 * 1024; // 10 MB — Twikoo (includes uploads)
export const MAX_IMAGE_UPLOAD_BYTES: number = 5 * 1024 * 1024; // 5 MB — decoded image payload
export const MAX_MUSIC_UPLOAD_BYTES: number = 25 * 1024 * 1024; // 25 MB — per uploaded audio file
export const MUSIC_UPLOAD_R2_BATCH_SIZE: number = 10;

// ----------------------------------------------------------------
// Music constants
// ----------------------------------------------------------------
export const MUSIC_PREFIX = "music/";
export const MUSIC_OBJECT_SCAN_LIMIT = 200;
export const DEFAULT_MUSIC_COVER_URL = "/favicon/favicon-light-192.png";
export const MUSIC_METADATA_READ_BYTES: number = 256 * 1024; // 256 KB — ID3v2 tags live at the start of MP3 files
export const AUDIO_EXTENSIONS: Set<string> = new Set([
	"mp3",
	"m4a",
	"aac",
	"flac",
	"wav",
	"ogg",
	"opus",
	"webm",
]);

// ----------------------------------------------------------------
// Friend constants
// ----------------------------------------------------------------
export const FRIEND_STATUSES: Set<string> = new Set([
	"pending",
	"approved",
	"rejected",
]);

// ----------------------------------------------------------------
// Rate limits
// ----------------------------------------------------------------
export interface RateLimitConfig {
	scope: string;
	limit: number;
	windowSeconds: number;
}
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
	friendSubmit: { scope: "friend-submit", limit: 5, windowSeconds: 10 * 60 },
	commentsSession: {
		scope: "comments-session",
		limit: 8,
		windowSeconds: 10 * 60,
	},
	humanProofFailure: {
		scope: "human-proof-fail",
		limit: 2,
		windowSeconds: 10 * 60,
	},
	statsWrite: { scope: "stats-write", limit: 240, windowSeconds: 10 * 60 },
	setupInitDb: { scope: "setup-init-db", limit: 5, windowSeconds: 10 * 60 },
	twikooCommentsCount: {
		scope: "twikoo-comments-count",
		limit: 120,
		windowSeconds: 10 * 60,
	},
	twikooRecentComments: {
		scope: "twikoo-recent-comments",
		limit: 60,
		windowSeconds: 10 * 60,
	},
	adminFailure: { scope: "admin-auth-fail", limit: 6, windowSeconds: 5 * 60 },
};

export const HUMAN_PROOF_CONTEXTS: Set<string> = new Set([
	"friends",
	"comments",
]);

// ----------------------------------------------------------------
// Cache version domains
// ----------------------------------------------------------------
export const CACHE_VERSION_DOMAINS = {
	friends: "cv_friends",
	commentsConfig: "cv_comments_config",
	music: "cv_music",
} as const;

export type CacheDomain = keyof typeof CACHE_VERSION_DOMAINS;

// ----------------------------------------------------------------
// Security headers
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// API error messages (centralised, replaceable for i18n later)
// ----------------------------------------------------------------
export const API_ERROR = {
	NOT_FOUND: "接口不存在。",
	METHOD_NOT_ALLOWED: "不支持的请求方法。",
	SERVER_ERROR: "服务器暂时开小差了，请稍后再试。",
	RATE_LIMITED: "请求过于频繁，请稍后再试。",
	CROSS_SITE: "跨站请求已被拒绝。",
	BODY_TOO_LARGE: "请求体过大。",
	MISSING_TOKEN: "Missing admin token.",
	INVALID_TOKEN: "Invalid admin token.",
	TOKEN_NOT_INITIALIZED:
		"Admin token is not initialized. Call /api/setup/init-db with Authorization: Bearer <token> first.",
	MISSING_D1: "Missing D1 binding. Bind a D1 database as DB first.",
	MISSING_R2: "Missing R2 binding. Bind an R2 bucket as MEDIA_BUCKET first.",
	INVALID_MEDIA_PATH: "媒体路径不正确。",
	MEDIA_TYPE_MISSING: "媒体类型不存在。",
	COMMENTS_DISABLED: "评论区已关闭。",
	HUMAN_PROOF_MISSING: "请先完成人机验证。",
	HUMAN_PROOF_FAILED: "人机验证失败，请刷新后重试。",
	SETUP_TOKEN_MISSING:
		'Missing setup token. Use Authorization: Bearer <token> or POST JSON { "token": "<token>" }.',
	INVALID_SETUP_TOKEN_404:
		"Setup tokens are no longer accepted in URL paths. Use /api/setup/init-db with Authorization: Bearer <token> or a POST JSON body.",
	FRIEND_STATUS_INVALID: "友链状态不正确。",
	FRIEND_ID_INVALID: "友链 ID 不正确。",
	FRIEND_NOT_FOUND: "友链不存在。",
	FRIEND_FIELDS_MISSING: "请填写完整的名称、简介、链接和头像。",
	FRIEND_NAME_INVALID: "名称不能包含 HTML 或链接，且长度为 1-40 个字符。",
	FRIEND_DESC_INVALID: "简介不能包含 HTML，且长度为 1-120 个字符。",
	FRIEND_URL_NOT_HTTPS: "链接必须是 https 地址。",
	FRIEND_URL_INVALID: "链接格式不正确，不能是 IP 地址或本地地址。",
	FRIEND_AVATAR_INVALID: "头像需要使用公网 https 地址或站内头像地址。",
	FRIEND_DUPLICATE: "这个站点已经提交过申请或已经在友链中。",
	FRIEND_DOMAIN_DUPLICATE: "该域名的站点已经提交过申请或已经在友链中。",
	FRIEND_PENDING_LIMIT: "待审核申请过多，请稍后再试。",
	MUSIC_FIELDS_MISSING: "请填写歌曲名称和 R2 音频 Key。",
	MUSIC_ID_INVALID: "歌曲 ID 不正确。",
	MUSIC_NOT_FOUND: "歌曲不存在。",
	MUSIC_COVER_INVALID: "封面地址不正确。",
	MUSIC_COVER_R2: "封面地址需要是公网图片或站内头像地址。",
	MUSIC_OBJECT_KEY_INVALID: "R2 音频 Key 不正确。",
	MUSIC_IMPORT_EMPTY: "没有可导入的新音乐。",
	MUSIC_UPLOAD_EMPTY: "请选择要上传的音乐文件。",
	MUSIC_UPLOAD_TYPE_INVALID: "请使用 multipart/form-data 上传音乐文件。",
	MUSIC_UPLOAD_TOO_MANY: "一次上传的音乐文件过多。",
	TELEGRAM_INCOMPLETE: "Telegram 通知尚未完整配置。",
	TELEGRAM_FAILED: "Telegram API 返回错误。",
	TWIKOO_SESSION_REQUIRED: "请先完成评论区人机验证。",
} as const;

export type ApiErrorKey = keyof typeof API_ERROR;

/**
 * Resolve an API error message by key.
 * When i18n support is added, this function selects the language
 * based on the request's Accept-Language header.
 */
export function apiError(key: ApiErrorKey): string {
	return API_ERROR[key];
}

// ----------------------------------------------------------------
// Security headers
// ----------------------------------------------------------------
export const SECURITY_HEADERS: Record<string, string> = {
	// Do not set script-src — Astro/Swup pages require inline scripts.
	// Additional CSP directives sit in the HTML <meta> where they can be
	// page-specific. These directives apply to every Worker response.
	"content-security-policy": [
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"form-action 'self'",
		"frame-src 'none'",
		"upgrade-insecure-requests",
	].join("; "),
	"permissions-policy":
		"accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
	"referrer-policy": "strict-origin-when-cross-origin",
	"x-content-type-options": "nosniff",
};
