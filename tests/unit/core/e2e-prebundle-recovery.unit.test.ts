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
	isCompleteOwnedCommandShutdown,
	OwnedCommandError,
	runOwnedCommand,
} from "../../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs";

const COMPLETE_SHUTDOWN = Object.freeze({
	ownershipState: "established",
	killRequested: false,
	rootCloseObserved: true,
	rootExitCode: 0,
	rootSignal: null,
	treeExitAttempted: true,
	treeExitSettled: true,
	treeExitVerified: true,
	completionTimedOut: false,
});

function shutdown(overrides: Record<string, unknown> = {}) {
	return Object.freeze({ ...COMPLETE_SHUTDOWN, ...overrides });
}

function successfulChild(stdout = JSON.stringify({ ok: true, cacheHit: false })) {
	return async () => ({ code: 0, stdout, stderr: "", shutdown: COMPLETE_SHUTDOWN });
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
					shutdown: COMPLETE_SHUTDOWN,
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
			shutdown: shutdown({ killRequested: true, rootExitCode: null, rootSignal: "SIGKILL" }),
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
				assert.deepEqual(options.lifecycle.child, {
					...failure.shutdown,
					state: "closed",
					shutdownComplete: true,
				});
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

	it.each([
		["ownership timed out despite tree=true", new OwnedCommandError("ownership timeout", {
			shutdown: shutdown({ ownershipState: "timed out", killRequested: true, rootExitCode: null, rootSignal: "SIGKILL" }),
		})],
		["ownership failed despite tree=true", new OwnedCommandError("ownership failed", {
			shutdown: shutdown({ ownershipState: "failed", killRequested: true, rootExitCode: null, rootSignal: "SIGKILL" }),
		})],
		["root close was not observed", new OwnedCommandError("root close missing", {
			shutdown: shutdown({ rootCloseObserved: false, rootExitCode: null }),
		})],
		["tree verification was not attempted", new OwnedCommandError("tree attempt missing", {
			shutdown: shutdown({ treeExitAttempted: false }),
		})],
		["tree verification did not settle", new OwnedCommandError("tree unsettled", {
			shutdown: shutdown({ treeExitSettled: false }),
		})],
		["tree exit was not verified", new OwnedCommandError("tree unverified", {
			shutdown: shutdown({ treeExitVerified: false }),
		})],
		["completion state is absent despite root/tree flags", new OwnedCommandError("completion state absent", {
			shutdown: shutdown({ completionTimedOut: undefined }),
		})],
		["completion deadline expired despite root/tree flags", new OwnedCommandError("completion timed out", {
			shutdown: shutdown({ completionTimedOut: true }),
		})],
		["plain Error spoofs treeExitVerified=true", Object.assign(new Error("spoof"), {
			treeExitVerified: true,
			shutdown: COMPLETE_SHUTDOWN,
		})],
	] as const)("fails closed when %s", async (_label, failure) => {
		let removed = false;
		let validated = false;
		await assert.rejects(
			prepareE2EDistServerPrebundle({ root: "owned-run" }, {}, {
				runCommand: async () => { throw failure; },
				remove: async () => { removed = true; },
				resolvePrebundle: () => { validated = true; return canonicalResult(); },
			}),
			/retaining the run root and refusing to launch raw Group B/,
		);
		assert.equal(removed, false);
		assert.equal(validated, false);
	});

	it("treats cleanup failure as fatal instead of masking it with raw fallback", async () => {
		await assert.rejects(
			prepareE2EDistServerPrebundle({ root: "owned-run" }, {}, {
				runCommand: async () => ({ code: 1, stdout: "{}", stderr: "build failed", shutdown: COMPLETE_SHUTDOWN }),
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

	it("marks tree=true with a missed root-close deadline as structured incomplete proof", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		let executionTimeout: (() => void) | undefined;
		let completionTimeout: (() => void) | undefined;
		const running = runOwnedCommand("node", ["stalled-child.js"], {
			cwd: "repo-root",
			timeoutMs: 41,
			ownershipEstablishmentTimeoutMs: 17,
			treeExitTimeoutMs: 23,
			spawnOwned: async () => ({
				child,
				ownershipReady: Promise.resolve(),
				killTree: () => {},
				waitForTreeExit: async () => true,
			}),
			setTimer: (callback: () => void, timeoutMs: number) => {
				if (timeoutMs === 41) executionTimeout = callback;
				return Symbol(`timer-${timeoutMs}`);
			},
			clearTimer: () => {},
			setCompletionTimer: (callback: () => void) => {
				completionTimeout = callback;
				return Symbol("completion-timer");
			},
			clearCompletionTimer: () => {},
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.ok(executionTimeout, "execution timer must arm after ownership is established");
		executionTimeout!();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.ok(completionTimeout, "post-kill completion timer must arm");
		completionTimeout!();
		await assert.rejects(running, (error: unknown) => {
			if (!(error instanceof OwnedCommandError)) return false;
			const proof = (error as { shutdown: typeof COMPLETE_SHUTDOWN }).shutdown;
			assert.equal(proof.ownershipState, "established");
			assert.equal(proof.rootCloseObserved, false);
			assert.equal(proof.treeExitAttempted, true);
			assert.equal(proof.treeExitSettled, true);
			assert.equal(proof.treeExitVerified, true);
			assert.equal(proof.completionTimedOut, true);
			assert.equal(isCompleteOwnedCommandShutdown(proof), false);
			return true;
		});
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
			const structured = (error as { shutdown: typeof COMPLETE_SHUTDOWN }).shutdown;
			assert.equal(structured.rootCloseObserved, true);
			assert.equal(structured.treeExitSettled, true);
			assert.equal(structured.treeExitVerified, false);
			assert.equal(isCompleteOwnedCommandShutdown(structured), false);
			return true;
		});
	});
});
