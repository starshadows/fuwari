/* This is a script to create a new post markdown file with front-matter */

import fs from "node:fs";
import path from "node:path";

function getDate() {
	const today = new Date();
	const year = today.getFullYear();
	const month = String(today.getMonth() + 1).padStart(2, "0");
	const day = String(today.getDate()).padStart(2, "0");

	return `${year}-${month}-${day}`;
}

function escapeYamlValue(value) {
	// Escape double quotes and wrap in quotes if the value contains
	// characters that could break YAML parsing (colons, newlines, ---).
	if (/[:"'\n#{}[\]&*!|>%@`]/.test(value)) {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}

const args = process.argv.slice(2);

if (args.length === 0) {
	console.error(`Error: No filename argument provided
Usage: npm run new-post -- <filename>`);
	process.exit(1); // Terminate the script and return error code 1
}

let fileName = args[0];

// Restrict filename to safe slug characters only to prevent path traversal.
if (!/^[a-zA-Z0-9/_-]+$/.test(fileName)) {
	console.error(
		"Error: Filename may only contain letters, digits, hyphens, underscores, and forward slashes.",
	);
	process.exit(1);
}

// Prevent segment components like ".", "..", or hidden files.
const segments = fileName.split("/");
if (segments.some((s) => !s || s === "." || s === ".." || s.startsWith("."))) {
	console.error(
		"Error: Filename must not contain empty segments, dot segments, or hidden files.",
	);
	process.exit(1);
}

// Add .md extension if not present
const fileExtensionRegex = /\.(md|mdx)$/i;
if (!fileExtensionRegex.test(fileName)) {
	fileName += ".md";
}

const targetDir = path.resolve("./src/content/posts/");
const fullPath = path.resolve(path.join(targetDir, fileName));

// Verify the resolved path is still inside the posts directory.
if (!fullPath.startsWith(targetDir + path.sep)) {
	console.error("Error: File path escapes the posts directory.");
	process.exit(1);
}

if (fs.existsSync(fullPath)) {
	console.error(`Error: File ${fullPath} already exists `);
	process.exit(1);
}

// recursive mode creates multi-level directories
const dirPath = path.dirname(fullPath);
if (!fs.existsSync(dirPath)) {
	fs.mkdirSync(dirPath, { recursive: true });
}

const displayTitle = args[0]; // Original user input for the title

const content = `---
title: ${escapeYamlValue(displayTitle)}
published: ${getDate()}
description: ''
image: ''
tags: []
category: ''
draft: false
lang: ''
---
`;

fs.writeFileSync(fullPath, content);

console.log(`Post ${fullPath} created`);
