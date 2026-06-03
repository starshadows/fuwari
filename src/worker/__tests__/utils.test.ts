import { describe, expect, it } from "vitest";
import {
	base64UrlDecode,
	base64UrlEncode,
	clampInteger,
	isAvatarUrl,
	isHttpsUrl,
	isLikelyBot,
	isSameOrigin,
	maskSecret,
	md5,
	normalizeFriendHostname,
	readBoolean,
	readInteger,
	readString,
	rejectOversizedBody,
	safeDecodeURIComponent,
	safeNormalizeMediaKey,
	sanitizeFileName,
	stripMediaPrefix,
	timingSafeEqual,
} from "../utils";

// ================================================================
// md5
// ================================================================
describe("md5", () => {
	it("matches RFC 1321 / Node crypto compatible vectors", () => {
		expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
		expect(md5("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
		expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
		expect(md5("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
	});

	it("hashes UTF-8 input like blueimp-md5", () => {
		expect(md5("my-secret")).toBe("935571b8f79add9eacb3b622f95ad3a6");
		expect(md5("中文密码")).toBe("3d4acf94adca8562b4990599b15488de");
		expect(md5("😀")).toBe("2a02eac39d716a70ecf37579185927b6");
	});
});

// ================================================================
// readString
// ================================================================
describe("readString", () => {
	it("returns trimmed string within maxLength", () => {
		expect(readString("  hello  ", 10)).toBe("hello");
	});

	it("truncates to maxLength", () => {
		expect(readString("hello world", 5)).toBe("hello");
	});

	it("returns empty string for non-string input", () => {
		expect(readString(123, 10)).toBe("");
		expect(readString(null, 10)).toBe("");
		expect(readString(undefined, 10)).toBe("");
		expect(readString({}, 10)).toBe("");
	});
});

// ================================================================
// readInteger
// ================================================================
describe("readInteger", () => {
	it("returns integer for number input", () => {
		expect(readInteger(42, 0)).toBe(42);
	});

	it("parses numeric string", () => {
		expect(readInteger("42", 0)).toBe(42);
	});

	it("returns fallback for invalid input", () => {
		expect(readInteger("abc", 10)).toBe(10);
		expect(readInteger(null, 10)).toBe(10);
	});

	it("truncates floats", () => {
		expect(readInteger(3.14, 0)).toBe(3);
	});
});

// ================================================================
// readBoolean
// ================================================================
describe("readBoolean", () => {
	it("returns boolean values directly", () => {
		expect(readBoolean(true, false)).toBe(true);
		expect(readBoolean(false, true)).toBe(false);
	});

	it("coerces truthy values", () => {
		expect(readBoolean(1, false)).toBe(true);
		expect(readBoolean("true", false)).toBe(true);
	});

	it("coerces falsy values", () => {
		expect(readBoolean(0, true)).toBe(false);
		expect(readBoolean("false", true)).toBe(false);
	});

	it("returns fallback for unrecognised values", () => {
		expect(readBoolean("yes", true)).toBe(true);
		expect(readBoolean({}, false)).toBe(false);
	});
});

// ================================================================
// clampInteger
// ================================================================
describe("clampInteger", () => {
	it("returns value when within range", () => {
		expect(clampInteger(5, 0, 10)).toBe(5);
	});

	it("clamps to minimum", () => {
		expect(clampInteger(-1, 0, 10)).toBe(0);
	});

	it("clamps to maximum", () => {
		expect(clampInteger(15, 0, 10)).toBe(10);
	});
});

// ================================================================
// safeNormalizeMediaKey
// ================================================================
describe("safeNormalizeMediaKey", () => {
	it("returns prefixed key for valid input", () => {
		expect(safeNormalizeMediaKey("song.mp3", "music")).toBe("music/song.mp3");
	});

	it("removes duplicate prefix", () => {
		expect(safeNormalizeMediaKey("music/song.mp3", "music")).toBe(
			"music/song.mp3",
		);
	});

	it("rejects path traversal", () => {
		expect(safeNormalizeMediaKey("../../../etc/passwd", "music")).toBeNull();
	});

	it("rejects empty segments", () => {
		expect(safeNormalizeMediaKey("music//song.mp3", "music")).toBeNull();
	});

	it("rejects invalid prefix", () => {
		expect(safeNormalizeMediaKey("hacked", "malware")).toBeNull();
	});
});

// ================================================================
// safeDecodeURIComponent
// ================================================================
describe("safeDecodeURIComponent", () => {
	it("decodes valid URI components", () => {
		expect(safeDecodeURIComponent("hello%20world")).toBe("hello world");
	});

	it("returns original on malformed input", () => {
		expect(safeDecodeURIComponent("%ZZ")).toBe("%ZZ");
	});
});

// ================================================================
// stripMediaPrefix
// ================================================================
describe("stripMediaPrefix", () => {
	it("removes prefix", () => {
		expect(stripMediaPrefix("music/song.mp3", "music")).toBe("song.mp3");
	});

	it("leaves unprefixed value unchanged", () => {
		expect(stripMediaPrefix("song.mp3", "music")).toBe("song.mp3");
	});
});

// ================================================================
// base64UrlEncode / base64UrlDecode
// ================================================================
describe("base64UrlEncode / base64UrlDecode", () => {
	it("round-trips correctly", () => {
		const input = '{"hello":"world"}';
		const encoded = base64UrlEncode(input);
		expect(encoded).not.toContain("+");
		expect(encoded).not.toContain("/");
		expect(encoded).not.toContain("=");
		expect(base64UrlDecode(encoded)).toBe(input);
	});
});

// ================================================================
// timingSafeEqual
// ================================================================
describe("timingSafeEqual", () => {
	it("returns true for equal strings", () => {
		expect(timingSafeEqual("abc", "abc")).toBe(true);
	});

	it("returns false for different strings", () => {
		expect(timingSafeEqual("abc", "def")).toBe(false);
	});

	it("returns false for different lengths", () => {
		expect(timingSafeEqual("abc", "ab")).toBe(false);
	});
});

// ================================================================
// rejectOversizedBody
// ================================================================
describe("rejectOversizedBody", () => {
	function requestWithLength(length?: string): Request {
		const headers: Record<string, string> = {};
		if (length !== undefined) headers["content-length"] = length;
		return new Request("https://example.com/api/test", {
			method: "POST",
			headers,
			body: "{}",
		});
	}

	it("allows body sizes within the limit", () => {
		expect(rejectOversizedBody(requestWithLength("10"), 10)).toBeNull();
	});

	it("rejects body sizes over the limit", () => {
		const res = rejectOversizedBody(requestWithLength("11"), 10);
		expect(res?.status).toBe(413);
	});

	it("rejects invalid content-length values", () => {
		expect(rejectOversizedBody(requestWithLength("invalid"), 10)?.status).toBe(
			413,
		);
		expect(rejectOversizedBody(requestWithLength("-1"), 10)?.status).toBe(413);
	});

	it("allows requests without content-length", () => {
		expect(rejectOversizedBody(requestWithLength(), 10)).toBeNull();
	});
});

// ================================================================
// maskSecret
// ================================================================
describe("maskSecret", () => {
	it("returns empty for empty input", () => {
		expect(maskSecret("")).toBe("");
	});

	it("returns stars for short values", () => {
		expect(maskSecret("abcd")).toBe("********");
	});

	it("shows first 4 and last 4 for long values", () => {
		expect(maskSecret("1234567890abcdef")).toBe("1234...cdef");
	});
});

// ================================================================
// isSameOrigin
// ================================================================
describe("isSameOrigin", () => {
	it("returns true for same origin", () => {
		expect(
			isSameOrigin("https://example.com/page", "https://example.com/other"),
		).toBe(true);
	});

	it("returns false for different origins", () => {
		expect(isSameOrigin("https://attacker.com", "https://example.com")).toBe(
			false,
		);
	});

	it("returns false for invalid URLs", () => {
		expect(isSameOrigin("not-a-url", "https://example.com")).toBe(false);
	});
});

// ================================================================
// normalizeFriendHostname
// ================================================================
describe("normalizeFriendHostname", () => {
	it("lowercases and strips paths", () => {
		expect(normalizeFriendHostname("https://Example.COM/path")).toBe(
			"example.com",
		);
	});

	it("folds a leading www subdomain", () => {
		expect(normalizeFriendHostname("https://www.example.com/")).toBe(
			"example.com",
		);
	});

	it("keeps non-www subdomains distinct", () => {
		expect(normalizeFriendHostname("https://blog.example.com/")).toBe(
			"blog.example.com",
		);
	});

	it("returns empty string for invalid URLs", () => {
		expect(normalizeFriendHostname("not-a-url")).toBe("");
	});
});

// ================================================================
// isHttpsUrl
// ================================================================
describe("isHttpsUrl", () => {
	it("returns true for HTTPS URLs", () => {
		expect(isHttpsUrl("https://example.com")).toBe(true);
	});

	it("returns false for HTTP URLs", () => {
		expect(isHttpsUrl("http://example.com")).toBe(false);
	});

	it("returns false for invalid input", () => {
		expect(isHttpsUrl("not-a-url")).toBe(false);
	});
});

// ================================================================
// isAvatarUrl
// ================================================================
describe("isAvatarUrl", () => {
	it("accepts HTTPS URLs", () => {
		expect(isAvatarUrl("https://example.com/avatar.png")).toBe(true);
	});

	it("accepts internal avatar paths", () => {
		expect(isAvatarUrl("/media/avatars/user123.jpg")).toBe(true);
	});

	it("rejects HTTP URLs", () => {
		expect(isAvatarUrl("http://example.com/avatar.png")).toBe(false);
	});

	it("rejects invalid paths", () => {
		expect(isAvatarUrl("/media/avatars/../../etc/passwd")).toBe(false);
	});
});

// ================================================================
// sanitizeFileName
// ================================================================
describe("sanitizeFileName", () => {
	it("preserves valid file names", () => {
		expect(sanitizeFileName("song.mp3")).toBe("song.mp3");
	});

	it("replaces invalid characters", () => {
		expect(sanitizeFileName("song name!.mp3")).toBe("song-name-.mp3");
	});

	it("defaults to avatar for empty result", () => {
		expect(sanitizeFileName("!!!")).toBe("---");
	});
});

// ================================================================
// isLikelyBot
// ================================================================
describe("isLikelyBot", () => {
	function mockRequest(userAgent: string): Request {
		return new Request("https://example.com", {
			headers: { "user-agent": userAgent },
		});
	}

	it("detects Googlebot", () => {
		expect(isLikelyBot(mockRequest("Googlebot/2.1"))).toBe(true);
	});

	it("detects curl", () => {
		expect(isLikelyBot(mockRequest("curl/8.0"))).toBe(true);
	});

	it("passes human browsers", () => {
		expect(
			isLikelyBot(mockRequest("Mozilla/5.0 (Windows NT 10.0) Chrome/120")),
		).toBe(false);
	});
});
