import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	captureSourceProcess,
	finalizeSourceRuntimes,
	stopSourceProcess,
	waitForSourceGateway,
	waitForSourceVite,
	type SourceProcessTreeAuthority,
} from "../../support/helpers/browser/e2e/source-vite-runtime-helpers.js";
import { _trackedCount, spawnTracked } from "../../../src/server/agent/spawn-tree.js";

function fakeRawSourceChild(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.assign(child, {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
		pid: undefined,
		kill: () => true,
		unref: () => child,
	});
	return child;
}

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

	it("tracked source ownership gates readiness before the first health response", { timeout: 10_000 }, async () => {
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
		let authorization: string | null = null;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			fetchCalls++;
			authorization = new Headers(init?.headers).get("authorization");
			return new Response('{"status":"ok"}', { status: 200 });
		}) as typeof fetch;
		try {
			const readiness = waitForSourceGateway("http://source.invalid", runtime, async () => "test-token", 1_000);
			await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
			assert.equal(fetchCalls, 0, "health must remain behind spawn-time Job ownership");
			resolveOwnership();
			await readiness;
			assert.equal(fetchCalls, 1);
			assert.equal(authorization, "Bearer test-token");
		} finally {
			globalThis.fetch = originalFetch;
			await stopSourceProcess(runtime, { gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 1_000 });
		}
		assert.equal(killRequests, 1, "owned teardown must request one Job close");
	});

	it("tracked Vite ownership gates readiness before the first source response", { timeout: 10_000 }, async () => {
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
		const runtime = captureSourceProcess(child, "ownership-gated Vite fixture", authority);
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			return new Response('<script type="module" src="/src/app/main.ts"></script>', { status: 200 });
		}) as typeof fetch;
		try {
			const readiness = waitForSourceVite("http://source.invalid", runtime, 1_000);
			await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
			assert.equal(fetchCalls, 0, "Vite health must remain behind spawn-time tree ownership");
			resolveOwnership();
			await readiness;
			assert.equal(fetchCalls, 1);
		} finally {
			globalThis.fetch = originalFetch;
			await stopSourceProcess(runtime, { gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 1_000 });
		}
		assert.equal(killRequests, 1, "owned Vite teardown must request one tree close");
	});

	it("tracked source ownership failure is diagnostic and prevents health publication", { timeout: 10_000 }, async () => {
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
			const readiness = waitForSourceGateway("http://source.invalid", runtime, async () => "test-token", 1_000);
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

	it("tracked teardown requires process close after tree-exit proof", async () => {
		const child = fakeRawSourceChild();
		let killRequests = 0;
		let waitRequests = 0;
		const authority: SourceProcessTreeAuthority = {
			ownershipReady: Promise.resolve(),
			killTree: () => { killRequests++; },
			waitForTreeExit: async () => {
				waitRequests++;
				return true;
			},
		};
		const runtime = captureSourceProcess(child, "unclosed tracked source fixture", authority);
		(child.stderr as PassThrough).write("tracked close remained pending\n");

		await assert.rejects(
			stopSourceProcess(runtime, { gracefulStopTimeoutMs: 1, forceStopTimeoutMs: 1 }),
			(error: Error) => {
				assert.match(error.message, /shutdown proof failed within 2ms; treeVerified=true; closeVerified=false/);
				assert.match(error.message, /rootExited=false.*closed=false.*tracked=true/);
				assert.match(error.message, /tracked close remained pending/);
				return true;
			},
		);
		assert.equal(killRequests, 1);
		assert.equal(waitRequests, 1);
		assert.equal(child.stderr?.destroyed, true);
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
		await assert.rejects(firstStop, /shutdown proof failed within 50ms; treeVerified=false; closeVerified=true/);
		await childClosed;
		await assert.rejects(stopSourceProcess(runtime, options), /shutdown proof failed within 50ms; treeVerified=false; closeVerified=true/);
		assert.equal(killRequests, 1, "a failed completion proof must not retarget the process");
		assert.equal(waitRequests, 1, "repeated stop must join the original completion attempt");
		assert.equal(runtime.child.stdout?.destroyed, true);
		assert.equal(runtime.child.stderr?.destroyed, true);
	});

	it("source finalization attempts both tracked stops and reporting but retains the root after an unverified stop", { timeout: 10_000 }, async () => {
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
		const baseline = _trackedCount();

		let finalizationFailure: unknown;
		try {
			await finalizeSourceRuntimes({
				vite: firstRuntime,
				gateway: secondRuntime,
				stopOptions: { gracefulStopTimeoutMs: 20, forceStopTimeoutMs: 30 },
				bodyFailure: { reason: bodyFailure },
				callerClose: { label: "page close", result: { status: "fulfilled", value: undefined } },
				report: async () => {
					events.push("report");
					assert.equal(firstRuntime.stdout.join(""), "");
					assert.equal(secondRuntime.stderr.join(""), "");
					throw reportFailure;
				},
				removeTemp: async () => { events.push("remove-temp"); },
			});
		} catch (error) {
			finalizationFailure = error;
		}

		await Promise.all([firstClosed, secondClosed]);
		await assert.rejects(
			stopSourceProcess(firstRuntime, { gracefulStopTimeoutMs: 20, forceStopTimeoutMs: 30 }),
			/shutdown proof failed within 50ms; treeVerified=false; closeVerified=true/,
		);
		await stopSourceProcess(secondRuntime, { gracefulStopTimeoutMs: 20, forceStopTimeoutMs: 30 });
		assert.equal(firstKills, 1);
		assert.equal(firstWaits, 1);
		assert.equal(secondKills, 1);
		assert.equal(secondWaits, 1);
		assert.equal(firstRuntime.closed, true);
		assert.equal(secondRuntime.closed, true);
		assert.deepEqual(events, ["first-stop:SIGKILL", "second-stop:SIGKILL", "report"]);
		assert.equal(_trackedCount(), baseline);
		assert.ok(finalizationFailure instanceof AggregateError);
		const failures = finalizationFailure.errors as Error[];
		assert.equal(failures.length, 3);
		assert.equal(failures[0], bodyFailure);
		assert.match(failures[1].message, /unverified first source runtime stop failed/);
		assert.match(failures[1].message, /shutdown proof failed within 50ms; treeVerified=false; closeVerified=true/);
		assert.match((failures[1].cause as Error).message, /unverified first source runtime/);
		assert.equal(failures[2].cause, reportFailure);
	});

	it("raw post-exit inherited-stdio uncertainty fails loudly and blocks removal", async () => {
		const child = fakeRawSourceChild();
		const runtime = captureSourceProcess(child, "post-exit raw source fixture");
		const events: string[] = [];
		(child.stdout as PassThrough).write("captured stdout before root exit\n");
		(child.stderr as PassThrough).write("captured stderr before root exit\n");
		child.emit("exit", 0, null);
		assert.equal(runtime.exited, true);
		assert.equal(runtime.closed, false);

		await assert.rejects(
			finalizeSourceRuntimes({
				vite: runtime,
				stopOptions: { gracefulStopTimeoutMs: 1, forceStopTimeoutMs: 1 },
				callerClose: { label: "page close", result: { status: "fulfilled", value: undefined } },
				report: async () => { events.push("report"); },
				removeTemp: async () => { events.push("remove-temp"); },
			}),
			(error: Error) => {
				assert.match(error.message, /post-exit raw source fixture stop failed/);
				assert.match(error.message, /root exited before process close/);
				assert.match(error.message, /treeVerified=false/);
				assert.match(error.message, /rootExited=true.*closed=false.*tracked=false/);
				assert.match(error.message, /captured stdout before root exit/);
				assert.match(error.message, /captured stderr before root exit/);
				return true;
			},
		);
		assert.deepEqual(events, ["report"], "an unverified raw owner must retain its diagnostic root");
		assert.equal(child.stdout?.destroyed, true);
		assert.equal(child.stderr?.destroyed, true);
	});

	it("raw forced-close deadline fails instead of converting stream release into proof", async () => {
		const child = fakeRawSourceChild();
		const runtime = captureSourceProcess(child, "unclosed raw source fixture");
		(child.stdout as PassThrough).write("still-open stdout\n");

		await assert.rejects(
			stopSourceProcess(runtime, { gracefulStopTimeoutMs: 1, forceStopTimeoutMs: 1 }),
			(error: Error) => {
				assert.match(error.message, /process close was not observed within 1ms after forced shutdown/);
				assert.match(error.message, /treeVerified=false/);
				assert.match(error.message, /rootExited=false.*closed=false.*tracked=false/);
				assert.match(error.message, /still-open stdout/);
				return true;
			},
		);
		assert.equal(child.stdout?.destroyed, true);
		assert.equal(child.stderr?.destroyed, true);
	});

	it("source finalization reports but retains the root after the caller close barrier fails", async () => {
		const events: string[] = [];
		const closeFailure = new Error("page remained open");

		await assert.rejects(
			finalizeSourceRuntimes({
				callerClose: { label: "page close", result: { status: "rejected", reason: closeFailure } },
				report: async () => { events.push("report"); },
				removeTemp: async () => { events.push("remove-temp"); },
			}),
			(error: Error) => {
				assert.match(error.message, /page close failed: page remained open/);
				assert.equal(error.cause, closeFailure);
				return true;
			},
		);
		assert.deepEqual(events, ["report"]);
	});

	it("source finalization reports but retains the root after the test body fails", async () => {
		const events: string[] = [];
		const bodyFailure = new Error("source fixture assertion failed");

		await assert.rejects(
			finalizeSourceRuntimes({
				bodyFailure: { reason: bodyFailure },
				callerClose: { label: "page close", result: { status: "fulfilled", value: undefined } },
				report: async () => { events.push("report"); },
				removeTemp: async () => { events.push("remove-temp"); },
			}),
			(error: Error) => {
				assert.equal(error, bodyFailure, "finalization must surface the original body failure");
				return true;
			},
		);
		assert.deepEqual(events, ["report"]);
	});

	it("source finalization retains the root when diagnostic reporting fails", async () => {
		const events: string[] = [];
		const reportFailure = new Error("report attachment failed");

		await assert.rejects(
			finalizeSourceRuntimes({
				callerClose: { label: "page close", result: { status: "fulfilled", value: undefined } },
				report: async () => {
					events.push("report");
					throw reportFailure;
				},
				removeTemp: async () => { events.push("remove-temp"); },
			}),
			(error: Error) => {
				assert.match(error.message, /source runtime report failed: report attachment failed/);
				assert.equal(error.cause, reportFailure);
				return true;
			},
		);
		assert.deepEqual(events, ["report"]);
	});

	it("source finalization removes the root last after every owner proves shutdown", { timeout: 10_000 }, async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const childClosed = once(child, "close");
		const events: string[] = [];
		const authority: SourceProcessTreeAuthority = {
			ownershipReady: Promise.resolve(),
			killTree: signal => {
				events.push(`stop:${signal}`);
				child.kill("SIGKILL");
			},
			waitForTreeExit: async () => {
				await childClosed;
				events.push("tree-exit-verified");
				return true;
			},
		};
		const runtime = captureSourceProcess(child, "verified source runtime", authority);

		await finalizeSourceRuntimes({
			vite: runtime,
			stopOptions: { gracefulStopTimeoutMs: 20, forceStopTimeoutMs: 2_000 },
			callerClose: { label: "page close", result: { status: "fulfilled", value: undefined } },
			report: async () => {
				assert.equal(runtime.closed, true);
				events.push("report");
			},
			removeTemp: async () => {
				assert.equal(runtime.closed, true);
				events.push("remove-temp");
			},
		});

		assert.deepEqual(events, ["stop:SIGKILL", "tree-exit-verified", "report", "remove-temp"]);
	});

	it("actual source gateway and Vite launch only through cross-platform tracked authority", async () => {
		const source = await readFile(new URL("../../support/helpers/browser/e2e/source-vite-runtime-helpers.ts", import.meta.url), "utf8");
		assert.doesNotMatch(source, /spawnSync|taskkill/i);
		const launcher = source.match(/function startOwnedSourceProcess[\s\S]*?\n}\n\nexport function startIsolatedSourceGateway/)?.[0];
		assert.ok(launcher, "the shared real-runtime launcher must remain discoverable");
		assert.match(launcher, /const tracked = spawnTracked\(file, args, options\)/);
		assert.doesNotMatch(launcher, /\bspawn\(/, "the real-runtime launcher must not retain a raw process branch");
		assert.doesNotMatch(launcher, /process\.platform/, "every platform must use spawn-time tree authority");
		assert.equal(source.match(/return startOwnedSourceProcess\(/g)?.length, 2,
			"both the gateway and Vite launch through the sole tracked launcher");
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
