import type { Env } from "./types";
import type { RangeResult, MusicMetadata, EmbeddedCover } from "./types/aliases";
import { json, safeNormalizeMediaKey, safeDecodeURIComponent, stripMediaPrefix } from "./utils";
import { MUSIC_METADATA_READ_BYTES } from "./constants";
import {
  parseId3Metadata,
  cleanMetadataText,
  truncateText,
  readMusicMetadataFromBuffer,
} from "./id3";

// ================================================================
// Primary media handler
// ================================================================

export async function handleMedia(
  request: Request,
  env: Env,
  requestUrl: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "不支持的请求方法。" }, 405);
  }

  const segments = requestUrl.pathname.split("/").filter(Boolean);
  const kind = segments[1];
  const rawKey = safeDecodeURIComponent(segments.slice(2).join("/"));

  if (kind === "covers" && rawKey.startsWith("from-music/")) {
    return getEmbeddedCoverResponse(
      request,
      env,
      rawKey.slice("from-music/".length),
    );
  }

  if (
    kind !== "music" &&
    kind !== "avatars" &&
    kind !== "covers" &&
    kind !== "twikoo"
  ) {
    return json({ error: "媒体类型不存在。" }, 404);
  }

  const key = safeNormalizeMediaKey(rawKey, kind);
  if (!key) {
    return json({ error: "媒体路径不正确。" }, 400);
  }
  const head = await env.MEDIA_BUCKET.head(key);

  if (!head) {
    return new Response("Not found", { status: 404 });
  }

  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader, head.size) : null;

  if (range && !range.ok) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "content-range": `bytes */${head.size}` },
    });
  }

  const headers = mediaHeaders(head);

  if (range?.ok) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${head.size}`);
    headers.set("content-length", String(range.length));
    if (request.method === "HEAD") {
      return new Response(null, { status: 206, headers });
    }
    const object = await env.MEDIA_BUCKET.get(key, {
      range: { offset: range.start, length: range.length },
    });
    if (!object?.body) return new Response("Not found", { status: 404 });
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("content-length", String(head.size));
  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }
  const object = await env.MEDIA_BUCKET.get(key);
  if (!object?.body) return new Response("Not found", { status: 404 });
  return new Response(object.body, { headers });
}

// ================================================================
// Embedded cover (from MP3 ID3)
// ================================================================

async function getEmbeddedCoverResponse(
  request: Request,
  env: Env,
  rawMusicKey: string,
): Promise<Response> {
  const key = safeNormalizeMediaKey(rawMusicKey, "music");
  if (!key) return json({ error: "媒体路径不正确。" }, 400);

  const metadata = await readMusicMetadata(env, key);
  if (!metadata.cover) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "content-type": metadata.cover.mimeType,
    "cache-control": "public, max-age=31536000, immutable",
    "accept-ranges": "bytes",
  });
  const size = metadata.cover.bytes.byteLength;
  headers.set("content-length", String(size));

  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;

  if (range && !range.ok) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: {
        "accept-ranges": "bytes",
        "content-range": `bytes */${size}`,
      },
    });
  }

  if (range?.ok) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.length));
    if (request.method === "HEAD") {
      return new Response(null, { status: 206, headers });
    }
    return new Response(
      new Uint8Array(
        metadata.cover.bytes.slice(range.start, range.end + 1),
      ).buffer,
      { status: 206, headers },
    );
  }

  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }

  return new Response(
    new Uint8Array(metadata.cover.bytes).buffer,
    { headers },
  );
}

// ================================================================
// Range parsing
// ================================================================

function parseRange(rangeHeader: string, size: number): RangeResult {
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { ok: false };

  const [, startText, endText] = match;
  if (!startText && !endText) return { ok: false };

  let start: number;
  let end: number;

  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { ok: false };
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number.parseInt(startText, 10);
    end = endText ? Number.parseInt(endText, 10) : size - 1;
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return { ok: false };
  }

  end = Math.min(end, size - 1);
  return { ok: true, start, end, length: end - start + 1 };
}

function mediaHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("etag", object.httpEtag);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/octet-stream");
  }
  return headers;
}

// ================================================================
// Music metadata reading (ID3 parsing)
// ================================================================

async function readMusicMetadata(
  env: Env,
  key: string,
): Promise<MusicMetadata & { cover?: EmbeddedCover }> {
  const fallback = inferMusicMetadataFromKey(key);
  if (!key.toLowerCase().endsWith(".mp3")) return fallback;

  try {
    const object = await env.MEDIA_BUCKET.get(key, {
      range: { offset: 0, length: MUSIC_METADATA_READ_BYTES },
    });
    if (!object) return fallback;

    const bytes = new Uint8Array(await object.arrayBuffer());
    const metadata = readMusicMetadataFromBuffer(bytes);
    return {
      title: truncateText(metadata.title || fallback.title, 80),
      artist: truncateText(metadata.artist || fallback.artist, 80),
      album: truncateText(metadata.album || fallback.album, 80),
      cover: metadata.cover,
    };
  } catch {
    return fallback;
  }
}

function inferMusicMetadataFromKey(key: string): MusicMetadata {
  const fileName = getFileNameFromKey(key);
  const baseName = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_]+/g, " ")
    .trim();
  const parts = baseName.split(/\s+-\s+/).map(cleanMetadataText).filter(Boolean);

  if (parts.length >= 2) {
    return {
      title: truncateText(parts[0], 80),
      artist: truncateText(parts.slice(1).join(" - "), 80),
      album: "",
    };
  }
  return {
    title: truncateText(cleanMetadataText(baseName) || fileName, 80),
    artist: "",
    album: "",
  };
}

function getFileNameFromKey(key: string): string {
  const fileName = stripMediaPrefix(key, "music").split("/").pop() ?? key;
  return safeDecodeURIComponent(fileName);
}
