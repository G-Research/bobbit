import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildGateVerificationSnapshot, UnknownVerificationStepError } from "../src/server/gate-verification-snapshot.ts";

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

function lines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`).join("\n");
}

function makeMultiStepSnapshot(stepName?: string, selectionOptions?: Parameters<typeof buildGateVerificationSnapshot>[0]["selectionOptions"]) {
	return buildGateVerificationSnapshot({
		goalId: "goal-1",
		gateId: "gate-1",
		signalId: "signal-1",
		verification: {
			status: "failed",
			steps: [
				{ name: "build", type: "command", status: "passed", passed: true, output: lines("build-out", 30), duration_ms: 10 },
				{ name: "unit", type: "command", status: "failed", passed: false, output: `noise A\nERROR failed sentinel\nnoise B\n${lines("unit-tail", 50)}`, duration_ms: 20 },
				{ name: "lint", type: "command", status: "passed", passed: true, output: lines("lint-out", 15), duration_ms: 5 },
			],
		},
		selectionOptions,
		stepName,
		now: 100,
	});
}

describe("gate verification per-step (stepName) filter", () => {
	it("returns the full step array when stepName is omitted", () => {
		const snapshot = makeMultiStepSnapshot();
		assert.equal(snapshot.steps.length, 3);
		assert.deepEqual(snapshot.steps.map(s => s.name), ["build", "unit", "lint"]);
		assert.equal(snapshot.counts.passed, 2);
		assert.equal(snapshot.counts.failed, 1);
	});

	it("narrows to a single named step and recomputes counts/summary", () => {
		const snapshot = makeMultiStepSnapshot("unit");
		assert.equal(snapshot.steps.length, 1);
		assert.equal(snapshot.steps[0].name, "unit");
		assert.equal(snapshot.counts.failed, 1);
		assert.equal(snapshot.counts.passed, 0);
		assert.equal(snapshot.summary, "1 failed");
		assert.equal(snapshot.selection.totalLines, snapshot.steps[0].selection?.totalLines);
	});

	it("throws UnknownVerificationStepError listing available names for an unknown step", () => {
		assert.throws(
			() => makeMultiStepSnapshot("nope"),
			(err: unknown) => {
				assert.ok(err instanceof UnknownVerificationStepError);
				assert.deepEqual(err.availableSteps, ["build", "unit", "lint"]);
				assert.match(err.message, /Unknown verification step "nope"\. Available steps: build, unit, lint/);
				return true;
			},
		);
	});

	it("applies grep selection to the targeted step only", () => {
		const snapshot = makeMultiStepSnapshot("unit", { mode: "grep", pattern: "ERROR|failed", context: 1 });
		assert.equal(snapshot.steps.length, 1);
		const step = snapshot.steps[0];
		assert.equal(step.name, "unit");
		assert.match(step.output ?? "", /ERROR failed sentinel/);
		assert.doesNotMatch(step.output ?? "", /unit-tail-50/);
		assert.equal(step.selection?.mode, "grep");
	});

	it("applies slice selection to the targeted step only", () => {
		const snapshot = makeMultiStepSnapshot("build", { mode: "slice", from: 2, to: 4 });
		assert.equal(snapshot.steps.length, 1);
		const step = snapshot.steps[0];
		assert.equal(step.name, "build");
		assert.match(step.output ?? "", /^2\b.*build-out-2/m);
		assert.match(step.output ?? "", /^4\b.*build-out-4/m);
		assert.doesNotMatch(step.output ?? "", /build-out-5\b/);
		assert.equal(step.selection?.mode, "slice");
		assert.deepEqual(step.selection?.range, { from: 2, to: 4 });
	});
});

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
