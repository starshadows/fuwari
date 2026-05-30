import { describe, it, expect } from "vitest";
import {
	readString,
	readInteger,
	readBoolean,
	clampInteger,
	safeNormalizeMediaKey,
	safeDecodeURIComponent,
	stripMediaPrefix,
	base64UrlEncode,
	base64UrlDecode,
	timingSafeEqual,
	maskSecret,
	isSameOrigin,
	isHttpsUrl,
	isAvatarUrl,
	sanitizeFileName,
	isLikelyBot,
} from "../utils";

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
		expect(safeNormalizeMediaKey("song.mp3", "music")).toBe(
			"music/song.mp3",
		);
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
		expect(
			isSameOrigin(
				"https://attacker.com",
				"https://example.com",
			),
		).toBe(false);
	});

	it("returns false for invalid URLs", () => {
		expect(isSameOrigin("not-a-url", "https://example.com")).toBe(false);
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
		expect(
			isAvatarUrl("/media/avatars/../../etc/passwd"),
		).toBe(false);
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
			isLikelyBot(
				mockRequest(
					"Mozilla/5.0 (Windows NT 10.0) Chrome/120",
				),
			),
		).toBe(false);
	});
});
