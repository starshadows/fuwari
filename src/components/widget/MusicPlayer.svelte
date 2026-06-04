<script lang="ts">
import Icon from "@iconify/svelte";
import { onDestroy, onMount } from "svelte";

type Track = {
	id: number;
	title: string;
	artist: string;
	album: string;
	coverUrl: string;
	audioUrl: string;
};

type PlayMode = "shuffle" | "repeat-one" | "order";

type StoredPlayerState = {
	trackId: number;
	currentTime: number;
	volume: number;
	playMode: PlayMode;
	updatedAt: number;
};

const DEFAULT_VOLUME = 0.72;
const PLAYER_STORAGE_KEY = "fuwari:music-player:v1";
const PLAYER_STATE_SAVE_INTERVAL_MS = 1000;
const RESUME_END_BUFFER_SECONDS = 3;

const playModeOptions: Array<{ mode: PlayMode; icon: string; label: string }> =
	[
		{
			mode: "shuffle",
			icon: "material-symbols:shuffle-rounded",
			label: "随机播放",
		},
		{
			mode: "repeat-one",
			icon: "material-symbols:repeat-one-rounded",
			label: "单曲循环",
		},
		{
			mode: "order",
			icon: "material-symbols:format-list-numbered-rounded",
			label: "顺序播放",
		},
	];

let tracks: Track[] = [];
let activeIndex = 0;
let isLoading = true;
let isPlaying = false;
let currentTime = 0;
let duration = 0;
let error = "";
let audio: HTMLAudioElement;
let volume = DEFAULT_VOLUME;
let playMode: PlayMode = "order";
let isPlaylistOpen = false;
let hiddenCoverUrls = new Set<string>();
let scheduledTrackLoadId: number | undefined;
let scheduledTrackLoadType: "idle" | "timeout" | undefined;
let storedPlayerState: StoredPlayerState | null = null;
let pendingResumeTime: number | null = null;
let lastPlayerStateSaveAt = 0;

$: activeTrack = tracks[activeIndex];
$: progress = duration > 0 ? (currentTime / duration) * 100 : 0;
$: volumeProgress = Math.round(volume * 100);
$: activeCoverUrl =
	activeTrack?.coverUrl && !hiddenCoverUrls.has(activeTrack.coverUrl)
		? activeTrack.coverUrl
		: "";
$: currentPlayMode =
	playModeOptions.find((item) => item.mode === playMode) ?? playModeOptions[2];

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

const isPlayMode = (value: unknown): value is PlayMode =>
	value === "shuffle" || value === "repeat-one" || value === "order";

const readStoredPlayerState = (): StoredPlayerState | null => {
	try {
		const raw = localStorage.getItem(PLAYER_STORAGE_KEY);
		if (!raw) return null;

		const parsed = JSON.parse(raw) as Partial<StoredPlayerState>;
		if (
			typeof parsed.trackId !== "number" ||
			typeof parsed.currentTime !== "number" ||
			typeof parsed.volume !== "number" ||
			typeof parsed.updatedAt !== "number" ||
			!isPlayMode(parsed.playMode)
		) {
			return null;
		}

		return {
			trackId: parsed.trackId,
			currentTime: Math.max(0, parsed.currentTime),
			volume: clamp(parsed.volume, 0, 1),
			playMode: parsed.playMode,
			updatedAt: parsed.updatedAt,
		};
	} catch {
		return null;
	}
};

const savePlayerState = (force = false) => {
	const track = tracks[activeIndex];
	if (!track || !audio) return;

	const now = Date.now();
	if (!force && now - lastPlayerStateSaveAt < PLAYER_STATE_SAVE_INTERVAL_MS) {
		return;
	}

	const safeCurrentTime = Number.isFinite(audio.currentTime)
		? Math.max(0, audio.currentTime)
		: Math.max(0, currentTime);

	try {
		localStorage.setItem(
			PLAYER_STORAGE_KEY,
			JSON.stringify({
				trackId: track.id,
				currentTime: safeCurrentTime,
				volume,
				playMode,
				updatedAt: now,
			}),
		);
		lastPlayerStateSaveAt = now;
	} catch {
		// Ignore storage failures so playback controls keep working.
	}
};

const clampResumeTime = (value: number, durationValue: number) => {
	if (!Number.isFinite(value) || value <= 0) return 0;
	if (!Number.isFinite(durationValue) || durationValue <= 0) return value;

	const safeMax = Math.max(0, durationValue - RESUME_END_BUFFER_SECONDS);
	return clamp(value, 0, safeMax);
};

const queueResumeTime = (value: number) => {
	const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
	pendingResumeTime = safeValue > 0 ? safeValue : null;
	currentTime = safeValue;
};

const applyPendingResumeTime = () => {
	if (pendingResumeTime === null) return;

	const nextTime = clampResumeTime(pendingResumeTime, duration);
	pendingResumeTime = null;
	audio.currentTime = nextTime;
	currentTime = nextTime;
	savePlayerState(true);
};

const formatTime = (value: number) => {
	if (!Number.isFinite(value)) return "0:00";
	const minutes = Math.floor(value / 60);
	const seconds = Math.floor(value % 60)
		.toString()
		.padStart(2, "0");
	return `${minutes}:${seconds}`;
};

const loadTracks = async () => {
	isLoading = true;
	error = "";

	try {
		const response = await fetch("/api/music/tracks");
		const data = await response.json();
		if (!response.ok) throw new Error(data.error ?? "歌单加载失败。");
		tracks = data.tracks ?? [];
		if (tracks.length > 0) {
			const restoredIndex =
				storedPlayerState?.trackId !== undefined
					? tracks.findIndex((track) => track.id === storedPlayerState?.trackId)
					: -1;
			activeIndex = restoredIndex >= 0 ? restoredIndex : 0;
			duration = 0;
			queueResumeTime(
				restoredIndex >= 0 ? (storedPlayerState?.currentTime ?? 0) : 0,
			);
			audio.src = tracks[activeIndex].audioUrl;
			audio.load();
			if (restoredIndex < 0) savePlayerState(true);
		}
	} catch (err) {
		error = err instanceof Error ? err.message : "歌单加载失败。";
	} finally {
		isLoading = false;
	}
};

const play = async () => {
	if (!activeTrack) return;
	if (!audio.src) audio.src = activeTrack.audioUrl;

	try {
		await audio.play();
		isPlaying = true;
		savePlayerState(true);
	} catch {
		isPlaying = false;
		error = "浏览器暂时不允许播放，请再点一次。";
	}
};

const pause = () => {
	audio.pause();
	isPlaying = false;
	savePlayerState(true);
};

const togglePlay = () => {
	if (isPlaying) {
		pause();
		return;
	}
	play();
};

const nextIndex = (offset: number) => {
	if (tracks.length === 0) return activeIndex;
	if (playMode === "shuffle" && offset > 0 && tracks.length > 1) {
		let next = activeIndex;
		while (next === activeIndex) {
			next = Math.floor(Math.random() * tracks.length);
		}
		return next;
	}
	return (activeIndex + offset + tracks.length) % tracks.length;
};

const switchTrack = (offset: number, autoplay = isPlaying) => {
	if (tracks.length === 0) return;
	switchTrackTo(nextIndex(offset), autoplay);
};

const switchTrackTo = (index: number, autoplay = isPlaying) => {
	if (tracks.length === 0 || index < 0 || index >= tracks.length) return;
	activeIndex = index;
	pendingResumeTime = null;
	currentTime = 0;
	duration = 0;
	audio.src = tracks[activeIndex].audioUrl;
	audio.load();
	savePlayerState(true);
	if (autoplay) play();
};

const cyclePlayMode = () => {
	const index = playModeOptions.findIndex((item) => item.mode === playMode);
	playMode =
		playModeOptions[(index + 1) % playModeOptions.length]?.mode ?? "order";
	savePlayerState(true);
};

const seek = (event: Event) => {
	if (!duration) return;
	const input = event.currentTarget as HTMLInputElement;
	const nextTime = (Number(input.value) / 100) * duration;
	audio.currentTime = nextTime;
	currentTime = nextTime;
	savePlayerState(true);
};

const changeVolume = (event: Event) => {
	const input = event.currentTarget as HTMLInputElement;
	volume = clamp(Number(input.value) / 100, 0, 1);
	if (audio) audio.volume = volume;
	savePlayerState(true);
};

const hideCover = (url: string) => {
	hiddenCoverUrls = new Set([...hiddenCoverUrls, url]);
};

const scheduleTrackLoad = () => {
	if ("requestIdleCallback" in window) {
		scheduledTrackLoadType = "idle";
		scheduledTrackLoadId = window.requestIdleCallback(() => loadTracks(), {
			timeout: 1500,
		});
		return;
	}

	scheduledTrackLoadType = "timeout";
	scheduledTrackLoadId = window.setTimeout(() => loadTracks(), 600);
};

const cancelScheduledTrackLoad = () => {
	if (scheduledTrackLoadId === undefined) return;

	if (scheduledTrackLoadType === "idle" && "cancelIdleCallback" in window) {
		window.cancelIdleCallback(scheduledTrackLoadId);
	} else {
		window.clearTimeout(scheduledTrackLoadId);
	}

	scheduledTrackLoadId = undefined;
	scheduledTrackLoadType = undefined;
};

onMount(() => {
	storedPlayerState = readStoredPlayerState();
	if (storedPlayerState) {
		volume = storedPlayerState.volume;
		playMode = storedPlayerState.playMode;
	}

	audio = new Audio();
	audio.preload = "metadata";
	audio.volume = volume;

	const handleTimeUpdate = () => {
		currentTime = audio.currentTime;
		savePlayerState();
	};

	const handleLoadedMetadata = () => {
		duration = audio.duration;
		applyPendingResumeTime();
	};

	const handleEnded = () => {
		if (playMode === "repeat-one") {
			audio.currentTime = 0;
			currentTime = 0;
			savePlayerState(true);
			play();
			return;
		}
		switchTrack(1, true);
	};

	const handlePause = () => {
		isPlaying = false;
		savePlayerState(true);
	};

	const handlePlay = () => {
		isPlaying = true;
		savePlayerState(true);
	};

	const handleVisibilityChange = () => {
		if (document.visibilityState === "hidden") savePlayerState(true);
	};

	const handlePageHide = () => savePlayerState(true);

	audio.addEventListener("timeupdate", handleTimeUpdate);
	audio.addEventListener("loadedmetadata", handleLoadedMetadata);
	audio.addEventListener("ended", handleEnded);
	audio.addEventListener("pause", handlePause);
	audio.addEventListener("play", handlePlay);
	document.addEventListener("visibilitychange", handleVisibilityChange);
	window.addEventListener("pagehide", handlePageHide);
	window.addEventListener("beforeunload", handlePageHide);

	scheduleTrackLoad();

	return () => {
		audio.removeEventListener("timeupdate", handleTimeUpdate);
		audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
		audio.removeEventListener("ended", handleEnded);
		audio.removeEventListener("pause", handlePause);
		audio.removeEventListener("play", handlePlay);
		document.removeEventListener("visibilitychange", handleVisibilityChange);
		window.removeEventListener("pagehide", handlePageHide);
		window.removeEventListener("beforeunload", handlePageHide);
	};
});

onDestroy(() => {
	cancelScheduledTrackLoad();
	if (audio) {
		savePlayerState(true);
		audio.pause();
		audio.src = "";
	}
});
</script>

<div class="music-card card-base p-4">
	<div class="mb-3 flex items-center justify-between">
		<div class="relative pl-4 text-lg font-bold text-90 before:absolute before:left-0 before:top-[5.5px] before:h-4 before:w-1 before:rounded-md before:bg-[var(--primary)]">
			音乐
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
	{:else if !activeTrack}
		<div class="rounded-xl bg-[var(--btn-plain-bg-hover)] px-3 py-4 text-center text-sm text-50">
			暂无音乐
		</div>
	{:else}
		<div class="track-main">
			<div class="cover">
				{#if activeCoverUrl}
					<img
						src={activeCoverUrl}
						alt={activeTrack.title}
						class="h-full w-full object-cover"
							referrerpolicy="no-referrer"
						on:error={() => hideCover(activeCoverUrl)}
					/>
				{:else}
					<Icon icon="material-symbols:music-note-rounded" class="text-4xl" />
				{/if}
			</div>

			<div class="min-w-0 flex-1">
				<div class="truncate text-base font-black leading-tight text-90">{activeTrack.title}</div>
				<div class="mt-1 truncate text-sm font-bold text-40">{activeTrack.artist || "Starshadow"}</div>
				<div class="mt-1 text-xs font-bold text-30">{formatTime(currentTime)} / {formatTime(duration)}</div>
			</div>
		</div>

		<div class="mt-3 flex items-center gap-2">
			<Icon icon={volume === 0 ? "material-symbols:volume-off-rounded" : "material-symbols:volume-up-rounded"} class="shrink-0 text-xl text-30" />
			<input
				aria-label="音量"
				class="music-range volume-range"
				style={`--range-value: ${volumeProgress}%`}
				type="range"
				min="0"
				max="100"
				step="1"
				value={volumeProgress}
				on:input={changeVolume}
			/>
		</div>

		<input
			aria-label="播放进度"
			class="music-range progress-range mt-3 w-full"
			style={`--range-value: ${progress}%`}
			type="range"
			min="0"
			max="100"
			step="0.1"
			value={progress}
			on:input={seek}
		/>

		<div class="control-row mt-3">
			<button
				type="button"
				class="control-btn mode-btn"
				aria-label={currentPlayMode.label}
				title={currentPlayMode.label}
				on:click={cyclePlayMode}
			>
				<Icon icon={currentPlayMode.icon} />
			</button>
			<button type="button" class="control-btn" aria-label="上一首" on:click={() => switchTrack(-1)}>
				<Icon icon="material-symbols:skip-previous-rounded" />
			</button>
			<button type="button" class="play-btn" aria-label={isPlaying ? "暂停" : "播放"} on:click={togglePlay}>
				<Icon icon={isPlaying ? "material-symbols:pause-rounded" : "material-symbols:play-arrow-rounded"} />
			</button>
			<button type="button" class="control-btn" aria-label="下一首" on:click={() => switchTrack(1)}>
				<Icon icon="material-symbols:skip-next-rounded" />
			</button>
			<button
				type="button"
				class={`control-btn ${isPlaylistOpen ? "is-active" : ""}`}
				aria-label="歌曲列表"
				aria-expanded={isPlaylistOpen}
				on:click={() => (isPlaylistOpen = !isPlaylistOpen)}
			>
				<Icon icon="material-symbols:queue-music-rounded" />
			</button>
		</div>

		{#if isPlaylistOpen}
			<div class="playlist" data-music-playlist-scroll>
				{#each tracks as track, index}
					<button
						type="button"
						class={`playlist-item ${index === activeIndex ? "playlist-item-active" : ""}`}
						on:click={() => switchTrackTo(index, true)}
					>
						<div class="playlist-cover">
							{#if track.coverUrl && !hiddenCoverUrls.has(track.coverUrl)}
								<img
									src={track.coverUrl}
									alt={track.title}
									class="h-full w-full object-cover"
							referrerpolicy="no-referrer"
									on:error={() => hideCover(track.coverUrl)}
								/>
							{:else}
								<Icon icon="material-symbols:music-note-rounded" class="text-xl" />
							{/if}
						</div>
						<div class="min-w-0 flex-1 text-left">
							<div class="playlist-title">{track.title}</div>
							<div class="playlist-meta">{track.artist || "Starshadow"}</div>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.music-card {
		--range-value: 0%;
	}

	.track-main {
		display: flex;
		align-items: center;
		gap: 0.8rem;
	}

	.cover {
		display: flex;
		width: 4.25rem;
		height: 4.25rem;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border-radius: 0.9rem;
		background: var(--btn-regular-bg);
		color: var(--btn-content);
		box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 0.1);
	}

	.music-range {
		height: 0.34rem;
		cursor: pointer;
		appearance: none;
		border-radius: 999px;
		background: linear-gradient(
			to right,
			var(--primary) 0%,
			var(--primary) var(--range-value),
			var(--btn-regular-bg) var(--range-value),
			var(--btn-regular-bg) 100%
		);
	}

	.progress-range {
		display: block;
		height: 0.38rem;
	}

	.volume-range {
		width: min(6.5rem, 100%);
	}

	.music-range::-webkit-slider-thumb {
		width: 0.82rem;
		height: 0.82rem;
		appearance: none;
		border-radius: 999px;
		background: var(--primary);
	}

	.music-range::-moz-range-thumb {
		width: 0.82rem;
		height: 0.82rem;
		border: 0;
		border-radius: 999px;
		background: var(--primary);
	}

	.control-row {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		align-items: center;
		justify-items: center;
		gap: 0.25rem;
	}

	.control-btn,
	.play-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		transition: transform 150ms ease, color 150ms ease, background-color 150ms ease;
	}

	.control-btn {
		width: 2.25rem;
		height: 2.25rem;
		color: rgb(0 0 0 / 0.46);
		font-size: 1.7rem;
	}

	.mode-btn,
	.control-btn:hover,
	.control-btn.is-active {
		color: var(--primary);
		background: var(--btn-regular-bg);
	}

	.play-btn {
		width: 3.7rem;
		height: 3.7rem;
		background: var(--primary);
		color: var(--deep-text);
		font-size: 2.15rem;
		box-shadow: 0 0.65rem 1.5rem color-mix(in oklch, var(--primary), transparent 72%);
	}

	.control-btn:active,
	.play-btn:active {
		transform: scale(0.92);
	}

	.playlist {
		margin-top: 0.85rem;
		max-height: 17rem;
		overflow: auto;
		border-top: 1px solid rgb(0 0 0 / 0.06);
		padding-top: 0.7rem;
	}

	.playlist-item {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		min-height: 4rem;
		border-radius: 0.9rem;
		padding: 0.5rem 0.6rem;
		color: rgb(0 0 0 / 0.72);
		transition: background-color 150ms ease, color 150ms ease;
	}

	.playlist-item:hover,
	.playlist-item-active {
		background: var(--btn-regular-bg);
		color: var(--primary);
	}

	.playlist-cover {
		display: flex;
		width: 2.75rem;
		height: 2.75rem;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border-radius: 0.7rem;
		background: var(--btn-regular-bg);
		color: var(--btn-content);
	}

	.playlist-title {
		overflow: hidden;
		font-weight: 900;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.playlist-meta {
		margin-top: 0.28rem;
		overflow: hidden;
		color: rgb(0 0 0 / 0.4);
		font-size: 0.82rem;
		font-weight: 700;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.dark) .control-btn {
		color: rgb(255 255 255 / 0.58);
	}

	:global(.dark) .mode-btn,
	:global(.dark) .control-btn:hover,
	:global(.dark) .control-btn.is-active {
		color: var(--primary);
	}

	:global(.dark) .playlist {
		border-top-color: rgb(255 255 255 / 0.08);
	}

	:global(.dark) .playlist-item {
		color: rgb(255 255 255 / 0.76);
	}

	:global(.dark) .playlist-meta {
		color: rgb(255 255 255 / 0.42);
	}
</style>
