import type { Env } from "./types";
import type { MusicObjectInfo, MusicMetadata, EmbeddedCover } from "./types/aliases";
import {
  json,
  readString,
  readJson,
  readInteger,
  readBoolean,
  safeNormalizeMediaKey,
  stripMediaPrefix,
  sanitizeFileName,
  safeDecodeURIComponent,
  isAvatarUrl,
  cachedResponse,
} from "./utils";
import {
  MUSIC_PREFIX,
  MUSIC_OBJECT_SCAN_LIMIT,
  MUSIC_METADATA_READ_BYTES,
  AUDIO_EXTENSIONS,
} from "./constants";

// ================================================================
// Public: GET /api/music/tracks
// ================================================================

export async function getPublicMusicTracks(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, title, artist, album, object_key AS objectKey, cover_url AS coverUrl
     FROM music_tracks
     WHERE is_active = 1
     ORDER BY sort_order ASC, created_at DESC`,
  ).all();

  const tracks = (result.results ?? []).map((track) => {
    const row = track as Record<string, string | number>;
    return {
      id: row.id,
      title: row.title,
      artist: row.artist,
      album: row.album,
      objectKey: row.objectKey,
      coverUrl:
        row.coverUrl ||
        embeddedCoverUrlForMusicKey(String(row.objectKey)),
      audioUrl: `/media/music/${stripMediaPrefix(
        String(row.objectKey),
        "music",
      )}`,
    };
  });

  return json({ tracks });
}

function embeddedCoverUrlForMusicKey(objectKey: string): string {
  const key = safeNormalizeMediaKey(objectKey, "music");
  if (!key) return "";
  if (!key.toLowerCase().endsWith(".mp3")) return "";
  return `/media/covers/from-music/${stripMediaPrefix(key, "music")}`;
}

// ================================================================
// Admin: list music
// ================================================================

export async function listAdminMusic(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, title, artist, album, object_key AS objectKey, cover_url AS coverUrl,
            is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
            updated_at AS updatedAt
     FROM music_tracks
     ORDER BY sort_order ASC, created_at DESC`,
  ).all();
  return json({ tracks: result.results ?? [] });
}

// ================================================================
// Admin: list R2 music objects
// ================================================================

export async function listR2MusicObjects(env: Env): Promise<Response> {
  if (!env.MEDIA_BUCKET) {
    return json(
      { error: "Missing R2 binding. Bind an R2 bucket as MEDIA_BUCKET first." },
      503,
    );
  }
  const objects = await scanR2MusicObjects(env);
  return json({ objects: objects.map(stripCoverBytes) });
}

// ================================================================
// Admin: import R2 music objects
// ================================================================

export async function importR2MusicObjects(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.MEDIA_BUCKET) {
    return json(
      { error: "Missing R2 binding. Bind an R2 bucket as MEDIA_BUCKET first." },
      503,
    );
  }

  const body = await readJson(request);
  const requestedKeys = Array.isArray(body.objectKeys)
    ? (body.objectKeys as string[])
        .filter((key): key is string => typeof key === "string")
        .map((key) => safeNormalizeMediaKey(key, "music"))
        .filter((key): key is string => Boolean(key))
    : [];
  const isActive = readBoolean(body.isActive, true) ? 1 : 0;
  const objects = await scanR2MusicObjects(env);
  const requestedKeySet = new Set(requestedKeys);
  const candidates = objects.filter((obj) => {
    if (obj.imported) return false;
    return requestedKeySet.size === 0 || requestedKeySet.has(obj.key);
  });

  if (candidates.length === 0) {
    return json({ ok: true, imported: [], message: "没有可导入的新音乐。" });
  }

  const maxSortRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM music_tracks",
  ).first<{ maxSort: number }>();
  let sortOrder =
    readInteger(body.sortOrderStart, Number(maxSortRow?.maxSort ?? 0) + 1);
  const imported: Record<string, unknown>[] = [];

  for (const obj of candidates) {
    const coverUrl = obj.cover
      ? await saveEmbeddedCover(env, obj.key, obj.cover)
      : "";
    const result = await env.DB.prepare(
      `INSERT INTO music_tracks
       (title, artist, album, object_key, cover_url, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(obj.title, obj.artist, obj.album, obj.key, coverUrl, isActive, sortOrder)
      .run();

    imported.push({
      id: result.meta.last_row_id,
      title: obj.title,
      artist: obj.artist,
      album: obj.album,
      objectKey: obj.key,
      coverUrl,
      isActive,
      sortOrder,
    });
    sortOrder += 1;
  }

  return json({ ok: true, imported }, 201);
}

// ================================================================
// Admin: create / update / delete music track
// ================================================================

export async function createMusicTrack(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson(request);
  const title = readString(body.title, 80);
  const artist = readString(body.artist, 80);
  const album = readString(body.album, 80);
  const objectKey = safeNormalizeMediaKey(
    readString(body.objectKey, 500),
    "music",
  );
  const coverUrl = readString(body.coverUrl, 600);
  const sortOrder = readInteger(body.sortOrder, 0);
  const isActive = readBoolean(body.isActive, true) ? 1 : 0;

  if (!title || !objectKey) {
    return json({ error: "请填写歌曲名称和 R2 音频 Key。" }, 400);
  }

  if (coverUrl && !isAvatarUrl(coverUrl)) {
    return json({ error: "封面地址需要是公网图片或站内头像地址。" }, 400);
  }

  const result = await env.DB.prepare(
    `INSERT INTO music_tracks
     (title, artist, album, object_key, cover_url, is_active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(title, artist, album, objectKey, coverUrl, isActive, sortOrder)
    .run();

  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

export async function updateMusicTrack(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  if (!Number.isInteger(id)) return json({ error: "歌曲 ID 不正确。" }, 400);

  const body = await readJson(request);
  const fields: string[] = [];
  const values: (string | number)[] = [];

  if (typeof body.title === "string") { fields.push("title = ?"); values.push(readString(body.title, 80)); }
  if (typeof body.artist === "string") { fields.push("artist = ?"); values.push(readString(body.artist, 80)); }
  if (typeof body.album === "string") { fields.push("album = ?"); values.push(readString(body.album, 80)); }
  if (typeof body.objectKey === "string") {
    const v = safeNormalizeMediaKey(readString(body.objectKey, 500), "music");
    if (!v) return json({ error: "R2 音频 Key 不正确。" }, 400);
    fields.push("object_key = ?");
    values.push(v);
  }
  if (typeof body.coverUrl === "string") {
    const v = readString(body.coverUrl, 600);
    if (v && !isAvatarUrl(v)) return json({ error: "封面地址不正确。" }, 400);
    fields.push("cover_url = ?");
    values.push(v);
  }
  if (typeof body.isActive === "boolean") { fields.push("is_active = ?"); values.push(body.isActive ? 1 : 0); }
  if (typeof body.sortOrder === "number" || typeof body.sortOrder === "string") {
    fields.push("sort_order = ?");
    values.push(readInteger(body.sortOrder, 0));
  }

  if (fields.length > 0) {
    await env.DB.prepare(
      `UPDATE music_tracks SET ${fields.join(", ")} WHERE id = ?`,
    )
      .bind(...values, id)
      .run();
  }

  const track = await env.DB.prepare(
    `SELECT id, title, artist, album, object_key AS objectKey, cover_url AS coverUrl,
            is_active AS isActive, sort_order AS sortOrder, created_at AS createdAt,
            updated_at AS updatedAt
     FROM music_tracks WHERE id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();

  if (!track) return json({ error: "歌曲不存在。" }, 404);
  return json({ track });
}

export async function deleteMusicTrack(
  env: Env,
  id: number,
): Promise<Response> {
  if (!Number.isInteger(id)) return json({ error: "歌曲 ID 不正确。" }, 400);
  await env.DB.prepare("DELETE FROM music_tracks WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ================================================================
// R2 scanning helpers
// ================================================================

async function scanR2MusicObjects(env: Env): Promise<MusicObjectInfo[]> {
  const existingKeys = await getExistingMusicKeys(env);
  const objects: MusicObjectInfo[] = [];
  let cursor: string | undefined;

  do {
    const listed = await env.MEDIA_BUCKET.list({
      prefix: MUSIC_PREFIX,
      cursor,
      limit: Math.min(1000, MUSIC_OBJECT_SCAN_LIMIT - objects.length),
    });

    for (const obj of listed.objects) {
      if (objects.length >= MUSIC_OBJECT_SCAN_LIMIT) break;
      if (!isAudioObjectKey(obj.key)) continue;

      const key = safeNormalizeMediaKey(obj.key, "music");
      if (!key) continue;

      const metadata = await readMusicMetadata(env, key);
      const coverUrl = embeddedCoverUrlForMusicKey(key);
      objects.push({
        ...metadata,
        key,
        fileName: getFileNameFromKey(key),
        size: obj.size,
        uploaded:
          obj.uploaded instanceof Date
            ? obj.uploaded.toISOString()
            : String(obj.uploaded),
        imported: existingKeys.has(key),
        audioUrl: `/media/music/${stripMediaPrefix(key, "music")}`,
        coverUrl,
        hasEmbeddedCover: Boolean(metadata.cover),
      });
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && objects.length < MUSIC_OBJECT_SCAN_LIMIT);

  return objects.sort((a, b) =>
    a.fileName.localeCompare(b.fileName, "zh-Hans-CN"),
  );
}

function stripCoverBytes(
  obj: MusicObjectInfo,
): Omit<MusicObjectInfo, "cover"> {
  const { cover: _c, ...safe } = obj;
  return safe;
}

async function getExistingMusicKeys(env: Env): Promise<Set<string>> {
  const result = await env.DB.prepare(
    "SELECT object_key AS objectKey FROM music_tracks",
  ).all();

  return new Set(
    (result.results ?? [])
      .map((row) => String((row as Record<string, unknown>).objectKey ?? ""))
      .map((key) => safeNormalizeMediaKey(key, "music"))
      .filter((key): key is string => Boolean(key)),
  );
}

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
    const parsed = parseId3Metadata(bytes);
    return {
      title: truncateText(parsed.title || fallback.title, 80),
      artist: truncateText(parsed.artist || fallback.artist, 80),
      album: truncateText(parsed.album || fallback.album, 80),
      cover: parsed.cover,
    };
  } catch {
    return fallback;
  }
}

function isAudioObjectKey(key: string): boolean {
  if (key.endsWith("/")) return false;
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.has(ext);
}

function getFileNameFromKey(key: string): string {
  const fileName = stripMediaPrefix(key, "music").split("/").pop() ?? key;
  return safeDecodeURIComponent(fileName);
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

function cleanMetadataText(value: string): string {
  return value
    .replace(/ +/g, " / ")
    .replace(/\s+\/\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

async function saveEmbeddedCover(
  env: Env,
  musicKey: string,
  cover: EmbeddedCover,
): Promise<string> {
  const ext = imageExtensionFromMimeType(cover.mimeType);
  const baseName = sanitizeFileName(
    getFileNameFromKey(musicKey).replace(/\.[^.]+$/, ""),
  );
  const key = `covers/${baseName}-${crypto.randomUUID()}.${ext}`;
  await env.MEDIA_BUCKET.put(key, cover.bytes, {
    httpMetadata: { contentType: cover.mimeType },
  });
  return `/media/covers/${stripMediaPrefix(key, "covers")}`;
}

function imageExtensionFromMimeType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

// ID3 parsing (re-exported from media.ts but duplicated for import isolation)
// These are identical to the ones in media.ts; we keep them here for independence.
function parseId3Metadata(
  bytes: Uint8Array,
): Partial<MusicMetadata> & { cover?: EmbeddedCover } {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") return {};
  const version = bytes[3];
  if (version < 3 || version > 4) return {};

  const flags = bytes[5];
  const tagSize = readSyncSafeInteger(bytes, 6);
  const end = Math.min(bytes.length, 10 + tagSize);
  let offset = 10;

  if (flags & 0x40) {
    if (offset + 4 > end) return {};
    const extSize = version === 4
      ? readSyncSafeInteger(bytes, offset)
      : readUint32(bytes, offset);
    offset += version === 4 ? extSize : extSize + 4;
  }

  const frameMap: Record<string, keyof MusicMetadata> = { TIT2: "title", TPE1: "artist", TALB: "album" };
  const result: Partial<MusicMetadata> & { cover?: EmbeddedCover } = {};

  while (offset + 10 <= end) {
    const frameId = ascii(bytes, offset, 4);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

    const frameSize = version === 4
      ? readSyncSafeInteger(bytes, offset + 4)
      : readUint32(bytes, offset + 4);
    if (frameSize <= 0) break;

    const fs = offset + 10;
    const fe = Math.min(fs + frameSize, end);
    const field = frameMap[frameId];

    if (field && fs < fe) {
      const val = decodeId3Text(bytes.slice(fs, fe));
      if (val) result[field] = val;
    } else if (frameId === "APIC" && fs < fe && !result.cover) {
      result.cover = parseApicFrame(bytes.slice(fs, fe));
    }

    offset = fe;
  }

  return result;
}

function decodeId3Text(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const enc = bytes[0];
  let payload = bytes.slice(1);
  let decoder: TextDecoder;

  if (enc === 1) {
    if (payload[0] === 0xfe && payload[1] === 0xff) {
      decoder = new TextDecoder("utf-16be");
      payload = payload.slice(2);
    } else {
      decoder = new TextDecoder("utf-16le");
      if (payload[0] === 0xff && payload[1] === 0xfe) payload = payload.slice(2);
    }
  } else if (enc === 2) {
    decoder = new TextDecoder("utf-16be");
  } else if (enc === 3) {
    decoder = new TextDecoder("utf-8");
  } else {
    decoder = new TextDecoder("iso-8859-1");
  }

  return cleanMetadataText(decoder.decode(payload));
}

function parseApicFrame(bytes: Uint8Array): EmbeddedCover | undefined {
  if (bytes.length < 5) return undefined;
  const enc = bytes[0];
  let off = 1;
  const mimeEnd = indexOfTerminator(bytes, off, 1);
  if (mimeEnd < 0) return undefined;
  const mimeType = cleanMetadataText(new TextDecoder("iso-8859-1").decode(bytes.slice(off, mimeEnd))).toLowerCase();
  off = mimeEnd + 1;
  if (!mimeType.startsWith("image/") || off >= bytes.length) return undefined;
  off += 1;
  const termLen = enc === 1 || enc === 2 ? 2 : 1;
  const descEnd = indexOfTerminator(bytes, off, termLen);
  if (descEnd < 0) return undefined;
  const imgStart = descEnd + termLen;
  if (imgStart >= bytes.length) return undefined;
  return { mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType, bytes: bytes.slice(imgStart) };
}

function indexOfTerminator(bytes: Uint8Array, start: number, termLen: 1 | 2): number {
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
  return (((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);
}

function readSyncSafeInteger(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3]);
}
