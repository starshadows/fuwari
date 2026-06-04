/// <reference types="@cloudflare/workers-types" />

import { handleAdminApi } from "./admin";
import { getAntiAbuseChallenge } from "./anti-abuse";
import {
	createCommentsSession,
	getCommentsConfig,
	handleTwikooRequest,
} from "./comments";
import { apiError } from "./constants";
import { initializeDatabase } from "./db";
import { getApprovedFriends, submitFriendLink } from "./friends";
import { handleMedia } from "./media";
import { getPublicMusicTracks } from "./music";
import { getStatsSummaryResponse, recordStatsVisit } from "./stats";
import type { Env } from "./types";
import {
	cachedResponse,
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

			response = await env.ASSETS.fetch(request);
			return withSecurityHeaders(response);
		} catch (error) {
			console.error(error);
			const response = json({ error: apiError("SERVER_ERROR") }, 500);
			return withServerTiming(response, startedAt);
		}
	},
};

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
	if (pathname === "/api/twikoo/admin") {
		return handleTwikooRequest(request, env, requestUrl, ctx, {
			adminEndpoint: true,
		});
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
		return cachedResponse(request, ctx, 60, () =>
			getStatsSummaryResponse(env, requestUrl),
		);
	}
	if (pathname === "/api/stats/visit" && request.method === "POST") {
		return recordStatsVisit(request, env, false, ctx);
	}
	if (pathname === "/api/stats/heartbeat" && request.method === "POST") {
		return recordStatsVisit(request, env, true, ctx);
	}

	// Admin API
	if (pathname.startsWith("/api/admin/")) {
		return handleAdminApi(request, env, requestUrl, ctx);
	}

	return json({ error: apiError("NOT_FOUND") }, 404);
}
