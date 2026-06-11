import { unified } from "@astrojs/markdown-remark";
import sitemap from "@astrojs/sitemap";
import svelte from "@astrojs/svelte";
import { pluginCollapsibleSections } from "@expressive-code/plugin-collapsible-sections";
import { pluginLineNumbers } from "@expressive-code/plugin-line-numbers";
import swup from "@swup/astro";
import { defineConfig } from "astro/config";
import expressiveCode from "astro-expressive-code";
import icon from "astro-icon";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeComponents from "rehype-components"; /* Render the custom directive content */
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkDirective from "remark-directive"; /* Handle directives */
import remarkGithubAdmonitionsToDirectives from "remark-github-admonitions-to-directives";
import remarkMath from "remark-math";
import remarkSectionize from "remark-sectionize";
import { expressiveCodeConfig } from "./src/config.ts";
import { pluginCustomCopyButton } from "./src/plugins/expressive-code/custom-copy-button.js";
import { pluginLanguageBadge } from "./src/plugins/expressive-code/language-badge.ts";
import { AdmonitionComponent } from "./src/plugins/rehype-component-admonition.mjs";
import { GithubCardComponent } from "./src/plugins/rehype-component-github-card.mjs";
import { parseDirectiveNode } from "./src/plugins/remark-directive-rehype.js";
import { remarkExcerpt } from "./src/plugins/remark-excerpt.js";
import { remarkReadingTime } from "./src/plugins/remark-reading-time.mjs";

const site = process.env.PUBLIC_SITE_ORIGIN || "http://localhost:4321";
const KNOWN_ASTRO_EXPRESSIVE_CODE_MARKDOWN_WARNING =
	"`markdown.remarkPlugins`, `markdown.rehypePlugins`, and `markdown.remarkRehype` are deprecated";
const KNOWN_TWIKOO_CHUNK_WARNING =
	/chunks\/twikoo\.[^\s]+\.js is larger than 500 kB after minification/;

const originalProcessStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
	const message =
		chunk instanceof Uint8Array ? chunk.toString() : String(chunk);
	if (message.includes(KNOWN_ASTRO_EXPRESSIVE_CODE_MARKDOWN_WARNING)) {
		return true;
	}
	return originalProcessStderrWrite(chunk, ...args);
};

// https://astro.build/config
export default defineConfig({
	site,
	base: "/",
	trailingSlash: "always",
	integrations: [
		swup({
			theme: false,
			animationClass: "transition-swup-", // see https://swup.js.org/options/#animationselector
			// the default value `transition-` cause transition delay
			// when the Tailwind class `transition-all` is used
			containers: ["main", "#toc"],
			smoothScrolling: false,
			cache: true,
			preload: false,
			accessibility: true,
			updateHead: true,
			updateBodyClass: false,
			globalInstance: true,
		}),
		icon({
			include: {
				"fa6-brands": ["*"],
				"fa6-regular": ["*"],
				"fa6-solid": ["*"],
				"material-symbols": ["*"],
			},
		}),
		expressiveCode({
			themes: [expressiveCodeConfig.theme, expressiveCodeConfig.theme],
			plugins: [
				pluginCollapsibleSections(),
				pluginLineNumbers(),
				pluginLanguageBadge(),
				pluginCustomCopyButton(),
			],
			defaultProps: {
				wrap: true,
				overridesByLang: {
					shellsession: {
						showLineNumbers: false,
					},
				},
			},
			styleOverrides: {
				codeBackground: "var(--codeblock-bg)",
				borderRadius: "0.75rem",
				borderColor: "none",
				codeFontSize: "0.875rem",
				codeFontFamily:
					"'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
				codeLineHeight: "1.5rem",
				frames: {
					editorBackground: "var(--codeblock-bg)",
					terminalBackground: "var(--codeblock-bg)",
					terminalTitlebarBackground: "var(--codeblock-topbar-bg)",
					editorTabBarBackground: "var(--codeblock-topbar-bg)",
					editorActiveTabBackground: "none",
					editorActiveTabIndicatorBottomColor: "var(--primary)",
					editorActiveTabIndicatorTopColor: "none",
					editorTabBarBorderBottomColor: "var(--codeblock-topbar-bg)",
					terminalTitlebarBorderBottomColor: "none",
				},
				textMarkers: {
					delHue: 0,
					insHue: 180,
					markHue: 250,
				},
			},
			frames: {
				showCopyToClipboardButton: false,
			},
		}),
		svelte(),
		sitemap(),
	],
	markdown: {
		processor: unified({
			remarkPlugins: [
				remarkMath,
				remarkReadingTime,
				remarkExcerpt,
				remarkGithubAdmonitionsToDirectives,
				remarkDirective,
				remarkSectionize,
				parseDirectiveNode,
			],
			rehypePlugins: [
				rehypeKatex,
				rehypeSlug,
				[
					rehypeComponents,
					{
						components: {
							github: GithubCardComponent,
							note: (x, y) => AdmonitionComponent(x, y, "note"),
							tip: (x, y) => AdmonitionComponent(x, y, "tip"),
							important: (x, y) => AdmonitionComponent(x, y, "important"),
							caution: (x, y) => AdmonitionComponent(x, y, "caution"),
							warning: (x, y) => AdmonitionComponent(x, y, "warning"),
						},
					},
				],
				[
					rehypeAutolinkHeadings,
					{
						behavior: "append",
						properties: {
							className: ["anchor"],
						},
						content: {
							type: "element",
							tagName: "span",
							properties: {
								className: ["anchor-icon"],
								"data-pagefind-ignore": true,
							},
							children: [
								{
									type: "text",
									value: "#",
								},
							],
						},
					},
				],
			],
		}),
	},
	vite: {
		server: {
			proxy: {
				"/api": {
					target: "http://localhost:8787",
					changeOrigin: true,
				},
				"/media": {
					target: "http://localhost:8787",
					changeOrigin: true,
				},
			},
		},
		build: {
			chunkSizeWarningLimit: 1000,
			rollupOptions: {
				output: {
					manualChunks(id) {
						if (id.includes("/node_modules/photoswipe/")) return "photoswipe";
						if (id.includes("/node_modules/twikoo/")) return "twikoo";
					},
				},
				onwarn(warning, warn) {
					if (KNOWN_TWIKOO_CHUNK_WARNING.test(warning.message)) {
						return;
					}
					if (
						warning.message.includes("is dynamically imported by") &&
						warning.message.includes("but also statically imported by")
					) {
						return;
					}
					if (
						warning.code === "INVALID_ANNOTATION" &&
						warning.message.includes('"/* @__PURE__ */"') &&
						warning.message.includes("Rollup cannot interpret") &&
						warning.id?.endsWith(".svelte")
					) {
						return;
					}
					if (
						warning.message.includes(
							"Error when using sourcemap for reporting an error",
						) &&
						warning.message.includes("Can't resolve original location") &&
						warning.id?.endsWith(".svelte")
					) {
						return;
					}
					warn(warning);
				},
			},
		},
	},
});
