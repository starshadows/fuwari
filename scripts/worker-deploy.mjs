import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const deployArgs = process.argv.slice(2);
const generatedDir = path.join(projectRoot, ".wrangler");
const generatedConfigPath = path.join(generatedDir, "deploy-wrangler.jsonc");

const d1DatabaseId = readEnv("D1_DATABASE_ID", "CLOUDFLARE_D1_DATABASE_ID");
const d1DatabaseName = readEnv(
	"D1_DATABASE_NAME",
	"CLOUDFLARE_D1_DATABASE_NAME",
);
const r2BucketName = readEnv(
	"R2_BUCKET_NAME",
	"CLOUDFLARE_R2_BUCKET_NAME",
	"MEDIA_BUCKET_NAME",
);

const missing = [];
if (!d1DatabaseId) missing.push("D1_DATABASE_ID or CLOUDFLARE_D1_DATABASE_ID");
if (!r2BucketName) {
	missing.push(
		"R2_BUCKET_NAME, CLOUDFLARE_R2_BUCKET_NAME, or MEDIA_BUCKET_NAME",
	);
}

if (missing.length > 0) {
	console.error(
		`[worker-deploy] Refusing to deploy without explicit resource bindings. Missing: ${missing.join(", ")}.`,
	);
	console.error(
		"[worker-deploy] This prevents Wrangler/Cloudflare Git deploys from replacing the Worker with a version that has no DB or MEDIA_BUCKET binding.",
	);
	process.exit(1);
}

const config = JSON.parse(
	await fs.readFile(path.join(projectRoot, "wrangler.jsonc"), "utf8"),
);
if (config.main && !path.isAbsolute(config.main)) {
	config.main = path
		.relative(generatedDir, path.join(projectRoot, config.main))
		.replaceAll(path.sep, "/");
}
config.d1_databases = [
	{
		binding: "DB",
		database_id: d1DatabaseId,
		...(d1DatabaseName ? { database_name: d1DatabaseName } : {}),
	},
];
config.r2_buckets = [
	{
		binding: "MEDIA_BUCKET",
		bucket_name: r2BucketName,
	},
];

await fs.mkdir(generatedDir, { recursive: true });
await fs.writeFile(
	generatedConfigPath,
	`${JSON.stringify(config, null, "\t")}\n`,
);

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawnSync(
	pnpm,
	[
		"exec",
		"wrangler",
		"deploy",
		"--config",
		generatedConfigPath,
		...deployArgs,
	],
	{
		stdio: "inherit",
		env: {
			...process.env,
			CI: process.env.CI || "1",
		},
	},
);

if (child.error) {
	console.error(
		`[worker-deploy] Failed to run Wrangler: ${child.error.message}`,
	);
	process.exit(1);
}
if (child.signal) {
	console.error(`[worker-deploy] Wrangler exited with signal ${child.signal}.`);
	process.exit(1);
}
process.exit(child.status ?? 1);

function readEnv(...names) {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return "";
}
