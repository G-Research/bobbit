import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { readHeartbeatDiagnostics } = await import(new URL("../scripts/lib/unit-heartbeat.mjs", import.meta.url).href);

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function writeHeartbeat(state: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "hb-diag-test-"));
	tmpDirs.push(dir);
	const file = join(dir, "hb.json");
	writeFileSync(file, JSON.stringify(state));
	return file;
}

const NOW = 1_000_000;

test("diagnostics name the hung file(s) still in flight at timeout", () => {
	const file = writeHeartbeat({
		schemaVersion: 1,
		lastEventAt: NOW - 90_000,
		completedFiles: 338,
		activeFiles: [{ file: "C:\\repo\\tests\\bg-process-manager.test.ts", startedAt: NOW - 95_000 }],
		runningTests: [],
	});
	const lines = readHeartbeatDiagnostics(file, NOW);
	const joined = lines.join("\n");
	assert.match(joined, /338 test file\(s\) completed/, "reports how many files finished");
	assert.match(joined, /last node:test event 90\.0s ago/, "reports staleness of the last event");
	assert.match(joined, /1 test file\(s\) still in flight/, "reports the in-flight count");
	assert.match(joined, /HUNG FILE: C:\\repo\\tests\\bg-process-manager\.test\.ts \(running 95\.0s\)/, "explicitly names the hung file and how long it ran");
});

test("diagnostics include best-effort in-flight subtest names", () => {
	const file = writeHeartbeat({
		lastEventAt: NOW,
		completedFiles: 1,
		activeFiles: [{ file: "/repo/tests/slow.test.ts", startedAt: NOW - 5_000 }],
		runningTests: [{ file: "/repo/tests/slow.test.ts", name: "waits forever", startedAt: NOW - 5_000 }],
	});
	const joined = readHeartbeatDiagnostics(file, NOW).join("\n");
	assert.match(joined, /HUNG FILE: \/repo\/tests\/slow\.test\.ts/);
	assert.match(joined, /in-flight test: waits forever \(\/repo\/tests\/slow\.test\.ts\)/);
});

test("diagnostics flag a hang with no in-flight files as outside a test file", () => {
	const file = writeHeartbeat({ lastEventAt: NOW - 3_000, completedFiles: 341, activeFiles: [], runningTests: [] });
	const joined = readHeartbeatDiagnostics(file, NOW).join("\n");
	assert.match(joined, /no test files were still in flight/, "distinguishes a leaked-handle/descendant hang");
	assert.match(joined, /leaked handle\/descendant/);
});

test("diagnostics degrade gracefully when the heartbeat is missing or corrupt", () => {
	const missing = readHeartbeatDiagnostics(join(tmpdir(), "definitely-absent-heartbeat-xyz.json"), NOW);
	assert.match(missing.join("\n"), /no node heartbeat file at/, "missing heartbeat is reported, not thrown");

	const dir = mkdtempSync(join(tmpdir(), "hb-diag-bad-"));
	tmpDirs.push(dir);
	const badFile = join(dir, "hb.json");
	writeFileSync(badFile, "{not valid json");
	const corrupt = readHeartbeatDiagnostics(badFile, NOW);
	assert.match(corrupt.join("\n"), /could not parse node heartbeat/, "corrupt heartbeat is reported, not thrown");
});
