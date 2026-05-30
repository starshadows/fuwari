<script lang="ts">
import Icon from "@iconify/svelte";
import { onDestroy, onMount } from "svelte";

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
const MIN_HEARTBEAT_DELAY_MS = 60 * 1000;
const MAX_HEARTBEAT_DELAY_MS = 120 * 1000;

let stats: StatsSummary | null = null;
let isLoading = true;
let error = "";
let heartbeatTimer: number | undefined;
let lastTrackedPath = "";
let lastTrackedAt = 0;

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

const randomHeartbeatDelay = () =>
	MIN_HEARTBEAT_DELAY_MS +
	Math.floor(
		Math.random() * (MAX_HEARTBEAT_DELAY_MS - MIN_HEARTBEAT_DELAY_MS + 1),
	);

const statsPayload = (path: string) =>
	JSON.stringify({
		path,
		visitorId: getVisitorId(),
	});

const sendStatsPost = (
	endpoint: "visit" | "heartbeat",
	path = currentPath(),
) => {
	const url = `/api/stats/${endpoint}`;
	const body = statsPayload(path);

	try {
		if (navigator.sendBeacon) {
			const blob = new Blob([body], { type: "application/json" });
			if (navigator.sendBeacon(url, blob)) return;
		}
	} catch {
		// Ignore write failures; stats must never block navigation or rendering.
	}

	void fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		keepalive: true,
	}).catch(() => {
		// Ignore write failures; the next visit or heartbeat can recover.
	});
};

const loadStatsSummary = async (path = currentPath()) => {
	const response = await fetch(
		`/api/stats/summary?path=${encodeURIComponent(path)}`,
	);
	const data = await response.json();
	if (!response.ok) throw new Error(data.error ?? "统计加载失败。");
	if (path !== currentPath()) return;

	stats = data;
	error = "";
	isLoading = false;
};

const recordVisit = () => {
	const path = currentPath();
	const now = Date.now();
	if (path === lastTrackedPath && now - lastTrackedAt < 1500) return;

	lastTrackedPath = path;
	lastTrackedAt = now;
	sendStatsPost("visit", path);
	void loadStatsSummary(path).catch((err) => {
		error = err instanceof Error ? err.message : "统计加载失败。";
		isLoading = false;
	});
};

const clearHeartbeat = () => {
	if (heartbeatTimer) window.clearTimeout(heartbeatTimer);
	heartbeatTimer = undefined;
};

const scheduleHeartbeat = () => {
	clearHeartbeat();
	if (document.hidden) return;

	heartbeatTimer = window.setTimeout(() => {
		if (document.hidden) return;
		sendHeartbeat();
		scheduleHeartbeat();
	}, randomHeartbeatDelay());
};

const sendHeartbeat = () => {
	sendStatsPost("heartbeat");
	void loadStatsSummary().catch(() => {
		// Keep the last visible stats; the next page view or heartbeat can recover.
	});
};

const handleVisibilityChange = () => {
	if (document.hidden) {
		clearHeartbeat();
		return;
	}

	scheduleHeartbeat();
};

const setupSwupTracking = () => {
	const swup = (
		window as unknown as {
			swup?: { hooks?: { on?: (event: string, handler: () => void) => void } };
		}
	).swup;
	swup?.hooks?.on?.("page:view", () => {
		recordVisit();
	});
};

onMount(() => {
	window.setTimeout(recordVisit, 0);
	scheduleHeartbeat();
	document.addEventListener("visibilitychange", handleVisibilityChange);

	if ((window as unknown as { swup?: unknown }).swup) {
		setupSwupTracking();
	} else {
		document.addEventListener("swup:enable", setupSwupTracking, { once: true });
	}
});

onDestroy(() => {
	if (typeof window === "undefined" || typeof document === "undefined") return;
	clearHeartbeat();
	document.removeEventListener("visibilitychange", handleVisibilityChange);
});
</script>

<div class="visitor-card card-base p-4">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div class="relative pl-4 text-lg font-bold text-90 before:absolute before:left-0 before:top-[5.5px] before:h-4 before:w-1 before:rounded-md before:bg-[var(--primary)]">
			访客信息
		</div>
		<div class="flex items-center gap-1 text-xs font-bold text-30">
			<Icon icon="material-symbols:sync-rounded" class="text-base text-[var(--primary)]" />
			<span>已更新</span>
		</div>
	</div>

	{#if isLoading}
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
