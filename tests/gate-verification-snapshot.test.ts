import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildGateVerificationSnapshot } from "../src/server/gate-verification-snapshot.ts";

const tempDirs: string[] = [];

after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gate-snapshot-"));
	tempDirs.push(dir);
	return dir;
}

function writeLines(filePath: string, prefix: string, count: number): void {
	const fd = fs.openSync(filePath, "w");
	try {
		for (let i = 1; i <= count; i++) fs.writeSync(fd, `${prefix}-${i}\n`);
	} finally {
		fs.closeSync(fd);
	}
}

function makeSnapshot(outFile: string, selectionOptions?: Parameters<typeof buildGateVerificationSnapshot>[0]["selectionOptions"]) {
	return buildGateVerificationSnapshot({
		goalId: "goal-1",
		gateId: "gate-1",
		signalId: "signal-1",
		verification: {
			status: "running",
			steps: [{
				name: "Verbose command",
				type: "command",
				status: "running",
				passed: false,
				output: "",
				duration_ms: 0,
			}],
		},
		activeVerification: {
			goalId: "goal-1",
			gateId: "gate-1",
			signalId: "signal-1",
			overallStatus: "running",
			startedAt: 1,
			steps: [{
				name: "Verbose command",
				type: "command",
				status: "running",
				startedAt: 1,
				outFile,
			}],
		},
		selectionOptions,
		now: 100,
	});
}

describe("gate verification active live command log reads", () => {
	it("default tail selection reads a bounded suffix and exposes the last 20 live log lines", () => {
		const dir = makeTempDir();
		const outFile = path.join(dir, "stdout.log");
		writeLines(outFile, "live-line", 100_000);

		const snapshot = makeSnapshot(outFile);
		const step = snapshot.steps[0];

		assert.equal(step.status, "running");
		assert.match(step.output ?? "", /live-line-99981/);
		assert.match(step.output ?? "", /live-line-100000/);
		assert.doesNotMatch(step.output ?? "", /live-line-99980/);
		assert.doesNotMatch(step.output ?? "", /live-line-1\b/);
		assert.equal(step.selection?.mode, "tail");
		assert.equal(step.selection?.truncated, true);
		assert.match(step.selection?.truncationReason ?? "", /live log read bounded to last \d+ bytes before selection/);
	});

	it("non-tail selection modes mark live logs truncated before selection when the read budget is reached", () => {
		const dir = makeTempDir();
		const outFile = path.join(dir, "stdout.log");
		writeLines(outFile, "full-mode-line", 100_000);

		const snapshot = makeSnapshot(outFile, { mode: "full" });
		const step = snapshot.steps[0];

		assert.match(step.output ?? "", /full-mode-line-1\b/);
		assert.doesNotMatch(step.output ?? "", /full-mode-line-100000\b/);
		assert.equal(step.selection?.truncated, true);
		assert.match(step.selection?.truncationReason ?? "", /live log read bounded to first \d+ bytes before selection/);
	});
});
