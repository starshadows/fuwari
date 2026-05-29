import { createChallenge, sha, verifySolution, type Payload } from "altcha/lib";
import type { Env } from "./types";
import type { HumanProof, HumanProofContext } from "./types/aliases";
import {
  json,
  readString,
  readJson,
  isLikelyBot,
  ensureStatsSaltCached,
  enforceRateLimit,
  getRateLimitCount,
  incrementRateLimitCounter,
} from "./utils";
import { RATE_LIMITS, ALTCHA_COST, ALTCHA_CHALLENGE_TTL_SECONDS } from "./constants";

export function getTurnstileConfig(env: Env): Response {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  return json({ enabled: Boolean(siteKey && secretKey), siteKey });
}

export async function getAntiAbuseChallenge(
  request: Request,
  env: Env,
  requestUrl: URL,
): Promise<Response> {
  const context = normalizeContext(requestUrl.searchParams.get("context"));
  const turnstile = await shouldRequireTurnstile(request, env, context);

  if (turnstile.required) {
    const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
    const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
    if (!siteKey || !secretKey) {
      return json(
        {
          mode: "turnstile",
          error:
            "当前访问需要 Turnstile 验证，但站点尚未配置 Turnstile。请稍后再试或联系站长。",
          reason: turnstile.reason,
        },
        503,
      );
    }
    return json({ mode: "turnstile", siteKey, reason: turnstile.reason });
  }

  const salt = await ensureStatsSaltCached(env);
  const challenge = await createChallenge({
    algorithm: "SHA-256",
    cost: ALTCHA_COST,
    data: { context },
    deriveKey: sha.deriveKey,
    expiresAt:
      Math.floor(Date.now() / 1000) + ALTCHA_CHALLENGE_TTL_SECONDS,
    hmacSignatureSecret: salt,
  });

  return json({ mode: "altcha", challenge });
}

function normalizeContext(value: string | null): HumanProofContext {
  const ctx = value?.trim() ?? "";
  const valid = new Set<HumanProofContext>(["friends", "comments"]);
  return valid.has(ctx as HumanProofContext) ? (ctx as HumanProofContext) : "friends";
}

export async function shouldRequireTurnstile(
  request: Request,
  env: Env,
  context: HumanProofContext,
): Promise<{ required: boolean; reason: string }> {
  if (isLikelyBot(request)) {
    return { required: true, reason: "bot-user-agent" };
  }

  const failureCount = await getRateLimitCount(request, env, {
    ...RATE_LIMITS.humanProofFailure,
    scope: `${RATE_LIMITS.humanProofFailure.scope}:${context}`,
  });
  if (failureCount >= RATE_LIMITS.humanProofFailure.limit) {
    return { required: true, reason: "proof-failures" };
  }

  const submitConfig =
    context === "friends"
      ? RATE_LIMITS.friendSubmit
      : RATE_LIMITS.commentsSession;
  const submitCount = await getRateLimitCount(request, env, submitConfig);
  if (submitCount >= 3) {
    // TURNSTILE_SUBMIT_THRESHOLD
    return { required: true, reason: "high-frequency" };
  }

  return { required: false, reason: "" };
}

async function recordHumanProofFailure(
  request: Request,
  env: Env,
  context: HumanProofContext,
): Promise<void> {
  await incrementRateLimitCounter(request, env, {
    ...RATE_LIMITS.humanProofFailure,
    scope: `${RATE_LIMITS.humanProofFailure.scope}:${context}`,
  });
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

async function verifyTurnstile(
  request: Request,
  env: Env,
  token: string,
): Promise<Response | null> {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? "";

  if (!siteKey || !secretKey) {
    return json({ error: "人机验证尚未配置，暂时无法提交友链申请。" }, 503);
  }

  if (!token) {
    return json({ error: "请先完成人机验证。" }, 400);
  }

  const form = new FormData();
  form.append("secret", secretKey);
  form.append("response", token);

  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) form.append("remoteip", remoteIp);

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form },
    );
    const result = (await response.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };

    if (!response.ok || !result.success) {
      console.warn("Turnstile verification failed", result["error-codes"] ?? []);
      return json({ error: "人机验证失败，请刷新后重试。" }, 400);
    }
  } catch (error) {
    console.error("Turnstile verification request failed", error);
    return json({ error: "人机验证暂时不可用，请稍后再试。" }, 503);
  }

  return null;
}

export async function verifyHumanProof(
  request: Request,
  env: Env,
  context: HumanProofContext,
  humanProof: HumanProof | null,
): Promise<Response | null> {
  const proofType = humanProof?.type;
  const turnstile = await shouldRequireTurnstile(request, env, context);

  if (turnstile.required || proofType === "turnstile") {
    if (
      turnstile.required &&
      (!env.TURNSTILE_SITE_KEY?.trim() || !env.TURNSTILE_SECRET_KEY?.trim())
    ) {
      return json(
        {
          error:
            "当前访问需要 Turnstile 验证，但站点尚未配置 Turnstile。请稍后再试或联系站长。",
          requiresTurnstile: true,
          reason: turnstile.reason,
        },
        503,
      );
    }

    const proof = humanProof as
      | Extract<HumanProof, { type?: "turnstile" }>
      | null;
    const token =
      readString(proof?.token, 2048) ||
      readString(proof?.turnstileToken, 2048);
    if (!token) {
      await recordHumanProofFailure(request, env, context);
      return json(
        {
          error:
            "当前访问需要 Turnstile 验证，请刷新验证后重试。",
          requiresTurnstile: true,
          reason: turnstile.reason,
        },
        400,
      );
    }
    const turnstileError = await verifyTurnstile(request, env, token);
    if (turnstileError) {
      await recordHumanProofFailure(request, env, context);
      return turnstileError;
    }
    return null;
  }

  const proof = humanProof as
    | Extract<HumanProof, { type?: "altcha" }>
    | null;
  const payload = readString(proof?.payload, 20000);
  if (!payload) {
    await recordHumanProofFailure(request, env, context);
    return json({ error: "请先完成人机验证。" }, 400);
  }

  const ok = await verifyAltchaPayload(env, payload, context);
  if (!ok) {
    await recordHumanProofFailure(request, env, context);
    return json(
      {
        error: "人机验证失败，请刷新后重试。",
        requiresTurnstile: (
          await shouldRequireTurnstile(request, env, context)
        ).required,
      },
      400,
    );
  }

  return null;
}
