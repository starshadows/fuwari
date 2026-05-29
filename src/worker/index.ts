/// <reference types="@cloudflare/workers-types" />

import type { Env } from "./types";
import {
  json,
  withSecurityHeaders,
  withServerTiming,
  cachedResponse,
  normalizeHumanProofContext,
} from "./utils";
import { initializeDatabase } from "./db";
import {
  getTurnstileConfig,
  getAntiAbuseChallenge,
} from "./anti-abuse";
import { getApprovedFriends, submitFriendLink } from "./friends";
import {
  getPublicMusicTracks,
} from "./music";
import {
  getStatsSummaryResponse,
  recordStatsVisit,
} from "./stats";
import {
  getCommentsConfig,
  createCommentsSession,
  handleTwikooRequest,
} from "./comments";
import { handleAdminApi } from "./admin";
import { handleMedia } from "./media";
import { HUMAN_PROOF_CONTEXTS } from "./constants";

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
            error:
              "Setup tokens are no longer accepted in URL paths. Use /api/setup/init-db with Authorization: Bearer <token> or a POST JSON body.",
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
      const response = json(
        { error: "服务器暂时开小差了，请稍后再试。" },
        500,
      );
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

  // Turnstile config
  if (pathname === "/api/turnstile/config" && request.method === "GET") {
    return cachedResponse(request, ctx, 300, () =>
      getTurnstileConfig(env),
    );
  }

  // Anti-abuse challenge
  if (pathname === "/api/anti-abuse/challenge" && request.method === "GET") {
    return getAntiAbuseChallenge(request, env, requestUrl);
  }

  // Comments
  if (pathname === "/api/comments/config" && request.method === "GET") {
    return cachedResponse(request, ctx, 300, () =>
      getCommentsConfig(env),
    );
  }
  if (pathname === "/api/comments/session" && request.method === "POST") {
    return createCommentsSession(request, env);
  }
  if (pathname === "/api/twikoo") {
    return handleTwikooRequest(request, env, requestUrl);
  }

  // Friends
  if (pathname === "/api/friends") {
    if (request.method === "GET") {
      return cachedResponse(request, ctx, 300, () =>
        getApprovedFriends(env),
      );
    }
    if (request.method === "POST") {
      return submitFriendLink(request, env, ctx);
    }
  }

  // Music
  if (pathname === "/api/music/tracks" && request.method === "GET") {
    return cachedResponse(request, ctx, 300, () =>
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
    return recordStatsVisit(request, env, false);
  }
  if (pathname === "/api/stats/heartbeat" && request.method === "POST") {
    return recordStatsVisit(request, env, true);
  }

  // Admin API
  if (pathname.startsWith("/api/admin/")) {
    return handleAdminApi(request, env, requestUrl);
  }

  return json({ error: "接口不存在。" }, 404);
}
