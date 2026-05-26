<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";

type Friend = {
	id: number;
	name: string;
	description: string;
	url: string;
	avatarUrl: string;
};

type TurnstileConfig = {
	enabled?: boolean;
	siteKey?: string;
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

let friends: Friend[] = [];
let isLoading = true;
let isSubmitting = false;
let message = "";
let error = "";
let brokenAvatarUrls = new Set<string>();
export let showList = true;
export let showForm = true;

let form = {
	name: "",
	description: "",
	url: "",
	avatarUrl: "",
};

let turnstileContainer: HTMLDivElement;
let turnstileEnabled = false;
let turnstileToken = "";
let turnstileWidgetId = "";
let turnstileMessage = "正在加载人机验证...";

$: canSubmit = !isSubmitting && turnstileEnabled && Boolean(turnstileToken);

const loadFriends = async () => {
	if (!showList) {
		isLoading = false;
		return;
	}

	isLoading = true;
	error = "";

	try {
		const response = await fetch("/api/friends");
		const data = await response.json();
		if (!response.ok) throw new Error(data.error ?? "友链加载失败。");
		friends = data.friends ?? [];
	} catch (err) {
		error = err instanceof Error ? err.message : "友链加载失败。";
	} finally {
		isLoading = false;
	}
};

const waitForTurnstile = async () => {
	if (window.turnstile) return;

	const startedAt = Date.now();
	while (!window.turnstile) {
		if (Date.now() - startedAt > 8000) {
			throw new Error("人机验证脚本加载超时。");
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
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

	await waitForTurnstile();
};

const setupTurnstile = async () => {
	if (!showForm) return;

	try {
		const response = await fetch("/api/turnstile/config");
		const config = (await response.json()) as TurnstileConfig;

		if (!response.ok || !config.enabled || !config.siteKey) {
			turnstileEnabled = false;
			turnstileMessage = "人机验证尚未配置，暂时无法提交友链申请。";
			return;
		}

		turnstileEnabled = true;
		turnstileMessage = "请完成人机验证。";

		await loadTurnstileScript();
		await tick();

		if (!turnstileContainer || !window.turnstile) {
			throw new Error("人机验证容器不可用。");
		}

		turnstileWidgetId = window.turnstile.render(turnstileContainer, {
			sitekey: config.siteKey,
			theme: "auto",
			callback: (token: string) => {
				turnstileToken = token;
				turnstileMessage = "";
			},
			"expired-callback": () => {
				turnstileToken = "";
				turnstileMessage = "人机验证已过期，请重新验证。";
			},
			"error-callback": () => {
				turnstileToken = "";
				turnstileMessage = "人机验证加载失败，请刷新后重试。";
			},
		});
	} catch (err) {
		turnstileEnabled = false;
		turnstileToken = "";
		turnstileMessage = err instanceof Error ? err.message : "人机验证加载失败。";
	}
};

const resetTurnstile = () => {
	turnstileToken = "";
	if (turnstileWidgetId && window.turnstile) {
		window.turnstile.reset(turnstileWidgetId);
		turnstileMessage = "请完成人机验证。";
	}
};

const submit = async () => {
	if (!canSubmit) {
		error = "请先完成人机验证。";
		return;
	}

	isSubmitting = true;
	message = "";
	error = "";

	try {
		const response = await fetch("/api/friends", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...form, turnstileToken }),
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.error ?? "提交失败。");

		message = data.message ?? "申请已提交。";
		form = { name: "", description: "", url: "", avatarUrl: "" };
	} catch (err) {
		error = err instanceof Error ? err.message : "提交失败。";
	} finally {
		isSubmitting = false;
		resetTurnstile();
	}
};

const markBrokenAvatar = (url: string) => {
	brokenAvatarUrls = new Set([...brokenAvatarUrls, url]);
};

onMount(() => {
	void loadFriends();
	void setupTurnstile();
});

onDestroy(() => {
	if (typeof window === "undefined") return;
	if (turnstileWidgetId && window.turnstile) {
		window.turnstile.remove(turnstileWidgetId);
	}
});
</script>

{#if showList}
<div class="card-base px-6 py-6 md:px-8">
	<div class="relative mb-5 pl-4 text-2xl font-bold text-90 before:absolute before:left-0 before:top-2 before:h-5 before:w-1 before:rounded-md before:bg-[var(--primary)]">
		友链
	</div>

	{#if isLoading}
		<div class="text-50">加载中...</div>
	{:else if friends.length === 0}
		<div class="rounded-xl bg-[var(--btn-plain-bg-hover)] px-4 py-5 text-center text-50">
			这里还没有展示中的友链。
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
			{#each friends as friend}
				<a
					href={friend.url}
					target="_blank"
					rel="noopener noreferrer"
					class="group flex min-h-24 gap-4 rounded-xl bg-[var(--btn-plain-bg-hover)] p-4 transition hover:bg-[var(--btn-regular-bg-hover)] active:scale-[0.99]"
				>
					<div class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--btn-regular-bg)] text-xl font-bold text-[var(--btn-content)]">
						{#if friend.avatarUrl && !brokenAvatarUrls.has(friend.avatarUrl)}
							<img
								src={friend.avatarUrl}
								alt={friend.name}
								class="h-full w-full shrink-0 object-cover"
								on:error={() => markBrokenAvatar(friend.avatarUrl)}
							/>
						{:else}
							<span>{friend.name.slice(0, 1)}</span>
						{/if}
					</div>
					<div class="min-w-0">
						<div class="mb-1 truncate font-bold text-90 group-hover:text-[var(--primary)]">
							{friend.name}
						</div>
						<div class="line-clamp-2 text-sm text-50">{friend.description}</div>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>
{/if}

{#if showForm}
<form class="card-base mt-4 px-6 py-6 md:px-8" on:submit|preventDefault={submit}>
	<div class="relative mb-5 pl-4 text-2xl font-bold text-90 before:absolute before:left-0 before:top-2 before:h-5 before:w-1 before:rounded-md before:bg-[var(--primary)]">
		申请友链
	</div>

	<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
		<label class="flex flex-col gap-2 text-sm font-bold text-75">
			名称
			<input
				bind:value={form.name}
				maxlength="40"
				required
				class="h-11 rounded-xl bg-[var(--btn-plain-bg-hover)] px-4 font-normal text-75 outline-none transition focus:bg-[var(--btn-regular-bg)]"
			/>
		</label>
		<label class="flex flex-col gap-2 text-sm font-bold text-75">
			链接
			<input
				bind:value={form.url}
				type="url"
				pattern="https://.*"
				required
				placeholder="https://example.com"
				class="h-11 rounded-xl bg-[var(--btn-plain-bg-hover)] px-4 font-normal text-75 outline-none transition focus:bg-[var(--btn-regular-bg)]"
			/>
		</label>
		<label class="flex flex-col gap-2 text-sm font-bold text-75 md:col-span-2">
			头像
			<input
				bind:value={form.avatarUrl}
				type="url"
				pattern="https://.*"
				required
				placeholder="https://example.com/avatar.jpg"
				class="h-11 rounded-xl bg-[var(--btn-plain-bg-hover)] px-4 font-normal text-75 outline-none transition focus:bg-[var(--btn-regular-bg)]"
			/>
		</label>
		<label class="flex flex-col gap-2 text-sm font-bold text-75 md:col-span-2">
			简介
			<textarea
				bind:value={form.description}
				maxlength="120"
				required
				rows="3"
				class="resize-none rounded-xl bg-[var(--btn-plain-bg-hover)] px-4 py-3 font-normal text-75 outline-none transition focus:bg-[var(--btn-regular-bg)]"
			></textarea>
		</label>
	</div>

	<div class="mt-4 rounded-xl bg-[var(--btn-plain-bg-hover)] px-4 py-3">
		{#if turnstileEnabled}
			<div bind:this={turnstileContainer} class="min-h-[65px]"></div>
		{/if}
		{#if turnstileMessage}
			<div class="text-sm font-bold text-50">{turnstileMessage}</div>
		{/if}
	</div>

	<div class="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
		<div class="min-h-5 text-sm">
			{#if message}
				<span class="text-[var(--primary)]">{message}</span>
			{:else if error}
				<span class="text-red-500">{error}</span>
			{/if}
		</div>
		<button
			type="submit"
			disabled={!canSubmit}
			class="btn-regular h-11 rounded-xl px-5 font-bold active:scale-95 disabled:pointer-events-none disabled:opacity-50"
		>
			{isSubmitting ? "提交中..." : "提交申请"}
		</button>
	</div>
</form>
{/if}
