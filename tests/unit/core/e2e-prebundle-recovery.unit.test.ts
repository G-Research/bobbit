import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import {
	createE2EDistPrebundleInvocation,
	prepareE2EDistServerPrebundle,
} from "../../../scripts/testing-v2/run-e2e-v2.mjs";
import {
	createE2EDistPhaseTelemetry,
} from "../../../scripts/testing-v2/server-prebundle.mjs";
import {
	OwnedCommandError,
	runOwnedCommand,
} from "../../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs";

const VERIFIED_SHUTDOWN = Object.freeze({ treeExitVerified: true });

function successfulChild(stdout = JSON.stringify({ ok: true, cacheHit: false })) {
	return async () => ({ code: 0, stdout, stderr: "", shutdown: VERIFIED_SHUTDOWN });
}

function canonicalResult() {
	return { key: "parent-computed-key", bundlePath: "owned-run/e2e-dist-server-prebundle/parent-computed-key/runtime.mjs" };
}

describe("bounded E2E dist prebundle recovery", () => {
	it("uses a shell-free local child invocation with explicit authoritative roots", () => {
		const invocation = createE2EDistPrebundleInvocation(
			{ root: "owned-run" },
			{ execPath: "node-bin", cli: "server-prebundle.mjs", repoRoot: "repo-root" },
		);
		assert.equal(invocation.command, "node-bin");
		assert.equal(invocation.shell, false);
		assert.deepEqual(invocation.args, [
			"server-prebundle.mjs",
			"--e2e-dist-child",
			"--repo-root", "repo-root",
			"--run-root", "owned-run",
		]);
	});

	it("accepts child success only after verified shutdown and parent-side canonical validation", async () => {
		const events: string[] = [];
		const foreign = "C:/foreign/attacker-selected/runtime.mjs";
		const environment = { BOBBIT_TEST_NO_EXTERNAL: "1" };
		const result = await prepareE2EDistServerPrebundle({ root: "owned-run" }, environment, {
			runCommand: async (_command: string, _args: readonly string[], options: Record<string, unknown>) => {
				events.push("child-verified");
				assert.equal(options.env, environment);
				assert.equal(options.timeoutMs, 25_000);
				assert.equal(options.treeExitTimeoutMs, 10_000);
				return {
					code: 0,
					stdout: JSON.stringify({ ok: true, cacheHit: false, bundlePath: foreign, key: "foreign-key" }),
					stderr: "",
					shutdown: VERIFIED_SHUTDOWN,
				};
			},
			resolvePrebundle: ({ runRoot }: { runRoot: string }) => {
				events.push("parent-validated");
				assert.equal(runRoot, "owned-run");
				return canonicalResult();
			},
			remove: async () => { throw new Error("success must not clean the published artifact"); },
		});
		assert.deepEqual(events, ["child-verified", "parent-validated"]);
		assert.equal(result.bundlePath, canonicalResult().bundlePath);
		assert.equal(result.key, "parent-computed-key");
		assert.equal(result.fallback, false);
		assert.notEqual(result.bundlePath, foreign);
	});

	it("cleans only after a verified failed child join, then authorizes raw fallback", async () => {
		const events: string[] = [];
		const failure = new OwnedCommandError("synthetic execution timeout", {
			command: "node",
			args: ["server-prebundle.mjs"],
			cwd: "repo-root",
			shutdown: {
				rootCloseObserved: true,
				treeExitSettled: true,
				treeExitVerified: true,
			},
		});
		const result = await prepareE2EDistServerPrebundle({ root: "owned-run" }, {}, {
			runCommand: async () => {
				events.push("tree-joined");
				throw failure;
			},
			remove: async (target: string, options: Record<string, any>) => {
				events.push("subtree-removed");
				assert.match(target.replace(/\\/g, "/"), /owned-run\/e2e-dist-server-prebundle$/);
				assert.equal(options.ownerRoot, "owned-run");
				assert.equal(options.allowOwnerRoot, undefined);
				assert.equal(options.lifecycle.child.treeExitVerified, true);
			},
			resolvePrebundle: () => { throw new Error("failed child must not validate"); },
		});
		assert.deepEqual(events, ["tree-joined", "subtree-removed"]);
		assert.equal(result.status, "raw-fallback");
		assert.equal(result.fallback, true);
		assert.match(result.error!, /synthetic execution timeout/);
	});

	it("falls back after verified success only when parent validation rejects corrupt or wrong-key bytes", async () => {
		const events: string[] = [];
		const result = await prepareE2EDistServerPrebundle({ root: "owned-run" }, {}, {
			runCommand: successfulChild(JSON.stringify({
				ok: true,
				cacheHit: true,
				key: "wrong-key",
				bundlePath: "C:/outside/runtime.mjs",
			})),
			resolvePrebundle: () => {
				events.push("hash-validation");
				throw new Error("canonical artifact failed immutable manifest validation");
			},
			remove: async () => { events.push("subtree-removed"); },
		});
		assert.deepEqual(events, ["hash-validation", "subtree-removed"]);
		assert.equal(result.status, "raw-fallback");
		assert.match(result.error!, /immutable manifest validation/);
	});

	it("fails closed without cleanup or Group B fallback when tree exit is unverified", async () => {
		let removed = false;
		let validated = false;
		const failure = new OwnedCommandError("tree join expired", {
			shutdown: {
				rootCloseObserved: false,
				treeExitSettled: false,
				treeExitVerified: false,
			},
		});
		await assert.rejects(
			prepareE2EDistServerPrebundle({ root: "owned-run" }, {}, {
				runCommand: async () => { throw failure; },
				remove: async () => { removed = true; },
				resolvePrebundle: () => { validated = true; return canonicalResult(); },
			}),
			/refusing to launch raw Group B/,
		);
		assert.equal(removed, false);
		assert.equal(validated, false);
	});

	it("treats cleanup failure as fatal instead of masking it with raw fallback", async () => {
		await assert.rejects(
			prepareE2EDistServerPrebundle({ root: "owned-run" }, {}, {
				runCommand: async () => ({ code: 1, stdout: "{}", stderr: "build failed", shutdown: VERIFIED_SHUTDOWN }),
				remove: async () => { throw new Error("cleanup EBUSY history"); },
			}),
			/cleanup EBUSY history/,
		);
	});

	it("emits bounded, ordered, finite phase telemetry without ambient paths", () => {
		const chunks: string[] = [];
		const telemetry = createE2EDistPhaseTelemetry((chunk: string) => chunks.push(chunk));
		const phases = ["key", "initial-validation", "lock", "inputs", "esbuild", "manifest-hash", "publish", "final-validation"];
		for (const phase of phases) {
			telemetry({ phase, state: "started", elapsedMs: Number.POSITIVE_INFINITY, path: "C:/secret/root" });
			telemetry({ phase, state: "completed", elapsedMs: 1.4, key: "k".repeat(1_000), valid: true });
		}
		const records = chunks.map(chunk => JSON.parse(chunk));
		assert.deepEqual(records.map(record => record.sequence), Array.from({ length: 16 }, (_, index) => index + 1));
		assert.ok(records.every(record => Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0));
		assert.ok(records.every(record => JSON.stringify(record).length < 300));
		assert.ok(records.every(record => !JSON.stringify(record).includes("secret")));
		assert.deepEqual(records.filter(record => record.state === "started").map(record => record.phase), phases);

		const source = readFileSync("scripts/testing-v2/server-prebundle.mjs", "utf8");
		let previous = source.indexOf("export async function ensureE2EDistServerPrebundle");
		for (const phase of phases) {
			const index = source.indexOf(`"${phase}"`, previous + 1);
			assert.ok(index > previous, `${phase} must be instrumented in build order`);
			previous = index;
		}
	});

	it("retains structured package-command shutdown proof on terminal errors", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		const running = runOwnedCommand("node", ["npm-cli.js", "pack"], {
			cwd: "repo-root",
			timeoutMs: 1_000,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => { throw new Error("normal close must not kill"); },
				waitForTreeExit: async () => false,
			}),
		});
		await Promise.resolve();
		child.emit("close", 0, null);
		await assert.rejects(running, (error: unknown) => {
			if (!(error instanceof OwnedCommandError)) return false;
			const structured = error as {
				treeExitVerified: boolean;
				shutdown: { rootCloseObserved: boolean; treeExitSettled: boolean };
			};
			assert.equal(structured.treeExitVerified, false);
			assert.equal(structured.shutdown.rootCloseObserved, true);
			assert.equal(structured.shutdown.treeExitSettled, true);
			return true;
		});
	});
});
