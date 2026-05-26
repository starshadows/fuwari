<script lang="ts">
import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
import "altcha/altcha.css";

type ProofContext = "friends" | "comments";
type ProofDetail =
	| { type: "altcha"; payload: string }
	| { type: "turnstile"; token: string };

type ChallengeResponse =
	| {
			mode: "altcha";
			challenge: unknown;
	  }
	| {
			mode: "turnstile";
			siteKey?: string;
			error?: string;
			reason?: string;
	  };

type TurnstileOptions = {
	sitekey: string;
	theme: "auto";
	callback: (token: string) => void;
	"expired-callback": () => void;
	"error-callback": () => void;
};

declare global {
	interface Window {
		turnstile?: {
			render: (container: HTMLElement, options: TurnstileOptions) => string;
			reset: (widgetId?: string) => void;
			remove: (widgetId?: string) => void;
		};
	}
}

export let context: ProofContext = "friends";
export let resetSignal = 0;

const dispatch = createEventDispatcher<{
	verified: ProofDetail;
	expired: void;
	error: { message: string };
}>();

let mode: "loading" | "altcha" | "turnstile" | "error" = "loading";
let message = "正在加载验证...";
let mounted = false;
let verified = false;
let loadId = 0;
let widgetKey = 0;
let altchaWidget: HTMLElement & {
	configure?: (config: Record<string, unknown>) => Promise<void>;
	reset?: () => void;
};
let turnstileContainer: HTMLDivElement;
let turnstileWidgetId = "";

$: if (mounted) {
	resetSignal;
	void loadChallenge();
}

const loadChallenge = async () => {
	const currentLoad = ++loadId;
	removeTurnstile();
	mode = "loading";
	verified = false;
	message = "正在加载验证...";
	dispatch("expired");

	try {
		const response = await fetch(`/api/anti-abuse/challenge?context=${context}`);
		const data = (await response.json()) as ChallengeResponse;
		if (!response.ok) {
			throw new Error("error" in data ? data.error : "验证加载失败。");
		}
		if (currentLoad !== loadId) return;

		if (data.mode === "turnstile") {
			if (!data.siteKey) {
				throw new Error(data.error ?? "Turnstile 尚未配置。");
			}
			mode = "turnstile";
			message = "请完成 Turnstile 验证。";
			await tick();
			await renderTurnstile(data.siteKey);
			return;
		}

		await import("altcha");
		await import("altcha/i18n/zh-cn");
		if (currentLoad !== loadId) return;

		widgetKey += 1;
		mode = "altcha";
		message = "";
		await tick();
		await altchaWidget?.configure?.({
			challenge: data.challenge,
			hideFooter: true,
			language: "zh-cn",
			type: "checkbox",
		});
	} catch (err) {
		mode = "error";
		message = err instanceof Error ? err.message : "验证加载失败。";
		dispatch("error", { message });
	}
};

const renderTurnstile = async (siteKey: string) => {
	await loadTurnstileScript();
	await tick();

	if (!turnstileContainer || !window.turnstile) {
		throw new Error("Turnstile 容器不可用。");
	}

	turnstileWidgetId = window.turnstile.render(turnstileContainer, {
		sitekey: siteKey,
		theme: "auto",
		callback: (token: string) => {
			message = "";
			dispatch("verified", { type: "turnstile", token });
		},
		"expired-callback": () => {
			message = "Turnstile 已过期，请重新验证。";
			dispatch("expired");
		},
		"error-callback": () => {
			message = "Turnstile 加载失败，请刷新后重试。";
			dispatch("error", { message });
		},
	});
};

const loadTurnstileScript = async () => {
	if (window.turnstile) return;

	const scriptId = "cloudflare-turnstile-script";
	if (!document.getElementById(scriptId)) {
		const script = document.createElement("script");
		script.id = scriptId;
		script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
		script.async = true;
		script.defer = true;
		document.head.appendChild(script);
	}

	const startedAt = Date.now();
	while (!window.turnstile) {
		if (Date.now() - startedAt > 8000) {
			throw new Error("Turnstile 脚本加载超时。");
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

const removeTurnstile = () => {
	if (turnstileWidgetId && window.turnstile) {
		window.turnstile.remove(turnstileWidgetId);
	}
	turnstileWidgetId = "";
};

const handleAltchaVerified = (event: CustomEvent<{ payload: string }>) => {
	const payload = event.detail?.payload;
	if (!payload) return;
	verified = true;
	message = "";
	dispatch("verified", { type: "altcha", payload });
};

const handleAltchaExpired = () => {
	verified = false;
	dispatch("expired");
};

const handleAltchaError = () => {
	verified = false;
	message = "验证失败，请刷新后重试。";
	dispatch("error", { message });
};

onMount(() => {
	mounted = true;
});

onDestroy(() => {
	removeTurnstile();
});
</script>

<div class="human-proof rounded-xl bg-[var(--btn-plain-bg-hover)] px-4 py-3">
	{#if verified}
		<div class="human-proof-success">
			<span class="human-proof-success-icon" aria-hidden="true">✓</span>
			<span>已通过验证</span>
		</div>
	{:else if mode === "altcha"}
		{#key widgetKey}
			<altcha-widget
				bind:this={altchaWidget}
				on:verified={handleAltchaVerified}
				on:expired={handleAltchaExpired}
				on:error={handleAltchaError}
			></altcha-widget>
		{/key}
	{:else if mode === "turnstile"}
		<div bind:this={turnstileContainer} class="min-h-[65px]"></div>
	{/if}

	{#if mode === "loading" && message}
		<div class="human-proof-loading">
			<span class="human-proof-spinner" aria-hidden="true"></span>
			<span>{message}</span>
		</div>
	{:else if message}
		<div class="text-sm font-bold text-50">{message}</div>
	{/if}
</div>

<style>
	.human-proof :global(altcha-widget) {
		display: block;
		max-width: min(100%, 28rem);
	}

	.human-proof-loading,
	.human-proof-success {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 2.75rem;
		font-size: 0.95rem;
		font-weight: 700;
		color: rgb(0 0 0 / 0.5);
	}

	.human-proof-success {
		color: var(--primary);
	}

	:global(html.dark) .human-proof-loading {
		color: rgb(255 255 255 / 0.5);
	}

	.human-proof-success-icon {
		display: inline-flex;
		width: 1.6rem;
		height: 1.6rem;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		background: var(--primary);
		color: var(--deep-text);
		line-height: 1;
	}

	.human-proof-spinner {
		width: 1.25rem;
		height: 1.25rem;
		border: 2px solid currentColor;
		border-right-color: transparent;
		border-bottom-color: transparent;
		border-radius: 999px;
		animation: human-proof-spin 0.7s linear infinite;
		opacity: 0.8;
	}

	@keyframes human-proof-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
