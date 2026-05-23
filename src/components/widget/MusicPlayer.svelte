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

$: activeTrack = tracks[activeIndex];
$: progress = duration > 0 ? (currentTime / duration) * 100 : 0;

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
	activeIndex = (activeIndex + offset + tracks.length) % tracks.length;
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

onMount(() => {
	audio = new Audio();
	audio.preload = "metadata";
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
            <div class="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--btn-regular-bg)] text-[var(--btn-content)]">
                {#if activeTrack.coverUrl}
                    <img src={activeTrack.coverUrl} alt={activeTrack.title} class="h-full w-full object-cover" />
                {:else}
                    <Icon icon="material-symbols:music-note-rounded" class="text-3xl" />
                {/if}
            </div>
            <div class="min-w-0 flex-1">
                <div class="truncate font-bold text-75">{activeTrack.title}</div>
                <div class="truncate text-sm text-30">{activeTrack.artist || "Starshadow"}</div>
                <input
                    aria-label="播放进度"
                    class="music-range mt-2 w-full"
                    type="range"
                    min="0"
                    max="100"
                    step="0.1"
                    value={progress}
                    on:input={seek}
                />
            </div>
        </div>

        <div class="mt-3 flex items-center justify-between">
            <div class="text-xs font-medium text-30">{formatTime(currentTime)} / {formatTime(duration)}</div>
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
        </div>
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
</style>
