import rss from "@astrojs/rss";
import { getSortedPosts } from "@utils/content-utils";
import { getPostSlugById, url } from "@utils/url-utils";
import type { APIContext } from "astro";
import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import { siteConfig } from "@/config";

const parser = new MarkdownIt();

function stripInvalidXmlChars(str: string): string {
	return str.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: https://www.w3.org/TR/xml/#charsets
		/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
		"",
	);
}

function absolutizeFeedUrls(html: string, postUrl: URL, siteUrl: URL): string {
	return html.replace(
		/\b(src|href)=("|')([^"']+)\2/g,
		(_, attr: string, quote: string, rawValue: string) => {
			if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(rawValue)) {
				return `${attr}=${quote}${rawValue}${quote}`;
			}
			const baseUrl = rawValue.startsWith("/") ? siteUrl : postUrl;
			return `${attr}=${quote}${new URL(rawValue, baseUrl).toString()}${quote}`;
		},
	);
}

export async function GET(context: APIContext): Promise<Response> {
	const blog = await getSortedPosts();
	const siteUrl = new URL(context.site ?? context.url.origin);

	return rss({
		title: siteConfig.title,
		description: siteConfig.subtitle || "No description",
		site: siteUrl,
		items: blog.map((post) => {
			const content =
				typeof post.body === "string" ? post.body : String(post.body || "");
			const cleanedContent = stripInvalidXmlChars(content);
			const postPath = url(`/posts/${getPostSlugById(post.id)}/`);
			const postUrl = new URL(postPath, siteUrl);
			const renderedContent = absolutizeFeedUrls(
				parser.render(cleanedContent),
				postUrl,
				siteUrl,
			);
			return {
				title: post.data.title,
				pubDate: post.data.published,
				description: post.data.description || "",
				link: postPath,
				content: sanitizeHtml(renderedContent, {
					allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
				}),
			};
		}),
		customData: `<language>${siteConfig.lang}</language>`,
	});
}
