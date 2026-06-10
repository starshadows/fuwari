import { type CollectionEntry, getCollection } from "astro:content";
import fs from "node:fs/promises";
import path from "node:path";
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { getCategoryUrl, getPostSlugById } from "@utils/url-utils.ts";

const postsDir = path.join(process.cwd(), "src", "content", "posts");

async function hasLocalPostFiles(dir = postsDir): Promise<boolean> {
	try {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const entryPath = path.join(dir, entry.name);
			if (entry.isFile() && /\.md$/i.test(entry.name)) return true;
			if (entry.isDirectory() && (await hasLocalPostFiles(entryPath))) {
				return true;
			}
		}
	} catch {
		return false;
	}
	return false;
}

async function getPostEntries(): Promise<CollectionEntry<"posts">[]> {
	if (!(await hasLocalPostFiles())) return [];
	return getCollection("posts", ({ data }) => {
		return import.meta.env.PROD ? data.draft !== true : true;
	});
}

// // Retrieve posts and sort them by publication date
async function getRawSortedPosts() {
	const allBlogPosts = await getPostEntries();

	const sorted = [...allBlogPosts].sort((a, b) => {
		const dateA = new Date(a.data.published);
		const dateB = new Date(b.data.published);
		return dateA > dateB ? -1 : 1;
	});
	return sorted;
}

export async function getSortedPosts(): Promise<CollectionEntry<"posts">[]> {
	const sorted = await getRawSortedPosts();

	return sorted.map((post, index) => {
		const newerPost = sorted[index - 1];
		const olderPost = sorted[index + 1];
		return {
			...post,
			data: {
				...post.data,
				nextSlug: newerPost ? getPostSlugById(newerPost.id) : "",
				nextTitle: newerPost?.data.title ?? "",
				prevSlug: olderPost ? getPostSlugById(olderPost.id) : "",
				prevTitle: olderPost?.data.title ?? "",
			},
		};
	});
}
export type PostForList = {
	slug: string;
	data: CollectionEntry<"posts">["data"];
};
export async function getSortedPostsList(): Promise<PostForList[]> {
	const sortedFullPosts = await getRawSortedPosts();

	// delete post.body
	const sortedPostsList = sortedFullPosts.map((post) => ({
		slug: getPostSlugById(post.id),
		data: { ...post.data },
	}));

	return sortedPostsList;
}
export type Tag = {
	name: string;
	count: number;
};

export async function getTagList(): Promise<Tag[]> {
	const allBlogPosts = await getPostEntries();

	const countMap: { [key: string]: number } = {};
	allBlogPosts.forEach((post: { data: { tags: string[] } }) => {
		post.data.tags.forEach((tag: string) => {
			if (!countMap[tag]) countMap[tag] = 0;
			countMap[tag]++;
		});
	});

	// sort tags
	const keys: string[] = Object.keys(countMap).sort((a, b) => {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	return keys.map((key) => ({ name: key, count: countMap[key] }));
}

export type Category = {
	name: string;
	count: number;
	url: string;
};

export async function getCategoryList(): Promise<Category[]> {
	const allBlogPosts = await getPostEntries();
	const count: { [key: string]: number } = {};
	allBlogPosts.forEach((post: { data: { category: string | null } }) => {
		if (!post.data.category) {
			const ucKey = i18n(I18nKey.uncategorized);
			count[ucKey] = count[ucKey] ? count[ucKey] + 1 : 1;
			return;
		}

		const categoryName =
			typeof post.data.category === "string"
				? post.data.category.trim()
				: String(post.data.category).trim();

		count[categoryName] = count[categoryName] ? count[categoryName] + 1 : 1;
	});

	const lst = Object.keys(count).sort((a, b) => {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	const ret: Category[] = [];
	for (const c of lst) {
		ret.push({
			name: c,
			count: count[c],
			url: getCategoryUrl(c),
		});
	}
	return ret;
}
