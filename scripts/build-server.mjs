#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputFlag = process.argv.indexOf("--out-dir");
if (outputFlag >= 0 && !process.argv[outputFlag + 1]) {
	throw new Error("--out-dir requires a path");
}
const outputDir = path.resolve(projectRoot, outputFlag >= 0 ? process.argv[outputFlag + 1] : "dist");
const tscCli = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
let activeChild = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => activeChild?.kill(signal));
}

function run(command, args, env = process.env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: projectRoot, env, stdio: "inherit" });
		activeChild = child;
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			activeChild = null;
			if (code === 0) resolve();
			else reject(new Error(`${path.basename(command)} ${args[0] ?? ""} failed (${signal ? `signal ${signal}` : `code ${code}`})`));
		});
	});
}

await run(process.execPath, [tscCli, "-p", path.join(projectRoot, "tsconfig.server.json"), "--outDir", outputDir]);

const cliPath = path.join(outputDir, "server", "cli.js");
if (process.platform !== "win32") {
	fs.chmodSync(cliPath, 0o755);
}
fs.rmSync(path.join(outputDir, "server", "defaults"), { recursive: true, force: true });
fs.rmSync(path.join(outputDir, "server", "builtin-packs"), { recursive: true, force: true });

const copyEnv = { ...process.env, BOBBIT_SERVER_OUT_DIR: outputDir };
await run(process.execPath, [path.join(projectRoot, "scripts", "copy-defaults.mjs")], copyEnv);
await run(process.execPath, [path.join(projectRoot, "scripts", "copy-builtin-packs.mjs")], copyEnv);
