import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalEnv = {
	BOBBIT_CPU_DIAG: process.env.BOBBIT_CPU_DIAG,
	BOBBIT_CPU_DIAG_FLUSH_MS: process.env.BOBBIT_CPU_DIAG_FLUSH_MS,
	BOBBIT_CPU_DIAG_JSONL: process.env.BOBBIT_CPU_DIAG_JSONL,
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

async function importFresh(tag: string): Promise<typeof import("../src/server/agent/cpu-diagnostics.ts")> {
	return await import(`../src/server/agent/cpu-diagnostics.ts?${tag}-${Date.now()}-${Math.random()}`);
}

function tempFile(name: string): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-cpu-diag-"));
	return { dir, file: path.join(dir, name) };
}

afterEach(() => {
	restoreEnv();
});

describe("cpu diagnostics", () => {
	it("is a disabled no-op unless BOBBIT_CPU_DIAG=1", async () => {
		const { dir, file } = tempFile("disabled.jsonl");
		try {
			delete process.env.BOBBIT_CPU_DIAG;
			process.env.BOBBIT_CPU_DIAG_JSONL = file;
			process.env.BOBBIT_CPU_DIAG_FLUSH_MS = "1";

			const mod = await importFresh("disabled");
			assert.equal(mod.cpuDiagnosticsEnabled(), false);

			const diag = mod.getCpuDiagnostics();
			diag.recordRest("GET /api/projects", 200, 1, 10);
			diag.recordWsBroadcast("server:broadcastToAll", "projects_changed", { frames: 1, recipients: 1, bytes: 10 });
			diag.recordTimer("session-manager:statusHeartbeat", 2, { sessionsScanned: 1 });
			diag.recordChildProcess("git status", 3, { exitCode: 0 });
			diag.flush("unit");
			diag.shutdown();

			assert.equal(fs.existsSync(file), false, "disabled diagnostics must not create JSONL output");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes JSONL snapshots and resets interval aggregation after flush", async () => {
		const { dir, file } = tempFile("enabled.jsonl");
		try {
			process.env.BOBBIT_CPU_DIAG = "1";
			process.env.BOBBIT_CPU_DIAG_JSONL = file;
			process.env.BOBBIT_CPU_DIAG_FLUSH_MS = "60000";

			const mod = await importFresh("enabled");
			assert.equal(mod.cpuDiagnosticsEnabled(), true);
			const diag = mod.getCpuDiagnostics();

			diag.recordRest("GET /api/projects", 200, 10, 100);
			diag.recordRest("GET /api/projects", 404, 30, 50);
			diag.recordWsBroadcast("server:broadcastToAll", "projects_changed", {
				frames: 1,
				recipients: 2,
				scanned: 3,
				bytes: 40,
				stringifyMs: 1,
				sendMs: 2,
			});
			diag.recordTimer("session-manager:statusHeartbeat", 4, {
				sessionsScanned: 2,
				sessionsWithClients: 1,
				frames: 1,
				recipients: 2,
			});
			diag.recordChildProcess("git status", 12, { exitCode: 0 });

			diag.flush("unit");
			const firstLines = fs.readFileSync(file, "utf-8").trim().split("\n");
			assert.equal(firstLines.length, 1);
			const first = JSON.parse(firstLines[0]);

			assert.equal(first.kind, "cpu");
			assert.equal(first.reason, "unit");
			assert.equal(typeof first.cpuUserMs, "number");
			assert.equal(typeof first.cpuSystemMs, "number");
			assert.equal(typeof first.cpuPct, "number");
			assert.equal(typeof first.elu, "number");
			assert.equal(typeof first.delayP95Ms, "number");
			assert.equal(typeof first.rssMb, "number");
			assert.equal(typeof first.handles, "object");

			assert.equal(first.rest["GET /api/projects"].count, 2);
			assert.equal(first.rest["GET /api/projects"].status["2xx"], 1);
			assert.equal(first.rest["GET /api/projects"].status["4xx"], 1);
			assert.equal(first.rest["GET /api/projects"].responseBytes, 150);
			assert.equal(first.ws["server:broadcastToAll:projects_changed"].count, 1);
			assert.equal(first.ws["server:broadcastToAll:projects_changed"].recipients, 2);
			assert.equal(first.ws["server:broadcastToAll:projects_changed"].bytes, 40);
			assert.equal(first.timers["session-manager:statusHeartbeat"].count, 1);
			assert.equal(first.timers["session-manager:statusHeartbeat"].sessionsScanned, 2);
			assert.equal(first.child["git status"].count, 1);
			assert.equal(first.child["git status"].metadata.exitCode["0"], 1);

			diag.flush("after-reset");
			const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
			assert.equal(lines.length, 2);
			const second = JSON.parse(lines[1]);
			assert.equal(second.reason, "after-reset");
			assert.deepEqual(second.rest, {});
			assert.deepEqual(second.ws, {});
			assert.deepEqual(second.timers, {});
			assert.deepEqual(second.child, {});

			diag.shutdown();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
