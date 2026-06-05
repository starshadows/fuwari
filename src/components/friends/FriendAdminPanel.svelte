<script lang="ts">
import TwikooComments from "@components/comments/TwikooComments.svelte";
import { onDestroy, onMount } from "svelte";

type FriendStatus = "pending" | "approved" | "rejected" | "all";
type AdminTab = "friends" | "music" | "comments" | "notifications";

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

type MusicObject = {
	key: string;
	fileName: string;
	title: string;
	artist: string;
	album: string;
	size: number;
	uploaded: string;
	imported: boolean;
	audioUrl: string;
};

type MusicUploadResult = {
	fileName: string;
	objectKey: string;
	hash: string;
	size: number;
	trackId: number;
	status: "uploaded" | "duplicate";
};

type MusicUploadFailure = {
	fileName: string;
	status: "failed";
	reason: string;
};

type CommentSettings = {
	enabled: boolean;
};

type TelegramSettings = {
	enabled: boolean;
	botTokenConfigured: boolean;
	chatId: string;
	threadId: string;
};

type TelegramCommentSettings = TelegramSettings & {
	useFriendSettings: boolean;
};

const tokenKey = "fuwari-admin-token";
const tokenLoginTimeKey = "fuwari-admin-login-time";
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

const statusOptions: FriendStatus[] = [
	"pending",
	"approved",
	"rejected",
	"all",
];

let tokenInput = "";
let token = "";
let isAuthed = false;
let activeTab: AdminTab = "music";
let friendStatus: FriendStatus = "pending";
let friends: Friend[] = [];
let tracks: Track[] = [];
let musicObjects: MusicObject[] = [];
let unimportedMusicObjects: MusicObject[] = [];
let message = "";
let error = "";
let isScanningMusic = false;
let isImportingMusic = false;
let isUploadingMusic = false;
let isNormalizingMusicSort = false;
let selectedMusicFiles: File[] = [];
let uploadResults: {
	uploaded: MusicUploadResult[];
	duplicates: MusicUploadResult[];
	failed: MusicUploadFailure[];
} = {
	uploaded: [],
	duplicates: [],
	failed: [],
};
let musicSectionsOpen = {
	upload: true,
	scan: false,
	tracks: false,
};
const musicSectionPanelIds = {
	upload: "friend-admin-music-upload-panel",
	scan: "friend-admin-music-scan-panel",
	tracks: "friend-admin-music-tracks-panel",
} as const;
let musicFileInput: HTMLInputElement | null = null;
let isSavingComments = false;
let isSavingFriendTelegram = false;
let isTestingFriendTelegram = false;
let isSavingCommentTelegram = false;
let isTestingCommentTelegram = false;

let commentSettings: CommentSettings = {
	enabled: true,
};

let telegramSettings: TelegramSettings = {
	enabled: false,
	botTokenConfigured: false,
	chatId: "",
	threadId: "",
};

let telegramTokenInput = "";

let commentTelegramSettings: TelegramCommentSettings = {
	enabled: false,
	useFriendSettings: true,
	botTokenConfigured: false,
	chatId: "",
	threadId: "",
};

let commentTelegramTokenInput = "";

const statusLabels: Record<FriendStatus, string> = {
	pending: "待审核",
	approved: "已通过",
	rejected: "已拒绝",
	all: "全部",
};

$: unimportedMusicObjects = musicObjects.filter((object) => !object.imported);
$: selectedMusicFileSummary =
	selectedMusicFiles.length === 0
		? "未选择任何文件"
		: `${selectedMusicFiles.length} 个文件`;

const setMessage = (value: string) => {
	message = value;
	error = "";
};

const setError = (value: string) => {
	error = value;
	message = "";
};

const rememberLoginActivity = () => {
	if (!token) return;
	sessionStorage.setItem(tokenLoginTimeKey, String(Date.now()));
};

const adminFetch = async (path: string, init: RequestInit = {}) => {
	const headers = new Headers(init.headers);
	headers.set("x-fuwari-admin-token", token);

	if (init.body && !(init.body instanceof FormData)) {
		headers.set("content-type", "application/json");
	}

	const response = await fetch(path, { ...init, headers });
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		if (response.status === 401) {
			const wasAuthed = isAuthed;
			logout();
			throw new Error(
				wasAuthed ? "登录已过期，请重新登录。" : "管理口令不正确，请重新输入。",
			);
		}
		throw new Error(data.error ?? "请求失败。");
	}
	resetInactivityTimer();
	return data;
};

const login = async () => {
	token = tokenInput.trim();
	if (!token) {
		setError("请输入管理口令。");
		return;
	}

	try {
		activeTab = "music";
		await loadMusic();
		sessionStorage.setItem(tokenKey, token);
		rememberLoginActivity();
		isAuthed = true;
		setMessage("已登录。");
		await loadMusicObjects();
		startInactivityTimer();
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
	sessionStorage.removeItem(tokenLoginTimeKey);
	stopInactivityTimer();
};

const loadFriends = async () => {
	const data = await adminFetch(`/api/admin/friends?status=${friendStatus}`);
	friends = data.friends ?? [];
};

const loadMusic = async () => {
	const data = await adminFetch("/api/admin/music");
	tracks = data.tracks ?? [];
};

const loadCommentSettings = async () => {
	const data = await adminFetch("/api/admin/settings/comments");
	commentSettings = {
		enabled: Boolean(data.enabled),
	};
};

const saveCommentSettings = async () => {
	isSavingComments = true;
	try {
		const data = await adminFetch("/api/admin/settings/comments", {
			method: "POST",
			body: JSON.stringify(commentSettings),
		});
		commentSettings.enabled = Boolean(data.enabled);
		setMessage("评论设置已保存。");
	} catch (err) {
		setError(err instanceof Error ? err.message : "评论设置保存失败。");
	} finally {
		isSavingComments = false;
	}
};

const loadTelegramSettings = async () => {
	const data = await adminFetch("/api/admin/settings/telegram");
	telegramSettings = {
		enabled: Boolean(data.enabled),
		botTokenConfigured: Boolean(data.botTokenConfigured),
		chatId: data.chatId ?? "",
		threadId: data.threadId ?? "",
	};
	telegramTokenInput = "";
};

const loadTelegramCommentSettings = async () => {
	const data = await adminFetch("/api/admin/settings/telegram/comments");
	commentTelegramSettings = {
		enabled: Boolean(data.enabled),
		useFriendSettings: Boolean(data.useFriendSettings),
		botTokenConfigured: Boolean(data.botTokenConfigured),
		chatId: data.chatId ?? "",
		threadId: data.threadId ?? "",
	};
	commentTelegramTokenInput = "";
};

const saveTelegramSettings = async () => {
	isSavingFriendTelegram = true;
	try {
		const data = await adminFetch("/api/admin/settings/telegram", {
			method: "POST",
			body: JSON.stringify({
				enabled: telegramSettings.enabled,
				botToken: telegramTokenInput,
				chatId: telegramSettings.chatId,
				threadId: telegramSettings.threadId,
			}),
		});
		telegramSettings = {
			enabled: Boolean(data.enabled),
			botTokenConfigured: Boolean(data.botTokenConfigured),
			chatId: data.chatId ?? "",
			threadId: data.threadId ?? "",
		};
		telegramTokenInput = "";
		setMessage("友链申请通知设置已保存。");
	} catch (err) {
		setError(err instanceof Error ? err.message : "友链通知设置保存失败。");
	} finally {
		isSavingFriendTelegram = false;
	}
};

const sendTelegramTest = async () => {
	isTestingFriendTelegram = true;
	try {
		await adminFetch("/api/admin/settings/telegram/test", { method: "POST" });
		setMessage("友链申请测试通知已发送。");
	} catch (err) {
		setError(err instanceof Error ? err.message : "友链测试通知发送失败。");
	} finally {
		isTestingFriendTelegram = false;
	}
};

const saveTelegramCommentSettings = async () => {
	isSavingCommentTelegram = true;
	try {
		const data = await adminFetch("/api/admin/settings/telegram/comments", {
			method: "POST",
			body: JSON.stringify({
				enabled: commentTelegramSettings.enabled,
				useFriendSettings: commentTelegramSettings.useFriendSettings,
				botToken: commentTelegramTokenInput,
				chatId: commentTelegramSettings.chatId,
				threadId: commentTelegramSettings.threadId,
			}),
		});
		commentTelegramSettings = {
			enabled: Boolean(data.enabled),
			useFriendSettings: Boolean(data.useFriendSettings),
			botTokenConfigured: Boolean(data.botTokenConfigured),
			chatId: data.chatId ?? "",
			threadId: data.threadId ?? "",
		};
		commentTelegramTokenInput = "";
		setMessage("评论通知设置已保存。");
	} catch (err) {
		setError(err instanceof Error ? err.message : "评论通知设置保存失败。");
	} finally {
		isSavingCommentTelegram = false;
	}
};

const sendTelegramCommentTest = async () => {
	isTestingCommentTelegram = true;
	try {
		await adminFetch("/api/admin/settings/telegram/comments/test", {
			method: "POST",
		});
		setMessage("评论测试通知已发送。");
	} catch (err) {
		setError(err instanceof Error ? err.message : "评论测试通知发送失败。");
	} finally {
		isTestingCommentTelegram = false;
	}
};

const loadMusicObjects = async () => {
	isScanningMusic = true;
	try {
		const data = await adminFetch("/api/admin/music/objects");
		musicObjects = data.objects ?? [];
		const unimportedCount = musicObjects.filter(
			(object) => !object.imported,
		).length;
		setMessage(
			`已扫描 R2：${musicObjects.length} 个音频，${unimportedCount} 个未导入。`,
		);
	} catch (err) {
		setError(err instanceof Error ? err.message : "扫描 R2 音乐失败。");
	} finally {
		isScanningMusic = false;
	}
};

const importMusicObjects = async (objectKeys?: string[]) => {
	const keys = objectKeys ?? unimportedMusicObjects.map((object) => object.key);
	if (keys.length === 0) {
		setMessage("没有可导入的新音乐。");
		return;
	}

	isImportingMusic = true;
	try {
		const data = await adminFetch("/api/admin/music/import", {
			method: "POST",
			body: JSON.stringify({ objectKeys: keys }),
		});
		await loadMusic();
		await loadMusicObjects();
		setMessage(`已导入 ${data.imported?.length ?? 0} 首音乐。`);
	} catch (err) {
		setError(err instanceof Error ? err.message : "导入 R2 音乐失败。");
	} finally {
		isImportingMusic = false;
	}
};

const selectMusicFiles = (event: Event) => {
	const input = event.currentTarget as HTMLInputElement;
	selectedMusicFiles = Array.from(input.files ?? []);
};

const openMusicFilePicker = () => {
	musicFileInput?.click();
};

const uploadMusicFiles = async () => {
	if (selectedMusicFiles.length === 0) {
		setError("请选择要上传的音乐文件。");
		return;
	}

	const formData = new FormData();
	for (const file of selectedMusicFiles) {
		formData.append("files", file);
	}
	formData.append("isActive", "true");

	isUploadingMusic = true;
	try {
		const data = await adminFetch("/api/admin/music/upload", {
			method: "POST",
			body: formData,
		});
		uploadResults = {
			uploaded: data.uploaded ?? [],
			duplicates: data.duplicates ?? [],
			failed: data.failed ?? [],
		};
		selectedMusicFiles = [];
		if (musicFileInput) musicFileInput.value = "";
		await loadMusic();
		await loadMusicObjects();
		setMessage(
			`上传完成：新增 ${uploadResults.uploaded.length}，重复 ${uploadResults.duplicates.length}，失败 ${uploadResults.failed.length}。`,
		);
	} catch (err) {
		setError(err instanceof Error ? err.message : "音乐上传失败。");
	} finally {
		isUploadingMusic = false;
	}
};

const toggleMusicSection = (section: keyof typeof musicSectionsOpen) => {
	musicSectionsOpen = {
		...musicSectionsOpen,
		[section]: !musicSectionsOpen[section],
	};
};

const openFriendsTab = async () => {
	activeTab = "friends";
	await loadFriends();
};

const openMusicTab = async () => {
	activeTab = "music";
	if (musicObjects.length === 0) await loadMusicObjects();
};

const openCommentsTab = async () => {
	activeTab = "comments";
	await loadCommentSettings();
};

const openNotificationsTab = async () => {
	activeTab = "notifications";
	await loadTelegramSettings();
	await loadTelegramCommentSettings();
};

const formatFileSize = (size: number) => {
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(2)} MB`;
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

const normalizeTrackSort = async () => {
	if (tracks.length === 0) {
		setMessage("没有需要整理的歌曲。");
		return;
	}

	isNormalizingMusicSort = true;
	try {
		const data = await adminFetch("/api/admin/music/normalize-sort", {
			method: "POST",
		});
		await loadMusic();
		setMessage(`排序已整理为 1、2、3...，共更新 ${data.updated ?? 0} 首。`);
	} catch (err) {
		setError(err instanceof Error ? err.message : "整理排序失败。");
	} finally {
		isNormalizingMusicSort = false;
	}
};

const resetInactivityTimer = () => {
	if (inactivityTimer) clearTimeout(inactivityTimer);
	rememberLoginActivity();
	inactivityTimer = setTimeout(logout, INACTIVITY_TIMEOUT_MS);
};

const stopInactivityTimer = () => {
	if (typeof document === "undefined") return;
	document.removeEventListener("mousemove", resetInactivityTimer);
	document.removeEventListener("keydown", resetInactivityTimer);
	document.removeEventListener("click", resetInactivityTimer);
	if (inactivityTimer) {
		clearTimeout(inactivityTimer);
		inactivityTimer = null;
	}
};

const startInactivityTimer = () => {
	stopInactivityTimer();
	document.addEventListener("mousemove", resetInactivityTimer, {
		passive: true,
	});
	document.addEventListener("keydown", resetInactivityTimer, { passive: true });
	document.addEventListener("click", resetInactivityTimer, { passive: true });
	resetInactivityTimer();
};

onMount(async () => {
	tokenInput = sessionStorage.getItem(tokenKey) ?? "";
	if (tokenInput) {
		const loginTimeStr = sessionStorage.getItem(tokenLoginTimeKey);
		const loginTime = loginTimeStr ? Number(loginTimeStr) : 0;
		if (loginTime && Date.now() - loginTime > INACTIVITY_TIMEOUT_MS) {
			sessionStorage.removeItem(tokenKey);
			sessionStorage.removeItem(tokenLoginTimeKey);
			tokenInput = "";
			setError("登录已过期，请重新登录。");
		} else {
			await login();
		}
	}
});

onDestroy(() => {
	stopInactivityTimer();
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
            <div class="flex flex-wrap gap-2">
                <button
                    class={`btn-regular h-10 rounded-xl px-4 font-bold ${activeTab === "friends" ? "!bg-[var(--btn-regular-bg-active)]" : ""}`}
                    on:click={openFriendsTab}
                >
                    友链
                </button>
                <button
                    class={`btn-regular h-10 rounded-xl px-4 font-bold ${activeTab === "music" ? "!bg-[var(--btn-regular-bg-active)]" : ""}`}
                    on:click={openMusicTab}
                >
                    音乐
                </button>
                <button
                    class={`btn-regular h-10 rounded-xl px-4 font-bold ${activeTab === "comments" ? "!bg-[var(--btn-regular-bg-active)]" : ""}`}
                    on:click={openCommentsTab}
                >
                    评论
                </button>
                <button
                    class={`btn-regular h-10 rounded-xl px-4 font-bold ${activeTab === "notifications" ? "!bg-[var(--btn-regular-bg-active)]" : ""}`}
                    on:click={openNotificationsTab}
                >
                    通知
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
        {:else if activeTab === "music"}
			<section class="mb-4 rounded-xl bg-[var(--btn-plain-bg-hover)] p-4">
				<div class="flex items-center justify-between gap-3">
					<button
						type="button"
						class="min-w-0 flex-1 text-left"
						aria-expanded={musicSectionsOpen.upload}
						aria-controls={musicSectionPanelIds.upload}
						on:click={() => toggleMusicSection("upload")}
					>
						<div class="font-bold text-75">批量上传音乐</div>
						<div class="mt-1 text-sm text-50">
							已选择 {selectedMusicFiles.length} 个文件；上次新增 {uploadResults.uploaded.length}，重复 {uploadResults.duplicates.length}，失败 {uploadResults.failed.length}
						</div>
					</button>
					<button
						type="button"
						class="admin-collapse-button"
						aria-expanded={musicSectionsOpen.upload}
						aria-controls={musicSectionPanelIds.upload}
						on:click={() => toggleMusicSection("upload")}
					>
						{musicSectionsOpen.upload ? "收起" : "展开"}
					</button>
				</div>

				{#if musicSectionsOpen.upload}
					<div id={musicSectionPanelIds.upload} class="mt-4 flex flex-col gap-3">
						<input
							bind:this={musicFileInput}
							type="file"
							accept="audio/*,.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus,.webm"
							multiple
							class="sr-only"
							on:change={selectMusicFiles}
						/>
						<button
							type="button"
							class="admin-file-picker"
							on:click={openMusicFilePicker}
						>
							<span class="font-bold text-90">选择文件</span>
							<span class="text-50">{selectedMusicFileSummary}</span>
						</button>
						<div class="flex flex-wrap items-center gap-2">
							<button
								type="button"
								class="btn-regular h-10 rounded-xl px-4 font-bold"
								disabled={isUploadingMusic || selectedMusicFiles.length === 0}
								on:click={uploadMusicFiles}
							>
								{isUploadingMusic ? "上传中" : `上传并入库 ${selectedMusicFiles.length} 个文件`}
							</button>
							<div class="text-sm text-50">单文件上限 25 MB；后端按每批 10 个文件上传到 R2。</div>
						</div>

						{#if uploadResults.uploaded.length || uploadResults.duplicates.length || uploadResults.failed.length}
							<div class="grid grid-cols-1 gap-2 md:grid-cols-3">
								<div class="rounded-lg bg-[var(--card-bg)] p-3 text-sm text-75">
									<div class="mb-2 font-bold text-90">新增 {uploadResults.uploaded.length}</div>
									{#each uploadResults.uploaded.slice(0, 5) as item}
										<div class="truncate">{item.fileName}</div>
									{/each}
								</div>
								<div class="rounded-lg bg-[var(--card-bg)] p-3 text-sm text-75">
									<div class="mb-2 font-bold text-90">重复 {uploadResults.duplicates.length}</div>
									{#each uploadResults.duplicates.slice(0, 5) as item}
										<div class="truncate">{item.fileName}</div>
									{/each}
								</div>
								<div class="rounded-lg bg-[var(--card-bg)] p-3 text-sm text-75">
									<div class="mb-2 font-bold text-90">失败 {uploadResults.failed.length}</div>
									{#each uploadResults.failed.slice(0, 5) as item}
										<div class="truncate">{item.fileName}：{item.reason}</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/if}
			</section>

			<section class="mb-4 rounded-xl bg-[var(--btn-plain-bg-hover)] p-4">
				<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
					<button
						type="button"
						class="min-w-0 flex-1 text-left"
						aria-expanded={musicSectionsOpen.scan}
						aria-controls={musicSectionPanelIds.scan}
						on:click={() => toggleMusicSection("scan")}
					>
						<div class="font-bold text-75">智能扫描 R2 音乐</div>
						<div class="mt-1 text-sm text-50">{musicObjects.length} 个对象，{unimportedMusicObjects.length} 个未入库</div>
					</button>
					<div class="flex flex-wrap gap-2">
						<button type="button" class="btn-regular h-10 rounded-xl px-4 font-bold" disabled={isScanningMusic} on:click={loadMusicObjects}>
							{isScanningMusic ? "扫描中" : "扫描 R2"}
						</button>
						<button
							type="button"
							class="btn-regular h-10 rounded-xl px-4 font-bold"
							disabled={isImportingMusic || unimportedMusicObjects.length === 0}
							on:click={() => importMusicObjects()}
						>
							{isImportingMusic ? "导入中" : `导入未入库 ${unimportedMusicObjects.length} 首`}
						</button>
						<button
							type="button"
							class="admin-collapse-button"
							aria-expanded={musicSectionsOpen.scan}
							aria-controls={musicSectionPanelIds.scan}
							on:click={() => toggleMusicSection("scan")}
						>
							{musicSectionsOpen.scan ? "收起" : "展开"}
						</button>
					</div>
				</div>

				{#if musicSectionsOpen.scan}
					{#if musicObjects.length > 0}
						<div id={musicSectionPanelIds.scan} class="mt-3 flex max-h-[32rem] flex-col gap-2 overflow-y-auto pr-1">
							{#each musicObjects as object}
								<div class="rounded-lg bg-[var(--card-bg)] px-3 py-3">
									<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
										<div class="min-w-0">
											<div class="truncate font-bold text-90">{object.title}</div>
											<div class="truncate text-sm text-50">{object.artist || "未知艺术家"}{object.album ? ` · ${object.album}` : ""}</div>
											<div class="mt-1 truncate text-xs text-30">{object.key} · {formatFileSize(object.size)}</div>
										</div>
										<div class="flex shrink-0 flex-wrap gap-2">
											<span class={`rounded-lg px-3 py-2 text-sm font-bold ${object.imported ? "bg-[var(--btn-regular-bg)] text-50" : "bg-[var(--primary)] text-white"}`}>
												{object.imported ? "已入库" : "未入库"}
											</span>
											{#if !object.imported}
												<button type="button" class="btn-regular h-9 rounded-lg px-3 text-sm font-bold" on:click={() => importMusicObjects([object.key])}>
													导入
												</button>
											{/if}
										</div>
									</div>
								</div>
							{/each}
						</div>
					{:else}
						<div class="mt-3 rounded-lg bg-[var(--card-bg)] px-4 py-5 text-sm text-50">
							暂无扫描结果。
						</div>
					{/if}
				{/if}
			</section>

			<section class="rounded-xl bg-[var(--btn-plain-bg-hover)] p-4">
				<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
					<button
						type="button"
						class="min-w-0 flex-1 text-left"
						aria-expanded={musicSectionsOpen.tracks}
						aria-controls={musicSectionPanelIds.tracks}
						on:click={() => toggleMusicSection("tracks")}
					>
						<div class="font-bold text-75">已入库音乐</div>
						<div class="mt-1 text-sm text-50">共 {tracks.length} 首</div>
					</button>
					<div class="flex flex-wrap gap-2">
						<button type="button" class="btn-plain h-10 rounded-xl px-4 font-bold" disabled={isNormalizingMusicSort} on:click={normalizeTrackSort}>
							{isNormalizingMusicSort ? "整理中" : "整理排序"}
						</button>
						<button
							type="button"
							class="admin-collapse-button"
							aria-expanded={musicSectionsOpen.tracks}
							aria-controls={musicSectionPanelIds.tracks}
							on:click={() => toggleMusicSection("tracks")}
						>
							{musicSectionsOpen.tracks ? "收起" : "展开"}
						</button>
					</div>
				</div>

				{#if musicSectionsOpen.tracks}
					<div id={musicSectionPanelIds.tracks} class="flex max-h-[52rem] flex-col gap-3 overflow-y-auto pr-1">
						{#each tracks as track}
							<div class="rounded-xl bg-[var(--card-bg)] p-4">
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
			</section>
		{:else if activeTab === "comments"}
            <section class="mb-4 rounded-xl bg-[var(--btn-plain-bg-hover)] p-4">
                <div class="mb-3 font-bold text-75">评论区开关</div>
                <label class="flex items-center gap-2 text-sm text-75">
                    <input type="checkbox" bind:checked={commentSettings.enabled} />
                    启用文章评论区
                </label>
                <button
                    type="button"
                    class="btn-regular mt-4 h-10 rounded-xl px-4 font-bold"
                    disabled={isSavingComments}
                    on:click={saveCommentSettings}
                >
                    {isSavingComments ? "保存中" : "保存设置"}
                </button>
            </section>

            <section class="rounded-xl bg-[var(--btn-plain-bg-hover)] p-4">
                <div class="mb-3 font-bold text-75">Twikoo 评论管理</div>
                <div class="rounded-xl bg-[var(--card-bg)] p-4">
                    <TwikooComments adminMode={true} adminToken={token} embedded={true} />
                </div>
            </section>
        {:else if activeTab === "notifications"}
            <section class="mb-4 rounded-xl bg-[var(--btn-plain-bg-hover)] p-4">
                <div class="mb-3 font-bold text-75">Telegram 友链申请通知</div>
                <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label class="flex items-center gap-2 text-sm text-75 md:col-span-2">
                        <input type="checkbox" bind:checked={telegramSettings.enabled} />
                        启用通知
                    </label>
                    <input
                        bind:value={telegramTokenInput}
                        type="password"
                        placeholder={telegramSettings.botTokenConfigured ? "Bot Token 已配置" : "Bot Token"}
                        class="admin-input md:col-span-2"
                    />
                    <input bind:value={telegramSettings.chatId} placeholder="Chat ID" class="admin-input" />
                    <input bind:value={telegramSettings.threadId} placeholder="Topic / Thread ID（可选）" class="admin-input" />
                </div>
                <div class="mt-4 flex flex-wrap gap-2">
                    <button
                        type="button"
                        class="btn-regular h-10 rounded-xl px-4 font-bold"
                        disabled={isSavingFriendTelegram}
                        on:click={saveTelegramSettings}
                    >
                        {isSavingFriendTelegram ? "保存中" : "保存友链通知"}
                    </button>
                    <button
                        type="button"
                        class="btn-plain h-10 rounded-xl px-4 font-bold"
                        disabled={isTestingFriendTelegram}
                        on:click={sendTelegramTest}
                    >
                        {isTestingFriendTelegram ? "发送中" : "发送友链测试"}
                    </button>
                </div>
            </section>

            <section class="rounded-xl bg-[var(--btn-plain-bg-hover)] p-4">
                <div class="mb-3 font-bold text-75">Telegram 评论通知</div>
                <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label class="flex items-center gap-2 text-sm text-75 md:col-span-2">
                        <input type="checkbox" bind:checked={commentTelegramSettings.enabled} />
                        启用评论通知
                    </label>
                    <label class="flex items-center gap-2 text-sm text-75 md:col-span-2">
                        <input type="checkbox" bind:checked={commentTelegramSettings.useFriendSettings} />
                        使用友链申请通知的机器人
                    </label>
                    {#if !commentTelegramSettings.useFriendSettings}
                        <input
                            bind:value={commentTelegramTokenInput}
                            type="password"
                            placeholder={commentTelegramSettings.botTokenConfigured ? "Bot Token 已配置" : "Bot Token"}
                            class="admin-input md:col-span-2"
                        />
                        <input bind:value={commentTelegramSettings.chatId} placeholder="Chat ID" class="admin-input" />
                        <input bind:value={commentTelegramSettings.threadId} placeholder="Topic / Thread ID（可选）" class="admin-input" />
                    {:else}
                        <div class="rounded-xl bg-[var(--card-bg)] px-4 py-3 text-sm text-50 md:col-span-2">
                            将使用上方友链申请通知的 Bot Token、Chat ID 和 Topic。
                        </div>
                    {/if}
                </div>
                <div class="mt-4 flex flex-wrap gap-2">
                    <button
                        type="button"
                        class="btn-regular h-10 rounded-xl px-4 font-bold"
                        disabled={isSavingCommentTelegram}
                        on:click={saveTelegramCommentSettings}
                    >
                        {isSavingCommentTelegram ? "保存中" : "保存评论通知"}
                    </button>
                    <button
                        type="button"
                        class="btn-plain h-10 rounded-xl px-4 font-bold"
                        disabled={isTestingCommentTelegram}
                        on:click={sendTelegramCommentTest}
                    >
                        {isTestingCommentTelegram ? "发送中" : "发送评论测试"}
                    </button>
                </div>
            </section>
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

    .admin-collapse-button {
        min-height: 2.5rem;
        border-radius: 0.75rem;
        background: var(--btn-regular-bg);
        padding: 0 1rem;
        color: var(--primary);
        font-size: 0.875rem;
        font-weight: 700;
        transition: background-color 150ms ease, transform 150ms ease;
    }

    .admin-collapse-button:hover {
        background: var(--btn-regular-bg-hover);
    }

    .admin-collapse-button:active {
        transform: scale(0.97);
    }

    .admin-file-picker {
        display: flex;
        min-height: 3.5rem;
        width: 100%;
        align-items: center;
        justify-content: flex-start;
        gap: 0.75rem;
        border-radius: 0.875rem;
        background: var(--card-bg);
        padding: 0 1rem;
        text-align: left;
        transition: background-color 150ms ease;
    }

    .admin-file-picker:hover {
        background: var(--btn-regular-bg);
    }
</style>
