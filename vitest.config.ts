import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		// Cloudflare Worker modules use Web APIs (crypto, TextEncoder, etc.)
		// which are available in Node 22+ and in the vitest environment.
	},
});
