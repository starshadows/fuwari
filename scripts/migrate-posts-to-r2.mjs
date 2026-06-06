import { File } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

const projectRoot = process.cwd();
const postsDir = path.join(projectRoot, "src", "content", "posts");
const apiBase = stripTrailingSlash(
	process.env.FUWARI_ADMIN_API_BASE_URL ||
		process.env.CONTENT_SYNC_BASE_URL ||
		"",
);
const adminToken =
	process.env.ADMIN_TOKEN || process.env.FUWARI_ADMIN_TOKEN || "";

if (!apiBase || !adminToken) {
	throw new Error(
		"Set FUWARI_ADMIN_API_BASE_URL and ADMIN_TOKEN/FUWARI_ADMIN_TOKEN before running migration.",
	);
}

const articles = await discoverArticles(postsDir);
if (articles.length === 0) {
	console.log("[migrate-posts] No local posts found.");
	process.exit(0);
}

for (const article of articles) {
	const zipBytes = await buildArticleZip(article);
	const form = new FormData();
	form.set(
		"file",
		new File([zipBytes], `${article.slug}.zip`, { type: "application/zip" }),
	);
	form.set("status", "published");

	const response = await fetch(`${apiBase}/api/admin/content`, {
		method: "POST",
		headers: { "x-fuwari-admin-token": adminToken },
		body: form,
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok && response.status !== 409) {
		throw new Error(
			`Failed to upload ${article.slug}: ${data.error || response.status}`,
		);
	}
	console.log(
		response.status === 409
			? `[migrate-posts] Skipped existing ${article.slug}.`
			: `[migrate-posts] Uploaded ${article.slug}.`,
	);
}

const deployResponse = await fetch(`${apiBase}/api/admin/content/deploy`, {
	method: "POST",
	headers: { "x-fuwari-admin-token": adminToken },
});
const deployData = await deployResponse.json().catch(() => ({}));
if (!deployResponse.ok) {
	throw new Error(
		`Uploaded posts, but deploy trigger failed: ${deployData.error || deployResponse.status}`,
	);
}
console.log(
	`[migrate-posts] Triggered Vercel deployment for ${articles.length} posts.`,
);

async function discoverArticles(baseDir) {
	const entries = await fs
		.readdir(baseDir, { withFileTypes: true })
		.catch(() => []);
	const articles = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const fullPath = path.join(baseDir, entry.name);
		if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
			articles.push({
				slug: entry.name.replace(/\.(md|mdx)$/i, ""),
				root: baseDir,
				files: [
					{ absolute: fullPath, relative: `index${path.extname(entry.name)}` },
				],
			});
			continue;
		}
		if (!entry.isDirectory()) continue;
		const indexPath = await findIndexFile(fullPath);
		if (!indexPath) continue;
		articles.push({
			slug: entry.name,
			root: fullPath,
			files: await listFiles(fullPath),
		});
	}
	return articles.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function findIndexFile(dir) {
	for (const name of ["index.md", "index.mdx"]) {
		const candidate = path.join(dir, name);
		try {
			const stat = await fs.stat(candidate);
			if (stat.isFile()) return candidate;
		} catch {
			// keep looking
		}
	}
	return "";
}

async function listFiles(dir, root = dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const absolute = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(absolute, root)));
			continue;
		}
		if (entry.isFile()) {
			files.push({
				absolute,
				relative: path.relative(root, absolute).replace(/\\/g, "/"),
			});
		}
	}
	return files;
}

async function buildArticleZip(article) {
	const entries = {};
	for (const file of article.files) {
		entries[`${article.slug}/${file.relative}`] = new Uint8Array(
			await fs.readFile(file.absolute),
		);
	}
	return zipSync(entries, { level: 6 });
}

function stripTrailingSlash(value) {
	return value.replace(/\/+$/g, "");
}
