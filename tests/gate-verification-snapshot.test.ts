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

function makeDiagnosticsSnapshot(selectionOptions?: Parameters<typeof buildGateVerificationSnapshot>[0]["selectionOptions"]) {
	const dir = makeTempDir();
	const stdoutPath = path.join(dir, "stdout.log");
	const stderrPath = path.join(dir, "stderr.log");
	const artifactPath = path.join(dir, "artifacts", "test-results", "case", "error-context.md");
	fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
	fs.writeFileSync(stdoutPath, "retained stdout marker\n", "utf8");
	fs.writeFileSync(stderrPath, "retained stderr marker\n", "utf8");
	fs.writeFileSync(artifactPath, "# Error Context\nretained artifact marker\n", "utf8");

	return makeArtifactDiagnosticsSnapshot({
		artifacts: [{ relativePath: "test-results/case/error-context.md", content: "# Error Context\nretained artifact marker\n" }],
		selectionOptions,
		dir,
		stdoutPath,
		stderrPath,
	});
}

function makeArtifactDiagnosticsSnapshot(input: {
	artifacts: Array<{ relativePath: string; content: string }>;
	selectionOptions?: Parameters<typeof buildGateVerificationSnapshot>[0]["selectionOptions"];
	dir?: string;
	stdoutPath?: string;
	stderrPath?: string;
}) {
	const dir = input.dir ?? makeTempDir();
	const stdoutPath = input.stdoutPath ?? path.join(dir, "stdout.log");
	const stderrPath = input.stderrPath ?? path.join(dir, "stderr.log");
	if (!fs.existsSync(stdoutPath)) fs.writeFileSync(stdoutPath, "retained stdout marker\n", "utf8");
	if (!fs.existsSync(stderrPath)) fs.writeFileSync(stderrPath, "retained stderr marker\n", "utf8");
	const artifacts = input.artifacts.map((artifact) => {
		const artifactPath = path.join(dir, "artifacts", ...artifact.relativePath.split("/"));
		fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
		fs.writeFileSync(artifactPath, artifact.content, "utf8");
		return {
			path: artifactPath,
			relativePath: artifact.relativePath,
			sourcePath: path.join(dir, "source", ...artifact.relativePath.split("/")),
			bytes: fs.statSync(artifactPath).size,
			kind: "test-results" as const,
			content: artifact.content,
			contentType: "text/markdown",
		};
	});

	return buildGateVerificationSnapshot({
		goalId: "goal-1",
		gateId: "gate-1",
		signalId: "signal-1",
		verification: {
			status: "failed",
			steps: [{
				name: "playwright command",
				type: "command",
				status: "failed",
				passed: false,
				output: "compact failure tail only",
				duration_ms: 7,
				diagnostics: {
					type: "retained-command-diagnostics",
					baseDir: dir,
					stdout: { path: stdoutPath, bytes: fs.statSync(stdoutPath).size, lines: 1 },
					stderr: { path: stderrPath, bytes: fs.statSync(stderrPath).size, lines: 1 },
					artifacts,
					createdAt: 1,
				},
			}],
		},
		selectionOptions: input.selectionOptions,
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

describe("gate verification retained diagnostics compactness", () => {
	it("keeps implicit/default snapshots compact while preserving explicit diagnostics access", () => {
		const compact = makeDiagnosticsSnapshot({ implicitDefault: true });
		const compactStep = compact.steps[0];
		const compactJson = JSON.stringify(compactStep);

		assert.equal(compactStep.output, "compact failure tail only");
		assert.doesNotMatch(compactJson, /stdout\.log|stderr\.log|error-context\.md|retained artifact marker/);
		assert.equal(compactStep.diagnostics?.logs, undefined, "default status snapshots must not expose retained log paths");
		assert.equal(compactStep.diagnostics?.artifacts?.files, undefined, "default status snapshots must not expose retained artifact file lists");

		const explicit = makeDiagnosticsSnapshot({ mode: "full" });
		const explicitStep = explicit.steps[0];
		const explicitJson = JSON.stringify(explicitStep);

		assert.match(explicitStep.output ?? "", /retained stdout marker/);
		assert.match(explicitStep.output ?? "", /retained stderr marker/);
		assert.match(explicitJson, /stdout\.log/);
		assert.match(explicitJson, /error-context\.md/);
		assert.doesNotMatch(explicitJson, /retained artifact marker/);
		assert.ok(explicitStep.diagnostics?.artifacts?.files.every(file => !("content" in file)), "verification snapshots must expose artifact metadata only");
	});

	it("keeps many failed artifact metadata compact and never serializes artifact content", () => {
		const artifactCount = 100;
		const marker = "SYNTHETIC_ARTIFACT_BODY_MARKER_SHOULD_NOT_INLINE";
		const snapshot = makeArtifactDiagnosticsSnapshot({
			selectionOptions: { mode: "full" },
			artifacts: Array.from({ length: artifactCount }, (_, i) => ({
				relativePath: `test-results/failing-case-${String(i + 1).padStart(3, "0")}/error-context.md`,
				content: `# Error Context\n${marker}-${i + 1}\n${"artifact body ".repeat(500)}\n`,
			})),
		});
		const json = JSON.stringify(snapshot);
		const files = snapshot.steps[0].diagnostics?.artifacts?.files ?? [];

		assert.ok(Buffer.byteLength(json, "utf8") < 64 * 1024, `verification snapshot was ${Buffer.byteLength(json, "utf8")} bytes`);
		assert.equal(snapshot.steps[0].diagnostics?.artifacts?.count, artifactCount);
		assert.equal(files.length, artifactCount);
		assert.ok(files.every(file => !("content" in file)), "artifact content fields must be omitted from verification snapshots");
		assert.doesNotMatch(json, new RegExp(marker));
	});

	it("collapses Playwright retry artifacts under the stable base id", () => {
		const baseSlug = "pr-walkthrough-host-agents-078cd-verable-child-self-recover--api";
		const snapshot = makeArtifactDiagnosticsSnapshot({
			selectionOptions: { mode: "full" },
			artifacts: ["", "-retry1", "-retry2", "-retry3"].map(suffix => ({
				relativePath: `test-results/${baseSlug}${suffix}/error-context.md`,
				content: `# Error Context\nretry fixture ${suffix || "base"}\n`,
			})),
		});
		const files = snapshot.steps[0].diagnostics?.artifacts?.files as Array<any> | undefined;
		assert.ok(files);
		assert.equal(snapshot.steps[0].diagnostics?.artifacts?.count, 4);
		assert.equal(files!.length, 1);
		assert.equal(files![0].id, baseSlug);
		assert.equal(files![0].retries, 3);
		assert.equal(files![0].relativePath, `test-results/${baseSlug}/error-context.md`);
	});

	it("adds artifact retrieval examples to inspect hints when artifact metadata exists", () => {
		const snapshot = makeDiagnosticsSnapshot({ mode: "full" });
		const hints = snapshot.steps[0].diagnostics?.inspectHints ?? [];
		assert.ok(
			hints.some(hint => /section="artifact"/.test(hint) && /artifact="case"/.test(hint) && /step="playwright command"/.test(hint)),
			`expected artifact inspect hint, got: ${hints.join("\n")}`,
		);
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
