<script lang="ts">
import { onMount } from "svelte";
import HumanProof from "@components/anti-abuse/HumanProof.svelte";

type HumanProofDetail =
	| { type: "altcha"; payload: string }
	| { type: "turnstile"; token: string };

type TwikooClient = {
	init: (options: {
		envId: string;
		el: string;
		path: string;
		lang?: string;
	}) => void;
};

type TwikooModule = Partial<TwikooClient> & {
	default?: unknown;
	twikoo?: unknown;
};

let enabled = true;
let isLoadingConfig = true;
let isCreatingSession = false;
let isLoaded = false;
let message = "";
let error = "";
let proofResetSignal = 0;

const loadConfig = async () => {
	isLoadingConfig = true;
	try {
		const response = await fetch("/api/comments/config");
		const data = await response.json();
		if (!response.ok) throw new Error(data.error ?? "评论配置加载失败。");
		enabled = Boolean(data.enabled);
	} catch (err) {
		enabled = false;
		error = err instanceof Error ? err.message : "评论配置加载失败。";
	} finally {
		isLoadingConfig = false;
	}
};

const createSession = async (humanProof: HumanProofDetail) => {
	isCreatingSession = true;
	error = "";
	message = "";

	try {
		const response = await fetch("/api/comments/session", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ humanProof }),
		});
		const data = await response.json();
		if (!response.ok) {
			if (data.requiresTurnstile) proofResetSignal += 1;
			throw new Error(data.error ?? "评论验证失败。");
		}

		await loadTwikoo();
	} catch (err) {
		error = err instanceof Error ? err.message : "评论验证失败。";
		proofResetSignal += 1;
	} finally {
		isCreatingSession = false;
	}
};

const loadTwikoo = async () => {
	message = "正在加载评论...";
	const module = await import("twikoo") as TwikooModule;
	const twikoo = resolveTwikooClient(module);

	twikoo.init({
		envId: "/api/twikoo",
		el: "#twikoo-comments",
		path: window.location.pathname,
		lang: "zh-CN",
	});

	isLoaded = true;
	message = "";
};

const resolveTwikooClient = (module: TwikooModule): TwikooClient => {
	const defaultModule = module.default as TwikooModule | undefined;
	const candidates: unknown[] = [
		module,
		defaultModule,
		defaultModule?.default,
		module.twikoo,
		defaultModule?.twikoo,
	];
	const client = candidates.find(
		(candidate): candidate is TwikooClient =>
			typeof (candidate as TwikooClient | undefined)?.init === "function",
	);

	if (!client) {
		throw new Error("评论客户端加载失败，请刷新后重试。");
	}

	return client;
};

onMount(() => {
	void loadConfig();
});
</script>

<section class="mt-8 border-t border-[var(--line-divider)] pt-6">
	<div class="relative mb-5 pl-4 text-2xl font-bold text-90 before:absolute before:left-0 before:top-2 before:h-5 before:w-1 before:rounded-md before:bg-[var(--primary)]">
		评论
	</div>

	{#if isLoadingConfig}
		<div class="text-50">加载中...</div>
	{:else if !enabled}
		<div class="rounded-xl bg-[var(--btn-plain-bg-hover)] px-4 py-5 text-center text-50">
			评论区已关闭。
		</div>
	{:else}
		{#if !isLoaded}
			<HumanProof
				context="comments"
				resetSignal={proofResetSignal}
				on:verified={(event) => createSession(event.detail)}
				on:expired={() => (message = "")}
				on:error={(event) => (error = event.detail.message)}
			/>
		{/if}

		{#if message}
			<div class="mt-3 text-sm text-[var(--primary)]">{message}</div>
		{:else if error}
			<div class="mt-3 text-sm text-red-500">{error}</div>
		{/if}

		{#if isCreatingSession}
			<div class="mt-3 text-sm text-50">验证中...</div>
		{/if}

		<div id="twikoo-comments" class:is-hidden={!isLoaded}></div>
	{/if}
</section>

<style>
	.is-hidden {
		display: none;
	}
</style>
