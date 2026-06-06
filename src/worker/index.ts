/// <reference types="@cloudflare/workers-types" />

import { handleAdminApi } from "./admin";
import { getAntiAbuseChallenge } from "./anti-abuse";
import {
	createCommentsSession,
	getCommentsConfig,
	handleTwikooRequest,
} from "./comments";
import { apiError } from "./constants";
import { handleContentSyncApi } from "./content";
import { initializeDatabase } from "./db";
import { getApprovedFriends, submitFriendLink } from "./friends";
import { handleMedia } from "./media";
import { getPublicMusicTracks } from "./music";
import { getStatsSummaryResponse, recordStatsVisit } from "./stats";
import type { Env } from "./types";
import {
	cachedResponseV,
	json,
	withSecurityHeaders,
	withServerTiming,
} from "./utils";

const BLOG_ORIGIN = "https://blog.starshadow.cc";
const ADMIN_PAGE_PATH = "/friends/admin/";
const ADMIN_ASSET_PREFIX = "/friends/admin/_asset/";
const ADMIN_ASSET_PATH_PREFIXES = [
	"/_astro/",
	"/favicon/",
	"/sakana/",
	"/vendor/",
];

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const startedAt = performance.now();
		const requestUrl = new URL(request.url);

		try {
			let response: Response;

			if (requestUrl.pathname.startsWith("/setup/init-db")) {
				response = json(
					{
						error: apiError("INVALID_SETUP_TOKEN_404"),
					},
					410,
				);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			if (requestUrl.pathname.startsWith("/friends/admin")) {
				response = await handleAccessProtectedAdminPage(request, requestUrl);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			if (requestUrl.pathname.startsWith("/api/")) {
				response = await handleApi(request, env, requestUrl, ctx);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			if (requestUrl.pathname.startsWith("/media/")) {
				response = await handleMedia(request, env, requestUrl);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			response = json({ error: apiError("NOT_FOUND") }, 404);
			return withServerTiming(withSecurityHeaders(response), startedAt);
		} catch (error) {
			const ip =
				request.headers.get("cf-connecting-ip") ??
				request.headers.get("x-real-ip") ??
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				"";
			console.error(
				"Worker fetch error",
				JSON.stringify({
					method: request.method,
					path: requestUrl.pathname,
					ip,
					ua: request.headers.get("user-agent") ?? "",
					message: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				}),
			);
			const response = json({ error: apiError("SERVER_ERROR") }, 500);
			return withServerTiming(response, startedAt);
		}
	},
};

async function handleAccessProtectedAdminPage(
	request: Request,
	requestUrl: URL,
): Promise<Response> {
	if (requestUrl.pathname === "/friends/admin") {
		const redirectUrl = new URL(request.url);
		redirectUrl.pathname = ADMIN_PAGE_PATH;
		return Response.redirect(redirectUrl.toString(), 308);
	}
	if (requestUrl.pathname.startsWith(ADMIN_ASSET_PREFIX)) {
		return handleAccessProtectedAdminAsset(request, requestUrl);
	}
	if (requestUrl.pathname !== ADMIN_PAGE_PATH) {
		return json({ error: apiError("NOT_FOUND") }, 404);
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json({ error: apiError("METHOD_NOT_ALLOWED") }, 405);
	}

	const upstreamUrl = new URL(ADMIN_PAGE_PATH, BLOG_ORIGIN);
	upstreamUrl.search = requestUrl.search;
	const upstream = await fetch(upstreamUrl, {
		headers: {
			accept: request.headers.get("accept") ?? "text/html",
			"user-agent": request.headers.get("user-agent") ?? "fuwari-worker",
		},
	});

	const headers = new Headers({
		"cache-control": "no-store",
		"content-type":
			upstream.headers.get("content-type") ?? "text/html; charset=utf-8",
		"x-robots-tag": "noindex,nofollow",
	});

	if (!upstream.ok) {
		return new Response(
			request.method === "HEAD" ? null : await upstream.text(),
			{
				status: upstream.status,
				headers,
			},
		);
	}

	const html = await upstream.text();
	return new Response(
		request.method === "HEAD" ? null : rewriteAdminPageHtml(html),
		{
			status: upstream.status,
			headers,
		},
	);
}

function rewriteAdminPageHtml(html: string): string {
	return html
		.replace(
			/\b(src|component-url|renderer-url)=("|')\/(?!\/)([^"']+)/g,
			(_, attr: string, quote: string, path: string) =>
				`${attr}=${quote}${toAdminAssetUrl(path)}`,
		)
		.replace(
			/\bhref=("|')\/(?!\/)(_astro|favicon|sakana|vendor)\/([^"']+)/g,
			(_, quote: string, prefix: string, rest: string) =>
				`href=${quote}${toAdminAssetUrl(`/${prefix}/${rest}`)}`,
		)
		.replace(
			/\bhref=("|')\/(?!\/)([^"']+)/g,
			(_, quote: string, path: string) => `href=${quote}${BLOG_ORIGIN}/${path}`,
		)
		.replace(
			/(["'`])\/(?!\/)(_astro|favicon|sakana|vendor)\//g,
			(_, quote: string, prefix: string) =>
				`${quote}${ADMIN_ASSET_PREFIX}${prefix}/`,
		);
}

async function handleAccessProtectedAdminAsset(
	request: Request,
	requestUrl: URL,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json({ error: apiError("METHOD_NOT_ALLOWED") }, 405);
	}

	const assetPath = getAdminAssetPath(requestUrl.pathname);
	if (!assetPath) {
		return json({ error: apiError("NOT_FOUND") }, 404);
	}

	const upstreamUrl = new URL(assetPath, BLOG_ORIGIN);
	upstreamUrl.search = requestUrl.search;
	const upstream = await fetch(upstreamUrl, {
		method: request.method === "HEAD" ? "HEAD" : "GET",
		headers: {
			accept: request.headers.get("accept") ?? "*/*",
			"user-agent": request.headers.get("user-agent") ?? "fuwari-worker",
		},
	});

	const headers = new Headers({
		"cache-control":
			upstream.headers.get("cache-control") ?? "public, max-age=3600",
		"x-robots-tag": "noindex,nofollow",
	});
	for (const headerName of ["content-type", "etag", "last-modified"]) {
		const value = upstream.headers.get(headerName);
		if (value) headers.set(headerName, value);
	}

	return new Response(request.method === "HEAD" ? null : upstream.body, {
		status: upstream.status,
		headers,
	});
}

function getAdminAssetPath(pathname: string): string | null {
	const assetPath = `/${pathname.slice(ADMIN_ASSET_PREFIX.length)}`;
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(assetPath);
	} catch {
		return null;
	}
	if (decodedPath.includes("..") || decodedPath.includes("\\")) {
		return null;
	}
	if (
		!ADMIN_ASSET_PATH_PREFIXES.some((prefix) => assetPath.startsWith(prefix))
	) {
		return null;
	}
	return assetPath;
}

function toAdminAssetUrl(path: string): string {
	return `${ADMIN_ASSET_PREFIX}${path.replace(/^\/+/, "")}`;
}

async function handleApi(
	request: Request,
	env: Env,
	requestUrl: URL,
	ctx: ExecutionContext,
): Promise<Response> {
	const { pathname } = requestUrl;

	// Database initialization
	if (pathname === "/api/setup/init-db") {
		return initializeDatabase(request, env, requestUrl);
	}

	// Anti-abuse challenge
	if (pathname === "/api/anti-abuse/challenge" && request.method === "GET") {
		return getAntiAbuseChallenge(request, env, requestUrl);
	}

	// Comments
	if (pathname === "/api/comments/config" && request.method === "GET") {
		return cachedResponseV(request, ctx, 300, env, "commentsConfig", () =>
			getCommentsConfig(env),
		);
	}
	if (pathname === "/api/comments/session" && request.method === "POST") {
		return createCommentsSession(request, env);
	}
	if (pathname === "/api/twikoo") {
		return handleTwikooRequest(request, env, requestUrl, ctx);
	}

	// Friends
	if (pathname === "/api/friends") {
		if (request.method === "GET") {
			return cachedResponseV(request, ctx, 300, env, "friends", () =>
				getApprovedFriends(env),
			);
		}
		if (request.method === "POST") {
			return submitFriendLink(request, env, ctx);
		}
	}

	// Music
	if (pathname === "/api/music/tracks" && request.method === "GET") {
		return cachedResponseV(request, ctx, 300, env, "music", () =>
			getPublicMusicTracks(env),
		);
	}

	// Stats
	if (pathname === "/api/stats/summary" && request.method === "GET") {
		return getStatsSummaryResponse(env, requestUrl);
	}
	if (pathname === "/api/stats/visit" && request.method === "POST") {
		return recordStatsVisit(request, env, false, ctx);
	}
	if (pathname === "/api/stats/heartbeat" && request.method === "POST") {
		return recordStatsVisit(request, env, true, ctx);
	}

	// Build-time content sync
	if (pathname.startsWith("/api/content/")) {
		return handleContentSyncApi(request, env, requestUrl);
	}

	// Admin API
	if (pathname.startsWith("/api/admin/")) {
		return handleAdminApi(request, env, requestUrl, ctx);
	}

	return json({ error: apiError("NOT_FOUND") }, 404);
}
