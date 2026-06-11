export type * from "./aliases";

export type Env = {
	DB: D1Database;
	MEDIA_BUCKET: R2Bucket;
	ADMIN_TOKEN?: string;
	CONTENT_SYNC_TOKEN?: string;
	PUBLIC_SITE_ORIGIN?: string;
	PUBLIC_API_ORIGIN?: string;
	ADMIN_SHELL_ORIGIN?: string;
	VERCEL_DEPLOY_HOOK_URL?: string;
};
