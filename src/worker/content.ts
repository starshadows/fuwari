import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import {
	apiError,
	CONTENT_POSTS_PREFIX,
	MAX_POST_EXPANDED_BYTES,
	MAX_POST_FILE_COUNT,
	MAX_POST_ZIP_UPLOAD_BYTES,
	RATE_LIMITS,
} from "./constants";
import { CONTENT_POSTS_STATEMENTS } from "./db-schema";
import type { Env } from "./types";
import type {
	ContentFileInfo,
	ContentPostDto,
	ContentPostStatus,
} from "./types/aliases";
import {
	auditAdminAction,
	enforceRateLimit,
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
	format: "md";
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
	const auth = await requireContentSync(request, env);
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

async function requireContentSync(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const rateLimit = await enforceRateLimit(
		request,
		env,
		RATE_LIMITS.contentSyncAuth,
	);
	if (rateLimit) return rateLimit;

	const configured = env.CONTENT_SYNC_TOKEN?.trim();
	if (!configured)
		return json({ error: apiError("CONTENT_SYNC_TOKEN_MISSING") }, 503);

	const token =
		request.headers.get("x-content-sync-token")?.trim() ||
		readBearerToken(request);
	if (!token) {
		return contentSyncAuthFailure(request, env, "CONTENT_SYNC_TOKEN_MISSING");
	}
	if (!timingSafeEqual(token, configured)) {
		return contentSyncAuthFailure(request, env, "CONTENT_SYNC_TOKEN_INVALID");
	}
	return null;
}

async function contentSyncAuthFailure(
	request: Request,
	env: Env,
	errorKey: "CONTENT_SYNC_TOKEN_MISSING" | "CONTENT_SYNC_TOKEN_INVALID",
): Promise<Response> {
	const rateLimit = await enforceRateLimit(
		request,
		env,
		RATE_LIMITS.contentSyncAuthFail,
	);
	if (rateLimit) return rateLimit;
	return json({ error: apiError(errorKey) }, 401);
}

async function getContentManifest(env: Env): Promise<Response> {
	const generatedAt = new Date().toISOString();
	try {
		const rows = await listContentRows(env, "published");
		const posts = rows.map((row) => toContentPostDto(row));
		const d1PostsWithFiles = posts.filter((post) => post.files.length > 0);
		const r2Posts = await listR2ContentPosts(
			env,
			new Set(d1PostsWithFiles.map((post) => post.slug)),
		);
		return json({
			posts: [...d1PostsWithFiles, ...r2Posts].sort(compareContentPosts),
			generatedAt,
		});
	} catch (error) {
		if (isMissingD1SchemaError(error)) {
			return json({ posts: await listR2ContentPosts(env), generatedAt });
		}
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
	const schema = await ensureContentPostsSchema(env);
	if (schema) return schema;

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

async function ensureContentPostsSchema(env: Env): Promise<Response | null> {
	if (!env.DB) return json({ error: apiError("MISSING_D1") }, 503);
	try {
		const row = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		)
			.bind("content_posts")
			.first<{ name: string }>();
		if (row?.name) return null;

		for (const statement of CONTENT_POSTS_STATEMENTS) {
			await env.DB.prepare(statement).run();
		}
		return null;
	} catch (error) {
		if (isMissingD1SchemaError(error)) {
			for (const statement of CONTENT_POSTS_STATEMENTS) {
				await env.DB.prepare(statement).run();
			}
			return null;
		}
		throw error;
	}
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

	const bodyError = rejectOversizedBody(request, MAX_POST_ZIP_UPLOAD_BYTES, {
		requireContentLength: true,
	});
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
	const deployStatus = status === "published" ? "pending" : "idle";
	const uploadedKeys: string[] = [];

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
				"draft",
				parsed.contentHash,
				JSON.stringify(stripBytes(parsed.files)),
				"idle",
			)
			.run();
		insertedId = Number(result.meta.last_row_id ?? 0);

		for (const file of parsed.files) {
			await env.MEDIA_BUCKET.put(file.key, file.bytes, {
				httpMetadata: { contentType: file.contentType },
			});
			uploadedKeys.push(file.key);
		}

		await env.DB.prepare(
			`UPDATE content_posts
       SET status = ?, deploy_status = ?, deployment_error = ''
       WHERE id = ?`,
		)
			.bind(status, deployStatus, insertedId)
			.run();
	} catch (error) {
		await deleteUploadedContentObjects(env, uploadedKeys);
		if (insertedId > 0) await deleteInsertedContentRow(env, insertedId);
		if (isD1ConstraintError(error)) {
			return null;
		}
		throw error;
	}

	const row = await getContentRow(env, parsed.slug);
	return row ? toContentPostDto(row) : ({ id: insertedId } as ContentPostDto);
}

async function deleteInsertedContentRow(env: Env, id: number): Promise<void> {
	try {
		await env.DB.prepare(
			"DELETE FROM content_posts WHERE id = ? AND status = 'draft'",
		)
			.bind(id)
			.run();
	} catch (error) {
		console.warn("Failed to clean up inserted content row", {
			id,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

async function deleteUploadedContentObjects(
	env: Env,
	keys: string[],
): Promise<void> {
	for (const key of keys) {
		try {
			await env.MEDIA_BUCKET.delete(key);
		} catch (error) {
			console.warn("Failed to clean up uploaded content object", {
				key,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
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
	return json({ ok: true, deployStatus: "pending" });
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
	return json({ ok: true, deployStatus: "pending" });
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

	try {
		for (const file of post.files) {
			await env.MEDIA_BUCKET.delete(file.key);
		}
		await env.DB.prepare("DELETE FROM content_posts WHERE slug = ?")
			.bind(slug)
			.run();
	} catch (error) {
		return markContentDeleteCleanupFailed(env, slug, error);
	}
	ctx.waitUntil(auditAdminAction(env, request, "delete", "content", slug));
	return json({ ok: true, deployment: deploy });
}

async function markContentDeleteCleanupFailed(
	env: Env,
	slug: string,
	error: unknown,
): Promise<Response> {
	const detail = error instanceof Error ? error.message : String(error);
	const message = detail || apiError("CONTENT_DELETE_FAILED");
	try {
		await markDeployFailed(env, slug, message);
	} catch (markError) {
		console.error("Failed to mark content delete cleanup failure", {
			slug,
			message:
				markError instanceof Error ? markError.message : String(markError),
		});
	}
	return json(
		{ error: apiError("CONTENT_DELETE_FAILED"), detail: message },
		500,
	);
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

	const targetWhere = slug
		? "WHERE slug = ?"
		: "WHERE deploy_status IN ('pending', 'failed')";
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
	const targetWhere = slug
		? "WHERE slug = ?"
		: "WHERE deploy_status IN ('pending', 'failed')";
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
	const archiveError: {
		key: "CONTENT_ZIP_INVALID" | "CONTENT_ZIP_TOO_LARGE" | "";
	} = { key: "" };
	try {
		let announcedExpandedBytes = 0;
		let announcedFileCount = 0;
		entries = unzipSync(new Uint8Array(bytes), {
			filter(file) {
				const path = normalizeZipPath(file.name);
				if (!path) {
					if (isIgnorableZipEntry(file.name)) return false;
					archiveError.key = "CONTENT_ZIP_INVALID";
					throw new Error(archiveError.key);
				}
				announcedExpandedBytes += file.originalSize;
				if (announcedExpandedBytes > MAX_POST_EXPANDED_BYTES) {
					archiveError.key = "CONTENT_ZIP_TOO_LARGE";
					throw new Error(archiveError.key);
				}
				announcedFileCount += 1;
				if (announcedFileCount > MAX_POST_FILE_COUNT) {
					archiveError.key = "CONTENT_ZIP_INVALID";
					throw new Error(archiveError.key);
				}
				return true;
			},
		});
	} catch {
		if (archiveError.key === "CONTENT_ZIP_TOO_LARGE") {
			return json({ error: apiError("CONTENT_ZIP_TOO_LARGE") }, 413);
		}
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
		if (parts.length === 1 && /\.md$/i.test(parts[0])) {
			const slug = parts[0].replace(/\.md$/i, "");
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
		return parts.length === 1 && /^index\.md$/i.test(parts[0]);
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

	const index = files.find((file) => /^index\.md$/i.test(file.path));
	if (!index) return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	const markdown = decoder.decode(index.bytes);
	const format = "md";
	const frontmatter = parseFrontmatter(markdown);
	if (frontmatter instanceof Response) return frontmatter;
	if (!frontmatter.title || !frontmatter.published) {
		return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	}
	const imageError = validateFrontmatterImage(frontmatter.image, files);
	if (imageError) return imageError;
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
	return parseR2ContentKey(value) !== null;
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
		case "png":
			return "image/png";
		case "webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}

function validateFrontmatterImage(
	image: string,
	files: ParsedZipFile[],
): Response | null {
	const value = image.trim();
	if (!value) return null;
	if (/^(?:https?:\/\/|data:|\/)/i.test(value)) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
		return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	}

	const reference = safeDecodePathSegment(value.split(/[?#]/, 1)[0] ?? "")
		.replace(/^\.\//, "")
		.trim();
	const normalized = normalizeZipPath(reference);
	if (!normalized || !ALLOWED_ASSET_EXTENSIONS.has(extensionOf(normalized))) {
		return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	}
	if (!files.some((file) => file.path === normalized)) {
		return json({ error: apiError("CONTENT_ZIP_INVALID") }, 400);
	}
	return null;
}

function parseFrontmatter(markdown: string): ContentFrontmatter | Response {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	const raw = match?.[1] ?? "";
	let data: unknown;
	try {
		data = parseYaml(raw) ?? {};
	} catch {
		return json({ error: apiError("CONTENT_FRONTMATTER_INVALID") }, 400);
	}
	const frontmatter =
		data && typeof data === "object" && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: {};

	return {
		title: yamlScalar(frontmatter.title, 200),
		description: yamlScalar(frontmatter.description, 500),
		image: yamlScalar(frontmatter.image, 500),
		tags: yamlArray(frontmatter.tags),
		category: yamlScalar(frontmatter.category, 120),
		lang: yamlScalar(frontmatter.lang, 40),
		published: yamlScalar(frontmatter.published, 40),
		updated: yamlScalar(frontmatter.updated, 40),
	};
}

function yamlScalar(value: unknown, maxLength: number): string {
	if (value === null || value === undefined) return "";
	const clean =
		value instanceof Date
			? value.toISOString().slice(0, 10)
			: typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean"
				? String(value).trim()
				: "";
	return clean.slice(0, maxLength);
}

function yamlArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => yamlScalar(item, 80)).filter(Boolean);
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

async function listR2ContentPosts(
	env: Env,
	excludedSlugs = new Set<string>(),
): Promise<ContentPostDto[]> {
	if (!env.MEDIA_BUCKET) return [];

	const filesBySlug = new Map<string, ContentFileInfo[]>();
	for (const object of await listR2ContentObjects(env.MEDIA_BUCKET)) {
		const parsed = parseR2ContentKey(object.key);
		if (!parsed || excludedSlugs.has(parsed.slug)) continue;
		if (
			parsed.path !== "index.md" &&
			!ALLOWED_ASSET_EXTENSIONS.has(extensionOf(parsed.path))
		) {
			continue;
		}

		const files = filesBySlug.get(parsed.slug) ?? [];
		files.push({
			path: parsed.path,
			key: object.key,
			size: Number(object.size ?? 0),
			contentType: contentTypeForPath(parsed.path),
		});
		filesBySlug.set(parsed.slug, files);
	}

	const posts: ContentPostDto[] = [];
	for (const [slug, files] of filesBySlug) {
		const index = files.find((file) => file.path === "index.md");
		if (!index) continue;

		const object = await env.MEDIA_BUCKET.get(index.key);
		if (!object?.body) continue;
		const frontmatter = parseFrontmatter(await object.text());
		if (frontmatter instanceof Response) continue;
		if (!frontmatter.title || !frontmatter.published) continue;

		const imageError = validateFrontmatterImage(
			frontmatter.image,
			files.map((file) => ({ ...file, bytes: new Uint8Array() })),
		);
		if (imageError) continue;

		posts.push({
			id: 0,
			slug,
			sourceKey: index.key,
			format: "md",
			title: frontmatter.title,
			description: frontmatter.description,
			image: frontmatter.image,
			tags: frontmatter.tags,
			category: frontmatter.category,
			lang: frontmatter.lang,
			published: frontmatter.published,
			updated: frontmatter.updated,
			status: "published",
			contentHash: index.key,
			files: files.sort((a, b) => a.path.localeCompare(b.path)),
			deployStatus: "triggered",
			deploymentError: "",
			lastDeployTriggeredAt: "",
			createdAt: "",
			updatedAt: "",
		});
	}

	return posts;
}

async function listR2ContentObjects(bucket: R2Bucket): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const listed = await bucket.list({
			prefix: CONTENT_POSTS_PREFIX,
			cursor,
		});
		objects.push(...listed.objects);
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	return objects;
}

function parseR2ContentKey(
	value: string,
): { slug: string; path: string } | null {
	if (!value.startsWith(CONTENT_POSTS_PREFIX)) return null;
	const clean = normalizeZipPath(value);
	if (clean !== value) return null;

	const parts = clean.slice(CONTENT_POSTS_PREFIX.length).split("/");
	if (parts.length === 1) {
		const fileName = parts[0] ?? "";
		if (!/\.md$/i.test(fileName)) return null;
		const slug = fileName.replace(/\.md$/i, "");
		return isValidContentSlug(slug) ? { slug, path: "index.md" } : null;
	}

	const slug = parts[0] ?? "";
	const path = parts.slice(1).join("/");
	if (!isValidContentSlug(slug)) return null;
	if (!path || normalizeZipPath(path) !== path) return null;
	return { slug, path };
}

function compareContentPosts(a: ContentPostDto, b: ContentPostDto): number {
	return (
		b.published.localeCompare(a.published) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.slug.localeCompare(b.slug)
	);
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
	const parsed = parseR2ContentKey(key);
	if (!parsed) return false;

	let rows: ContentPostRow[] = [];
	try {
		rows = await listContentRows(env, "published");
	} catch (error) {
		if (!isMissingD1SchemaError(error)) throw error;
	}
	let hasD1AllowlistForSlug = false;
	const isAllowedByD1 = rows.some((row) => {
		const post = toContentPostDto(row);
		if (post.slug === parsed.slug && post.files.length > 0) {
			hasD1AllowlistForSlug = true;
		}
		return post.files.some((file) => file.key === key);
	});
	if (isAllowedByD1) return true;
	if (hasD1AllowlistForSlug) return false;
	return isPublishedR2ContentKey(env, key);
}

async function isPublishedR2ContentKey(
	env: Env,
	key: string,
): Promise<boolean> {
	const parsed = parseR2ContentKey(key);
	if (!parsed || !env.MEDIA_BUCKET) return false;
	if (
		parsed.path !== "index.md" &&
		!ALLOWED_ASSET_EXTENSIONS.has(extensionOf(parsed.path))
	) {
		return false;
	}

	const indexObject = await firstExistingR2Object(
		env.MEDIA_BUCKET,
		parsed.path === "index.md"
			? [key]
			: [
					`${CONTENT_POSTS_PREFIX}${parsed.slug}/index.md`,
					`${CONTENT_POSTS_PREFIX}${parsed.slug}.md`,
				],
	);
	if (!indexObject?.body) return false;
	const frontmatter = parseFrontmatter(await indexObject.text());
	return !(
		frontmatter instanceof Response ||
		!frontmatter.title ||
		!frontmatter.published
	);
}

async function firstExistingR2Object(
	bucket: R2Bucket,
	keys: string[],
): Promise<R2ObjectBody | null> {
	for (const key of keys) {
		const object = await bucket.get(key);
		if (object?.body) return object;
	}
	return null;
}

function safeDecodePathSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
