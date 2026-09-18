import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	capturePackagedCli,
	finalizePackagedRuntime,
	getFreePort,
	startPackagedCli,
	stopPackagedCli,
	waitForHealth,
	type PackagedProcessTreeAuthority,
} from "../../support/helpers/browser/e2e/packaged-runtime-helpers.js";
import { createRunChild, removeOwnedRunChild } from "../../support/harnesses/shared/run-isolation.js";
import { _trackedCount } from "../../../src/server/agent/spawn-tree.js";

function childClose(child: ChildProcess): Promise<void> {
	return once(child, "close").then(() => undefined);
}

describe("packaged runtime process ownership and teardown", () => {
	let trackedBaseline = 0;

	beforeEach(() => { trackedBaseline = _trackedCount(); });
	afterEach(() => {
		assert.equal(_trackedCount(), trackedBaseline, "packaged-runtime teardown must release every spawnTracked owner");
	});

	it("gates health publication on process-tree ownership readiness", { timeout: 10_000 }, async () => {
		let resolveOwnership!: () => void;
		const ownershipReady = new Promise<void>(resolve => { resolveOwnership = resolve; });
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const closed = childClose(child);
		let killRequests = 0;
		const authority: PackagedProcessTreeAuthority = {
			ownershipReady,
			killTree: () => {
				killRequests++;
				child.kill("SIGKILL");
			},
			waitForTreeExit: async () => {
				await closed;
				return true;
			},
		};
		const runtime = capturePackagedCli(child, [], [], authority);
		const originalFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			return new Response('{"status":"ok"}', { status: 200 });
		}) as typeof fetch;
		try {
			const health = waitForHealth("http://packaged.invalid", runtime, 1_000);
			await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
			assert.equal(fetchCalls, 0, "health must stay behind the spawn-time ownership barrier");
			resolveOwnership();
			await health;
			assert.equal(fetchCalls, 1);
		} finally {
			globalThis.fetch = originalFetch;
			await stopPackagedCli(runtime, { gracefulStopTimeoutMs: 20, forceStopTimeoutMs: 2_000 });
		}
		assert.equal(killRequests, 1, "tracked teardown must request one tree close");
	});

	it("joins tree exit and ChildProcess close before reporting final diagnostics", { timeout: 10_000 }, async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const events: string[] = [];
		const closed = childClose(child);
		child.once("close", () => { events.push("child-close"); });
		const authority: PackagedProcessTreeAuthority = {
			ownershipReady: Promise.resolve(),
			killTree: signal => {
				events.push(`kill:${signal}`);
				child.kill("SIGKILL");
			},
			waitForTreeExit: async () => {
				events.push("tree-wait");
				await closed;
				events.push("tree-exit");
				return true;
			},
		};
		const runtime = capturePackagedCli(child, [], [], authority);

		await finalizePackagedRuntime({
			runtime,
			stopOptions: { gracefulStopTimeoutMs: 20, forceStopTimeoutMs: 2_000 },
			report: async () => {
				assert.equal(runtime.closed, true, "reporting must follow ChildProcess close");
				events.push("report");
			},
		});

		assert.deepEqual(events, ["kill:SIGTERM", "tree-wait", "child-close", "tree-exit", "report"]);
	});

	it("fails a raw post-exit unclosed seam only after attaching lifecycle diagnostics", { timeout: 10_000 }, async () => {
		const child = spawn(process.execPath, ["-e", [
			'console.log("raw stdout marker");',
			'console.error("raw stderr marker");',
			"setInterval(() => {}, 1000);",
		].join("")], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const closed = childClose(child);
		const runtime = capturePackagedCli(child);
		await Promise.all([once(child.stdout!, "data"), once(child.stderr!, "data")]);
		// Model the exact raw seam after the numeric root identity has crossed its
		// exit boundary while inherited handles have not produced `close`. Keeping
		// the fixture process alive proves teardown does not issue a late signal.
		runtime.exited = true;
		assert.equal(runtime.closed, false);
		const events: string[] = [];
		try {
			await assert.rejects(
				finalizePackagedRuntime({
					runtime,
					report: async () => { events.push("report"); },
				}),
				(error: Error) => {
					assert.match(error.message, /root exited before ChildProcess close/);
					assert.match(error.message, /exited=true; closed=false/);
					assert.match(error.message, /raw stdout marker/);
					assert.match(error.message, /raw stderr marker/);
					return true;
				},
			);
			assert.deepEqual(events, ["report"], "reporting must complete before the owner failure surfaces");
			assert.equal(child.exitCode, null, "fail-closed teardown must not late-signal the raw numeric identity");
			assert.equal(runtime.child.stdout?.destroyed, true);
			assert.equal(runtime.child.stderr?.destroyed, true);
		} finally {
			child.kill("SIGKILL");
			await closed;
		}
	});

	it("fails loudly when a raw owner cannot prove close before its bounded deadline", { timeout: 10_000 }, async () => {
		const child = spawn(process.execPath, ["-e", [
			'console.log("forced-close stdout marker");',
			'console.error("forced-close stderr marker");',
			"setInterval(() => {}, 1000);",
		].join("")], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const closed = childClose(child);
		const runtime = capturePackagedCli(child);
		await Promise.all([once(child.stdout!, "data"), once(child.stderr!, "data")]);
		const originalPid = child.pid;
		assert.ok(originalPid);
		// A raw seam without a live numeric witness cannot be signalled safely. It
		// must exhaust the close bound and reject rather than claim tree completion.
		Object.defineProperty(child, "pid", { value: undefined, configurable: true });
		try {
			await assert.rejects(
				stopPackagedCli(runtime, { gracefulStopTimeoutMs: 10, forceStopTimeoutMs: 20 }),
				(error: Error) => {
					assert.match(error.message, /ChildProcess close was not observed within 30ms/);
					assert.match(error.message, /forced-close stdout marker/);
					assert.match(error.message, /forced-close stderr marker/);
					return true;
				},
			);
			assert.equal(runtime.closed, false);
		} finally {
			Object.defineProperty(child, "pid", { value: originalPid, configurable: true });
			child.kill("SIGKILL");
			await closed;
		}
	});

	it("launches the real packaged CLI path through cross-platform tracked ownership", { timeout: 20_000 }, async () => {
		const tempRoot = createRunChild("packaged-runtime-owned");
		const consumerDir = join(tempRoot, "consumer");
		const workspaceDir = join(consumerDir, "workspace");
		const secretsDir = join(consumerDir, "secrets");
		const agentDir = join(consumerDir, "agent");
		const cliPath = join(consumerDir, "fixture-cli.cjs");
		const agentPath = join(consumerDir, "fixture-agent.cjs");
		await Promise.all([
			mkdir(workspaceDir, { recursive: true }),
			mkdir(secretsDir, { recursive: true }),
			mkdir(agentDir, { recursive: true }),
		]);
		await writeFile(cliPath, [
			'const http = require("node:http");',
			'const index = process.argv.indexOf("--port");',
			"const port = Number(process.argv[index + 1]);",
			'const server = http.createServer((request, response) => { response.writeHead(request.url === "/health" ? 200 : 404); response.end(); });',
			'server.listen(port, "127.0.0.1");',
			'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
		].join("\n"), "utf8");
		await writeFile(agentPath, "", "utf8");
		const port = await getFreePort();
		const runtime = startPackagedCli({
			cliPath,
			consumerDir,
			workspaceDir,
			agentPath,
			secretsDir,
			agentDir,
			port,
		});
		try {
			assert.ok(runtime.trackedAuthority, "real packaged launch must retain spawnTracked authority");
			await waitForHealth(`http://127.0.0.1:${port}`, runtime, 10_000);
			await stopPackagedCli(runtime, { gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 5_000 });
			assert.equal(runtime.closed, true);
		} finally {
			if (!runtime.closed) {
				await stopPackagedCli(runtime, { gracefulStopTimeoutMs: 100, forceStopTimeoutMs: 5_000 }).catch(() => {});
			}
			await removeOwnedRunChild(tempRoot, {
				owner: "packaged runtime node E2E",
				closed: runtime.closed,
			});
		}
	});
});
