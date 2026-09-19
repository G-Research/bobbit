import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
	prepareE2EDistServerPrebundle,
} from "../../../scripts/testing-v2/run-e2e-v2.mjs";
import {
	isCompleteOwnedCommandShutdown,
	runOwnedCommand,
} from "../../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs";
import {
	killAllTracked,
	spawnTracked,
} from "../../../src/server/agent/spawn-tree.ts";

const roots: string[] = [];

function isAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

after(() => {
	try { killAllTracked("SIGKILL", true); } catch { /* best effort */ }
	for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

test("tracked prebundle timeout proves root and descendant dead before cleanup authorizes raw fallback", async () => {
	const root = mkdtempSync(join(tmpdir(), "bobbit-prebundle-owned-shutdown-"));
	roots.push(root);
	const marker = join(root, "owned-pids.json");
	const fixture = [
		"const fs=require('node:fs');",
		"const {spawn}=require('node:child_process');",
		"const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
		"const marker=process.argv[1];",
		"fs.writeFileSync(marker+'.tmp',JSON.stringify({root:process.pid,descendant:descendant.pid}));",
		"fs.renameSync(marker+'.tmp',marker);",
		"setInterval(()=>{},1000);",
	].join("");
	let cleanupObserved = false;

	const result = await prepareE2EDistServerPrebundle({ root }, process.env, {
		invocation: {
			command: process.execPath,
			args: ["-e", fixture, marker],
			shell: false,
		},
		timeoutMs: 3_000,
		treeExitTimeoutMs: 10_000,
		runCommand: (command: string, args: readonly string[], options: Record<string, unknown>) =>
			runOwnedCommand(command, args, {
				...options,
				spawnOwned: async (ownedCommand: string, ownedArgs: readonly string[], ownedOptions: Record<string, unknown>) =>
					spawnTracked(ownedCommand, ownedArgs, {
						cwd: ownedOptions.cwd as string,
						env: ownedOptions.env as NodeJS.ProcessEnv,
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
					}),
			}),
		remove: async (target: string, options: { lifecycle: { child: Record<string, unknown> } }) => {
			assert.equal(resolve(target), join(resolve(root), "e2e-dist-server-prebundle"));
			assert.equal(isCompleteOwnedCommandShutdown(options.lifecycle.child), true);
			assert.equal(existsSync(marker), true, "fixture must publish both owned PIDs before its execution deadline");
			const pids = JSON.parse(readFileSync(marker, "utf8")) as { root: number; descendant: number };
			assert.equal(isAlive(pids.root), false, "tracked root must be dead before cleanup begins");
			assert.equal(isAlive(pids.descendant), false, "tracked descendant must be dead before cleanup begins");
			cleanupObserved = true;
		},
	});

	assert.equal(cleanupObserved, true);
	assert.equal(result.status, "raw-fallback");
	assert.equal(result.fallback, true);
	assert.match(result.error ?? "", /timed out after 3000ms/);
});
