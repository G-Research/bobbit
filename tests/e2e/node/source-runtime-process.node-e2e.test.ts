import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	captureSourceProcess,
	finalizeSourceRuntimes,
	stopSourceProcess,
	waitForSourceGateway,
	type SourceProcessTreeAuthority,
} from "../../support/helpers/browser/e2e/source-vite-runtime-helpers.js";
import { _trackedCount, spawnTracked } from "../../../src/server/agent/spawn-tree.js";

function waitForFixtureMessage(child: ChildProcess, expectedType: string): Promise<void> {
	return new Promise((resolveMessage, rejectMessage) => {
		const cleanup = () => {
			child.removeListener("message", onMessage);
			child.removeListener("error", onError);
			child.removeListener("close", onClose);
		};
		const onMessage = (message: unknown) => {
			if (!message || typeof message !== "object" || !("type" in message) || message.type !== expectedType) return;
			cleanup();
			resolveMessage();
		};
		const onError = (error: Error) => {
			cleanup();
			rejectMessage(error);
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			rejectMessage(new Error(`fixture closed before ${expectedType}: code=${code} signal=${signal}`));
		};
		child.on("message", onMessage);
		child.once("error", onError);
		child.once("close", onClose);
	});
}

// Real process-fidelity cases deliberately run in Group A: none requests a
// Playwright browser fixture. The source Vite browser journey remains Group C.
describe("source runtime process ownership and teardown", () => {
	let trackedBaseline = 0;

	beforeEach(() => { trackedBaseline = _trackedCount(); });
	afterEach(() => {
		assert.equal(_trackedCount(), trackedBaseline, "source-runtime teardown must release every spawnTracked registry owner");
	});

	it("Windows source ownership gates readiness before the first health response", { timeout: 10_000 }, async () => {
		let resolveOwnership!: () => void;
		const ownershipReady = new Promise<void>(resolve => { resolveOwnership = resolve; });
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const childClosed = once(child, "close");
		let killRequests = 0;
		const authority: SourceProcessTreeAuthority = {
			ownershipReady,
			killTree: () => {
				killRequests++;
				child.kill("SIGKILL");
			},
			waitForTreeExit: async () => {
				await childClosed;
				return true;
			},
		};
		const runtime = captureSourceProcess(child, "ownership-gated source fixture", authority);
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			return new Response('{"status":"ok"}', { status: 200 });
		}) as typeof fetch;
		try {
			const readiness = waitForSourceGateway("http://source.invalid", runtime, 1_000);
			await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
			assert.equal(fetchCalls, 0, "health must remain behind spawn-time Job ownership");
			resolveOwnership();
			await readiness;
			assert.equal(fetchCalls, 1);
		} finally {
			globalThis.fetch = originalFetch;
			await stopSourceProcess(runtime, { gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 1_000 });
		}
		assert.equal(killRequests, 1, "owned teardown must request one Job close");
	});

	it("Windows source ownership failure is diagnostic and prevents health publication", { timeout: 10_000 }, async () => {
		let rejectOwnership!: (error: Error) => void;
		const ownershipReady = new Promise<void>((_resolve, reject) => { rejectOwnership = reject; });
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const childClosed = once(child, "close");
		const authority: SourceProcessTreeAuthority = {
			ownershipReady,
			killTree: () => { child.kill("SIGKILL"); },
			waitForTreeExit: async () => {
				await childClosed;
				return true;
			},
		};
		const runtime = captureSourceProcess(child, "ownership-failed source fixture", authority);
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			return new Response('{"status":"ok"}', { status: 200 });
		}) as typeof fetch;
		try {
			const readiness = waitForSourceGateway("http://source.invalid", runtime, 1_000);
			rejectOwnership(new Error("fixture Job assignment failed"));
			await assert.rejects(readiness, /ownership-failed source fixture failed before ownership readiness/);
			assert.equal(fetchCalls, 0, "failed Job ownership must never publish health readiness");
		} finally {
			globalThis.fetch = originalFetch;
			await stopSourceProcess(runtime, { gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 1_000 });
		}
	});

	it("tracked teardown coalesces repeated stops and joins the exact tree-completion bound", { timeout: 10_000 }, async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const childClosed = once(child, "close");
		const signals: string[] = [];
		const waitBounds: number[] = [];
		const authority: SourceProcessTreeAuthority = {
			ownershipReady: Promise.resolve(),
			killTree: signal => {
				signals.push(signal ?? "SIGTERM");
				child.kill("SIGKILL");
			},
			waitForTreeExit: async timeoutMs => {
				waitBounds.push(timeoutMs ?? -1);
				await childClosed;
				return true;
			},
		};
		const runtime = captureSourceProcess(child, "coalesced tracked source fixture", authority);
		const options = { gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 2_000 };
		await Promise.all([stopSourceProcess(runtime, options), stopSourceProcess(runtime, options)]);
		await stopSourceProcess(runtime, options);

		assert.deepEqual(signals, ["SIGKILL"], "the Windows Job authority must receive one close request");
		assert.deepEqual(waitBounds, [2_100], "tree completion must use the existing grace plus force lifecycle bound");
		assert.equal(runtime.closed, true);
	});

	it("an unverified tracked completion stays event-loop bounded and preserves its failure across repeated stop", { timeout: 10_000 }, async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const childClosed = once(child, "close");
		let killRequests = 0;
		let waitRequests = 0;
		const authority: SourceProcessTreeAuthority = {
			ownershipReady: Promise.resolve(),
			killTree: () => {
				killRequests++;
				child.kill("SIGKILL");
			},
			waitForTreeExit: () => {
				waitRequests++;
				return new Promise<boolean>(() => {});
			},
		};
		const runtime = captureSourceProcess(child, "unverified tracked source fixture", authority);
		const options = { gracefulStopTimeoutMs: 20, forceStopTimeoutMs: 30 };
		const firstStop = stopSourceProcess(runtime, options);
		await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
		await assert.rejects(firstStop, /tree completion was not verified within 50ms/);
		await childClosed;
		await assert.rejects(stopSourceProcess(runtime, options), /tree completion was not verified within 50ms/);
		assert.equal(killRequests, 1, "a failed completion proof must not retarget the process");
		assert.equal(waitRequests, 1, "repeated stop must join the original completion attempt");
		assert.equal(runtime.child.stdout?.destroyed, true);
		assert.equal(runtime.child.stderr?.destroyed, true);
	});

	it("source finalization attempts both tracked stops, reporting, and removal before surfacing exact failures", { timeout: 10_000 }, async () => {
		const firstChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const secondChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const firstClosed = once(firstChild, "close");
		const secondClosed = once(secondChild, "close");
		const events: string[] = [];
		let firstKills = 0;
		let firstWaits = 0;
		let secondKills = 0;
		let secondWaits = 0;
		const firstAuthority: SourceProcessTreeAuthority = {
			ownershipReady: Promise.resolve(),
			killTree: signal => {
				firstKills++;
				events.push(`first-stop:${signal}`);
				firstChild.kill("SIGKILL");
			},
			waitForTreeExit: () => {
				firstWaits++;
				return new Promise<boolean>(() => {});
			},
		};
		const secondAuthority: SourceProcessTreeAuthority = {
			ownershipReady: Promise.resolve(),
			killTree: signal => {
				secondKills++;
				events.push(`second-stop:${signal}`);
				secondChild.kill("SIGKILL");
			},
			waitForTreeExit: async () => {
				secondWaits++;
				await secondClosed;
				return true;
			},
		};
		const firstRuntime = captureSourceProcess(firstChild, "unverified first source runtime", firstAuthority);
		const secondRuntime = captureSourceProcess(secondChild, "verified second source runtime", secondAuthority);
		const bodyFailure = new Error("fixture body assertion failed");
		const reportFailure = new Error("fixture report attachment failed");
		const removalFailure = new Error("fixture temporary removal failed");
		const baseline = _trackedCount();

		let finalizationFailure: unknown;
		try {
			await finalizeSourceRuntimes({
				vite: firstRuntime,
				gateway: secondRuntime,
				stopOptions: { gracefulStopTimeoutMs: 20, forceStopTimeoutMs: 30 },
				bodyFailure: { reason: bodyFailure },
				report: async () => {
					events.push("report");
					assert.equal(firstRuntime.stdout.join(""), "");
					assert.equal(secondRuntime.stderr.join(""), "");
					throw reportFailure;
				},
				removeTemp: async () => {
					events.push("remove-temp");
					throw removalFailure;
				},
			});
		} catch (error) {
			finalizationFailure = error;
		}

		await Promise.all([firstClosed, secondClosed]);
		await assert.rejects(
			stopSourceProcess(firstRuntime, { gracefulStopTimeoutMs: 20, forceStopTimeoutMs: 30 }),
			/tree completion was not verified within 50ms/,
		);
		await stopSourceProcess(secondRuntime, { gracefulStopTimeoutMs: 20, forceStopTimeoutMs: 30 });
		assert.equal(firstKills, 1);
		assert.equal(firstWaits, 1);
		assert.equal(secondKills, 1);
		assert.equal(secondWaits, 1);
		assert.equal(firstRuntime.closed, true);
		assert.equal(secondRuntime.closed, true);
		assert.deepEqual(events, ["first-stop:SIGKILL", "second-stop:SIGKILL", "report", "remove-temp"]);
		assert.equal(_trackedCount(), baseline);
		assert.ok(finalizationFailure instanceof AggregateError);
		const failures = finalizationFailure.errors as Error[];
		assert.equal(failures.length, 4);
		assert.equal(failures[0], bodyFailure);
		assert.match(failures[1].message, /unverified first source runtime stop failed/);
		assert.match(failures[1].message, /tree completion was not verified within 50ms/);
		assert.match((failures[1].cause as Error).message, /unverified first source runtime/);
		assert.equal(failures[2].cause, reportFailure);
		assert.equal(failures[3].cause, removalFailure);
	});

	it("source-runtime cleanup contains no synchronous Windows process-tree utility", async () => {
		const source = await readFile(new URL("../../support/helpers/browser/e2e/source-vite-runtime-helpers.ts", import.meta.url), "utf8");
		assert.doesNotMatch(source, /spawnSync|taskkill/i);
		assert.match(source, /spawnTracked\(file, args, options\)/);
		assert.equal(source.match(/return startOwnedSourceProcess\(/g)?.length, 2);
		assert.match(source, /process\.platform === "win32"/);
	});

	it("teardown escalates a SIGTERM-ignoring detached source process and awaits close", { timeout: 10_000 }, async () => {
		const child = spawn(process.execPath, ["--input-type=module", "--eval", [
			'process.on("SIGTERM", () => process.send?.({ type: "sigterm-received" }));',
			'process.send?.({ type: "handler-ready" });',
			"setInterval(() => {}, 1_000);",
		].join("")], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			windowsHide: true,
		});
		const handlerReady = waitForFixtureMessage(child, "handler-ready");
		const runtime = captureSourceProcess(child, "SIGTERM-ignoring source helper fixture");
		try {
			await handlerReady;
			let gracefulSignalReceived = false;
			const gracefulSignalReceipt = process.platform === "win32"
				? undefined
				: waitForFixtureMessage(child, "sigterm-received").then(() => { gracefulSignalReceived = true; });

			await stopSourceProcess(runtime, {
				gracefulStopTimeoutMs: 100,
				gracefulSignalReceipt,
				forceStopTimeoutMs: 2_000,
			});

			assert.equal(runtime.closed, true, "teardown must wait for close after forced termination");
			if (process.platform !== "win32") {
				assert.equal(gracefulSignalReceived, true, "fixture must acknowledge graceful SIGTERM before escalation");
				assert.equal(child.signalCode, "SIGKILL", "detached POSIX process must be force-killed after grace");
			}
		} finally {
			if (!runtime.closed) {
				await stopSourceProcess(runtime, { gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 2_000 });
			}
		}
	});

	it("teardown falls back to the grace deadline when its pre-armed IPC receipt is lost", { timeout: 10_000 }, async () => {
		const child = spawn(process.execPath, ["--input-type=module", "--eval", [
			'process.on("SIGTERM", () => {});',
			'process.send?.({ type: "handler-ready" });',
			"setInterval(() => {}, 1_000);",
		].join("")], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			windowsHide: true,
		});
		const handlerReady = waitForFixtureMessage(child, "handler-ready");
		const runtime = captureSourceProcess(child, "lost graceful receipt fixture");
		try {
			await handlerReady;
			const lostReceipt = waitForFixtureMessage(child, "sigterm-received");

			await stopSourceProcess(runtime, {
				gracefulStopTimeoutMs: 100,
				gracefulSignalReceipt: lostReceipt,
				forceStopTimeoutMs: 2_000,
			});

			assert.equal(runtime.closed, true, "the grace deadline must still lead to an awaited close");
			await assert.rejects(lostReceipt, /fixture closed before sigterm-received/);
			assert.equal(child.listenerCount("message"), 0, "the lost IPC receipt listener must be removed");
			assert.equal(child.listenerCount("error"), 0, "the lost IPC error listener must be removed");
			assert.equal(child.listenerCount("close"), 0, "temporary close listeners must be removed");
			if (process.platform !== "win32") {
				assert.equal(child.signalCode, "SIGKILL", "the detached POSIX process must be force-killed after the deadline");
			}
		} finally {
			if (!runtime.closed) {
				await stopSourceProcess(runtime, { gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 2_000 });
			}
		}
	});

	it("reaps an inherited-stdio descendant at the owned root-exit boundary", { timeout: 5_000 }, async () => {
		const fixtureArgs = ["-e", [
			'const { spawn } = require("node:child_process");',
			'const descendant = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000);"], { stdio: "inherit" });',
			'process.stdout.write("ready\\n");',
			'process.on("SIGTERM", () => process.exit(0));',
		].join("")];
		const tracked = process.platform === "win32"
			? spawnTracked(process.execPath, fixtureArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
			: undefined;
		const child = tracked?.child ?? spawn(process.execPath, fixtureArgs, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const runtime = captureSourceProcess(child, "root-exit boundary fixture", tracked);
		const actualExit = once(child, "exit");
		const actualClose = once(child, "close");
		await tracked?.ownershipReady;
		await once(child.stdout!, "data");

		try {
			await stopSourceProcess(runtime, { gracefulStopTimeoutMs: 500, forceStopTimeoutMs: 1_000 });
			await actualExit;
			await actualClose;
			assert.equal(runtime.exited, true, "root exit must be recorded before inherited stdio closes");
			assert.equal(runtime.closed, true, "the owned process tree must close after teardown");
			if (process.platform !== "win32") {
				assert.equal(runtime.finalTreeSignalSent, true, "the original POSIX group must be finalized at root exit");
			}
		} finally {
			if (!runtime.closed) await stopSourceProcess(runtime, { gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 1_000 });
		}
	});
});
