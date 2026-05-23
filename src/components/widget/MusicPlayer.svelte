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
let isPlaylistOpen = false;
let hiddenCoverUrls = new Set<string>();

$: activeTrack = tracks[activeIndex];
$: progress = duration > 0 ? (currentTime / duration) * 100 : 0;
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

<div class="card-base p-4">
    <div class="mb-3 flex items-center justify-between">
        <div class="relative pl-4 text-lg font-bold text-90 before:absolute before:left-0 before:top-[5.5px] before:h-4 before:w-1 before:rounded-md before:bg-[var(--primary)]">
            音乐
        </div>
        <div class="text-xs font-bold text-30">{tracks.length} 首</div>
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
        <div class="flex gap-3">
            <div class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--btn-regular-bg)] text-[var(--btn-content)]">
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
                <div class="truncate font-bold text-75">{activeTrack.title}</div>
                <div class="truncate text-sm text-30">{activeTrack.artist || "Starshadow"}</div>
                <input
                    aria-label="播放进度"
                    class="music-range mt-3 w-full"
                    type="range"
                    min="0"
                    max="100"
                    step="0.1"
                    value={progress}
                    on:input={seek}
                />
                <div class="mt-2 text-xs font-medium text-30">{formatTime(currentTime)} / {formatTime(duration)}</div>
            </div>
        </div>

        <div class="mt-3 flex items-center justify-between gap-3">
            <div class="flex items-center gap-1">
                <button class="btn-plain h-9 w-9 rounded-lg active:scale-90" aria-label="上一首" on:click={() => switchTrack(-1)}>
                    <Icon icon="material-symbols:skip-previous-rounded" class="text-xl" />
                </button>
                <button class="btn-regular h-10 w-10 rounded-xl active:scale-90" aria-label={isPlaying ? "暂停" : "播放"} on:click={togglePlay}>
                    <Icon icon={isPlaying ? "material-symbols:pause-rounded" : "material-symbols:play-arrow-rounded"} class="text-2xl" />
                </button>
                <button class="btn-plain h-9 w-9 rounded-lg active:scale-90" aria-label="下一首" on:click={() => switchTrack(1)}>
                    <Icon icon="material-symbols:skip-next-rounded" class="text-xl" />
                </button>
            </div>
            <div class="flex min-w-0 items-center gap-2">
                <Icon icon={volume === 0 ? "material-symbols:volume-off-rounded" : "material-symbols:volume-up-rounded"} class="shrink-0 text-lg text-30" />
                <input
                    aria-label="音量"
                    class="music-range volume-range"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(volume * 100)}
                    on:input={changeVolume}
                />
                <button
                    class={`btn-plain h-9 w-9 rounded-lg active:scale-90 ${isPlaylistOpen ? "!bg-[var(--btn-regular-bg)]" : ""}`}
                    aria-label="歌曲列表"
                    aria-expanded={isPlaylistOpen}
                    on:click={() => (isPlaylistOpen = !isPlaylistOpen)}
                >
                    <Icon icon="material-symbols:queue-music-rounded" class="text-xl" />
                </button>
            </div>
        </div>

        {#if isPlaylistOpen}
            <div class="playlist mt-3 flex flex-col gap-1">
                {#each tracks as track, index}
                    <button
                        type="button"
                        class={`playlist-item ${index === activeIndex ? "playlist-item-active" : ""}`}
                        on:click={() => switchTrackTo(index, true)}
                    >
                        <span class="min-w-0 flex-1 truncate text-left">{track.title}</span>
                        <span class="shrink-0 truncate text-right text-xs text-30">{track.artist || "Starshadow"}</span>
                    </button>
                {/each}
            </div>
        {/if}
    {/if}
</div>

<style>
    .music-range {
        height: 0.35rem;
        cursor: pointer;
        appearance: none;
        border-radius: 999px;
        background: var(--btn-regular-bg);
    }

    .volume-range {
        width: 4.6rem;
    }

    .music-range::-webkit-slider-thumb {
        width: 0.9rem;
        height: 0.9rem;
        appearance: none;
        border-radius: 999px;
        background: var(--primary);
    }

    .music-range::-moz-range-thumb {
        width: 0.9rem;
        height: 0.9rem;
        border: 0;
        border-radius: 999px;
        background: var(--primary);
    }

    .playlist {
        max-height: 12rem;
        overflow: auto;
    }

    .playlist-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        min-height: 2.35rem;
        border-radius: 0.625rem;
        padding: 0 0.75rem;
        color: rgb(0 0 0 / 0.75);
        transition: background-color 150ms ease, color 150ms ease;
    }

    .playlist-item:hover,
    .playlist-item-active {
        background: var(--btn-regular-bg);
        color: var(--primary);
    }

    :global(.dark) .playlist-item {
        color: rgb(255 255 255 / 0.75);
    }
</style>
