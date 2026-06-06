import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const postsDir = path.join(projectRoot, "src", "content", "posts");
const baseUrl = stripTrailingSlash(
	process.env.CONTENT_SYNC_BASE_URL ||
		process.env.FUWARI_CONTENT_API_BASE_URL ||
		"",
);
const token = process.env.CONTENT_SYNC_TOKEN || "";

if (!baseUrl || !token) {
	await fs.mkdir(postsDir, { recursive: true });
	console.log(
		"[sync-posts] CONTENT_SYNC_BASE_URL/FUWARI_CONTENT_API_BASE_URL or CONTENT_SYNC_TOKEN is not set; keeping local posts unchanged.",
	);
	process.exit(0);
}

const headers = { authorization: `Bearer ${token}` };
const manifest = await fetchJson(`${baseUrl}/api/content/manifest`, headers);
const posts = Array.isArray(manifest.posts) ? manifest.posts : [];

await fs.rm(postsDir, { recursive: true, force: true });
await fs.mkdir(postsDir, { recursive: true });

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
		const target = path.join(postsDir, String(post.slug), file.path);
		if (!target.startsWith(path.join(postsDir, String(post.slug)) + path.sep)) {
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

await fs.writeFile(path.join(postsDir, ".gitkeep"), "");
console.log(
	`[sync-posts] Synced ${posts.length} posts and ${fileCount} files.`,
);

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
