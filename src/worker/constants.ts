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
export const MAX_MUSIC_UPLOAD_REQUEST_BYTES: number =
	MAX_MUSIC_UPLOAD_BYTES * 2 + 1024 * 1024;
export const MUSIC_UPLOAD_R2_BATCH_SIZE: number = 10;
export const MAX_POST_ZIP_UPLOAD_BYTES: number = 25 * 1024 * 1024;
export const MAX_POST_EXPANDED_BYTES: number = 60 * 1024 * 1024;
export const MAX_POST_FILE_COUNT: number = 200;

// ----------------------------------------------------------------
// Music constants
// ----------------------------------------------------------------
export const MUSIC_PREFIX = "music/";
export const CONTENT_POSTS_PREFIX = "posts/";
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
	METHOD_NOT_ALLOWED: "请求方法不支持。",
	SERVER_ERROR: "服务器内部错误，请稍后再试。",
	RATE_LIMITED: "请求过于频繁，请稍后再试。",
	CROSS_SITE: "跨站请求被拒绝。",
	INVALID_JSON: "请求体必须是有效的 JSON 对象。",
	BODY_TOO_LARGE: "请求体过大。",
	BODY_LENGTH_REQUIRED: "请求体长度为必填项。",
	SCHEMA_NOT_READY: "数据库未就绪，请先运行 D1 数据库迁移。",
	MISSING_TOKEN: "缺少管理员令牌。",
	INVALID_TOKEN: "管理员令牌无效。",
	TOKEN_NOT_INITIALIZED:
		"管理员令牌未初始化。请先调用 /api/setup/init-db 并在 Authorization 头中传入 Bearer <token>。",
	MISSING_D1: "缺少 D1 绑定，请先将 D1 数据库绑定为 DB。",
	MISSING_R2: "缺少 R2 绑定，请先将 R2 存储桶绑定为 MEDIA_BUCKET。",
	INVALID_MEDIA_PATH: "媒体路径无效。",
	MEDIA_TYPE_MISSING: "未知的媒体类型。",
	COMMENTS_DISABLED: "评论功能已关闭。",
	HUMAN_PROOF_MISSING: "需要进行人机验证。",
	HUMAN_PROOF_FAILED: "人机验证失败，请刷新页面后重试。",
	SETUP_TOKEN_MISSING:
		'缺少初始化令牌。请使用 Authorization: Bearer <token> 或在 POST JSON 中传入 { "token": "<token>" }。',
	INVALID_SETUP_TOKEN_404:
		"URL 路径中不再接受初始化令牌。请使用 /api/setup/init-db 并在 Authorization 头中传入 Bearer <token> 或 POST JSON 请求体。",
	FRIEND_STATUS_INVALID: "友链状态无效。",
	FRIEND_ID_INVALID: "友链 ID 无效。",
	FRIEND_NOT_FOUND: "友链不存在。",
	FRIEND_FIELDS_MISSING: "请填写名称、描述、链接和头像。",
	FRIEND_NAME_INVALID: "名称长度须为 1-40 个字符，且不得包含 HTML 或链接。",
	FRIEND_DESC_INVALID: "描述长度须为 1-120 个字符，且不得包含 HTML。",
	FRIEND_URL_NOT_HTTPS: "链接必须使用 https://。",
	FRIEND_URL_INVALID: "链接不是有效的公开 URL（不支持 IP 或 localhost）。",
	FRIEND_AVATAR_INVALID: "头像必须是公开的 https URL 或内部头像路径。",
	FRIEND_DUPLICATE: "该站点已被提交或已存在链接。",
	FRIEND_DOMAIN_DUPLICATE: "该域名下的站点已被提交或已存在链接。",
	FRIEND_PENDING_LIMIT: "待审核提交过多，请稍后再试。",
	MUSIC_FIELDS_MISSING: "请提供曲目标题和 R2 音频键。",
	MUSIC_ID_INVALID: "曲目 ID 无效。",
	MUSIC_NOT_FOUND: "曲目不存在。",
	MUSIC_COVER_INVALID: "封面 URL 无效。",
	MUSIC_COVER_R2: "封面必须是公开图片或内部头像路径。",
	MUSIC_OBJECT_KEY_INVALID: "R2 音频键无效。",
	MUSIC_OBJECT_NOT_FOUND: "R2 音频对象不存在。",
	MUSIC_DUPLICATE: "该曲目已添加。",
	MUSIC_IMPORT_EMPTY: "没有可导入的新曲目。",
	MUSIC_UPLOAD_EMPTY: "请选择要上传的音频文件。",
	MUSIC_UPLOAD_TYPE_INVALID: "请使用 multipart/form-data 格式上传音频文件。",
	MUSIC_UPLOAD_TOO_MANY: "上传总大小超出限制。",
	CONTENT_SYNC_TOKEN_MISSING: "缺少内容同步令牌。",
	CONTENT_SYNC_TOKEN_INVALID: "内容同步令牌无效。",
	CONTENT_ZIP_TYPE_INVALID:
		"请使用 multipart/form-data 格式上传文章 ZIP 文件。",
	CONTENT_ZIP_EMPTY: "请选择一个文章 ZIP 文件。",
	CONTENT_ZIP_INVALID: "文章 ZIP 文件无效。",
	CONTENT_FRONTMATTER_INVALID: "文章 frontmatter YAML 语法无效。",
	CONTENT_ZIP_TOO_MANY_FILES: "文章 ZIP 文件包含过多文件。",
	CONTENT_ZIP_TOO_LARGE: "解压后的文章 ZIP 文件过大。",
	CONTENT_SLUG_INVALID: "文章别名无效。",
	CONTENT_DUPLICATE: "文章别名已存在。",
	CONTENT_NOT_FOUND: "文章不存在。",
	CONTENT_OBJECT_NOT_FOUND: "文章对象不存在。",
	CONTENT_DEPLOY_HOOK_MISSING: "Vercel 部署钩子未配置。",
	CONTENT_DEPLOY_FAILED: "Vercel 部署钩子调用失败。",
	TELEGRAM_INCOMPLETE: "Telegram 通知未完整配置。",
	TELEGRAM_FAILED: "Telegram API 返回错误。",
	TWIKOO_SESSION_REQUIRED: "请先完成评论人机验证。",
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
