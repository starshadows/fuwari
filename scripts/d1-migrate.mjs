import { spawn } from "node:child_process";

const mode = process.argv.includes("--remote") ? "--remote" : "--local";
const databaseName =
	process.env.D1_DATABASE_NAME || process.env.CLOUDFLARE_D1_DATABASE_NAME || "";

if (!databaseName) {
	console.log(
		"[d1-migrate] D1_DATABASE_NAME is not set; skipping Wrangler migration. The Worker auto-runs migrations through the bound DB at runtime.",
	);
	process.exit(0);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(
	pnpm,
	[
		"exec",
		"wrangler",
		"d1",
		"migrations",
		"apply",
		databaseName,
		mode,
		"--yes",
	],
	{ stdio: "inherit" },
);

child.on("exit", (code, signal) => {
	if (signal) {
		console.error(`[d1-migrate] Wrangler exited with signal ${signal}.`);
		process.exit(1);
	}
	process.exit(code ?? 1);
});
