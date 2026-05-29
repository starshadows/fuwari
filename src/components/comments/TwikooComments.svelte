<script lang="ts">
import { onMount, tick } from "svelte";
import HumanProof from "@components/anti-abuse/HumanProof.svelte";
import "twikoo/dist/twikoo.css";

type HumanProofDetail = { type: "altcha"; payload: string };

type TwikooClient = {
	init: (options: {
		envId: string;
		el: string;
		path: string;
		lang?: string;
	}) => void | Promise<void>;
};

type TwikooModule = Partial<TwikooClient> & {
	default?: unknown;
	twikoo?: unknown;
};

let enabled = true;
let isLoadingConfig = true;
let isCreatingSession = false;
let isTwikooLoaded = false;
let message = "";
let error = "";
let proofResetSignal = 0;
let showVerification = false;

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

const loadTwikoo = async () => {
	if (isTwikooLoaded) return;
	message = "正在加载评论...";
	const module = await import("twikoo") as TwikooModule;
	const twikoo = resolveTwikooClient(module);

	isTwikooLoaded = true;
	await tick();

	await twikoo.init({
		envId: new URL("/api/twikoo", window.location.origin).href,
		el: "#twikoo-comments",
		path: window.location.pathname,
		lang: "zh-CN",
	});

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

// 先加载 Twikoo 展示已有评论区，再决定是否展示验证
const initComments = async () => {
	await loadConfig();
	if (!enabled) return;

	// 先加载 Twikoo 展示评论列表（不验证）
	await loadTwikoo();

	// 对比 envId 是否包含 /api/twikoo，如果是则 Twikoo 走的是 worker 代理，
	// 那么发帖需要验证。展示评论区区域后，再把验证框放出来
	showVerification = true;
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
			throw new Error(data.error ?? "评论验证失败。");
		}

		// 验证通过后重新加载 Twikoo（session cookie 已设置）
		await loadTwikoo();
	} catch (err) {
		message = "";
		error = err instanceof Error ? err.message : "评论验证失败。";
		proofResetSignal += 1;
	} finally {
		isCreatingSession = false;
	}
};

onMount(() => {
	void initComments();
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
		<!-- 评论区容器 — 始终展示 Twikoo 已有评论列表 -->
		<div id="twikoo-comments"></div>

		{#if message}
			<div class="mt-3 text-sm text-[var(--primary)]">{message}</div>
		{:else if error}
			<div class="mt-3 text-sm text-red-500">{error}</div>
		{/if}

		{#if isCreatingSession}
			<div class="mt-3 text-sm text-50">验证中...</div>
		{/if}

		<!-- 发帖需要验证 — 在评论区下方显示 -->
		{#if showVerification}
			<div class="mt-4">
				<HumanProof
					context="comments"
					resetSignal={proofResetSignal}
					on:verified={(event) => createSession(event.detail)}
					on:expired={() => (message = "")}
					on:error={(event) => (error = event.detail.message)}
				/>
			</div>
		{/if}
	{/if}
</section>

<style>
	:global(#twikoo-comments .tk-avatar) {
		width: 2.5rem;
		height: 2.5rem;
		max-width: 2.5rem;
		max-height: 2.5rem;
		flex: 0 0 2.5rem;
	}

	:global(#twikoo-comments .tk-comment .tk-submit .tk-avatar),
	:global(#twikoo-comments .tk-replies .tk-avatar) {
		width: 1.6rem;
		height: 1.6rem;
		max-width: 1.6rem;
		max-height: 1.6rem;
		flex-basis: 1.6rem;
	}

	:global(#twikoo-comments .tk-avatar .tk-avatar-img),
	:global(#twikoo-comments .tk-avatar svg),
	:global(#twikoo-comments .tk-avatar img) {
		width: 100%;
		height: 100%;
		display: block;
		object-fit: cover;
	}
</style>
