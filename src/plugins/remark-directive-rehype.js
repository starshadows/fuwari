import { h } from "hastscript";
import { visit } from "unist-util-visit";

/**
 * Only these directive names are allowed — they map to the rehypeComponents
 * registered in astro.config.mjs.  Any other name is silently dropped to
 * prevent arbitrary HTML tag injection via directive syntax.
 */
const ALLOWED_NAMES = new Set([
	"github",
	"note",
	"tip",
	"important",
	"caution",
	"warning",
]);

/**
 * Per-directive attribute allowlist.  Only these attributes are forwarded
 * to the generated HTML element.  Everything else is stripped.
 */
const ALLOWED_ATTRS = new Set([
	"repo", // github card
	"title", // admonition / github
	"className", // admonition style variants
	"has-directive-label", // internal flag
]);

export function parseDirectiveNode() {
	return (tree, { _data }) => {
		visit(tree, (node) => {
			if (
				node.type === "containerDirective" ||
				node.type === "leafDirective" ||
				node.type === "textDirective"
			) {
				// Drop unknown directive names — prevent arbitrary HTML tag injection.
				if (!ALLOWED_NAMES.has(node.name)) return;

				// biome-ignore lint/suspicious/noAssignInExpressions: <check later>
				const data = node.data || (node.data = {});
				node.attributes = node.attributes || {};
				if (
					node.children.length > 0 &&
					node.children[0].data &&
					node.children[0].data.directiveLabel
				) {
					// Add a flag to the node to indicate that it has a directive label
					node.attributes["has-directive-label"] = true;
				}

				// Strip unknown attributes before passing to h()
				const safeAttrs = {};
				for (const [key, value] of Object.entries(node.attributes)) {
					if (ALLOWED_ATTRS.has(key)) {
						safeAttrs[key] = value;
					}
				}

				const hast = h(node.name, safeAttrs);

				data.hName = hast.tagName;
				data.hProperties = hast.properties;
			}
		});
	};
}
