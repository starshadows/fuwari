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

			if (requestUrl.pathname.startsWith("/api/")) {
				response = await handleApi(request, env, requestUrl, ctx);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			if (requestUrl.pathname.startsWith("/media/")) {
				response = await handleMedia(request, env, requestUrl);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			if (requestUrl.pathname.startsWith("/_astro/")) {
				response = await handleStaticAsset(request, env);
				return withServerTiming(withSecurityHeaders(response), startedAt);
			}

			if (requestUrl.pathname.startsWith("/friends/admin")) {
				response = await handleWorkerAdminPage(request, env, requestUrl);
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

async function handleStaticAsset(
	request: Request,
	env: Env,
): Promise<Response> {
	if (!env.ASSETS) return json({ error: apiError("NOT_FOUND") }, 404);
	return env.ASSETS.fetch(request);
}

async function handleWorkerAdminPage(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	if (!env.ASSETS) return json({ error: apiError("NOT_FOUND") }, 404);
	if (requestUrl.pathname === "/friends/admin") {
		return Response.redirect(`${requestUrl.origin}/friends/admin/`, 308);
	}
	if (requestUrl.pathname !== "/friends/admin/") {
		return json({ error: apiError("NOT_FOUND") }, 404);
	}

	const assetUrl = new URL(request.url);
	assetUrl.pathname = "/worker-admin/friends/admin/";
	return env.ASSETS.fetch(new Request(assetUrl, request));
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
