<script lang="ts">
import Icon from "@iconify/svelte";
import { onMount } from "svelte";

type StatsSummary = {
	site: {
		totalPv: number;
		todayPv: number;
		todayUv: number;
		totalUv: number;
		realtimeVisitors: number;
		yesterdayPv?: number;
		monthPv?: number;
	};
	page: {
		path: string;
		totalPv: number;
		todayPv: number;
		todayUv: number;
		totalUv: number;
	};
};

const VISITOR_ID_KEY = "starshadow-visitor-id";
const STATS_API_BASE = import.meta.env.PROD ? "https://api.starshadow.cc" : "";

let stats: StatsSummary | null = null;
let isLoading = true;
let isRefreshing = false;
let error = "";

$: statCards = stats
	? [
			{
				label: "当前在线",
				value: stats.site.realtimeVisitors,
				icon: "material-symbols:person-check-rounded",
			},
			{
				label: "今日访客",
				value: stats.site.todayUv,
				icon: "material-symbols:group-rounded",
			},
			{
				label: "今日浏览",
				value: stats.site.todayPv,
				icon: "material-symbols:visibility-rounded",
			},
			{
				label: "昨日浏览",
				value: stats.site.yesterdayPv ?? 0,
				icon: "material-symbols:history-rounded",
			},
			{
				label: "本月浏览",
				value: stats.site.monthPv ?? stats.site.totalPv,
				icon: "material-symbols:calendar-month-rounded",
			},
			{
				label: "总浏览",
				value: stats.site.totalPv,
				icon: "material-symbols:bar-chart-rounded",
			},
		]
	: [];

const numberFormatter = new Intl.NumberFormat("zh-CN");

const formatNumber = (value: number) => numberFormatter.format(value || 0);

const getVisitorId = () => {
	try {
		let id = localStorage.getItem(VISITOR_ID_KEY);
		if (id) return id;

		id = crypto.randomUUID();
		localStorage.setItem(VISITOR_ID_KEY, id);
		return id;
	} catch {
		return crypto.randomUUID();
	}
};

const currentPath = () => window.location.pathname || "/";

const statsApiUrl = (path: string) => `${STATS_API_BASE}${path}`;

const statsPayload = (path: string) =>
	JSON.stringify({
		path,
		visitorId: getVisitorId(),
	});

const applyStatsSummary = (data: StatsSummary, path = currentPath()) => {
	if (path !== currentPath()) return;
	stats = data;
	error = "";
};

const sendStatsVisit = async (path = currentPath()): Promise<StatsSummary> => {
	const url = statsApiUrl("/api/stats/visit");
	const body = statsPayload(path);
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "text/plain" },
		body,
		cache: "no-store",
		credentials: "omit",
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error ?? "统计加载失败。");
	return data;
};

const loadStatsSummary = async (
	path = currentPath(),
): Promise<StatsSummary> => {
	const response = await fetch(
		statsApiUrl(
			`/api/stats/summary?path=${encodeURIComponent(path)}&_=${Date.now()}`,
		),
		{
			cache: "no-store",
			credentials: "omit",
		},
	);
	const data = await response.json();
	if (!response.ok) throw new Error(data.error ?? "统计加载失败。");
	return data;
};

const loadInitialStats = async () => {
	const path = currentPath();
	isLoading = true;
	error = "";
	try {
		applyStatsSummary(await sendStatsVisit(path), path);
	} catch (err) {
		error = err instanceof Error ? err.message : "统计加载失败。";
	} finally {
		isLoading = false;
	}
};

const updateStats = async () => {
	if (isLoading || isRefreshing) return;
	isRefreshing = true;
	error = "";
	const path = currentPath();
	try {
		applyStatsSummary(await loadStatsSummary(path), path);
	} catch (err) {
		error = err instanceof Error ? err.message : "统计加载失败。";
	} finally {
		isRefreshing = false;
	}
};

onMount(() => {
	void loadInitialStats();
});
</script>

<div class="visitor-card card-base p-4">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div class="relative pl-4 text-lg font-bold text-90 before:absolute before:left-0 before:top-[5.5px] before:h-4 before:w-1 before:rounded-md before:bg-[var(--primary)]">
			访客信息
		</div>
		<button
			type="button"
			class="btn-plain flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-bold text-[var(--primary)] active:scale-95 disabled:pointer-events-none disabled:opacity-60"
			disabled={isLoading || isRefreshing}
			on:click={updateStats}
		>
			<Icon icon="material-symbols:sync-rounded" class="text-base" />
			<span>{isRefreshing ? "更新中" : "更新"}</span>
		</button>
	</div>

	{#if isLoading && !stats}
		<div class="rounded-xl bg-[var(--btn-plain-bg-hover)] px-3 py-4 text-center text-sm text-50">
			加载中...
		</div>
	{:else if error}
		<div class="rounded-xl bg-[var(--btn-plain-bg-hover)] px-3 py-4 text-center text-sm text-50">
			{error}
		</div>
	{:else if stats}
		<div class="stats-grid">
			{#each statCards as card}
				<div class="stat-cell">
					<div class="stat-label-row">
						<Icon icon={card.icon} class="text-base text-[var(--primary)]" />
						<span>{card.label}</span>
					</div>
					<div class="stat-value">{formatNumber(card.value)}</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="rounded-xl bg-[var(--btn-plain-bg-hover)] px-3 py-4 text-center text-sm text-50">
			暂无数据
		</div>
	{/if}
</div>

<style>
	.stats-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.7rem;
	}

	.stat-cell {
		min-width: 0;
		border-radius: 0.85rem;
		background: var(--btn-plain-bg-hover);
		padding: 0.72rem 0.78rem;
	}

	.stat-label-row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		color: rgb(0 0 0 / 0.46);
		font-size: 0.78rem;
		font-weight: 800;
		line-height: 1.2;
		white-space: nowrap;
	}

	.stat-value {
		margin-top: 0.55rem;
		color: rgb(0 0 0 / 0.84);
		font-size: 1.22rem;
		font-weight: 900;
		line-height: 1.05;
		overflow-wrap: anywhere;
	}

	:global(.dark) .stat-label-row {
		color: rgb(255 255 255 / 0.48);
	}

	:global(.dark) .stat-value {
		color: rgb(255 255 255 / 0.82);
	}
</style>
