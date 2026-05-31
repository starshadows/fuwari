import { createChallenge, type Payload, sha, verifySolution } from "altcha/lib";
import {
	ALTCHA_CHALLENGE_TTL_SECONDS,
	ALTCHA_COST,
	apiError,
	RATE_LIMITS,
} from "./constants";
import type { Env } from "./types";
import type { HumanProof, HumanProofContext } from "./types/aliases";
import {
	enforceRateLimit,
	ensureStatsSaltCached,
	getRateLimitCount,
	incrementRateLimitCounter,
	json,
	readString,
} from "./utils";

// ================================================================
// Generate ALTCHA challenge
// ================================================================

export async function getAntiAbuseChallenge(
	request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	// Lightweight rate limit on challenge generation to prevent abuse.
	const rl = await enforceRateLimit(request, env, {
		scope: "challenge-gen",
		limit: 30,
		windowSeconds: 10 * 60,
	});
	if (rl) return rl;

	const context = normalizeContext(requestUrl.searchParams.get("context"));
	const salt = await ensureStatsSaltCached(env);
	const challenge = await createChallenge({
		algorithm: "SHA-256",
		cost: ALTCHA_COST,
		data: { context },
		deriveKey: sha.deriveKey,
		expiresAt: Math.floor(Date.now() / 1000) + ALTCHA_CHALLENGE_TTL_SECONDS,
		hmacSignatureSecret: salt,
	});

	return json({ mode: "altcha", challenge });
}

function normalizeContext(value: string | null): HumanProofContext {
	const ctx = value?.trim() ?? "";
	const valid = new Set<HumanProofContext>(["friends", "comments"]);
	return valid.has(ctx as HumanProofContext)
		? (ctx as HumanProofContext)
		: "friends";
}

// ================================================================
// Verify ALTCHA payload
// ================================================================

export async function verifyHumanProof(
	request: Request,
	env: Env,
	context: HumanProofContext,
	humanProof: HumanProof | null,
): Promise<Response | null> {
	// Check the failure count BEFORE attempting verification.
	// If the actor is already over the limit, reject early with 429.
	const failConfig = {
		scope: `human-proof-fail:${context}`,
		limit: RATE_LIMITS.humanProofFailure.limit,
		windowSeconds: RATE_LIMITS.humanProofFailure.windowSeconds,
	};
	const failCount = await getRateLimitCount(request, env, failConfig);
	if (failCount > failConfig.limit) {
		const response = json({ error: apiError("RATE_LIMITED") }, 429);
		const nowSeconds = Math.floor(Date.now() / 1000);
		const windowStart =
			Math.floor(nowSeconds / failConfig.windowSeconds) *
			failConfig.windowSeconds;
		response.headers.set(
			"retry-after",
			String(Math.max(1, windowStart + failConfig.windowSeconds - nowSeconds)),
		);
		return response;
	}

	const payload = readString(humanProof?.payload, 20000);
	if (!payload) {
		await recordHumanProofFailure(request, env, context);
		return json({ error: apiError("HUMAN_PROOF_MISSING") }, 400);
	}

	// Validate base64 format before attempting decode.
	if (payload.length < 50 || !/^[A-Za-z0-9+/=]+$/.test(payload)) {
		await recordHumanProofFailure(request, env, context);
		return json({ error: apiError("HUMAN_PROOF_FAILED") }, 400);
	}

	const ok = await verifyAltchaPayload(env, payload, context);
	if (!ok) {
		await recordHumanProofFailure(request, env, context);
		return json({ error: apiError("HUMAN_PROOF_FAILED") }, 400);
	}

	return null;
}

async function verifyAltchaPayload(
	env: Env,
	payloadValue: string,
	context: HumanProofContext,
): Promise<boolean> {
	try {
		const payload = JSON.parse(atob(payloadValue)) as Partial<Payload>;
		if (!payload.challenge || !payload.solution) return false;
		if (payload.challenge.parameters?.data?.context !== context) return false;

		const result = await verifySolution({
			challenge: payload.challenge,
			deriveKey: sha.deriveKey,
			hmacSignatureSecret: await ensureStatsSaltCached(env),
			solution: payload.solution,
		});
		return result.verified;
	} catch {
		return false;
	}
}

async function recordHumanProofFailure(
	request: Request,
	env: Env,
	context: HumanProofContext,
): Promise<void> {
	await incrementRateLimitCounter(request, env, {
		scope: `human-proof-fail:${context}`,
		limit: RATE_LIMITS.humanProofFailure.limit,
		windowSeconds: RATE_LIMITS.humanProofFailure.windowSeconds,
	});
}
