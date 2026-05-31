/// <reference types="@cloudflare/workers-types" />

export type JsonRecord = Record<string, unknown>;

export type RangeResult =
	| { ok: true; start: number; end: number; length: number }
	| { ok: false };

export type RateLimitConfig = {
	scope: string;
	limit: number;
	windowSeconds: number;
};

export type MusicMetadata = {
	title: string;
	artist: string;
	album: string;
};

export type EmbeddedCover = {
	mimeType: string;
	bytes: Uint8Array;
};

export type HumanProof = {
	type?: "altcha";
	payload?: string;
};

export type HumanProofContext = "friends" | "comments";

export type TelegramSettings = {
	enabled: boolean;
	botToken: string;
	chatId: string;
	threadId: string;
};

export type CommentsSessionCookie = {
	context: "comments";
	expiresAt: number;
	actorHash: string;
	nonce: string;
	signature: string;
};

export type MusicObjectInfo = MusicMetadata & {
	key: string;
	fileName: string;
	size: number;
	uploaded: string;
	imported: boolean;
	audioUrl: string;
	coverUrl: string;
	hasEmbeddedCover: boolean;
	cover?: EmbeddedCover;
};
