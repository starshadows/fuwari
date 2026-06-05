import { MUSIC_METADATA_READ_BYTES } from "./constants";
import type { EmbeddedCover, MusicMetadata } from "./types/aliases";

// ================================================================
// ID3v2 tag parsing (shared between media.ts and music.ts)
// ================================================================

export function parseId3Metadata(
	bytes: Uint8Array,
): Partial<MusicMetadata> & { cover?: EmbeddedCover } {
	if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") return {};
	const version = bytes[3];
	if (version < 3 || version > 4) return {};

	const flags = bytes[5];
	const tagSize = readSyncSafeInteger(bytes, 6);
	if (tagSize > MUSIC_METADATA_READ_BYTES) return {};
	const end = Math.min(bytes.length, 10 + tagSize);
	let offset = 10;

	if (flags & 0x40) {
		if (offset + 4 > end) return {};
		const extendedSize =
			version === 4
				? readSyncSafeInteger(bytes, offset)
				: readUint32(bytes, offset);
		offset += version === 4 ? extendedSize : extendedSize + 4;
	}

	const frameMap: Record<string, keyof MusicMetadata> = {
		TIT2: "title",
		TPE1: "artist",
		TALB: "album",
	};
	const metadata: Partial<MusicMetadata> & { cover?: EmbeddedCover } = {};

	while (offset + 10 <= end) {
		const frameId = ascii(bytes, offset, 4);
		if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

		const frameSize =
			version === 4
				? readSyncSafeInteger(bytes, offset + 4)
				: readUint32(bytes, offset + 4);
		if (frameSize <= 0) break;

		const frameStart = offset + 10;
		const frameEnd = Math.min(frameStart + frameSize, end);
		const field = frameMap[frameId];

		if (field && frameStart < frameEnd) {
			const value = decodeId3Text(bytes.slice(frameStart, frameEnd));
			if (value) metadata[field] = value;
		} else if (frameId === "APIC" && frameStart < frameEnd && !metadata.cover) {
			metadata.cover = parseApicFrame(bytes.slice(frameStart, frameEnd));
		}

		if (frameEnd <= offset) break;
		offset = frameEnd;
	}

	return metadata;
}

export function readMusicMetadataFromBuffer(
	bytes: Uint8Array,
): Partial<MusicMetadata> & { cover?: EmbeddedCover } {
	return parseId3Metadata(bytes);
}

export function cleanMetadataText(value: string): string {
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strip NUL bytes from ID3 metadata
			.replace(/\x00+/g, " / ")
			.replace(/\s+\/\s*$/g, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

export function truncateText(value: string, maxLength: number): string {
	return value.trim().slice(0, maxLength);
}

// ================================================================
// Internal helpers
// ================================================================

function decodeId3Text(bytes: Uint8Array): string {
	if (bytes.length === 0) return "";
	const encoding = bytes[0];
	let payload = bytes.slice(1);
	let decoder = new TextDecoder("iso-8859-1");

	if (encoding === 1) {
		if (payload[0] === 0xfe && payload[1] === 0xff) {
			decoder = new TextDecoder("utf-16be");
			payload = payload.slice(2);
		} else {
			decoder = new TextDecoder("utf-16le");
			if (payload[0] === 0xff && payload[1] === 0xfe)
				payload = payload.slice(2);
		}
	} else if (encoding === 2) {
		decoder = new TextDecoder("utf-16be");
	} else if (encoding === 3) {
		decoder = new TextDecoder("utf-8");
	}

	return cleanMetadataText(decoder.decode(payload));
}

function parseApicFrame(bytes: Uint8Array): EmbeddedCover | undefined {
	if (bytes.length < 5) return undefined;

	const encoding = bytes[0];
	let offset = 1;
	const mimeEnd = indexOfTerminator(bytes, offset, 1);
	if (mimeEnd < 0) return undefined;

	const mimeType = cleanMetadataText(
		new TextDecoder("iso-8859-1").decode(bytes.slice(offset, mimeEnd)),
	).toLowerCase();
	offset = mimeEnd + 1;

	if (!mimeType.startsWith("image/") || offset >= bytes.length)
		return undefined;
	offset += 1;

	const termLen = encoding === 1 || encoding === 2 ? 2 : 1;
	const descEnd = indexOfTerminator(bytes, offset, termLen);
	if (descEnd < 0) return undefined;

	const imageStart = descEnd + termLen;
	if (imageStart >= bytes.length) return undefined;

	return {
		mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType,
		bytes: bytes.slice(imageStart),
	};
}

function indexOfTerminator(
	bytes: Uint8Array,
	start: number,
	termLen: 1 | 2,
): number {
	for (let i = start; i <= bytes.length - termLen; i++) {
		if (termLen === 1 && bytes[i] === 0) return i;
		if (termLen === 2 && bytes[i] === 0 && bytes[i + 1] === 0) return i;
	}
	return -1;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	return Array.from(bytes.slice(offset, offset + length))
		.map((b) => String.fromCharCode(b))
		.join("");
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return (
		((bytes[offset] << 24) |
			(bytes[offset + 1] << 16) |
			(bytes[offset + 2] << 8) |
			bytes[offset + 3]) >>>
		0
	);
}

function readSyncSafeInteger(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] << 21) |
		(bytes[offset + 1] << 14) |
		(bytes[offset + 2] << 7) |
		bytes[offset + 3]
	);
}
