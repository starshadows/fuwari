<script lang="ts">
import HumanProof from "@components/anti-abuse/HumanProof.svelte";
import { onDestroy, onMount, tick } from "svelte";
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

export let adminMode = false;
export let adminToken = "";
export let embedded = false;

const publicTwikooEndpoint = "/api/twikoo";
const adminTwikooEndpoint = "/api/admin/twikoo";
const twikooHostSelector = "#twikoo-comments";
const twikooMountSelector = "#twikoo-comments-mount";
let restoreFetchBridge: (() => void) | null = null;

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
	installAdminFetchBridge();
	const module = (await import("twikoo")) as TwikooModule;
	const twikoo = resolveTwikooClient(module);

	isTwikooLoaded = true;
	await tick();

	await twikoo.init({
		envId: new URL(
			adminMode ? adminTwikooEndpoint : publicTwikooEndpoint,
			window.location.origin,
		).href,
		el: twikooMountSelector,
		path: window.location.pathname,
		lang: "zh-CN",
	});

	if (adminMode) {
		revealTwikooAdmin();
	}

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

type TwikooVueRoot = {
	showAdmin?: boolean;
	showAdminEntry?: boolean;
	onShowAdminEntry?: (value: boolean) => void;
	$children?: TwikooVueRoot[];
	$forceUpdate?: () => void;
	$nextTick?: (callback: () => void) => void;
};

const revealTwikooAdmin = (attempt = 0) => {
	const host = document.querySelector(twikooHostSelector);
	const root = (host?.querySelector("#twikoo") ??
		document.querySelector("#twikoo")) as
		| (Element & { __vue__?: TwikooVueRoot })
		| null;
	const vueApp = root?.__vue__ ?? root?.firstElementChild?.__vue__;
	const vueRoot = vueApp?.$children?.[0] ?? vueApp;

	if (vueRoot) {
		vueRoot.onShowAdminEntry?.(true);
		vueRoot.showAdminEntry = true;
		vueRoot.showAdmin = true;
		vueRoot.$forceUpdate?.();
		vueRoot.$nextTick?.(() => {
			vueRoot.showAdmin = true;
			vueRoot.$forceUpdate?.();
		});
		return;
	}

	if (attempt < 20) {
		window.setTimeout(() => revealTwikooAdmin(attempt + 1), 150);
	}
};

const installAdminFetchBridge = () => {
	if (!adminMode || !adminToken || restoreFetchBridge) return;

	const originalFetch = window.fetch.bind(window);
	const adminPath = new URL(adminTwikooEndpoint, window.location.origin)
		.pathname;

	window.fetch = (input, init) => {
		const rawUrl =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const url = new URL(rawUrl, window.location.origin);

		if (url.pathname !== adminPath) {
			return originalFetch(input, init);
		}

		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		headers.set("x-fuwari-admin-token", adminToken);

		if (input instanceof Request) {
			return originalFetch(new Request(input, { ...init, headers }));
		}
		return originalFetch(input, { ...init, headers });
	};

	restoreFetchBridge = () => {
		window.fetch = originalFetch;
		restoreFetchBridge = null;
	};
};

// 先加载 Twikoo 展示已有评论区，再决定是否展示验证
const initComments = async () => {
	await loadConfig();
	if (!enabled && !adminMode) return;

	// 先加载 Twikoo 展示评论列表（不验证）
	await loadTwikoo();

	if (adminMode) return;

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

onDestroy(() => {
	restoreFetchBridge?.();
});
</script>

<section
	class={`${embedded ? "" : "mt-8 border-t border-[var(--line-divider)] pt-6"} ${adminMode ? "twikoo-admin-mode" : "twikoo-public-mode"}`}
>
	{#if !embedded}
		<div class="relative mb-5 pl-4 text-2xl font-bold text-90 before:absolute before:left-0 before:top-2 before:h-5 before:w-1 before:rounded-md before:bg-[var(--primary)]">
			评论
		</div>
	{/if}

	{#if isLoadingConfig}
		<div class="text-50">加载中...</div>
	{:else if !enabled && !adminMode}
		<div class="rounded-xl bg-[var(--btn-plain-bg-hover)] px-4 py-5 text-center text-50">
			评论区已关闭。
		</div>
	{:else}
		<!-- 评论区容器 — 始终展示 Twikoo 已有评论列表 -->
		<div id="twikoo-comments">
			<div id="twikoo-comments-mount"></div>
		</div>

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

	:global(.twikoo-public-mode .tk-admin-container),
	:global(.twikoo-public-mode .tk-icon.__comments + .tk-icon.__comments) {
		display: none !important;
	}
</style>
