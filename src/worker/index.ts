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
const ADMIN_SHELL_PATH = "/worker-admin-shell/friends-admin/";
const STATIC_ASSET_PATH_PREFIXES = [
	"_astro",
	"favicon",
	"pagefind",
	"sakana",
	"vendor",
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
				response = await handleAccessProtectedAdminPage(
					request,
					env,
					requestUrl,
				);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			if (requestUrl.pathname.startsWith("/_astro/")) {
				response = await proxyBlogStaticAsset(request, requestUrl);
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

async function proxyBlogStaticAsset(
	request: Request,
	requestUrl: URL,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json({ error: apiError("METHOD_NOT_ALLOWED") }, 405);
	}

	const upstreamUrl = new URL(requestUrl.pathname, BLOG_ORIGIN);
	upstreamUrl.search = requestUrl.search;
	const upstream = await fetch(upstreamUrl, {
		headers: {
			accept: request.headers.get("accept") ?? "*/*",
			"user-agent": request.headers.get("user-agent") ?? "fuwari-worker",
		},
	});
	const headers = new Headers(upstream.headers);
	headers.delete("set-cookie");
	return new Response(request.method === "HEAD" ? null : upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

async function handleAccessProtectedAdminPage(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	if (requestUrl.pathname === "/friends/admin") {
		const redirectUrl = new URL(request.url);
		redirectUrl.pathname = ADMIN_PAGE_PATH;
		return Response.redirect(redirectUrl.toString(), 308);
	}
	if (requestUrl.pathname !== ADMIN_PAGE_PATH) {
		return json({ error: apiError("NOT_FOUND") }, 404);
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json({ error: apiError("METHOD_NOT_ALLOWED") }, 405);
	}
	const adminShellToken = env.CONTENT_SYNC_TOKEN?.trim();
	if (!adminShellToken) {
		return json({ error: apiError("SERVER_ERROR") }, 503);
	}

	const upstreamUrl = new URL(ADMIN_SHELL_PATH, BLOG_ORIGIN);
	upstreamUrl.search = requestUrl.search;
	const upstream = await fetch(upstreamUrl, {
		headers: {
			accept: request.headers.get("accept") ?? "text/html",
			"x-fuwari-admin-shell-token": adminShellToken,
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
	const rewritten = html
		.replace(
			/\bsrcset=("|')([^"']+)\1/g,
			(_, quote: string, value: string) =>
				`srcset=${quote}${rewriteSrcsetUrls(value)}${quote}`,
		)
		.replace(
			/\b(href|src|content|poster|component-url|renderer-url)=("|')\/(?!\/)([^"']*)/g,
			(_, attr: string, quote: string, path: string) =>
				`${attr}=${quote}${toBlogUrl(path)}`,
		)
		.replace(
			staticAssetStringPattern(),
			(_, quote: string, prefix: string) => `${quote}${BLOG_ORIGIN}/${prefix}/`,
		);
	const unreplacedAsset = findUnrewrittenAdminAssetReference(rewritten);
	if (unreplacedAsset) {
		console.warn("Admin shell contains unrewritten relative asset reference", {
			reference: unreplacedAsset,
		});
	}
	return rewritten;
}

function rewriteSrcsetUrls(value: string): string {
	return value.replace(/(^|,\s*)\/(?!\/)/g, `$1${BLOG_ORIGIN}/`);
}

function staticAssetStringPattern(): RegExp {
	return new RegExp(
		`(["'\`])/(?!/)(${STATIC_ASSET_PATH_PREFIXES.join("|")})/`,
		"g",
	);
}

function findUnrewrittenAdminAssetReference(html: string): string | null {
	const prefixPattern = STATIC_ASSET_PATH_PREFIXES.join("|");
	const patterns = [
		new RegExp(
			`\\b(?:href|src|content|poster|component-url|renderer-url)=(?:"|')/(?!/)(${prefixPattern})/[^"']*`,
			"i",
		),
		new RegExp(
			`\\b(?:href|src|content|poster|component-url|renderer-url)=/(?!/)(${prefixPattern})/[^\\s>]*`,
			"i",
		),
		new RegExp(
			`\\bsrcset=(?:"|')[^"']*(?:^|,\\s*)/(?!/)(${prefixPattern})/`,
			"i",
		),
		new RegExp(`(?:"|'|\`)/(?!/)(${prefixPattern})/`, "i"),
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[0]) return match[0];
	}
	return null;
}

function toBlogUrl(path: string): string {
	return `${BLOG_ORIGIN}/${path.replace(/^\/+/, "")}`;
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
