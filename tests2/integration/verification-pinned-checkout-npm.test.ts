import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import type { GateSignal } from "../../src/server/agent/gate-store.ts";
import { VerificationPinnedCheckoutManager } from "../../src/server/agent/verification-pinned-checkout.ts";
import { createRunChild } from "../harness/run-isolation.ts";
import { runFixtureCommand } from "../harness/spawn-with-retry.ts";

const HEAD = "a".repeat(40);
const SIGNAL_ID = "a0f0f0f0-0000-4000-8000-000000000002";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function nul(entries: readonly string[]): Buffer {
	return Buffer.concat(entries.flatMap(entry => [Buffer.from(entry), Buffer.from("\0")]));
}

function signal(): GateSignal {
	return {
		id: SIGNAL_ID, gateId: "implementation", goalId: "goal", sessionId: "session",
		timestamp: Date.now(), commitSha: HEAD, verification: { status: "running", steps: [] },
	};
}

/** A real npm process paired with a deterministic Git boundary. */
function fakeGit(root: string): CommandRunner {
	const inventory = [".gitignore", "package.json"];
	return {
		execFile: async (_file, args) => {
			const command = [...args];
			if (command.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "" };
			if (command.includes("--verify")) return { stdout: `${HEAD}\n`, stderr: "" };
			if (command.includes("check-ignore")) {
				if (command.at(-1) === "node_modules") return { stdout: "", stderr: "" };
				throw Object.assign(new Error("path is not ignored"), { code: 1 });
			}
			if (command.includes("ls-files")) return { stdout: nul(inventory), stderr: Buffer.alloc(0) };
			if (command.includes("worktree") && command.includes("add")) {
				await mkdir(command.at(-2)!, { recursive: true });
				return { stdout: "", stderr: "" };
			}
			if (command.includes("worktree") && command.includes("remove")) {
				await rm(command.at(-1)!, { recursive: true, force: true });
				return { stdout: "", stderr: "" };
			}
			throw new Error(`unexpected Git command: ${command.join(" ")}`);
		},
	};
}

describe("pinned checkout npm dependency exposure", () => {
	it("runs an npm script against an ignored source node_modules link without digesting its bytes", async () => {
		const base = createRunChild("pinned-checkout-npm");
		roots.push(base);
		const root = path.join(base, "repo");
		const state = path.join(base, "state");
		await mkdir(root);
		await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
		await writeFile(path.join(root, "package.json"), JSON.stringify({
			name: "pinned-checkout-smoke",
			private: true,
			scripts: { "pinned-smoke": "node -e \"process.stdout.write(require('pinned-smoke-dependency'))\"" },
		}));
		const dependency = path.join(root, "node_modules", "pinned-smoke-dependency");
		await mkdir(dependency, { recursive: true });
		await writeFile(path.join(dependency, "index.js"), "module.exports = 'pinned dependency reachable';\n");

		const manager = new VerificationPinnedCheckoutManager(state, { commandRunner: fakeGit(root) });
		const checkout = await manager.acquire({ signal: signal(), sourceRoot: root, projectId: "test-project-id" });
		try {
			const npmCli = process.env.npm_execpath;
			assert.ok(npmCli, "npm test runner must provide npm_execpath for the cross-platform npm smoke");
			const result = await runFixtureCommand(process.execPath, [npmCli, "run", "pinned-smoke"], {
				cwd: checkout.path, timeoutMs: 30_000, attempts: 1,
			});
			assert.match(result.stdout, /pinned dependency reachable/);
			assert.equal(await readFile(path.join(checkout.path, "node_modules", "pinned-smoke-dependency", "index.js"), "utf8"), "module.exports = 'pinned dependency reachable';\n");
			assert.equal(checkout.contentDigest.fileCount, 2, "ignored dependency bytes stay outside the content digest");
			await manager.assertUnchanged(checkout);
		} finally {
			await manager.release(checkout.id, "test-project-id");
		}
	});
});
