import { createChallenge, type Payload, sha, verifySolution } from "altcha/lib";
import {
	ALTCHA_CHALLENGE_TTL_SECONDS,
	ALTCHA_COST,
	apiError,
} from "./constants";
import type { Env } from "./types";
import type { HumanProof, HumanProofContext } from "./types/aliases";
import {
	ensureStatsSaltCached,
	incrementRateLimitCounter,
	json,
	normalizeHumanProofContext,
	readString,
} from "./utils";

const VALID_HUMAN_PROOF_CONTEXTS = new Set<string>(["friends", "comments"]);

// ================================================================
// Generate ALTCHA challenge
// ================================================================

export async function getAntiAbuseChallenge(
	_request: Request,
	env: Env,
	requestUrl: URL,
): Promise<Response> {
	const context = normalizeHumanProofContext(
		requestUrl.searchParams.get("context"),
		VALID_HUMAN_PROOF_CONTEXTS,
	);
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

// ================================================================
// Verify ALTCHA payload
// ================================================================

export async function verifyHumanProof(
	request: Request,
	env: Env,
	context: HumanProofContext,
	humanProof: HumanProof | null,
): Promise<Response | null> {
	const payload = readString(humanProof?.payload, 20000);
	if (!payload) {
		await recordHumanProofFailure(request, env, context);
		return json({ error: apiError("HUMAN_PROOF_MISSING") }, 400);
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
		limit: 2,
		windowSeconds: 10 * 60,
	});
}
