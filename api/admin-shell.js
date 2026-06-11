import fs from "node:fs/promises";
import path from "node:path";

export default async function handler(request, response) {
	const expectedToken = process.env.CONTENT_SYNC_TOKEN;
	const requestToken = request.headers["x-fuwari-admin-shell-token"];

	if (!expectedToken || requestToken !== expectedToken) {
		response.statusCode = 404;
		response.setHeader("cache-control", "no-store");
		response.setHeader("x-robots-tag", "noindex,nofollow");
		response.end("Not found");
		return;
	}

	const htmlPath = path.join(
		process.cwd(),
		"dist",
		"worker-admin-shell",
		"friends-admin",
		"index.html",
	);
	const html = await fs.readFile(htmlPath, "utf8");
	response.statusCode = 200;
	response.setHeader("cache-control", "no-store");
	response.setHeader("content-type", "text/html; charset=utf-8");
	response.setHeader("x-robots-tag", "noindex,nofollow");
	response.end(html);
}
