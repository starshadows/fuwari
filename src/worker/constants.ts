// ----------------------------------------------------------------
// Environment variable & settings keys
// ----------------------------------------------------------------
export const ADMIN_TOKEN_SETTING_KEY = "admin_token_sha256";
export const STATS_SALT_SETTING_KEY = "stats_salt";
export const COMMENTS_ENABLED_SETTING_KEY = "comments_enabled";
export const TELEGRAM_SETTINGS_KEY = "telegram_friend_notification";
export const COMMENTS_SESSION_COOKIE = "fuwari_comments_session";

// ----------------------------------------------------------------
// Time / duration constants
// ----------------------------------------------------------------
export const COMMENTS_SESSION_MAX_AGE_SECONDS = 20 * 60;
export const ALTCHA_CHALLENGE_TTL_SECONDS = 10 * 60;
export const ALTCHA_COST = 800;
export const STATS_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
export const STATS_TIMEZONE_OFFSET_MINUTES = 8 * 60;
export const RATE_LIMIT_MAX_AGE_SECONDS = 24 * 60 * 60;

// ----------------------------------------------------------------
// Music constants
// ----------------------------------------------------------------
export const MUSIC_PREFIX = "music/";
export const MUSIC_OBJECT_SCAN_LIMIT = 200;
export const MUSIC_METADATA_READ_BYTES = 1024 * 1024;
export const AUDIO_EXTENSIONS = new Set([
  "mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "webm",
]);

// ----------------------------------------------------------------
// Friend / media constants
// ----------------------------------------------------------------
export const FRIEND_STATUSES = new Set(["pending", "approved", "rejected"]);
export const MAX_AVATAR_SIZE = 3 * 1024 * 1024;
export const ALLOWED_AVATAR_MIME_TYPES = new Set([
  "image/avif", "image/gif", "image/jpeg", "image/png", "image/webp",
]);

// ----------------------------------------------------------------
// Rate limits
// ----------------------------------------------------------------
export const RATE_LIMITS = {
  friendSubmit: { scope: "friend-submit", limit: 5, windowSeconds: 10 * 60 },
  commentsSession: { scope: "comments-session", limit: 8, windowSeconds: 10 * 60 },
  humanProofFailure: { scope: "human-proof-fail", limit: 2, windowSeconds: 10 * 60 },
  statsWrite: { scope: "stats-write", limit: 240, windowSeconds: 10 * 60 },
  adminFailure: { scope: "admin-auth-fail", limit: 6, windowSeconds: 5 * 60 },
} as const;

export const HUMAN_PROOF_CONTEXTS = new Set(["friends", "comments"]);

// ----------------------------------------------------------------
// Security headers
// ----------------------------------------------------------------
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
  "permissions-policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
};
