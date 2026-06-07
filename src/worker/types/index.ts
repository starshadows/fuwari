export type * from "./aliases";

export type Env = {
	DB: D1Database;
	MEDIA_BUCKET: R2Bucket;
	ADMIN_TOKEN?: string;
	ADMIN_SHELL_TOKEN?: string;
	TWIKOO_ADMIN_PASSWORD?: string;
	CONTENT_SYNC_TOKEN?: string;
	VERCEL_DEPLOY_HOOK_URL?: string;
};
