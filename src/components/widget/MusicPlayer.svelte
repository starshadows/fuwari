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

let tracks: Track[] = [];
let activeIndex = 0;
let isLoading = true;
let isPlaying = false;
let currentTime = 0;
let duration = 0;
let error = "";
let audio: HTMLAudioElement;
let volume = 0.72;
let isLooping = false;
let isPlaylistOpen = false;
let hiddenCoverUrls = new Set<string>();

$: activeTrack = tracks[activeIndex];
$: progress = duration > 0 ? (currentTime / duration) * 100 : 0;
$: volumeProgress = Math.round(volume * 100);
$: activeCoverUrl = activeTrack?.coverUrl && !hiddenCoverUrls.has(activeTrack.coverUrl)
	? activeTrack.coverUrl
	: "";

const formatTime = (value: number) => {
	if (!Number.isFinite(value)) return "0:00";
	const minutes = Math.floor(value / 60);
	const seconds = Math.floor(value % 60).toString().padStart(2, "0");
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
			audio.src = tracks[0].audioUrl;
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
	} catch {
		isPlaying = false;
		error = "浏览器暂时不允许播放，请再点一次。";
	}
};

const pause = () => {
	audio.pause();
	isPlaying = false;
};

const togglePlay = () => {
	if (isPlaying) {
		pause();
		return;
	}
	play();
};

const toggleLoop = () => {
	isLooping = !isLooping;
	if (audio) audio.loop = isLooping;
};

const switchTrack = (offset: number, autoplay = isPlaying) => {
	if (tracks.length === 0) return;
	switchTrackTo((activeIndex + offset + tracks.length) % tracks.length, autoplay);
};

const switchTrackTo = (index: number, autoplay = isPlaying) => {
	if (tracks.length === 0 || index < 0 || index >= tracks.length) return;
	activeIndex = index;
	currentTime = 0;
	duration = 0;
	audio.src = tracks[activeIndex].audioUrl;
	audio.load();
	if (autoplay) play();
};

const seek = (event: Event) => {
	if (!duration) return;
	const input = event.currentTarget as HTMLInputElement;
	const nextTime = (Number(input.value) / 100) * duration;
	audio.currentTime = nextTime;
	currentTime = nextTime;
};

const changeVolume = (event: Event) => {
	const input = event.currentTarget as HTMLInputElement;
	volume = Number(input.value) / 100;
	if (audio) audio.volume = volume;
};

const hideCover = (url: string) => {
	hiddenCoverUrls = new Set([...hiddenCoverUrls, url]);
};

onMount(() => {
	audio = new Audio();
	audio.preload = "metadata";
	audio.volume = volume;
	audio.loop = isLooping;
	audio.addEventListener("timeupdate", () => {
		currentTime = audio.currentTime;
	});
	audio.addEventListener("loadedmetadata", () => {
		duration = audio.duration;
	});
	audio.addEventListener("ended", () => {
		switchTrack(1, true);
	});
	audio.addEventListener("pause", () => {
		isPlaying = false;
	});
	audio.addEventListener("play", () => {
		isPlaying = true;
	});

	loadTracks();
});

onDestroy(() => {
	if (audio) {
		audio.pause();
		audio.src = "";
	}
});
</script>

<div class="music-card card-base p-4">
	<div class="mb-4 flex items-center justify-between">
		<div class="relative pl-4 text-lg font-bold text-90 before:absolute before:left-0 before:top-[5.5px] before:h-4 before:w-1 before:rounded-md before:bg-[var(--primary)]">
			音乐
		</div>
	</div>

	{#if isLoading}
		<div class="rounded-xl bg-[var(--btn-regular-bg)] px-3 py-4 text-center text-sm font-bold text-50">
			加载中...
		</div>
	{:else if error}
		<div class="rounded-xl bg-[var(--btn-regular-bg)] px-3 py-4 text-center text-sm font-bold text-50">
			{error}
		</div>
	{:else if !activeTrack}
		<div class="rounded-xl bg-[var(--btn-regular-bg)] px-3 py-4 text-center text-sm font-bold text-50">
			暂无音乐
		</div>
	{:else}
		<div class="track-row">
			<div class="cover">
				{#if activeCoverUrl}
					<img
						src={activeCoverUrl}
						alt={activeTrack.title}
						class="h-full w-full object-cover"
						on:error={() => hideCover(activeCoverUrl)}
					/>
				{:else}
					<Icon icon="material-symbols:music-note-rounded" class="text-4xl" />
				{/if}
			</div>

			<div class="min-w-0 flex-1">
				<div class="truncate text-xl font-black leading-tight text-90">{activeTrack.title}</div>
				<div class="mt-1 truncate text-sm font-bold text-50">{activeTrack.artist || "Starshadow"}</div>
				<div class="mt-1 text-xs font-bold text-40">{formatTime(currentTime)} / {formatTime(duration)}</div>
			</div>

			<div class="volume-group">
				<Icon icon={volume === 0 ? "material-symbols:volume-off-rounded" : "material-symbols:volume-up-rounded"} class="text-2xl text-40" />
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
		</div>

		<input
			aria-label="播放进度"
			class="music-range progress-range mt-4 w-full"
			style={`--range-value: ${progress}%`}
			type="range"
			min="0"
			max="100"
			step="0.1"
			value={progress}
			on:input={seek}
		/>

		<div class="control-row mt-4">
			<button
				type="button"
				class={`control-btn ${isLooping ? "is-active" : "is-muted"}`}
				aria-label={isLooping ? "关闭单曲循环" : "单曲循环"}
				on:click={toggleLoop}
			>
				<Icon icon="material-symbols:repeat-rounded" />
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
			<div class="playlist">
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
		--music-accent: var(--primary);
	}

	.track-row {
		display: grid;
		grid-template-columns: 4.5rem minmax(0, 1fr);
		gap: 0.85rem;
		align-items: center;
	}

	.cover {
		display: flex;
		width: 4.5rem;
		height: 4.5rem;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border-radius: 999px;
		background: var(--btn-regular-bg);
		color: var(--btn-content);
		box-shadow: 0 0.6rem 1.6rem rgb(0 0 0 / 0.12);
	}

	.volume-group {
		grid-column: 2;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.music-range {
		height: 0.42rem;
		cursor: pointer;
		appearance: none;
		border-radius: 999px;
		background: linear-gradient(
			to right,
			var(--music-accent) 0%,
			var(--music-accent) var(--range-value),
			var(--btn-regular-bg) var(--range-value),
			var(--btn-regular-bg) 100%
		);
	}

	.progress-range {
		display: block;
		height: 0.45rem;
	}

	.volume-range {
		width: min(6.2rem, 100%);
	}

	.music-range::-webkit-slider-thumb {
		width: 0;
		height: 0;
		appearance: none;
	}

	.music-range::-moz-range-thumb {
		width: 0;
		height: 0;
		border: 0;
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
		width: 2.35rem;
		height: 2.35rem;
		color: rgb(0 0 0 / 0.58);
		font-size: 1.75rem;
	}

	.control-btn:hover,
	.control-btn.is-active {
		color: var(--music-accent);
		background: var(--btn-regular-bg);
	}

	.control-btn.is-muted {
		color: rgb(0 0 0 / 0.22);
	}

	.play-btn {
		width: 4.3rem;
		height: 4.3rem;
		background: var(--music-accent);
		color: var(--deep-text);
		font-size: 2.45rem;
		box-shadow: 0 0.75rem 1.8rem color-mix(in oklch, var(--music-accent), transparent 65%);
	}

	.control-btn:active,
	.play-btn:active {
		transform: scale(0.92);
	}

	.playlist {
		margin-top: 1rem;
		max-height: 18rem;
		overflow: auto;
		border-top: 1px solid rgb(0 0 0 / 0.06);
		padding-top: 0.75rem;
	}

	.playlist-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		min-height: 4.15rem;
		border-radius: 0.9rem;
		padding: 0.5rem 0.65rem;
		color: rgb(0 0 0 / 0.72);
		transition: background-color 150ms ease, color 150ms ease;
	}

	.playlist-item:hover,
	.playlist-item-active {
		background: var(--btn-regular-bg);
		color: var(--music-accent);
	}

	.playlist-cover {
		display: flex;
		width: 2.9rem;
		height: 2.9rem;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border-radius: 0.7rem;
		background: var(--btn-regular-bg);
		color: var(--btn-content);
	}

	.playlist-title {
		font-weight: 900;
		line-height: 1.25;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.playlist-meta {
		margin-top: 0.35rem;
		color: rgb(0 0 0 / 0.42);
		font-size: 0.86rem;
		font-weight: 700;
		line-height: 1.2;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.dark) .control-btn {
		color: rgb(255 255 255 / 0.6);
	}

	:global(.dark) .control-btn.is-muted {
		color: rgb(255 255 255 / 0.24);
	}

	:global(.dark) .control-btn:hover,
	:global(.dark) .control-btn.is-active {
		color: var(--music-accent);
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
