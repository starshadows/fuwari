<script lang="ts">
import { onMount } from "svelte";

type FriendStatus = "pending" | "approved" | "rejected" | "all";

type Friend = {
	id: number;
	name: string;
	description: string;
	url: string;
	avatarUrl: string;
	status: FriendStatus;
	isActive: number;
	sortOrder: number;
	createdAt: string;
};

type Track = {
	id: number;
	title: string;
	artist: string;
	album: string;
	objectKey: string;
	coverUrl: string;
	isActive: number;
	sortOrder: number;
};

const tokenKey = "fuwari-admin-token";
const statusOptions: FriendStatus[] = ["pending", "approved", "rejected", "all"];

let tokenInput = "";
let token = "";
let isAuthed = false;
let activeTab: "friends" | "music" = "friends";
let friendStatus: FriendStatus = "pending";
let friends: Friend[] = [];
let tracks: Track[] = [];
let message = "";
let error = "";
let avatarFileInput: HTMLInputElement;

let musicForm = {
	title: "",
	artist: "",
	album: "",
	objectKey: "",
	coverUrl: "",
	sortOrder: 0,
	isActive: true,
};

const statusLabels: Record<FriendStatus, string> = {
	pending: "待审核",
	approved: "已通过",
	rejected: "已拒绝",
	all: "全部",
};

const setMessage = (value: string) => {
	message = value;
	error = "";
};

const setError = (value: string) => {
	error = value;
	message = "";
};

const adminFetch = async (path: string, init: RequestInit = {}) => {
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${token}`);

	if (init.body && !(init.body instanceof FormData)) {
		headers.set("content-type", "application/json");
	}

	const response = await fetch(path, { ...init, headers });
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(data.error ?? "请求失败。");
	}
	return data;
};

const login = async () => {
	token = tokenInput.trim();
	if (!token) {
		setError("请输入管理口令。");
		return;
	}

	try {
		await loadFriends();
		sessionStorage.setItem(tokenKey, token);
		isAuthed = true;
		setMessage("已登录。");
		await loadMusic();
	} catch (err) {
		token = "";
		isAuthed = false;
		setError(err instanceof Error ? err.message : "登录失败。");
	}
};

const logout = () => {
	token = "";
	tokenInput = "";
	isAuthed = false;
	sessionStorage.removeItem(tokenKey);
};

const loadFriends = async () => {
	const data = await adminFetch(`/api/admin/friends?status=${friendStatus}`);
	friends = data.friends ?? [];
};

const loadMusic = async () => {
	const data = await adminFetch("/api/admin/music");
	tracks = data.tracks ?? [];
};

const changeFriendStatusFilter = async (status: FriendStatus) => {
	friendStatus = status;
	await loadFriends();
};

const patchFriend = async (friend: Friend, patch: Record<string, unknown>) => {
	try {
		await adminFetch(`/api/admin/friends/${friend.id}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		});
		await loadFriends();
		setMessage("友链已更新。");
	} catch (err) {
		setError(err instanceof Error ? err.message : "友链更新失败。");
	}
};

const deleteFriend = async (friend: Friend) => {
	if (!confirm(`删除友链：${friend.name}？`)) return;

	try {
		await adminFetch(`/api/admin/friends/${friend.id}`, { method: "DELETE" });
		await loadFriends();
		setMessage("友链已删除。");
	} catch (err) {
		setError(err instanceof Error ? err.message : "删除失败。");
	}
};

const uploadAvatar = async () => {
	const file = avatarFileInput?.files?.[0];
	if (!file) {
		setError("请选择头像文件。");
		return;
	}

	const formData = new FormData();
	formData.append("file", file);

	try {
		const data = await adminFetch("/api/admin/avatar", {
			method: "POST",
			body: formData,
		});
		setMessage(`头像已上传：${data.avatarUrl}`);
	} catch (err) {
		setError(err instanceof Error ? err.message : "头像上传失败。");
	}
};

const createTrack = async () => {
	try {
		await adminFetch("/api/admin/music", {
			method: "POST",
			body: JSON.stringify(musicForm),
		});
		musicForm = {
			title: "",
			artist: "",
			album: "",
			objectKey: "",
			coverUrl: "",
			sortOrder: 0,
			isActive: true,
		};
		await loadMusic();
		setMessage("歌曲已添加。");
	} catch (err) {
		setError(err instanceof Error ? err.message : "歌曲添加失败。");
	}
};

const patchTrack = async (track: Track, patch: Record<string, unknown>) => {
	try {
		await adminFetch(`/api/admin/music/${track.id}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		});
		await loadMusic();
		setMessage("歌曲已更新。");
	} catch (err) {
		setError(err instanceof Error ? err.message : "歌曲更新失败。");
	}
};

const deleteTrack = async (track: Track) => {
	if (!confirm(`删除歌曲：${track.title}？`)) return;

	try {
		await adminFetch(`/api/admin/music/${track.id}`, { method: "DELETE" });
		await loadMusic();
		setMessage("歌曲已删除。");
	} catch (err) {
		setError(err instanceof Error ? err.message : "删除失败。");
	}
};

onMount(async () => {
	tokenInput = sessionStorage.getItem(tokenKey) ?? "";
	if (tokenInput) {
		await login();
	}
});
</script>

{#if !isAuthed}
    <form class="card-base px-6 py-6 md:px-8" on:submit|preventDefault={login}>
        <div class="relative mb-5 pl-4 text-2xl font-bold text-90 before:absolute before:left-0 before:top-2 before:h-5 before:w-1 before:rounded-md before:bg-[var(--primary)]">
            友链后台
        </div>
        <div class="flex flex-col gap-3 md:flex-row">
            <input
                bind:value={tokenInput}
                type="password"
                placeholder="管理口令"
                class="h-11 flex-1 rounded-xl bg-[var(--btn-plain-bg-hover)] px-4 text-75 outline-none transition focus:bg-[var(--btn-regular-bg)]"
            />
            <button type="submit" class="btn-regular h-11 rounded-xl px-5 font-bold active:scale-95">
                登录
            </button>
        </div>
        {#if error}
            <div class="mt-3 text-sm text-red-500">{error}</div>
        {/if}
    </form>
{:else}
    <div class="card-base px-6 py-6 md:px-8">
        <div class="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div class="relative pl-4 text-2xl font-bold text-90 before:absolute before:left-0 before:top-2 before:h-5 before:w-1 before:rounded-md before:bg-[var(--primary)]">
                内容管理
            </div>
            <div class="flex gap-2">
                <button
                    class={`btn-regular h-10 rounded-xl px-4 font-bold ${activeTab === "friends" ? "!bg-[var(--btn-regular-bg-active)]" : ""}`}
                    on:click={() => (activeTab = "friends")}
                >
                    友链
                </button>
                <button
                    class={`btn-regular h-10 rounded-xl px-4 font-bold ${activeTab === "music" ? "!bg-[var(--btn-regular-bg-active)]" : ""}`}
                    on:click={() => (activeTab = "music")}
                >
                    音乐
                </button>
                <button class="btn-plain h-10 rounded-xl px-4 font-bold" on:click={logout}>
                    退出
                </button>
            </div>
        </div>

        <div class="mb-4 min-h-5 text-sm">
            {#if message}
                <span class="text-[var(--primary)]">{message}</span>
            {:else if error}
                <span class="text-red-500">{error}</span>
            {/if}
        </div>

        {#if activeTab === "friends"}
            <div class="mb-4 flex flex-wrap gap-2">
                {#each statusOptions as option}
                    <button
                        class={`btn-regular h-9 rounded-xl px-3 text-sm font-bold ${friendStatus === option ? "!bg-[var(--btn-regular-bg-active)]" : ""}`}
                        on:click={() => changeFriendStatusFilter(option)}
                    >
                        {statusLabels[option]}
                    </button>
                {/each}
            </div>

            <div class="mb-4 rounded-xl bg-[var(--btn-plain-bg-hover)] p-4">
                <div class="mb-3 font-bold text-75">上传头像到 R2</div>
                <div class="flex flex-col gap-3 md:flex-row">
                    <input
                        bind:this={avatarFileInput}
                        type="file"
                        accept="image/*"
                        class="min-h-11 flex-1 rounded-xl bg-[var(--card-bg)] px-4 py-2 text-sm text-75"
                    />
                    <button class="btn-regular h-11 rounded-xl px-5 font-bold" on:click={uploadAvatar}>
                        上传
                    </button>
                </div>
            </div>

            <div class="flex flex-col gap-3">
                {#each friends as friend}
                    <div class="rounded-xl bg-[var(--btn-plain-bg-hover)] p-4">
                        <div class="mb-3 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div class="min-w-0">
                                <div class="font-bold text-90">{friend.name}</div>
                                <a href={friend.url} target="_blank" rel="noopener noreferrer" class="break-all text-sm text-[var(--primary)]">
                                    {friend.url}
                                </a>
                                <div class="mt-1 text-sm text-50">{friend.description}</div>
                                <div class="mt-1 break-all text-xs text-30">{friend.avatarUrl}</div>
                            </div>
                            <div class="flex shrink-0 flex-wrap gap-2">
                                <button class="btn-regular h-9 rounded-lg px-3 text-sm font-bold" on:click={() => patchFriend(friend, { status: "approved" })}>
                                    通过
                                </button>
                                <button class="btn-regular h-9 rounded-lg px-3 text-sm font-bold" on:click={() => patchFriend(friend, { status: "rejected" })}>
                                    拒绝
                                </button>
                                <button class="btn-plain h-9 rounded-lg px-3 text-sm font-bold" on:click={() => deleteFriend(friend)}>
                                    删除
                                </button>
                            </div>
                        </div>
                        <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                            <label class="flex items-center gap-2 text-sm text-75">
                                <input
                                    type="checkbox"
                                    checked={Boolean(friend.isActive)}
                                    on:change={(event) => patchFriend(friend, { isActive: (event.currentTarget as HTMLInputElement).checked })}
                                />
                                展示
                            </label>
                            <label class="flex items-center gap-2 text-sm text-75 md:col-span-2">
                                排序
                                <input
                                    type="number"
                                    value={friend.sortOrder}
                                    class="h-9 w-28 rounded-lg bg-[var(--card-bg)] px-3 text-75 outline-none"
                                    on:change={(event) => patchFriend(friend, { sortOrder: Number((event.currentTarget as HTMLInputElement).value) })}
                                />
                            </label>
                        </div>
                    </div>
                {/each}
            </div>
        {:else}
            <form class="mb-4 rounded-xl bg-[var(--btn-plain-bg-hover)] p-4" on:submit|preventDefault={createTrack}>
                <div class="mb-3 font-bold text-75">添加音乐</div>
                <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <input bind:value={musicForm.title} required placeholder="标题" class="admin-input" />
                    <input bind:value={musicForm.artist} placeholder="艺术家" class="admin-input" />
                    <input bind:value={musicForm.album} placeholder="专辑" class="admin-input" />
                    <input bind:value={musicForm.objectKey} required placeholder="music/song.mp3" class="admin-input" />
                    <input bind:value={musicForm.coverUrl} placeholder="封面 URL，可留空" class="admin-input md:col-span-2" />
                    <label class="flex items-center gap-2 text-sm text-75">
                        <input type="checkbox" bind:checked={musicForm.isActive} />
                        启用
                    </label>
                    <input bind:value={musicForm.sortOrder} type="number" placeholder="排序" class="admin-input" />
                </div>
                <button type="submit" class="btn-regular mt-3 h-10 rounded-xl px-4 font-bold">
                    添加
                </button>
            </form>

            <div class="flex flex-col gap-3">
                {#each tracks as track}
                    <div class="rounded-xl bg-[var(--btn-plain-bg-hover)] p-4">
                        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                            <input value={track.title} class="admin-input" on:change={(event) => patchTrack(track, { title: (event.currentTarget as HTMLInputElement).value })} />
                            <input value={track.artist} class="admin-input" on:change={(event) => patchTrack(track, { artist: (event.currentTarget as HTMLInputElement).value })} />
                            <input value={track.objectKey} class="admin-input" on:change={(event) => patchTrack(track, { objectKey: (event.currentTarget as HTMLInputElement).value })} />
                            <input value={track.coverUrl} class="admin-input" placeholder="封面 URL" on:change={(event) => patchTrack(track, { coverUrl: (event.currentTarget as HTMLInputElement).value })} />
                            <label class="flex items-center gap-2 text-sm text-75">
                                <input
                                    type="checkbox"
                                    checked={Boolean(track.isActive)}
                                    on:change={(event) => patchTrack(track, { isActive: (event.currentTarget as HTMLInputElement).checked })}
                                />
                                启用
                            </label>
                            <div class="flex gap-2">
                                <input
                                    type="number"
                                    value={track.sortOrder}
                                    class="admin-input w-28"
                                    on:change={(event) => patchTrack(track, { sortOrder: Number((event.currentTarget as HTMLInputElement).value) })}
                                />
                                <button type="button" class="btn-plain h-10 rounded-xl px-4 font-bold" on:click={() => deleteTrack(track)}>
                                    删除
                                </button>
                            </div>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </div>
{/if}

<style>
    .admin-input {
        height: 2.75rem;
        border-radius: 0.75rem;
        background: var(--card-bg);
        padding: 0 1rem;
        color: rgb(0 0 0 / 0.75);
        outline: none;
        transition: background-color 150ms ease;
    }

    :global(.dark) .admin-input {
        color: rgb(255 255 255 / 0.75);
    }

    .admin-input:focus {
        background: var(--btn-regular-bg);
    }
</style>
