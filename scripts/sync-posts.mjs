import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const postsDir = path.join(projectRoot, "src", "content", "posts");
const postsTmpDir = path.join(projectRoot, "src", "content", ".posts-sync-tmp");
const baseUrl = stripTrailingSlash(
	process.env.CONTENT_SYNC_BASE_URL ||
		process.env.FUWARI_CONTENT_API_BASE_URL ||
		"",
);
const token = process.env.CONTENT_SYNC_TOKEN || "";
const strict = process.env.CONTENT_SYNC_STRICT === "true";
const enabled = process.env.CONTENT_SYNC_ENABLED === "true";

if (!enabled) {
	console.log(
		"[sync-posts] CONTENT_SYNC_ENABLED is not true; keeping local posts unchanged.",
	);
	process.exit(0);
}

if (!baseUrl || !token) {
	await fs.mkdir(postsDir, { recursive: true });
	console.log(
		"[sync-posts] CONTENT_SYNC_BASE_URL/FUWARI_CONTENT_API_BASE_URL or CONTENT_SYNC_TOKEN is not set; keeping local posts unchanged.",
	);
	process.exit(0);
}

const headers = { authorization: `Bearer ${token}` };
try {
	const manifest = await fetchJson(`${baseUrl}/api/content/manifest`, headers);
	const posts = Array.isArray(manifest.posts) ? manifest.posts : [];

	await fs.rm(postsTmpDir, { recursive: true, force: true });
	await fs.mkdir(postsTmpDir, { recursive: true });

	let fileCount = 0;
	for (const post of posts) {
		if (!isSafeSlug(post.slug)) {
			throw new Error(`Unsafe content slug in manifest: ${post.slug}`);
		}
		const files = Array.isArray(post.files) ? post.files : [];
		for (const file of files) {
			if (!isSafeLocalPath(file.path) || typeof file.key !== "string") {
				throw new Error(
					`Unsafe content manifest entry for ${post.slug || "unknown"}.`,
				);
			}
			const target = path.join(postsTmpDir, String(post.slug), file.path);
			if (
				!target.startsWith(path.join(postsTmpDir, String(post.slug)) + path.sep)
			) {
				throw new Error(`Content object escapes posts directory: ${file.path}`);
			}
			await fs.mkdir(path.dirname(target), { recursive: true });
			const objectUrl = `${baseUrl}/api/content/object?key=${encodeURIComponent(file.key)}`;
			const response = await fetch(objectUrl, { headers });
			if (!response.ok) {
				throw new Error(`Failed to download ${file.key}: ${response.status}`);
			}
			await fs.writeFile(target, new Uint8Array(await response.arrayBuffer()));
			fileCount += 1;
		}
	}

	await validateSyncedMarkdownAssets(postsTmpDir);
	await fs.writeFile(path.join(postsTmpDir, ".gitkeep"), "");
	await fs.rm(postsDir, { recursive: true, force: true });
	await fs.rename(postsTmpDir, postsDir);
	console.log(
		`[sync-posts] Synced ${posts.length} posts and ${fileCount} files.`,
	);
} catch (error) {
	await fs.rm(postsTmpDir, { recursive: true, force: true });
	if (strict) throw error;
	await fs.mkdir(postsDir, { recursive: true });
	console.warn(
		`[sync-posts] Content sync failed; keeping local posts unchanged. Set CONTENT_SYNC_STRICT=true to fail the build. ${error instanceof Error ? error.message : String(error)}`,
	);
}

function stripTrailingSlash(value) {
	return value.replace(/\/+$/g, "");
}

async function fetchJson(url, requestHeaders) {
	const response = await fetch(url, { headers: requestHeaders });
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(data.error || `Request failed: ${response.status}`);
	}
	return data;
}

function isSafeLocalPath(value) {
	if (typeof value !== "string" || !value || value.includes("\0")) return false;
	if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return false;
	const parts = value.replace(/\\/g, "/").split("/");
	return parts.every((part) => part && part !== "." && part !== "..");
}

function isSafeSlug(value) {
	return (
		typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/.test(value)
	);
}

async function validateSyncedMarkdownAssets(rootDir) {
	for (const markdownPath of await listMarkdownFiles(rootDir)) {
		const postDir = path.dirname(markdownPath);
		const postDirName =
			path.relative(rootDir, postDir).split(path.sep)[0] ?? "post";
		const markdown = await fs.readFile(markdownPath, "utf8");
		for (const reference of markdownRelativeReferences(markdown)) {
			const target = path.normalize(path.join(postDir, reference));
			if (!target.startsWith(postDir + path.sep)) {
				throw new Error(
					`Synced post ${postDirName} references an unsafe asset path: ${reference}`,
				);
			}
			const asset = await fs.stat(target).catch(() => null);
			if (!asset?.isFile()) {
				throw new Error(
					`Synced post ${postDirName} references a missing asset: ${reference}`,
				);
			}
		}
	}
}

async function listMarkdownFiles(rootDir) {
	const files = [];
	await collectMarkdownFiles(rootDir, files);
	return files;
}

async function collectMarkdownFiles(dir, files) {
	for (const entry of await fs.readdir(dir)) {
		if (entry.startsWith(".")) continue;
		const entryPath = path.join(dir, entry);
		const stat = await fs.stat(entryPath).catch(() => null);
		if (!stat) continue;
		if (stat.isDirectory()) {
			await collectMarkdownFiles(entryPath, files);
			continue;
		}

		if (stat.isFile() && /\.(md|mdx)$/i.test(entry)) files.push(entryPath);
	}
}

function markdownRelativeReferences(markdown) {
	const references = new Set();
	const markdownImagePattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	const htmlSourcePattern = /\b(?:src|href)=["'](\.\.?\/[^"']+)["']/g;
	const relativeImagePattern =
		/(?:^|[\s"'(:])((?:\.\.?\/)[^\s"'<>)]*\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#][^\s"'<>)]*)?)/gim;

	for (const match of markdown.matchAll(markdownImagePattern)) {
		const value = normalizeMarkdownUrl(match[1]);
		if (isLocalRelativeReference(value)) references.add(value);
	}

	for (const match of markdown.matchAll(htmlSourcePattern)) {
		const value = normalizeMarkdownUrl(match[1]);
		if (isLocalRelativeReference(value)) references.add(value);
	}

	for (const match of markdown.matchAll(relativeImagePattern)) {
		const value = normalizeMarkdownUrl(match[1]);
		if (isLocalRelativeReference(value)) references.add(value);
	}

	return references;
}

function normalizeMarkdownUrl(value) {
	return decodeURI(value.split(/[?#]/, 1)[0] ?? "").trim();
}

function isLocalRelativeReference(value) {
	return value.startsWith("./") || value.startsWith("../");
}
