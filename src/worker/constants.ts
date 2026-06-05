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
	NOT_FOUND: "Endpoint not found.",
	METHOD_NOT_ALLOWED: "Method not allowed.",
	SERVER_ERROR: "Internal server error. Please try again later.",
	RATE_LIMITED: "Too many requests. Please try again later.",
	CROSS_SITE: "Cross-site request rejected.",
	INVALID_JSON: "Request body must be valid JSON object.",
	BODY_TOO_LARGE: "Request body is too large.",
	BODY_LENGTH_REQUIRED: "Request body length is required.",
	SCHEMA_NOT_READY:
		"Database schema is not ready. Run the D1 migrations before using this endpoint.",
	MISSING_TOKEN: "Missing admin token.",
	INVALID_TOKEN: "Invalid admin token.",
	TOKEN_NOT_INITIALIZED:
		"Admin token is not initialized. Call /api/setup/init-db with Authorization: Bearer <token> first.",
	MISSING_D1: "Missing D1 binding. Bind a D1 database as DB first.",
	MISSING_R2: "Missing R2 binding. Bind an R2 bucket as MEDIA_BUCKET first.",
	INVALID_MEDIA_PATH: "Invalid media path.",
	MEDIA_TYPE_MISSING: "Unknown media type.",
	COMMENTS_DISABLED: "Comments are disabled.",
	HUMAN_PROOF_MISSING: "Human verification required.",
	HUMAN_PROOF_FAILED: "Human verification failed. Please refresh and retry.",
	SETUP_TOKEN_MISSING:
		'Missing setup token. Use Authorization: Bearer <token> or POST JSON { "token": "<token>" }.',
	INVALID_SETUP_TOKEN_404:
		"Setup tokens are no longer accepted in URL paths. Use /api/setup/init-db with Authorization: Bearer <token> or a POST JSON body.",
	FRIEND_STATUS_INVALID: "Invalid friend link status.",
	FRIEND_ID_INVALID: "Invalid friend link id.",
	FRIEND_NOT_FOUND: "Friend link not found.",
	FRIEND_FIELDS_MISSING: "Please fill in name, description, link and avatar.",
	FRIEND_NAME_INVALID:
		"Name must be 1-40 characters and contain no HTML or links.",
	FRIEND_DESC_INVALID: "Description must be 1-120 characters with no HTML.",
	FRIEND_URL_NOT_HTTPS: "Link must use https://.",
	FRIEND_URL_INVALID: "Link is not a valid public URL (no IP or localhost).",
	FRIEND_AVATAR_INVALID:
		"Avatar must be a public https URL or an internal avatar path.",
	FRIEND_DUPLICATE: "This site has already been submitted or linked.",
	FRIEND_DOMAIN_DUPLICATE:
		"A site on this domain has already been submitted or linked.",
	FRIEND_PENDING_LIMIT: "Too many pending submissions. Please try again later.",
	MUSIC_FIELDS_MISSING: "Please provide track title and R2 audio key.",
	MUSIC_ID_INVALID: "Invalid track id.",
	MUSIC_NOT_FOUND: "Track not found.",
	MUSIC_COVER_INVALID: "Invalid cover URL.",
	MUSIC_COVER_R2: "Cover must be a public image or an internal avatar path.",
	MUSIC_OBJECT_KEY_INVALID: "Invalid R2 audio key.",
	MUSIC_OBJECT_NOT_FOUND: "R2 audio object not found.",
	MUSIC_DUPLICATE: "This music track has already been added.",
	MUSIC_IMPORT_EMPTY: "No new tracks available to import.",
	MUSIC_UPLOAD_EMPTY: "Please select audio files to upload.",
	MUSIC_UPLOAD_TYPE_INVALID:
		"Please upload audio files using multipart/form-data.",
	MUSIC_UPLOAD_TOO_MANY: "Aggregate upload size exceeds the limit.",
	TELEGRAM_INCOMPLETE: "Telegram notifications are not fully configured.",
	TELEGRAM_FAILED: "Telegram API returned an error.",
	TWIKOO_SESSION_REQUIRED:
		"Please complete the comments human verification first.",
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
