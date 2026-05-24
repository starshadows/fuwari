<script lang="ts">
import Icon from "@iconify/svelte";
import { onDestroy, onMount } from "svelte";

type TrendItem = {
	day: string;
	pv: number;
	uv: number;
};

type StatsSummary = {
	site: {
		totalPv: number;
		todayPv: number;
		todayUv: number;
		totalUv: number;
		realtimeVisitors: number;
	};
	page: {
		path: string;
		totalPv: number;
		todayPv: number;
		todayUv: number;
		totalUv: number;
	};
	trend: TrendItem[];
};

const VISITOR_ID_KEY = "starshadow-visitor-id";
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

let stats: StatsSummary | null = null;
let isLoading = true;
let error = "";
let heartbeatTimer: number | undefined;
let lastTrackedPath = "";
let lastTrackedAt = 0;

$: maxTrendValue = Math.max(1, ...(stats?.trend ?? []).flatMap((item) => [item.pv, item.uv]));
$: statCards = stats
	? [
			{ label: "总访问", value: stats.site.totalPv },
			{ label: "今日访问", value: stats.site.todayPv },
			{ label: "总访客", value: stats.site.totalUv },
			{ label: "实时在线", value: stats.site.realtimeVisitors },
			{ label: "本页访问", value: stats.page.totalPv },
			{ label: "本页今日", value: stats.page.todayPv },
			{ label: "本页访客", value: stats.page.totalUv },
			{ label: "今日访客", value: stats.site.todayUv },
		]
	: [];

const numberFormatter = new Intl.NumberFormat("zh-CN", {
	notation: "compact",
	maximumFractionDigits: 1,
});

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

const sendStatsRequest = async (endpoint: "visit" | "heartbeat" | "summary") => {
	const path = currentPath();
	const init =
		endpoint === "summary"
			? undefined
			: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						path,
						visitorId: getVisitorId(),
					}),
				};
	const url =
		endpoint === "summary"
			? `/api/stats/summary?path=${encodeURIComponent(path)}`
			: `/api/stats/${endpoint}`;
	const response = await fetch(url, init);
	const data = await response.json();
	if (!response.ok) throw new Error(data.error ?? "统计加载失败。");
	stats = data;
	error = "";
	isLoading = false;
};

const recordVisit = async () => {
	const path = currentPath();
	const now = Date.now();
	if (path === lastTrackedPath && now - lastTrackedAt < 1500) return;

	lastTrackedPath = path;
	lastTrackedAt = now;
	try {
		await sendStatsRequest("visit");
	} catch (err) {
		error = err instanceof Error ? err.message : "统计加载失败。";
		isLoading = false;
	}
};

const sendHeartbeat = async () => {
	try {
		await sendStatsRequest("heartbeat");
	} catch {
		// Keep the last visible stats; the next heartbeat or page view can recover.
	}
};

const setupSwupTracking = () => {
	const swup = (window as unknown as {
		swup?: { hooks?: { on?: (event: string, handler: () => void) => void } };
	}).swup;
	swup?.hooks?.on?.("page:view", recordVisit);
};

onMount(() => {
	recordVisit();
	heartbeatTimer = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

	if ((window as unknown as { swup?: unknown }).swup) {
		setupSwupTracking();
	} else {
		document.addEventListener("swup:enable", setupSwupTracking, { once: true });
	}
});

onDestroy(() => {
	if (heartbeatTimer) window.clearInterval(heartbeatTimer);
});
</script>

<div class="card-base p-4">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div class="relative pl-4 text-lg font-bold text-90 before:absolute before:left-0 before:top-[5.5px] before:h-4 before:w-1 before:rounded-md before:bg-[var(--primary)]">
			访客统计
		</div>
		<Icon icon="material-symbols:bar-chart-rounded" class="text-2xl text-[var(--primary)]" />
	</div>

	{#if isLoading}
		<div class="rounded-xl bg-[var(--btn-regular-bg)] px-3 py-4 text-center text-sm font-bold text-50">
			加载中...
		</div>
	{:else if error}
		<div class="rounded-xl bg-[var(--btn-regular-bg)] px-3 py-4 text-center text-sm font-bold text-50">
			{error}
		</div>
	{:else if stats}
		<div class="stats-grid">
			{#each statCards as card}
				<div class="stat-card">
					<div class="stat-value">{formatNumber(card.value)}</div>
					<div class="stat-label">{card.label}</div>
				</div>
			{/each}
		</div>

		<div class="trend-card mt-4">
			<div class="mb-2 flex items-center justify-between text-sm font-bold text-40">
				<span>近 7 日趋势</span>
				<span>访问 / 访客</span>
			</div>
			<div class="trend-bars" aria-label="近 7 日访问趋势">
				{#each stats.trend as item}
					<div class="trend-item" title={`${item.day}: ${item.pv} 访问 / ${item.uv} 访客`}>
						<div class="trend-stack">
							<div
								class="trend-bar trend-bar-uv"
								style={`height: ${Math.max(8, (item.uv / maxTrendValue) * 100)}%`}
							></div>
							<div
								class="trend-bar trend-bar-pv"
								style={`height: ${Math.max(10, (item.pv / maxTrendValue) * 100)}%`}
							></div>
						</div>
						<div class="trend-day">{item.day.slice(5).replace("-", "/")}</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.stats-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.65rem;
	}

	.stat-card {
		min-width: 0;
		min-height: 5.25rem;
		border-radius: 1rem;
		background: var(--btn-regular-bg);
		padding: 0.85rem 0.95rem;
	}

	.stat-value {
		color: var(--primary);
		font-size: 1.65rem;
		font-weight: 900;
		line-height: 1;
		overflow-wrap: anywhere;
	}

	.stat-label {
		margin-top: 0.85rem;
		color: rgb(0 0 0 / 0.5);
		font-size: 0.95rem;
		font-weight: 800;
		line-height: 1.2;
	}

	.trend-card {
		border-radius: 1rem;
		background: var(--btn-regular-bg);
		padding: 0.85rem 0.95rem;
	}

	.trend-bars {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		align-items: end;
		gap: 0.42rem;
		height: 5.15rem;
	}

	.trend-item {
		display: flex;
		min-width: 0;
		height: 100%;
		flex-direction: column;
		justify-content: end;
		gap: 0.35rem;
	}

	.trend-stack {
		position: relative;
		height: 3.8rem;
	}

	.trend-bar {
		position: absolute;
		bottom: 0;
		width: calc(50% - 0.05rem);
		min-height: 0.45rem;
		border-radius: 999px 999px 0.35rem 0.35rem;
	}

	.trend-bar-pv {
		left: 0;
		background: var(--primary);
		opacity: 0.72;
	}

	.trend-bar-uv {
		right: 0;
		background: var(--primary);
		opacity: 0.38;
	}

	.trend-day {
		overflow: hidden;
		color: rgb(0 0 0 / 0.42);
		font-size: 0.66rem;
		font-weight: 800;
		text-align: center;
		white-space: nowrap;
	}

	:global(.dark) .stat-label,
	:global(.dark) .trend-day {
		color: rgb(255 255 255 / 0.46);
	}
</style>
