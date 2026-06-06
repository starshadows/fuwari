import { unzipSync } from "fflate";
import {
	apiError,
	CONTENT_POSTS_PREFIX,
	MAX_POST_EXPANDED_BYTES,
	MAX_POST_FILE_COUNT,
	MAX_POST_ZIP_UPLOAD_BYTES,
} from "./constants";
import type { Env } from "./types";
import type {
	ContentFileInfo,
	ContentPostDto,
	ContentPostStatus,
} from "./types/aliases";
import {
	auditAdminAction,
	hashToken,
	isD1ConstraintError,
	isMissingD1SchemaError,
	json,
	readBearerToken,
	readString,
	rejectOversizedBody,
	timingSafeEqual,
} from "./utils";

export type ParsedPostZip = {
	slug: string;
	sourceKey: string;
	format: "md" | "mdx";
	markdown: string;
	frontmatter: ContentFrontmatter;
	contentHash: string;
	files: ParsedZipFile[];
};

export type ParsedZipFile = ContentFileInfo & {
	bytes: Uint8Array;
};

export type ContentFrontmatter = {
	title: string;
	description: string;
	image: string;
	tags: string[];
	category: string;
	lang: string;
	published: string;
	updated: string;
};

type ContentPostRow = {
	id: number;
	slug: string;
	sourceKey?: string;
	source_key?: string;
	format: "md" | "mdx";
	title: string;
	description: string;
	image: string;
	tagsJson?: string;
	tags_json?: string;
	category: string;
	lang: string;
	published: string;
	updated: string;
	status: ContentPostStatus;
	contentHash?: string;
	content_hash?: string;
	assetsManifest?: string;
	assets_manifest?: string;
	deployStatus?: string;
	deploy_status?: string;
	deploymentError?: string;
	deployment_error?: string;
	lastDeployTriggeredAt?: string;
	last_deploy_triggered_at?: string;
	createdAt?: string;
	created_at?: string;
	updatedAt?: string;
	updated_at?: string;
};

const ALLOWED_ASSET_EXTENSIONS = new Set([
	"avif",
	"gif",
	"jpeg",
	"jpg",
	"png",
	"svg",
	"webp",
]);

const decoder = new TextDecoder();

// ================================================================
// Public build-sync API
// ================================================================

export async function handleContentSyncApi(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	const auth = requireContentSync(request, env);
	if (auth) return auth;

	if (
		requestUrl.pathname === "/api/content/manifest" &&
		request.method === "GET"
	) {
		return getContentManifest(env);
	}

	if (
		requestUrl.pathname === "/api/content/object" &&
		request.method === "GET"
	) {
		return getContentObject(env, requestUrl);
	}

	return json({ error: apiError("NOT_FOUND") }, 404);
}

function requireContentSync(request: Request, env: Env): Response | null {
	const configured = env.CONTENT_SYNC_TOKEN?.trim();
	if (!configured)
		return json({ error: apiError("CONTENT_SYNC_TOKEN_MISSING") }, 503);

	const token =
		request.headers.get("x-content-sync-token")?.trim() ||
		readBearerToken(request);
	if (!token)
		return json({ error: apiError("CONTENT_SYNC_TOKEN_MISSING") }, 401);
	if (!timingSafeEqual(token, configured)) {
		return json({ error: apiError("CONTENT_SYNC_TOKEN_INVALID") }, 401);
	}
	return null;
}

async function getContentManifest(env: Env): Promise<Response> {
	try {
		const rows = await listContentRows(env, "published");
		return json({
			posts: rows.map((row) => toContentPostDto(row)),
			generatedAt: new Date().toISOString(),
		});
	} catch (error) {
		if (isMissingD1SchemaError(error))
			return json({ posts: [], generatedAt: new Date().toISOString() });
		throw error;
	}
}

async function getContentObject(env: Env, requestUrl: URL): Promise<Response> {
	if (!env.MEDIA_BUCKET) return json({ error: apiError("MISSING_R2") }, 503);

	const key = readString(requestUrl.searchParams.get("key"), 1024);
	if (!isContentObjectKey(key)) {
		return json({ error: apiError("INVALID_MEDIA_PATH") }, 400);
	}
	if (!(await isPublishedContentKey(env, key))) {
		return json({ error: apiError("CONTENT_OBJECT_NOT_FOUND") }, 404);
	}

	const object = await env.MEDIA_BUCKET.get(key);
	if (!object?.body)
		return json({ error: apiError("CONTENT_OBJECT_NOT_FOUND") }, 404);

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);
	headers.set("cache-control", "private, no-store");
	if (!headers.has("content-type")) {
		headers.set("content-type", contentTypeForPath(key));
	}
	return new Response(object.body, { headers });
}

// ================================================================
// Admin content API
// ================================================================

export async function handleAdminContentApi(
	request: Request,
	env: Env,
	requestUrl: URL,
	ctx: ExecutionContext,
): Promise<Response> {
	const segments = requestUrl.pathname.split("/").filter(Boolean);
	const slug = segments[3] ? safeDecodePathSegment(segments[3]) : "";

	if (!segments[3]) {
		if (request.method === "GET") return listAdminContentPosts(env);
		if (request.method === "POST") return uploadContentPost(request, env, ctx);
	}

	if (segments[3] === "deploy" && !segments[4] && request.method === "POST") {
		return triggerContentDeploy(env, "manual");
	}

	if (slug) {
		if (!segments[4] && request.method === "GET")
			return getAdminContentPost(env, slug);
		if (!segments[4] && request.method === "DELETE") {
			return deleteContentPost(request, env, slug, ctx);
		}
		if (segments[4] === "publish" && request.method === "POST") {
			return publishContentPost(request, env, slug, ctx);
		}
		if (segments[4] === "unpublish" && request.method === "POST") {
			return unpublishContentPost(request, env, slug, ctx);
		}
		if (segments[4] === "deploy" && request.method === "POST") {
			return triggerContentDeploy(env, "retry", slug);
		}
	}

	return json({ error: apiError("NOT_FOUND") }, 404);
}

async function listAdminContentPosts(env: Env): Promise<Response> {
	try {
		const rows = await listContentRows(env);
		return json({ posts: rows.map((row) => toContentPostDto(row)) });
	} catch (error) {
		if (isMissingD1SchemaError(error)) return json({ posts: [] });
		throw error;
	}
}

async function getAdminContentPost(env: Env, slug: string): Promise<Response> {
	const row = await getContentRow(env, slug);
	if (!row) return json({ error: apiError("CONTENT_NOT_FOUND") }, 404);
	const post = toContentPostDto(row);
	const object = await env.MEDIA_BUCKET.get(post.sourceKey);
	const markdown = object ? decoder.decode(await object.arrayBuffer()) : "";
	return json({ post, markdown });
}

async function uploadContentPost(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!env.MEDIA_BUCKET) return json({ error: apiError("MISSING_R2") }, 503);

	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("multipart/form-data")) {
		return json({ error: apiError("CONTENT_ZIP_TYPE_INVALID") }, 400);
	}

	const bodyError = rejectOversizedBody(request, MAX_POST_ZIP_UPLOAD_BYTES);
	if (bodyError) return bodyError;

	const formData = await request.formData();
	const fileValue = formData.get("file") ?? formData.get("zip");
	if (!(fileValue instanceof File) || fileValue.size <= 0) {
		return json({ error: apiError("CONTENT_ZIP_EMPTY") }, 400);
	}
	if (fileValue.size > MAX_POST_ZIP_UPLOAD_BYTES) {
		return json({ error: apiError("BODY_TOO_LARGE") }, 413);
	}

	const requestedStatus = readString(formData.get("status"), 20);
	const status: ContentPostStatus =
		requestedStatus === "published" ? "published" : "draft";
	const parsedPosts = await parsePostArchive(await fileValue.arrayBuffer());
	if (parsedPosts instanceof Response) return parsedPosts;

	const imported: ContentPostDto[] = [];
	const skipped: string[] = [];
	const isBulkUpload = parsedPosts.length > 1;
	for (const parsed of parsedPosts) {
		const existing = await getContentRow(env, parsed.slug);
		if (existing) {
			if (!isBulkUpload)
				return json({ error: apiError("CONTENT_DUPLICATE") }, 409);
			skipped.push(parsed.slug);
			continue;
		}

		const post = await saveParsedPost(env, parsed, status);
		if (!post) {
			if (!isBulkUpload)
				return json({ error: apiError("CONTENT_DUPLICATE") }, 409);
			skipped.push(parsed.slug);
			continue;
		}
		imported.push(post);
		ctx.waitUntil(
			auditAdminAction(
				env,
				request,
				"import",
				"content",
				parsed.slug,
				JSON.stringify({ status, fileCount: parsed.files.length }),
			),
		);
	}

	return json(
		{
			ok: true,
			post: imported[0] ?? null,
			posts: imported,
			skipped,
		},
		imported.length > 0 ? 201 : 200,
	);
}

async function saveParsedPost(
	env: Env,
	parsed: ParsedPostZip,
	status: ContentPostStatus,
): Promise<ContentPostDto | null> {
	for (const file of parsed.files) {
		await env.MEDIA_BUCKET.put(file.key, file.bytes, {
			httpMetadata: { contentType: file.contentType },
		});
	}

	const deployStatus = status === "published" ? "pending" : "idle";

	let insertedId = 0;
	try {
		const result = await env.DB.prepare(
			`INSERT INTO content_posts
       (slug, source_key, format, title, description, image, tags_json, category, lang,
        published, updated, status, content_hash, assets_manifest, deploy_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				parsed.slug,
				parsed.sourceKey,
				parsed.format,
				parsed.frontmatter.title,
				parsed.frontmatter.description,
				parsed.frontmatter.image,
				JSON.stringify(parsed.frontmatter.tags),
				parsed.frontmatter.category,
				parsed.frontmatter.lang,
				parsed.frontmatter.published,
				parsed.frontmatter.updated,
				status,
				parsed.contentHash,
				JSON.stringify(stripBytes(parsed.files)),
				deployStatus,
			)
			.run();
		insertedId = Number(result.meta.last_row_id ?? 0);
	} catch (error) {
		if (isD1ConstraintError(error)) {
			return null;
		}
		throw error;
	}

	const row = await getContentRow(env, parsed.slug);
	return row ? toContentPostDto(row) : ({ id: insertedId } as ContentPostDto);
}

async function publishContentPost(
	request: Request,
	env: Env,
	slug: string,
	ctx: ExecutionContext,
): Promise<Response> {
	const row = await getContentRow(env, slug);
	if (!row) return json({ error: apiError("CONTENT_NOT_FOUND") }, 404);

	await env.DB.prepare(
		`UPDATE content_posts
     SET status = 'published', deploy_status = 'pending', deployment_error = ''
     WHERE slug = ?`,
	)
		.bind(slug)
		.run();

	ctx.waitUntil(
		auditAdminAction(env, request, "update", "content", slug, "publish"),
	);
	return triggerContentDeploy(env, "publish", slug);
}

async function unpublishContentPost(
	request: Request,
	env: Env,
	slug: string,
	ctx: ExecutionContext,
): Promise<Response> {
	const row = await getContentRow(env, slug);
	if (!row) return json({ error: apiError("CONTENT_NOT_FOUND") }, 404);

	await env.DB.prepare(
		`UPDATE content_posts
     SET status = 'draft', deploy_status = 'pending', deployment_error = ''
     WHERE slug = ?`,
	)
		.bind(slug)
		.run();

	ctx.waitUntil(
		auditAdminAction(env, request, "update", "content", slug, "unpublish"),
	);
	return triggerContentDeploy(env, "unpublish", slug);
}

async function deleteContentPost(
	request: Request,
	env: Env,
	slug: string,
	ctx: ExecutionContext,
): Promise<Response> {
	const row = await getContentRow(env, slug);
	if (!row) return json({ error: apiError("CONTENT_NOT_FOUND") }, 404);
	const post = toContentPostDto(row);

	await env.DB.prepare(
		`UPDATE content_posts
     SET status = 'draft', deploy_status = 'pending', deployment_error = ''
     WHERE slug = ?`,
	)
		.bind(slug)
		.run();

	const deploy = await runVercelDeploy(env, slug, "delete");
	if (deploy instanceof Response) return deploy;

	for (const file of post.files) {
		await env.MEDIA_BUCKET.delete(file.key);
	}
	await env.DB.prepare("DELETE FROM content_posts WHERE slug = ?")
		.bind(slug)
		.run();
	ctx.waitUntil(auditAdminAction(env, request, "delete", "content", slug));
	return json({ ok: true, deployment: deploy });
}

async function triggerContentDeploy(
	env: Env,
	reason: string,
	slug = "",
): Promise<Response> {
	const deploy = await runVercelDeploy(env, slug, reason);
	if (deploy instanceof Response) return deploy;
	return json({ ok: true, deployment: deploy });
}

async function runVercelDeploy(
	env: Env,
	slug: string,
	_reason: string,
): Promise<Response | { status: "triggered"; triggeredAt: string }> {
	const hookUrl = env.VERCEL_DEPLOY_HOOK_URL?.trim();
	if (!hookUrl) {
		await markDeployFailed(env, slug, apiError("CONTENT_DEPLOY_HOOK_MISSING"));
		return json({ error: apiError("CONTENT_DEPLOY_HOOK_MISSING") }, 503);
	}

	const targetWhere = slug ? "WHERE slug = ?" : "";
	const bindings = slug ? [slug] : [];
	await env.DB.prepare(
		`UPDATE content_posts
     SET deploy_status = 'pending', deployment_error = ''
     ${targetWhere}`,
	)
		.bind(...bindings)
		.run();

	try {
		const response = await fetch(hookUrl, { method: "POST" });
		if (!response.ok) {
			throw new Error(`Deploy Hook returned ${response.status}`);
		}
		const triggeredAt = new Date().toISOString();
		await env.DB.prepare(
			`UPDATE content_posts
       SET deploy_status = 'triggered',
           deployment_error = '',
           last_deploy_triggered_at = ?
       ${targetWhere}`,
		)
			.bind(triggeredAt, ...bindings)
			.run();
		return { status: "triggered", triggeredAt };
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: apiError("CONTENT_DEPLOY_FAILED");
		await markDeployFailed(env, slug, message);
		return json(
			{ error: apiError("CONTENT_DEPLOY_FAILED"), detail: message },
			502,
		);
	}
}

async function markDeployFailed(
	env: Env,
	slug: string,
	message: string,
): Promise<void> {
	const targetWhere = slug ? "WHERE slug = ?" : "";
	const bindings = slug ? [slug] : [];
	await env.DB.prepare(
		`UPDATE content_posts
     SET deploy_status = 'failed', deployment_error = ?
     ${targetWhere}`,
	)
		.bind(message, ...bindings)
		.run();
}

// ================================================================
// ZIP parsing and metadata
// ================================================================

export async function parsePostZip(
	bytes: ArrayBuffer,
): Promise<ParsedPostZip | Response> {
	const parsed = await parsePostArchive(bytes);
	if (parsed instanceof Response) return parsed;
	if (parsed.length !== 1)
		return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	return parsed[0];
}

export async function parsePostArchive(
	bytes: ArrayBuffer,
): Promise<ParsedPostZip[] | Response> {
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(new Uint8Array(bytes));
	} catch {
		return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	}

	const normalized: Array<{ path: string; bytes: Uint8Array }> = [];
	let expandedBytes = 0;
	for (const [rawName, fileBytes] of Object.entries(entries)) {
		const path = normalizeZipPath(rawName);
		if (!path) {
			if (isIgnorableZipEntry(rawName)) continue;
			return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
		}
		if (path.endsWith("/")) continue;
		expandedBytes += fileBytes.byteLength;
		if (expandedBytes > MAX_POST_EXPANDED_BYTES) {
			return json({ error: apiError("CONTENT_ZIP_TOO_LARGE") }, 413);
		}
		normalized.push({ path, bytes: fileBytes });
	}

	if (normalized.length === 0)
		return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	if (normalized.length > MAX_POST_FILE_COUNT) {
		return json({ error: apiError("CONTENT_ZIP_TOO_MANY_FILES") }, 400);
	}

	const articles = groupArchiveEntries(normalized);
	if (articles instanceof Response) return articles;

	const parsedPosts: ParsedPostZip[] = [];
	for (const article of articles) {
		const parsed = await parseArticleEntries(article.slug, article.entries);
		if (parsed instanceof Response) return parsed;
		parsedPosts.push(parsed);
	}
	return parsedPosts;
}

function groupArchiveEntries(
	entries: Array<{ path: string; bytes: Uint8Array }>,
):
	| Array<{ slug: string; entries: Array<{ path: string; bytes: Uint8Array }> }>
	| Response {
	const cleanEntries = stripPostsRoot(entries).filter(
		(entry) => !entry.path.split("/").some((part) => part.startsWith(".")),
	);
	if (cleanEntries.length === 0) {
		return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	}

	const articles = new Map<
		string,
		Array<{ path: string; bytes: Uint8Array }>
	>();
	for (const entry of cleanEntries) {
		const parts = entry.path.split("/");
		if (parts.length === 1 && /\.(md|mdx)$/i.test(parts[0])) {
			const slug = parts[0].replace(/\.(md|mdx)$/i, "");
			if (!isValidContentSlug(slug)) {
				return json({ error: apiError("CONTENT_SLUG_INVALID") }, 400);
			}
			appendArticleEntry(articles, slug, {
				path: `index${pathExtension(parts[0])}`,
				bytes: entry.bytes,
			});
			continue;
		}

		if (parts.length < 2)
			return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
		const slug = parts[0];
		if (!isValidContentSlug(slug)) {
			return json({ error: apiError("CONTENT_SLUG_INVALID") }, 400);
		}
		appendArticleEntry(articles, slug, {
			path: parts.slice(1).join("/"),
			bytes: entry.bytes,
		});
	}

	return [...articles.entries()].map(([slug, articleEntries]) => ({
		slug,
		entries: articleEntries,
	}));
}

function stripPostsRoot(
	entries: Array<{ path: string; bytes: Uint8Array }>,
): Array<{ path: string; bytes: Uint8Array }> {
	const firstParts = entries.map((entry) => entry.path.split("/")[0]);
	if (firstParts.length > 0 && firstParts.every((part) => part === "posts")) {
		return entries.map((entry) => ({
			...entry,
			path: entry.path.split("/").slice(1).join("/"),
		}));
	}
	return entries;
}

function appendArticleEntry(
	articles: Map<string, Array<{ path: string; bytes: Uint8Array }>>,
	slug: string,
	entry: { path: string; bytes: Uint8Array },
) {
	const existing = articles.get(slug) ?? [];
	existing.push(entry);
	articles.set(slug, existing);
}

async function parseArticleEntries(
	topLevel: string,
	normalized: Array<{ path: string; bytes: Uint8Array }>,
): Promise<ParsedPostZip | Response> {
	if (!isValidContentSlug(topLevel)) {
		return json({ error: apiError("CONTENT_SLUG_INVALID") }, 400);
	}

	const indexFiles = normalized.filter((entry) => {
		const parts = entry.path.split("/");
		return parts.length === 1 && /^index\.(md|mdx)$/i.test(parts[0]);
	});
	if (indexFiles.length !== 1) {
		return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	}

	const files: ParsedZipFile[] = [];
	for (const entry of normalized) {
		const parts = entry.path.split("/");
		if (parts.length < 1) {
			return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
		}
		const relativePath = parts.join("/");
		const ext = extensionOf(relativePath);
		const isIndex = entry === indexFiles[0];
		if (!isIndex && !ALLOWED_ASSET_EXTENSIONS.has(ext)) {
			return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
		}
		if (entry.bytes.byteLength <= 0) {
			return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
		}
		files.push({
			path: relativePath,
			key: `${CONTENT_POSTS_PREFIX}${topLevel}/${relativePath}`,
			size: entry.bytes.byteLength,
			contentType: contentTypeForPath(relativePath),
			bytes: entry.bytes,
		});
	}

	const index = files.find((file) => /^index\.(md|mdx)$/i.test(file.path));
	if (!index) return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	const markdown = decoder.decode(index.bytes);
	const format = extensionOf(index.path) as "md" | "mdx";
	const frontmatter = parseFrontmatter(markdown);
	if (!frontmatter.title || !frontmatter.published) {
		return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	}
	const contentHash = await hashParsedFiles(files);

	return {
		slug: topLevel,
		sourceKey: index.key,
		format,
		markdown,
		frontmatter,
		contentHash,
		files,
	};
}

function pathExtension(value: string): string {
	const index = value.lastIndexOf(".");
	return index < 0 ? "" : value.slice(index);
}

function normalizeZipPath(value: string): string {
	const clean = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
	if (
		!clean ||
		clean.startsWith("/") ||
		/^[a-zA-Z]:\//.test(clean) ||
		clean.includes("\0")
	) {
		return "";
	}
	const parts = clean.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		return "";
	}
	return parts.join("/");
}

function isIgnorableZipEntry(value: string): boolean {
	const clean = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
	if (!clean || clean.endsWith("/")) return true;
	return clean
		.split("/")
		.some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

function isValidContentSlug(value: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/.test(value);
}

function isContentObjectKey(value: string): boolean {
	if (!value.startsWith(CONTENT_POSTS_PREFIX)) return false;
	const clean = normalizeZipPath(value);
	return clean === value && clean.split("/").length >= 3;
}

function extensionOf(value: string): string {
	const index = value.lastIndexOf(".");
	return index < 0 ? "" : value.slice(index + 1).toLowerCase();
}

function contentTypeForPath(value: string): string {
	switch (extensionOf(value)) {
		case "avif":
			return "image/avif";
		case "gif":
			return "image/gif";
		case "jpeg":
		case "jpg":
			return "image/jpeg";
		case "md":
			return "text/markdown; charset=utf-8";
		case "mdx":
			return "text/markdown; charset=utf-8";
		case "png":
			return "image/png";
		case "svg":
			return "image/svg+xml";
		case "webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}

function parseFrontmatter(markdown: string): ContentFrontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	const raw = match?.[1] ?? "";
	const data: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf(":");
		if (separator <= 0) continue;
		const key = trimmed.slice(0, separator).trim();
		const value = trimmed.slice(separator + 1).trim();
		data[key] = value;
	}

	return {
		title: yamlScalar(data.title, 200),
		description: yamlScalar(data.description, 500),
		image: yamlScalar(data.image, 500),
		tags: yamlArray(data.tags),
		category: yamlScalar(data.category, 120),
		lang: yamlScalar(data.lang, 40),
		published: yamlScalar(data.published, 40),
		updated: yamlScalar(data.updated, 40),
	};
}

function yamlScalar(value: string | undefined, maxLength: number): string {
	if (!value) return "";
	const clean = value
		.replace(/^['"]|['"]$/g, "")
		.replace(/^null$/i, "")
		.trim();
	return clean.slice(0, maxLength);
}

function yamlArray(value: string | undefined): string[] {
	if (!value) return [];
	const clean = value.trim();
	if (!clean.startsWith("[") || !clean.endsWith("]")) return [];
	return clean
		.slice(1, -1)
		.split(",")
		.map((item) => yamlScalar(item.trim(), 80))
		.filter(Boolean);
}

async function hashParsedFiles(files: ParsedZipFile[]): Promise<string> {
	const parts: string[] = [];
	for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
		parts.push(`${file.path}:${await hashBytes(file.bytes)}`);
	}
	return hashToken(parts.join("|"));
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
	const body = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(body).set(bytes);
	const digest = await crypto.subtle.digest("SHA-256", body);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function stripBytes(files: ParsedZipFile[]): ContentFileInfo[] {
	return files.map(({ path, key, size, contentType }) => ({
		path,
		key,
		size,
		contentType,
	}));
}

// ================================================================
// D1 helpers
// ================================================================

async function listContentRows(
	env: Env,
	status?: ContentPostStatus,
): Promise<ContentPostRow[]> {
	const sql = `SELECT id, slug, source_key AS sourceKey, format, title, description, image,
      tags_json AS tagsJson, category, lang, published, updated, status,
      content_hash AS contentHash, assets_manifest AS assetsManifest,
      deploy_status AS deployStatus, deployment_error AS deploymentError,
      last_deploy_triggered_at AS lastDeployTriggeredAt,
      created_at AS createdAt, updated_at AS updatedAt
     FROM content_posts
     ${status ? "WHERE status = ?" : ""}
     ORDER BY published DESC, updated_at DESC`;
	const statement = env.DB.prepare(sql);
	const result = status
		? await statement.bind(status).all<ContentPostRow>()
		: await statement.all<ContentPostRow>();
	return result.results ?? [];
}

async function getContentRow(
	env: Env,
	slug: string,
): Promise<ContentPostRow | null> {
	return env.DB.prepare(
		`SELECT id, slug, source_key AS sourceKey, format, title, description, image,
      tags_json AS tagsJson, category, lang, published, updated, status,
      content_hash AS contentHash, assets_manifest AS assetsManifest,
      deploy_status AS deployStatus, deployment_error AS deploymentError,
      last_deploy_triggered_at AS lastDeployTriggeredAt,
      created_at AS createdAt, updated_at AS updatedAt
     FROM content_posts WHERE slug = ?`,
	)
		.bind(slug)
		.first<ContentPostRow>();
}

function toContentPostDto(row: ContentPostRow): ContentPostDto {
	const files = parseFiles(row.assetsManifest ?? row.assets_manifest ?? "[]");
	return {
		id: Number(row.id),
		slug: row.slug,
		sourceKey: row.sourceKey ?? row.source_key ?? "",
		format: row.format,
		title: row.title ?? "",
		description: row.description ?? "",
		image: row.image ?? "",
		tags: parseTags(row.tagsJson ?? row.tags_json ?? "[]"),
		category: row.category ?? "",
		lang: row.lang ?? "",
		published: row.published ?? "",
		updated: row.updated ?? "",
		status: row.status,
		contentHash: row.contentHash ?? row.content_hash ?? "",
		files,
		deployStatus: (row.deployStatus ??
			row.deploy_status ??
			"idle") as ContentPostDto["deployStatus"],
		deploymentError: row.deploymentError ?? row.deployment_error ?? "",
		lastDeployTriggeredAt:
			row.lastDeployTriggeredAt ?? row.last_deploy_triggered_at ?? "",
		createdAt: row.createdAt ?? row.created_at ?? "",
		updatedAt: row.updatedAt ?? row.updated_at ?? "",
	};
}

function parseTags(value: string): string[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function parseFiles(value: string): ContentFileInfo[] {
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isContentFileInfo);
	} catch {
		return [];
	}
}

function isContentFileInfo(value: unknown): value is ContentFileInfo {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const file = value as Record<string, unknown>;
	return (
		typeof file.path === "string" &&
		typeof file.key === "string" &&
		typeof file.size === "number" &&
		typeof file.contentType === "string"
	);
}

async function isPublishedContentKey(env: Env, key: string): Promise<boolean> {
	const rows = await listContentRows(env, "published");
	return rows.some((row) => {
		const post = toContentPostDto(row);
		return post.files.some((file) => file.key === key);
	});
}

function safeDecodePathSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
