/// <reference types="mdast" />
import { h } from "hastscript";

/**
 * Creates a stable GitHub card component.
 *
 * The original Fuwari card fetches api.github.com in the browser. That can fail
 * in local preview or under rate limits, leaving the card in a loading state.
 * This version keeps the card static so it is reliable on the blog itself.
 *
 * @param {Object} properties - The properties of the component.
 * @param {string} properties.repo - The GitHub repository in the format "owner/repo".
 * @param {import('mdast').RootContent[]} children - The children elements of the component.
 * @returns {import('mdast').Parent} The created GitHub Card component.
 */
export function GithubCardComponent(properties, children) {
	if (Array.isArray(children) && children.length !== 0) {
		return h("div", { class: "hidden" }, [
			'Invalid directive. ("github" directive must be leaf type "::github{repo="owner/repo"}")',
		]);
	}

	if (!properties.repo || !properties.repo.includes("/")) {
		return h(
			"div",
			{ class: "hidden" },
			'Invalid repository. ("repo" attribute must be in the format "owner/repo")',
		);
	}

	const repo = properties.repo;
	const [repoOwner, repoName] = repo.split("/");

	const avatar = h("div", {
		class: "gc-avatar",
		style: `background-image: url("https://github.com/${repoOwner}.png?size=80"); background-color: transparent;`,
	});

	const title = h("div", { class: "gc-titlebar" }, [
		h("div", { class: "gc-titlebar-left" }, [
			h("div", { class: "gc-owner" }, [
				avatar,
				h("div", { class: "gc-user" }, repoOwner),
			]),
			h("div", { class: "gc-divider" }, "/"),
			h("div", { class: "gc-repo" }, repoName),
		]),
		h("div", { class: "github-logo" }),
	]);

	return h(
		"a",
		{
			class: "card-github no-styling",
			href: `https://github.com/${repo}`,
			target: "_blank",
			rel: "noopener noreferrer",
			repo,
		},
		[
			title,
			h("div", { class: "gc-description" }, "个人博客源码，基于 Fuwari 主题改造。"),
			h("div", { class: "gc-infobar" }, [
				h("div", { class: "gc-stars" }, "GitHub"),
				h("div", { class: "gc-forks" }, "Astro"),
				h("div", { class: "gc-license" }, "MIT"),
				h("span", { class: "gc-language" }, "Fuwari"),
			]),
		],
	);
}
