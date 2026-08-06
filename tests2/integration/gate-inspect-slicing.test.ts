// Gate-inspect is an HTTP selection contract, not a command-process fidelity
// suite. It seeds completed signals and retained diagnostics directly so shared
// integration forks never wait on an executor selected by another spec.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { test, expect } from "./_e2e/in-process-harness.js";
import { vi } from "vitest";
import { apiFetch, createGoal, deleteGoal, nonGitCwd } from "./_e2e/e2e-setup.js";
import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import { gateStoreV2Root } from "../../src/server/agent/gate-store-v2-persistence.js";
import { buildGateVerificationInspectionSnapshot } from "../../src/server/gate-verification-snapshot.js";
import type { GatewayFixture } from "../harness/gateway.js";
import { createFakeVerificationCommandRunner } from "../harness/fake-verification-command-runner.js";
import { createMemFs } from "../harness/mem-fs.js";

const VERIFY_LOG_OUTPUT = Array.from({ length: 160 }, (_, i) => {
	const line = i + 1;
	return `${line === 125 ? "ERROR failed sentinel line" : "noise line"} ${line}`;
}).join("\n");
const RETAINED_DIAGNOSTICS_MARKER = "RETAINED_GATE_DIAGNOSTICS_EARLY_MARKER stack frame";
const FAILED_RETAINED_DIAGNOSTICS_OUTPUT = [
	...Array.from({ length: 80 }, (_, i) => `prelude line ${i + 1} ${"x".repeat(100)}`),
	RETAINED_DIAGNOSTICS_MARKER,
	...Array.from({ length: 180 }, (_, i) => `tail line ${i + 81} ${"y".repeat(100)}`),
].join("\n");
const PLAYWRIGHT_ERROR_CONTEXT_MARKER = "PLAYWRIGHT_ERROR_CONTEXT_FILE_RETAINED_MARKER";
const PLAYWRIGHT_STYLE_FAILURE_SUMMARY = "PLAYWRIGHT_STYLE_FAILURE_SUMMARY: expect(locator).toBeVisible failed; see test-results/retain-artifact-fixture/error-context.md";
const RETAINED_LOG_CAP_MARKER = "RETAINED_GATE_DIAGNOSTICS_CAP_MARKER";
const RETAINED_LOG_CAP_BYTES = 128 * 1024;
const HUGE_RETAINED_LOG_CHUNKS = 96;
const HUGE_RETAINED_LOG_CHUNK_BYTES = 2048;
const HUGE_RETAINED_LOG_EMITTED_BYTES = HUGE_RETAINED_LOG_CHUNKS * ("CAP-FILL ".length + HUGE_RETAINED_LOG_CHUNK_BYTES + 1);
const CAPPED_RETAINED_LOG_OUTPUT = Array.from(
	{ length: HUGE_RETAINED_LOG_CHUNKS },
	() => `CAP-FILL ${"x".repeat(HUGE_RETAINED_LOG_CHUNK_BYTES)}`,
).join("\n").slice(0, RETAINED_LOG_CAP_BYTES);
const MANAGED_PRIMARY_ARTIFACT_MARKER = "MANAGED_PRIMARY_ARTIFACT_BOUNDED_MARKER";
const MANAGED_QA_ARTIFACT_MARKER = "MANAGED_QA_ARTIFACT_OLDER_THAN_HOT_WINDOW";
const MANAGED_ARTIFACT_BYTES = 10 * 1024 * 1024;
const PRODUCTION_SCALE_NO_NEWLINE_BYTES = 64 * 1024 * 1024;

function inspectHeartbeat(): { stop: () => number } {
	const intervalMs = 5;
	let last = performance.now();
	let maxLag = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxLag = Math.max(maxLag, now - last - intervalMs);
		last = now;
	}, intervalMs);
	return { stop: () => { clearInterval(timer); return maxLag; } };
}

function playwrightErrorContext(): string {
	return [
		"# Instructions",
		"You are given a Playwright error context.",
		"",
		"## Test failure",
		PLAYWRIGHT_ERROR_CONTEXT_MARKER,
		"locator(\"text=Missing\") failed after retry",
		...Array.from({ length: 2600 }, (_, i) => `artifact detail line ${i + 1} ${"z".repeat(40)}`),
	].join("\n");
}

function makeWorkflowId(): string {
	return `gate-inspect-slicing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function contentLines(count: number, prefix = "content-line"): string {
	return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`).join("\n");
}

async function createInspectWorkflow(workflowId: string): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: workflowId,
			name: "Gate Inspect Slicing",
			description: "Fixture workflow for gate inspect slicing tests.",
			gates: [
				{ id: "content-gate", name: "Content Gate", content: true, inject_downstream: true },
				{
					id: "verify-gate",
					name: "Verification Gate",
					verify: [{ name: "Large command output", type: "command", run: "true" }],
				},
				{
					id: "multi-verify-gate",
					name: "Multi Verification Gate",
					verify: [
						{ name: "build", type: "command", run: "true" },
						{ name: "unit", type: "command", run: "true" },
						{ name: "lint", type: "command", run: "true" },
					],
				},
				{
					id: "failed-retained-diagnostics-gate",
					name: "Failed Retained Diagnostics Gate",
					verify: [{ name: "failing verbose command", type: "command", run: "false" }],
				},
				{
					id: "playwright-artifacts-gate",
					name: "Playwright Artifacts Gate",
					verify: [{ name: "playwright-style failure", type: "command", run: "false" }],
				},
				{
					id: "huge-retained-log-gate",
					name: "Huge Retained Log Gate",
					verify: [{ name: "huge retained log failure", type: "command", run: "false" }],
				},
				{ id: "signals-gate", name: "Signals Gate", content: true },
			],
		}),
	});
	if (res.status !== 201) {
		throw new Error(`workflow creation failed: ${res.status} ${await res.text().catch(() => "")}`);
	}
}

async function deleteInspectWorkflow(workflowId: string): Promise<void> {
	await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => undefined);
}

interface SeededStep {
	name: string;
	passed: boolean;
	stdout?: string;
	stderr?: string;
	compactOutput?: string;
	truncated?: boolean;
	artifacts?: boolean;
}

const fakeCmdGlobal = globalThis as { __BOBBIT_V2_FAKE_CMD_STEP__?: boolean };
let gatewayFixture: GatewayFixture;
let originalCommandStepRunner: unknown;
let originalRetainedLogCap: string | undefined;
let originalFakeCmdFlag: boolean | undefined;
let hadFakeCmdFlag = false;
let signalSequence = 0;
let inspectWorkflowId: string;
let inspectGoalId: string;
let inspectStateDir: string;

const INSPECT_GATE_IDS = [
	"content-gate",
	"verify-gate",
	"multi-verify-gate",
	"failed-retained-diagnostics-gate",
	"playwright-artifacts-gate",
	"huge-retained-log-gate",
	"signals-gate",
];

test.beforeAll(async ({ gateway }) => {
	gatewayFixture = gateway;
	const verificationHarness = gateway.teamManager.verificationHarness;
	if (!verificationHarness) throw new Error("verification harness was not wired before gate-inspect setup");
	originalCommandStepRunner = verificationHarness.commandStepRunner;
	originalRetainedLogCap = process.env.BOBBIT_RETAINED_LOG_MAX_BYTES;
	hadFakeCmdFlag = Object.prototype.hasOwnProperty.call(fakeCmdGlobal, "__BOBBIT_V2_FAKE_CMD_STEP__");
	originalFakeCmdFlag = fakeCmdGlobal.__BOBBIT_V2_FAKE_CMD_STEP__;
	process.env.BOBBIT_RETAINED_LOG_MAX_BYTES = String(RETAINED_LOG_CAP_BYTES);
	fakeCmdGlobal.__BOBBIT_V2_FAKE_CMD_STEP__ = true;
	verificationHarness.commandStepRunner = createFakeVerificationCommandRunner();
	gateway.clock.advance(0);

	// One goal/workflow owns all selection cases. Per-test gate-store resets remove
	// repeated project discovery and disk churn while retaining the real HTTP route.
	inspectWorkflowId = makeWorkflowId();
	await createInspectWorkflow(inspectWorkflowId);
	inspectGoalId = (await createGoal({ title: "Gate Inspect Slicing", workflowId: inspectWorkflowId })).id;
	const context = gateway.projectContextManager.getContextForGoal(inspectGoalId);
	if (!context) throw new Error(`missing project context for shared inspect goal ${inspectGoalId}`);
	inspectStateDir = path.join(context.project.rootPath, ".bobbit", "state");
});

test.afterAll(async ({ gateway }) => {
	await deleteGoal(inspectGoalId).catch(() => undefined);
	await deleteInspectWorkflow(inspectWorkflowId);
	const verificationHarness = gateway.teamManager.verificationHarness;
	if (verificationHarness && originalCommandStepRunner !== undefined) {
		verificationHarness.commandStepRunner = originalCommandStepRunner;
	}
	if (originalRetainedLogCap === undefined) delete process.env.BOBBIT_RETAINED_LOG_MAX_BYTES;
	else process.env.BOBBIT_RETAINED_LOG_MAX_BYTES = originalRetainedLogCap;
	if (hadFakeCmdFlag) fakeCmdGlobal.__BOBBIT_V2_FAKE_CMD_STEP__ = originalFakeCmdFlag;
	else delete fakeCmdGlobal.__BOBBIT_V2_FAKE_CMD_STEP__;
});

function seededStepsForGate(gateId: string): { status: "passed" | "failed"; steps: SeededStep[] } {
	switch (gateId) {
		case "verify-gate":
			return { status: "passed", steps: [{ name: "Large command output", passed: true, stdout: VERIFY_LOG_OUTPUT }] };
		case "multi-verify-gate":
			return {
				status: "passed",
				steps: [
					{ name: "build", passed: true, stdout: "build ok line" },
					{ name: "unit", passed: true, stdout: VERIFY_LOG_OUTPUT },
					{ name: "lint", passed: true, stdout: "lint ok line" },
				],
			};
		case "failed-retained-diagnostics-gate":
			return {
				status: "failed",
				steps: [{
					name: "failing verbose command",
					passed: false,
					stdout: FAILED_RETAINED_DIAGNOSTICS_OUTPUT,
					compactOutput: "tail line 260",
				}],
			};
		case "playwright-artifacts-gate":
			return {
				status: "failed",
				steps: [{
					name: "playwright-style failure",
					passed: false,
					stderr: PLAYWRIGHT_STYLE_FAILURE_SUMMARY,
					compactOutput: PLAYWRIGHT_STYLE_FAILURE_SUMMARY,
					artifacts: true,
				}],
			};
		case "huge-retained-log-gate":
			return {
				status: "failed",
				steps: [{
					name: "huge retained log failure",
					passed: false,
					stdout: CAPPED_RETAINED_LOG_OUTPUT,
					stderr: RETAINED_LOG_CAP_MARKER,
					compactOutput: RETAINED_LOG_CAP_MARKER,
					truncated: true,
				}],
			};
		default:
			return { status: "passed", steps: [] };
	}
}

function logMetadata(filePath: string, text: string, truncated = false): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		path: filePath,
		bytes: Buffer.byteLength(text, "utf8"),
		lines: text.length ? text.split("\n").length : 0,
	};
	if (truncated) {
		metadata.truncated = true;
		metadata.truncationReason = `retained log capped at ${RETAINED_LOG_CAP_BYTES} bytes`;
	}
	return metadata;
}

async function seedStepDiagnostics(
	goalId: string,
	gateId: string,
	signalId: string,
	stepIndex: number,
	step: SeededStep,
): Promise<any> {
	const baseDir = path.join(inspectStateDir, "gate-diagnostics", goalId, gateId, signalId, `${String(stepIndex).padStart(2, "0")}-${step.name.replace(/[^A-Za-z0-9._-]/g, "_")}`);
	fs.rmSync(baseDir, { recursive: true, force: true });
	fs.mkdirSync(baseDir, { recursive: true });
	const diagnostics: any = {
		type: "retained-command-diagnostics",
		baseDir,
		createdAt: gatewayFixture.clock.now(),
	};
	if (step.stdout !== undefined) {
		const stdoutPath = path.join(baseDir, "stdout.log");
		fs.writeFileSync(stdoutPath, step.stdout);
		diagnostics.stdout = logMetadata(stdoutPath, step.stdout, step.truncated);
	}
	if (step.stderr !== undefined) {
		const stderrPath = path.join(baseDir, "stderr.log");
		fs.writeFileSync(stderrPath, step.stderr);
		diagnostics.stderr = logMetadata(stderrPath, step.stderr);
	}
	if (step.truncated) {
		diagnostics.truncated = true;
		diagnostics.truncationReason = `retained log capped at ${RETAINED_LOG_CAP_BYTES} bytes`;
	}
	if (step.artifacts) {
		const relativeRoot = path.join("test-results", "retain-artifact-fixture");
		const retainedRoot = path.join(baseDir, "artifacts", relativeRoot);
		fs.mkdirSync(retainedRoot, { recursive: true });
		const files = [
			{ name: "error-context.md", body: playwrightErrorContext(), contentType: "text/markdown" },
			{ name: "trace.zip", body: "trace placeholder", contentType: "application/zip" },
			{ name: "screenshot.png", body: "png placeholder", contentType: "image/png" },
		];
		diagnostics.artifacts = files.map(file => {
			const retainedPath = path.join(retainedRoot, file.name);
			fs.writeFileSync(retainedPath, file.body);
			const relativePath = path.join(relativeRoot, file.name).replace(/\\/g, "/");
			return {
				path: retainedPath,
				relativePath,
				sourcePath: path.join(nonGitCwd(), relativePath),
				bytes: Buffer.byteLength(file.body, "utf8"),
				kind: "test-results",
				contentType: file.contentType,
			};
		});
	}
	return diagnostics;
}

async function seedSignal(goalId: string, gateId: string, body: Record<string, unknown>): Promise<any> {
	const context = gatewayFixture.projectContextManager.getContextForGoal(goalId);
	if (!context) throw new Error(`missing project context for goal ${goalId}`);
	const gateStore = context.gateStore;
	const fixture = seededStepsForGate(gateId);
	const signalId = `gate-inspect-${process.pid}-${++signalSequence}`;
	const steps = await Promise.all(fixture.steps.map(async (step, index) => ({
		name: step.name,
		type: "command",
		passed: step.passed,
		status: step.passed ? "passed" : "failed",
		output: step.compactOutput ?? step.stdout ?? step.stderr ?? "",
		duration_ms: 0,
		diagnostics: await seedStepDiagnostics(goalId, gateId, signalId, index, step),
	})));
	const content = typeof body.content === "string" ? body.content : undefined;
	const signal = {
		id: signalId,
		gateId,
		goalId,
		sessionId: "gate-inspect-fixture",
		timestamp: gatewayFixture.clock.now() + signalSequence,
		commitSha: "fixture",
		content,
		contentVersion: content === undefined ? undefined : (gateStore.getGate(goalId, gateId)?.signals.length ?? 0) + 1,
		verification: { status: fixture.status, steps },
	};
	gateStore.recordSignal(signal);
	if (content !== undefined) gateStore.updateGateContent(goalId, gateId, content, signal.contentVersion);
	gateStore.updateGateStatus(goalId, gateId, fixture.status);
	// Flush any same-tick gateway observations deterministically; no polling or
	// host timer is involved in this fixture.
	gatewayFixture.clock.advance(0);
	return { signal: { id: signalId } };
}

async function signalAndWait(goalId: string, gateId: string, body: Record<string, unknown>): Promise<any> {
	const signal = await seedSignal(goalId, gateId, body);
	const stored = gatewayFixture.projectContextManager.getContextForGoal(goalId)?.gateStore
		.getGate(goalId, gateId)?.signals.find((entry: any) => entry.id === signal.signal.id);
	if (stored?.verification?.status !== "passed") throw new Error(`seeded ${gateId} did not pass`);
	return signal;
}

async function signalAndWaitFailed(goalId: string, gateId: string, body: Record<string, unknown>): Promise<any> {
	const signal = await seedSignal(goalId, gateId, body);
	const stored = gatewayFixture.projectContextManager.getContextForGoal(goalId)?.gateStore
		.getGate(goalId, gateId)?.signals.find((entry: any) => entry.id === signal.signal.id);
	if (stored?.verification?.status !== "failed") throw new Error(`seeded ${gateId} did not fail`);
	return signal;
}

async function inspectGate(goalId: string, gateId: string, section: string, params: Record<string, string | number> = {}): Promise<Response> {
	const qs = new URLSearchParams({ section });
	for (const [key, value] of Object.entries(params)) qs.set(key, String(value));
	return apiFetch(`/api/goals/${goalId}/gates/${gateId}/inspect?${qs.toString()}`);
}

async function gateSummary(goalId: string, gateId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}?view=summary`);
	if (res.status !== 200) throw new Error(`gate summary ${gateId} failed: ${res.status} ${await res.text().catch(() => "")}`);
	return res.json();
}

async function withGoal<T>(run: (goalId: string) => Promise<T>): Promise<T> {
	return run(inspectGoalId);
}

function resetInspectGateStore(): void {
	const gateStore = gatewayFixture.projectContextManager.getContextForGoal(inspectGoalId)?.gateStore;
	if (!gateStore) throw new Error(`missing gate store for shared inspect goal ${inspectGoalId}`);
	gateStore.removeGoalGates(inspectGoalId);
	gateStore.initGatesForGoal(inspectGoalId, INSPECT_GATE_IDS);
}

test.describe("gate inspect slicing", () => {
	test.beforeEach(() => resetInspectGateStore());
	test("preserves existing content inspect shape while defaulting to a bounded tail", async () => {
		await withGoal(async (goalId) => {
			const post = await signalAndWait(goalId, "content-gate", { content: contentLines(120) });
			const res = await inspectGate(goalId, "content-gate", "content");
			expect(res.status).toBe(200);
			const body = await res.json();

			expect(body.gateId).toBe("content-gate");
			expect(body.section).toBe("content");
			expect(body.signalIndex).toBe(0);
			expect(body.signalId).toBe(post.signal.id);
			expect(typeof body.text).toBe("string");
			expect(body.text).toContain("content-line-120");
			expect(body.text).not.toContain("content-line-40");
			expect(body.selection).toMatchObject({
				mode: "tail",
				totalLines: 120,
				range: { from: 41, to: 120 },
				truncated: false,
			});
			expect(body.selection.omittedHint).toMatch(/40 lines omitted.*mode="grep".*mode="slice"/i);
		});
	});

	test("supports explicit head and tail selection for content without default guidance", async () => {
		await withGoal(async (goalId) => {
			await signalAndWait(goalId, "content-gate", { content: contentLines(12) });

			const headRes = await inspectGate(goalId, "content-gate", "content", { mode: "head", lines: 3 });
			expect(headRes.status).toBe(200);
			const head = await headRes.json();
			expect(head.text).toContain("content-line-1");
			expect(head.text).toContain("content-line-3");
			expect(head.text).not.toContain("content-line-4");
			expect(head.selection).toMatchObject({ mode: "head", range: { from: 1, to: 3 }, totalLines: 12 });
			expect(head.selection.omittedHint).toBeUndefined();

			const tailRes = await inspectGate(goalId, "content-gate", "content", { mode: "tail", lines: 2 });
			expect(tailRes.status).toBe(200);
			const tail = await tailRes.json();
			expect(tail.text).toContain("content-line-11");
			expect(tail.text).toContain("content-line-12");
			expect(tail.text).not.toContain("content-line-10");
			expect(tail.selection).toMatchObject({ mode: "tail", range: { from: 11, to: 12 }, totalLines: 12 });
			expect(tail.selection.omittedHint).toBeUndefined();
		});
	});

	test("filters large verification output with grep context and slice ranges", async () => {
		await withGoal(async (goalId) => {
			const post = await signalAndWait(goalId, "verify-gate", {});

			const grepRes = await inspectGate(goalId, "verify-gate", "verification", {
				mode: "grep",
				pattern: "ERROR|failed",
				context: 2,
			});
			expect(grepRes.status).toBe(200);
			const grepBody = await grepRes.json();
			expect(grepBody.signalIndex).toBe(0);
			expect(grepBody.signalId).toBe(post.signal.id);
			expect(grepBody.steps).toHaveLength(1);
			const grepStep = grepBody.steps[0];
			expect(grepStep.output).toContain("noise line 123");
			expect(grepStep.output).toContain("noise line 124");
			expect(grepStep.output).toContain("ERROR failed sentinel line 125");
			expect(grepStep.output).toContain("noise line 126");
			expect(grepStep.output).toContain("noise line 127");
			expect(grepStep.output).not.toMatch(/\bnoise line 1\b/);
			expect(grepStep.output).not.toMatch(/\bnoise line 160\b/);
			expect(grepStep.selection).toMatchObject({ mode: "grep", totalLines: 160, matchCount: 1, shownMatches: 1 });
			expect(grepStep.selection.omittedHint).toBeUndefined();

			const sliceRes = await inspectGate(goalId, "verify-gate", "verification", {
				mode: "slice",
				from: 120,
				to: 126,
			});
			expect(sliceRes.status).toBe(200);
			const sliceBody = await sliceRes.json();
			const sliceStep = sliceBody.steps[0];
			expect(sliceStep.output).toMatch(/^120\b.*noise line 120/m);
			expect(sliceStep.output).toMatch(/^125\b.*ERROR failed sentinel line 125/m);
			expect(sliceStep.output).toMatch(/^126\b.*noise line 126/m);
			expect(sliceStep.output).not.toContain("noise line 119");
			expect(sliceStep.output).not.toContain("noise line 127");
			expect(sliceStep.selection).toMatchObject({ mode: "slice", totalLines: 160, range: { from: 120, to: 126 } });
			expect(sliceStep.selection.omittedHint).toBeUndefined();
		});
	});

	test("retains completed failed command diagnostics for explicit grep and slice inspection", async () => {
		await withGoal(async (goalId) => {
			const post = await signalAndWaitFailed(goalId, "failed-retained-diagnostics-gate", {});

			const grepRes = await inspectGate(goalId, "failed-retained-diagnostics-gate", "verification", {
				mode: "grep",
				pattern: "RETAINED_GATE_DIAGNOSTICS_EARLY_MARKER",
				context: 1,
			});
			expect(grepRes.status).toBe(200);
			const grepBody = await grepRes.json();
			expect(grepBody.signalId).toBe(post.signal.id);
			expect(grepBody.steps).toHaveLength(1);
			const grepStep = grepBody.steps[0];
			expect(
				grepStep.output,
				"RETAINED_GATE_DIAGNOSTICS_GREP_MISSING: completed failed command inspection must search retained full diagnostics, not only the compact persisted tail",
			).toContain(RETAINED_DIAGNOSTICS_MARKER);
			expect(grepStep.output).toContain("prelude line 80");
			expect(grepStep.output).toContain("tail line 81");
			expect(grepStep.selection).toMatchObject({ mode: "grep", matchCount: 1, shownMatches: 1 });

			const sliceRes = await inspectGate(goalId, "failed-retained-diagnostics-gate", "verification", {
				mode: "slice",
				from: 78,
				to: 83,
			});
			expect(sliceRes.status).toBe(200);
			const sliceBody = await sliceRes.json();
			const sliceStep = sliceBody.steps[0];
			expect(
				sliceStep.output,
				"RETAINED_GATE_DIAGNOSTICS_SLICE_MISSING: completed failed command inspection must slice retained full diagnostics, not only the compact persisted tail",
			).toContain(RETAINED_DIAGNOSTICS_MARKER);
			expect(sliceStep.output).toMatch(/^80\b.*prelude line 80/m);
			expect(sliceStep.output).toMatch(/^81\b.*RETAINED_GATE_DIAGNOSTICS_EARLY_MARKER/m);
			expect(sliceStep.output).toMatch(/^82\b.*tail line 81/m);
			expect(sliceStep.selection).toMatchObject({ mode: "slice", totalLines: 261, range: { from: 78, to: 83 } });
		});
	});

	test("retains completed failed command diagnostics after reloading persisted gate stores", async () => {
		await withGoal(async (goalId) => {
			const post = await signalAndWaitFailed(goalId, "failed-retained-diagnostics-gate", {});
			const liveSignal = gatewayFixture.projectContextManager.getContextForGoal(goalId)?.gateStore
				.getGate(goalId, "failed-retained-diagnostics-gate")?.signals.find((signal: any) => signal.id === post.signal.id);
			expect(liveSignal, "RETAINED_GATE_DIAGNOSTICS_GATE_STORE_FILE_MISSING: failed signal must be available for persistence reconstruction").toBeTruthy();

			// Reopen the exact persisted JSON through GateStore's in-memory FsLike seam.
			// This tests constructor reload semantics without recursively scanning every
			// project state directory on Defender-backed Windows filesystems.
			const memfs = createMemFs();
			const gateStoreDir = path.resolve("/memfs/gate-inspect-reload");
			const persistedGateStore = new GateStore(gateStoreDir, memfs);
			persistedGateStore.initGatesForGoal(goalId, ["failed-retained-diagnostics-gate"]);
			persistedGateStore.recordSignal(structuredClone(liveSignal));
			await persistedGateStore.flush();
			const reloadedGateStore = new GateStore(gateStoreDir, memfs);
			const reloadedGate = reloadedGateStore.getGate(goalId, "failed-retained-diagnostics-gate");
			const reloadedSignal = reloadedGate?.signals.find((signal: any) => signal.id === post.signal.id);
			expect(reloadedSignal, "RETAINED_GATE_DIAGNOSTICS_RELOAD_MISSING: failed signal must survive gate-store reconstruction").toBeTruthy();

			const snapshot = await buildGateVerificationInspectionSnapshot({
				goalId,
				gateId: "failed-retained-diagnostics-gate",
				signalId: post.signal.id,
				verification: reloadedSignal!.verification,
				selectionOptions: { mode: "grep", pattern: "RETAINED_GATE_DIAGNOSTICS_EARLY_MARKER", context: 1 },
				v2Root: gateStoreV2Root(inspectStateDir),
			});
			expect(snapshot.steps).toHaveLength(1);
			expect(
				snapshot.steps[0].output,
				"RETAINED_GATE_DIAGNOSTICS_RELOAD_GREP_MISSING: reconstructed gate inspection must read retained full diagnostics after restart/store reload, not only gates.json's compact tail",
			).toContain(RETAINED_DIAGNOSTICS_MARKER);
			expect(snapshot.steps[0].output).toContain("prelude line 80");
			expect(snapshot.steps[0].output).toContain("tail line 81");
			expect(snapshot.steps[0].selection).toMatchObject({ mode: "grep", matchCount: 1, shownMatches: 1 });
		});
	});

	test("hydrates a migrated managed output for inspection and fails closed when its payload is tampered", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gate-inspect-managed-"));
		try {
			const stateDir = path.join(root, "state");
			const v2Root = gateStoreV2Root(stateDir);
			fs.mkdirSync(stateDir, { recursive: true });
			const marker = "MIGRATED_MANAGED_INSPECT_MARKER";
			fs.writeFileSync(path.join(stateDir, "gates.json"), JSON.stringify([{
				goalId: "migrated-goal",
				gateId: "migrated-gate",
				status: "failed",
				signals: [{
					id: "migrated-signal",
					goalId: "migrated-goal",
					gateId: "migrated-gate",
					sessionId: "migrated-session",
					timestamp: 1,
					commitSha: "abc",
					verification: { status: "failed", steps: [{ name: "review", type: "llm-review", passed: false, status: "failed", output: marker, duration_ms: 1 }] },
				}],
				updatedAt: 1,
			}]), "utf8");

			const migrated = new GateStore(stateDir);
			const migratedSignal = migrated.getGate("migrated-goal", "migrated-gate")!.signals[0]!;
			const hydrated = await buildGateVerificationInspectionSnapshot({
				goalId: "migrated-goal",
				gateId: "migrated-gate",
				signalId: migratedSignal.id,
				verification: migratedSignal.verification,
				selectionOptions: { mode: "full" },
				v2Root,
			});
			expect(hydrated.steps[0].output).toBe(marker);
			const ref = migratedSignal.verification.steps[0]!.outputRef!;
			fs.writeFileSync(ref.path, "tampered payload", "utf8");

			const reloaded = new GateStore(stateDir);
			const tamperedSignal = reloaded.getGate("migrated-goal", "migrated-gate")!.signals[0]!;
			await expect(buildGateVerificationInspectionSnapshot({
				goalId: "migrated-goal",
				gateId: "migrated-gate",
				signalId: tamperedSignal.id,
				verification: tamperedSignal.verification,
				selectionOptions: { mode: "full" },
				v2Root,
			})).rejects.toThrow(/missing, tampered, or unavailable/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});


	test("inspects externalized bypass content root-bound and rejects missing, tampered, and cross-project refs", async () => {
		await withGoal(async (goalId) => {
			const context = gatewayFixture.projectContextManager.getContextForGoal(goalId);
			if (!context) throw new Error(`missing project context for bypass content fixture ${goalId}`);
			const marker = "EXTERNALIZED_BYPASS_CONTENT_MARKER";
			const originalStore = context.gateStore;
			let reloaded: GateStore | undefined;
			let signal: GateSignal | undefined;
			let originalRef: GateSignal["contentRef"];
			let originalBody: Buffer | undefined;
			originalStore.recordSignal({
				id: "externalized-bypass-content",
				goalId,
				gateId: "signals-gate",
				sessionId: "bypass-session",
				timestamp: gatewayFixture.clock.now(),
				commitSha: "bypass-commit",
				metadata: { bypass: "true" },
				content: marker,
				verification: { status: "passed", steps: [] },
			});
			await originalStore.flush();
			try {
				reloaded = new GateStore(inspectStateDir);
				Object.defineProperty(context, "gateStore", { configurable: true, value: reloaded, writable: true });
				signal = reloaded.getGate(goalId, "signals-gate")!.signals.find(row => row.id === "externalized-bypass-content")!;
				originalRef = structuredClone(signal.contentRef!);
				originalBody = fs.readFileSync(originalRef.path);
				expect(createHash("sha256").update(originalBody).digest("hex")).toBe(originalRef.sha256);
				expect(originalBody.byteLength).toBe(originalRef.bytes);
				expect(signal.content).toBe("");

				const healthy = await inspectGate(goalId, "signals-gate", "content", { signal_index: signal.persistenceOrdinal ?? 0, mode: "grep", pattern: marker });
				expect(healthy.status).toBe(200);
				expect((await healthy.json()).text).toContain(marker);

				fs.writeFileSync(originalRef.path, "tampered bypass payload", "utf8");
				const tampered = await inspectGate(goalId, "signals-gate", "content", { signal_index: signal.persistenceOrdinal ?? 0, mode: "full" });
				expect(tampered.status).toBe(400);
				const tamperedJson = JSON.stringify(await tampered.json());
				expect(tamperedJson).not.toContain("tampered bypass payload");
				expect(tamperedJson).not.toContain(originalRef.path);
				expect(tamperedJson).not.toContain(originalRef.sha256);

				fs.rmSync(originalRef.path, { force: true });
				const missing = await inspectGate(goalId, "signals-gate", "content", { signal_index: signal.persistenceOrdinal ?? 0, mode: "full" });
				expect(missing.status).toBe(400);

				const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-bypass-content-other-root-"));
				let otherStore: GateStore | undefined;
				let otherReloaded: GateStore | undefined;
				try {
					const otherState = path.join(otherRoot, "state");
					otherStore = new GateStore(otherState);
					otherStore.initGatesForGoal("other-goal", ["other-gate"]);
					otherStore.recordSignal({ ...structuredClone(signal), id: "other-bypass", goalId: "other-goal", gateId: "other-gate", content: "OTHER_PROJECT_BYPASS_SECRET", contentRef: undefined });
					await otherStore.flush();
					otherReloaded = new GateStore(otherState);
					const foreignRef = otherReloaded.getGate("other-goal", "other-gate")!.signals[0]!.contentRef!;
					signal.contentRef = foreignRef;
					const foreign = await inspectGate(goalId, "signals-gate", "content", { signal_index: signal.persistenceOrdinal ?? 0, mode: "full" });
					expect(foreign.status).toBe(400);
					const foreignJson = JSON.stringify(await foreign.json());
					expect(foreignJson).not.toContain("OTHER_PROJECT_BYPASS_SECRET");
					expect(foreignJson).not.toContain(foreignRef.path);
					expect(foreignJson).not.toContain(foreignRef.sha256);
				} finally {
					await otherReloaded?.close().catch(() => undefined);
					await otherStore?.close().catch(() => undefined);
					fs.rmSync(otherRoot, { recursive: true, force: true });
				}
			} finally {
				try {
					if (signal && originalRef) signal.contentRef = originalRef;
					if (originalRef && originalBody) {
						const restoreFile = `${originalRef.path}.${process.pid}.restore.tmp`;
						fs.mkdirSync(path.dirname(originalRef.path), { recursive: true });
						try {
							fs.writeFileSync(restoreFile, originalBody);
							fs.renameSync(restoreFile, originalRef.path);
						} finally {
							fs.rmSync(restoreFile, { force: true });
						}
						const restoredBody = fs.readFileSync(originalRef.path);
						expect(restoredBody.byteLength).toBe(originalRef.bytes);
						expect(createHash("sha256").update(restoredBody).digest("hex")).toBe(originalRef.sha256);
					}
				} finally {
					try {
						await reloaded?.close();
					} finally {
						Object.defineProperty(context, "gateStore", { configurable: true, value: originalStore, writable: true });
					}
				}
			}
		});
	});

	test("rejects two-root forged refs from verification and diagnostics artifact responses", async () => {
		await withGoal(async (goalId) => {
			const context = gatewayFixture.projectContextManager.getContextForGoal(goalId);
			if (!context) throw new Error(`missing project context for two-root managed ref fixture ${goalId}`);
			const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-cross-project-managed-ref-"));
			try {
				const otherState = path.join(otherRoot, "state");
				const otherMarker = "PROJECT_B_VERIFICATION_AND_DIAGNOSTICS_MARKER";
				const otherStore = new GateStore(otherState);
				otherStore.initGatesForGoal("project-b-goal", ["project-b-gate"]);
				otherStore.recordSignal({
					id: "project-b-managed-source", goalId: "project-b-goal", gateId: "project-b-gate",
					sessionId: "project-b-session", timestamp: gatewayFixture.clock.now(), commitSha: "project-b-commit",
					verification: { status: "failed", steps: [{ name: "project-b-step", type: "command", passed: false, status: "failed", output: otherMarker, duration_ms: 1 }] },
				});
				await otherStore.flush();
				const otherReloaded = new GateStore(otherState);
				const foreignRef = otherReloaded.getGate("project-b-goal", "project-b-gate")!.signals[0]!.verification.steps[0]!.outputRef!;

				const signalId = `project-a-forged-ref-${++signalSequence}`;
				const forgedSignal: any = {
					id: signalId, goalId, gateId: "signals-gate", sessionId: "project-a-session",
					timestamp: gatewayFixture.clock.now() + signalSequence, commitSha: "project-a-commit",
					verification: { status: "failed", steps: [{
						name: "forged managed output", type: "command", passed: false, status: "failed", output: "", outputRef: foreignRef, duration_ms: 1,
						diagnostics: {
							type: "retained-command-diagnostics", createdAt: gatewayFixture.clock.now(),
							baseDir: path.join(inspectStateDir, "gate-diagnostics", goalId, "signals-gate", signalId, "forged"),
							artifacts: [{ path: foreignRef.path, relativePath: "test-results/forged/error-context.md", sourcePath: foreignRef.path, bytes: foreignRef.bytes, kind: "test-results", contentType: "text/markdown", contentRef: foreignRef }],
						},
					}] },
				};
				context.gateStore.recordSignal(forgedSignal);
				context.gateStore.updateGateStatus(goalId, "signals-gate", "failed");
				const storedGate = context.gateStore.getGate(goalId, "signals-gate")!;
				const storedPosition = storedGate.signals.findIndex((signal: GateSignal) => signal.id === signalId);
				const signalIndex = storedGate.signals[storedPosition]!.persistenceOrdinal ?? storedPosition;
				const escapedForeignPath = JSON.stringify(foreignRef.path).slice(1, -1);

				const summaryJson = JSON.stringify(await gateSummary(goalId, "signals-gate"));
				expect(summaryJson, "GATE_SUMMARY_CROSS_PROJECT_PAYLOAD_LEAK: compact summaries must not hydrate project-B refs").not.toContain(otherMarker);
				expect(summaryJson).not.toContain(foreignRef.sha256);
				expect(summaryJson).not.toContain(escapedForeignPath);

				const verificationRes = await inspectGate(goalId, "signals-gate", "verification", { signal_index: signalIndex, step: "forged managed output", mode: "full" });
				expect(verificationRes.status).toBe(400);
				const verificationJson = JSON.stringify(await verificationRes.json());
				expect(verificationJson, "GATE_INSPECT_CROSS_PROJECT_VERIFICATION_PAYLOAD_LEAK: explicit verification must fail closed").not.toContain(otherMarker);
				expect(verificationJson).not.toContain(foreignRef.sha256);
				expect(verificationJson).not.toContain(escapedForeignPath);

				const artifactRes = await inspectGate(goalId, "signals-gate", "artifact", { signal_index: signalIndex, step: "forged managed output", artifact: "test-results/forged/error-context.md", mode: "full" });
				expect(artifactRes.status, "GATE_INSPECT_CROSS_PROJECT_DIAGNOSTICS_PAYLOAD_LEAK: a project-B diagnostics fallback must be rejected").not.toBe(200);
				const artifactJson = JSON.stringify(await artifactRes.json());
				expect(artifactJson).not.toContain(otherMarker);
				expect(artifactJson).not.toContain(foreignRef.sha256);
				expect(artifactJson).not.toContain(escapedForeignPath);
			} finally {
				fs.rmSync(otherRoot, { recursive: true, force: true });
			}
		});
	});

	test("inspects primary review and QA artifacts older than 32 signals with one bounded payload pass", async () => {
		await withGoal(async (goalId) => {
			const context = gatewayFixture.projectContextManager.getContextForGoal(goalId);
			if (!context) throw new Error(`missing project context for managed primary artifact fixture ${goalId}`);
			const gateStore = context.gateStore;
			const reviewContent = `review header\n${"x".repeat(MANAGED_ARTIFACT_BYTES)}\n${MANAGED_PRIMARY_ARTIFACT_MARKER}\nreview tail`;
			const qaContent = Array.from({ length: 120 }, (_, index) => `${index + 1}: ${index === 74 ? MANAGED_QA_ARTIFACT_MARKER : "qa detail"}`).join("\n");
			for (let ordinal = 0; ordinal < 40; ordinal++) {
				const type = ordinal === 1 ? "agent-qa" : "llm-review";
				const content = ordinal === 0 ? reviewContent : ordinal === 1 ? qaContent : `retained primary artifact ${ordinal}`;
				gateStore.recordSignal({
					id: `managed-primary-${ordinal}`,
					goalId,
					gateId: "signals-gate",
					sessionId: `managed-primary-session-${ordinal}`,
					timestamp: gatewayFixture.clock.now() + ordinal,
					commitSha: `managed-primary-commit-${ordinal}`,
					verification: {
						status: "passed",
						steps: [{
							name: ordinal === 1 ? "older QA" : `older review ${ordinal}`,
							type,
							passed: true,
							status: "passed",
							output: "compact verdict",
							duration_ms: 1,
							artifact: { content, contentType: type === "agent-qa" ? "text/html" : "text/markdown" },
						}],
					},
				});
			}
			await gateStore.flush();
			const reloaded = new GateStore(inspectStateDir);
			Object.defineProperty(context, "gateStore", { configurable: true, value: reloaded, writable: true });
			const reviewSignal = reloaded.getGate(goalId, "signals-gate")!.signals.find(signal => signal.id === "managed-primary-0")!;
			const qaSignal = reloaded.getGate(goalId, "signals-gate")!.signals.find(signal => signal.id === "managed-primary-1")!;
			const reviewRef = reviewSignal.verification.steps[0]!.artifact!.contentRef!;
			expect(reviewSignal.verification.steps[0]!.artifact!.content).toBe("");
			expect(qaSignal.verification.steps[0]!.artifact!.content).toBe("");

			// Affected-test reader audit: spying is scoped to managed payloads created
			// beneath this test's project state. Repository inputs delegate unchanged.
			const originalReadFileSync = fs.readFileSync.bind(fs);
			let fullPayloadReads = 0;
			const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathLike | number, options?: unknown) => {
				if (typeof file !== "number" && String(file).endsWith(".payload")) fullPayloadReads++;
				return originalReadFileSync(file, options as never);
			}) as typeof fs.readFileSync);
			const heartbeat = inspectHeartbeat();
			let grepRes: Response;
			try {
				grepRes = await inspectGate(goalId, "signals-gate", "artifact", {
					signal_index: 0,
					step: "older review 0",
					artifact: "primary",
					mode: "grep",
					pattern: MANAGED_PRIMARY_ARTIFACT_MARKER,
					context: 0,
				});
			} finally {
				readSpy.mockRestore();
			}
			const maxLag = heartbeat.stop();
			expect(
				grepRes.status,
				"GATE_INSPECT_PRIMARY_REVIEW_ARTIFACT_UNAVAILABLE: a primary review artifact older than the 32-signal hot window must remain inspectable",
			).toBe(200);
			const grepBody = await grepRes.json();
			expect(grepBody.text).toContain(MANAGED_PRIMARY_ARTIFACT_MARKER);
			expect(grepBody.text).not.toContain(reviewRef.path);
			expect(Buffer.byteLength(JSON.stringify(grepBody))).toBeLessThan(64 * 1024);
			expect(fullPayloadReads, "GATE_INSPECT_MANAGED_PAYLOAD_FULL_READ: bounded managed artifact inspection must not use readFileSync").toBe(0);
			expect(maxLag, `GATE_INSPECT_MANAGED_PAYLOAD_EVENT_LOOP_STALL: bounded selection stalled ${maxLag.toFixed(1)}ms`).toBeLessThanOrEqual(75);

			const tailRes = await inspectGate(goalId, "signals-gate", "artifact", {
				signal_index: 0,
				step: "older review 0",
				artifact: "primary",
				mode: "tail",
				lines: 1,
			});
			expect(tailRes.status, "GATE_INSPECT_PRIMARY_REVIEW_TAIL_UNAVAILABLE: managed primary artifact tail selection must remain supported").toBe(200);
			expect((await tailRes.json()).text).toContain("review tail");

			const qaRes = await inspectGate(goalId, "signals-gate", "artifact", {
				signal_index: 1,
				step: "older QA",
				artifact: "primary",
				mode: "slice",
				from: 74,
				to: 76,
			});
			expect(qaRes.status, "GATE_INSPECT_PRIMARY_QA_ARTIFACT_UNAVAILABLE: a primary QA artifact older than the 32-signal hot window must remain inspectable").toBe(200);
			const qaBody = await qaRes.json();
			expect(qaBody.text).toContain(MANAGED_QA_ARTIFACT_MARKER);
			expect(qaBody.text).not.toContain("73:");
			expect(qaBody.text).not.toContain("77:");

			fs.writeFileSync(reviewRef.path, "tampered managed primary payload", "utf8");
			const tamperedRes = await inspectGate(goalId, "signals-gate", "artifact", { signal_index: 0, artifact: "primary", mode: "tail" });
			expect(tamperedRes.status, "GATE_INSPECT_TAMPERED_PRIMARY_PAYLOAD_ACCEPTED: tampered managed primary artifacts must fail closed").not.toBe(200);
			expect(JSON.stringify(await tamperedRes.json())).not.toContain("tampered managed primary payload");

			const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-cross-project-managed-primary-"));
			try {
				const otherState = path.join(otherRoot, "state");
				const otherStore = new GateStore(otherState);
				otherStore.initGatesForGoal("other-goal", ["other-gate"]);
				otherStore.recordSignal({ ...structuredClone(reviewSignal), goalId: "other-goal", gateId: "other-gate", id: "other-primary", verification: { ...structuredClone(reviewSignal.verification), steps: [{ ...structuredClone(reviewSignal.verification.steps[0]!), artifact: { content: reviewContent, contentType: "text/markdown" } }] } });
				await otherStore.flush();
				const otherReloaded = new GateStore(otherState);
				const otherRef = otherReloaded.getGate("other-goal", "other-gate")!.signals[0]!.verification.steps[0]!.artifact!.contentRef!;
				reviewSignal.verification.steps[0]!.artifact = { content: "", contentType: "text/markdown", contentRef: otherRef };
				const crossProjectRes = await inspectGate(goalId, "signals-gate", "artifact", { signal_index: 0, artifact: "primary", mode: "grep", pattern: MANAGED_PRIMARY_ARTIFACT_MARKER });
				expect(crossProjectRes.status, "GATE_INSPECT_CROSS_PROJECT_PRIMARY_PAYLOAD_ACCEPTED: managed refs must be bound to the owning gate-store root").not.toBe(200);
			} finally {
				fs.rmSync(otherRoot, { recursive: true, force: true });
			}
		});
	});


	test("keeps production-scale no-newline gate list and verification reads asynchronous and bounded", async () => {
		await withGoal(async (goalId) => {
			const context = gatewayFixture.projectContextManager.getContextForGoal(goalId);
			if (!context) throw new Error(`missing project context for no-newline payload fixture ${goalId}`);
			const signalId = `managed-no-newline-${++signalSequence}`;
			context.gateStore.recordSignal({
				id: signalId, goalId, gateId: "signals-gate", sessionId: "managed-no-newline-session",
				timestamp: gatewayFixture.clock.now() + signalSequence, commitSha: "managed-no-newline-commit",
				verification: { status: "failed", steps: [{
					name: "production-scale no-newline output", type: "llm-review", passed: false, status: "failed",
					output: "N".repeat(PRODUCTION_SCALE_NO_NEWLINE_BYTES), duration_ms: 1,
				}] },
			});
			context.gateStore.updateGateStatus(goalId, "signals-gate", "failed");
			await context.gateStore.flush();
			const reloaded = new GateStore(inspectStateDir);
			Object.defineProperty(context, "gateStore", { configurable: true, value: reloaded, writable: true });
			const reloadedGate = reloaded.getGate(goalId, "signals-gate")!;
			const reloadedPosition = reloadedGate.signals.findIndex(signal => signal.id === signalId);
			const signalIndex = reloadedGate.signals[reloadedPosition]!.persistenceOrdinal ?? reloadedPosition;
			const managedRef = reloadedGate.signals[reloadedPosition]!.verification.steps[0]!.outputRef!;
			expect(managedRef.bytes).toBe(PRODUCTION_SCALE_NO_NEWLINE_BYTES);

			const originalReadFileSync = fs.readFileSync.bind(fs);
			let synchronousPayloadReads = 0;
			const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathLike | number, options?: unknown) => {
				if (typeof file !== "number" && String(file).endsWith(".payload")) synchronousPayloadReads++;
				return originalReadFileSync(file, options as never);
			}) as typeof fs.readFileSync);
			const heartbeat = inspectHeartbeat();
			let listRes: Response;
			let inspectRes: Response;
			try {
				listRes = await apiFetch(`/api/goals/${goalId}/gates?view=summary`);
				inspectRes = await inspectGate(goalId, "signals-gate", "verification", { signal_index: signalIndex, step: "production-scale no-newline output", mode: "head", lines: 1 });
				await new Promise(resolve => setTimeout(resolve, 15));
			} finally {
				readSpy.mockRestore();
			}
			const maxLag = heartbeat.stop();
			expect(listRes.status).toBe(200);
			const listText = await listRes.text();
			expect(Buffer.byteLength(listText), "GATE_LIST_NO_NEWLINE_RESPONSE_UNBOUNDED: list projection must remain body-free and bounded").toBeLessThan(256 * 1024);
			expect(inspectRes.status).toBe(200);
			const inspectBody = await inspectRes.json();
			const inspectJson = JSON.stringify(inspectBody);
			expect(Buffer.byteLength(inspectJson), "GATE_INSPECT_NO_NEWLINE_RESPONSE_UNBOUNDED: one long line must not escape the byte budget").toBeLessThan(64 * 1024);
			expect(Buffer.byteLength(inspectBody.steps[0].output), "GATE_INSPECT_NO_NEWLINE_SELECTION_UNBOUNDED: selected text must not scale with payload bytes").toBeLessThanOrEqual(50 * 1024);
			expect(synchronousPayloadReads, "GATE_INSPECT_MANAGED_PAYLOAD_FULL_READ: list and explicit verification must stream a bounded projection instead of readFileSync hydration").toBe(0);
			expect(maxLag, `GATE_INSPECT_NO_NEWLINE_EVENT_LOOP_STALL: payload selection stalled ${maxLag.toFixed(1)}ms`).toBeLessThanOrEqual(75);
		});
	});

	test("copies Playwright-style artifacts as metadata and retrieves bounded artifact content on demand", async () => {
		await withGoal(async (goalId) => {
			await signalAndWaitFailed(goalId, "playwright-artifacts-gate", {});
			const authoritativeMarkerLine = (() => {
				const stored = gatewayFixture.projectContextManager.getContextForGoal(goalId)?.gateStore
					.getGate(goalId, "playwright-artifacts-gate")?.signals.at(-1);
				const artifact = stored?.verification.steps[0]?.diagnostics?.artifacts?.find((file: any) => file.relativePath.endsWith("error-context.md"));
				if (!artifact) throw new Error("missing authoritative retained artifact fixture");
				return fs.readFileSync(artifact.path, "utf8").split("\n").find(line => line === PLAYWRIGHT_ERROR_CONTEXT_MARKER)!;
			})();

			const inspectRes = await inspectGate(goalId, "playwright-artifacts-gate", "verification", { mode: "full" });
			expect(inspectRes.status).toBe(200);
			const body = await inspectRes.json();
			const serialized = JSON.stringify(body);
			expect(
				serialized,
				"PLAYWRIGHT_ARTIFACT_REFERENCE_MISSING: failed gate inspection must expose copied Playwright artifact metadata/path for test-results/**/error-context.md after the original worktree artifact is gone",
			).toContain("error-context.md");
			expect(
				serialized,
				"PLAYWRIGHT_ERROR_CONTEXT_INLINE_CONTENT: verification inspect must expose compact artifact metadata only; marker content belongs behind section=artifact",
			).not.toContain(PLAYWRIGHT_ERROR_CONTEXT_MARKER);
			expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(64 * 1024);

			const artifactFiles = body.steps[0].diagnostics.artifacts.files;
			const artifact = artifactFiles.find((file: any) => file.relativePath.endsWith("error-context.md"));
			const traceArtifact = artifactFiles.find((file: any) => file.relativePath.endsWith("trace.zip"));
			const screenshotArtifact = artifactFiles.find((file: any) => file.relativePath.endsWith("screenshot.png"));
			expect(artifact).toMatchObject({
				id: "retain-artifact-fixture",
				relativePath: "test-results/retain-artifact-fixture/error-context.md",
				bytes: expect.any(Number),
				kind: "test-results",
				contentType: "text/markdown",
			});
			expect(traceArtifact).toMatchObject({
				id: "test-results/retain-artifact-fixture/trace.zip",
				relativePath: "test-results/retain-artifact-fixture/trace.zip",
			});
			expect(screenshotArtifact).toMatchObject({
				id: "test-results/retain-artifact-fixture/screenshot.png",
				relativePath: "test-results/retain-artifact-fixture/screenshot.png",
			});
			expect(artifactFiles.filter((file: any) => file.id === "retain-artifact-fixture")).toHaveLength(1);
			for (const file of artifactFiles) {
				expect(file).not.toHaveProperty("content");
				expect(file).not.toHaveProperty("path");
				expect(file).not.toHaveProperty("contentRef");
			}
			expect(body.steps[0].diagnostics).toMatchObject({
				outputSource: "retained-logs",
				logs: { stderr: { bytes: Buffer.byteLength(PLAYWRIGHT_STYLE_FAILURE_SUMMARY), lines: 1 } },
				artifacts: { count: 3, files: expect.any(Array) },
				inspectHints: expect.any(Array),
			});
			expect(body.steps[0].diagnostics.inspectHints).toEqual(expect.arrayContaining([
				expect.stringMatching(/section="artifact".*artifact="retain-artifact-fixture"/),
			]));

			const byIdRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", {
				step: "playwright-style failure",
				artifact: artifact.id,
				mode: "grep",
				pattern: PLAYWRIGHT_ERROR_CONTEXT_MARKER,
				context: 1,
			});
			expect(byIdRes.status).toBe(200);
			const byId = await byIdRes.json();
			expect(byId.section).toBe("artifact");
			expect(byId.artifact).toMatchObject({ id: artifact.id, relativePath: artifact.relativePath });
			expect(byId.text).toContain(authoritativeMarkerLine);
			expect(byId.text).toContain("locator");
			expect(byId.text).not.toContain("artifact detail line 100");
			expect(byId.text).not.toContain("# Instructions");
			expect(byId.selection).toMatchObject({ mode: "grep", matchCount: 1, shownMatches: 1 });

			const traceRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", {
				step: "playwright-style failure",
				artifact: traceArtifact.id,
				mode: "tail",
			});
			expect(traceRes.status).toBe(400);
			expect((await traceRes.json()).error).toMatch(/not a text artifact/i);

			const byPathRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", {
				step: "playwright-style failure",
				artifact: artifact.relativePath,
				mode: "slice",
				from: 5,
				to: 7,
			});
			expect(byPathRes.status).toBe(200);
			const byPath = await byPathRes.json();
			expect(byPath.artifact.relativePath).toBe(artifact.relativePath);
			expect(byPath.text).toMatch(/^5\b.*PLAYWRIGHT_ERROR_CONTEXT_FILE_RETAINED_MARKER/m);
			expect(byPath.text).toMatch(/^7\b.*artifact detail line 1/m);
			expect(byPath.text).not.toContain("artifact detail line 2");
			expect(byPath.text).not.toContain("# Instructions");
			expect(byPath.selection).toMatchObject({ mode: "slice", range: { from: 5, to: 7 } });

		});
	});

	test("bounds artifact grep tail slice full modes and rejects invalid artifact requests", async () => {
		await withGoal(async (goalId) => {
			await signalAndWaitFailed(goalId, "playwright-artifacts-gate", {});

			const inspectRes = await inspectGate(goalId, "playwright-artifacts-gate", "verification", { mode: "full" });
			expect(inspectRes.status).toBe(200);
			const inspect = await inspectRes.json();
			const artifact = inspect.steps[0].diagnostics.artifacts.files.find((file: any) => file.relativePath.endsWith("error-context.md"));
			expect(artifact?.id).toBe("retain-artifact-fixture");

			const grepRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", {
				artifact: artifact.id,
				mode: "grep",
				pattern: "artifact detail line 25[0-9]",
				context: 1,
				max_results: 2,
			});
			expect(grepRes.status).toBe(200);
			const grep = await grepRes.json();
			expect(grep.text).toContain("artifact detail line 250");
			expect(grep.text).not.toContain("artifact detail line 1 ");
			expect(grep.selection).toMatchObject({ mode: "grep", shownMatches: 2 });

			const tailRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", {
				artifact: artifact.id,
				mode: "tail",
				lines: 3,
			});
			expect(tailRes.status).toBe(200);
			const tail = await tailRes.json();
			expect(tail.text).toContain("artifact detail line 2600");
			expect(tail.text).not.toContain(PLAYWRIGHT_ERROR_CONTEXT_MARKER);
			expect(tail.selection).toMatchObject({ mode: "tail" });
			expect(tail.selection.range.to - tail.selection.range.from + 1).toBeLessThanOrEqual(3);

			const sliceRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", {
				artifact: artifact.relativePath,
				mode: "slice",
				from: 10,
				to: 12,
			});
			expect(sliceRes.status).toBe(200);
			const slice = await sliceRes.json();
			expect(slice.text).toContain("artifact detail line");
			expect(slice.text).toMatch(/^10\b/m);
			expect(slice.text).toMatch(/^12\b/m);
			expect(slice.text).not.toMatch(/^13\b/m);
			expect(slice.selection).toMatchObject({ mode: "slice", range: { from: 10, to: 12 } });

			const fullRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", {
				artifact: artifact.id,
				mode: "full",
			});
			expect(fullRes.status).toBe(200);
			const full = await fullRes.json();
			expect(Buffer.byteLength(full.text, "utf8")).toBeLessThanOrEqual(50 * 1024);
			expect(full.text).toContain(PLAYWRIGHT_ERROR_CONTEXT_MARKER);
			expect(full.text).not.toContain("artifact detail line 2600");
			expect(full.text).not.toContain("# Instructions");
			expect(full.selection).toMatchObject({ mode: "full", truncated: true });

			const missingRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", { mode: "tail" });
			expect(missingRes.status).toBe(400);
			expect((await missingRes.json()).error).toMatch(/artifact/i);

			const unknownRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", { artifact: "missing-artifact-id" });
			expect(unknownRes.status).toBe(400);
			const unknown = await unknownRes.json();
			expect(unknown.error).toMatch(/unknown|not found|artifact/i);
			expect(JSON.stringify(unknown)).toContain("retain-artifact-fixture");

			const traversalRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", { artifact: "../secrets.txt" });
			expect(traversalRes.status).toBe(400);
			expect((await traversalRes.json()).error).toMatch(/artifact|path|traversal|invalid/i);
		});
	});

	test("keeps gate status compact while explicit inspection exposes retained diagnostics", async () => {
		await withGoal(async (goalId) => {
			await signalAndWaitFailed(goalId, "playwright-artifacts-gate", {});
			const authoritativeMarkerLine = (() => {
				const stored = gatewayFixture.projectContextManager.getContextForGoal(goalId)?.gateStore
					.getGate(goalId, "playwright-artifacts-gate")?.signals.at(-1);
				const retainedArtifact = stored?.verification.steps[0]?.diagnostics?.artifacts?.find((file: any) => file.relativePath.endsWith("error-context.md"));
				if (!retainedArtifact) throw new Error("missing retained artifact fixture");
				return fs.readFileSync(retainedArtifact.path, "utf8").split("\n").find(line => line === PLAYWRIGHT_ERROR_CONTEXT_MARKER)!;
			})();

			const summary = await gateSummary(goalId, "playwright-artifacts-gate");
			const summaryJson = JSON.stringify(summary.latestSignal?.verification ?? summary);
			expect(summary.latestSignal?.verification?.status).toBe("failed");
			expect(
				summary.latestSignal?.verification?.steps?.[0]?.diagnostics,
				"GATE_STATUS_RETAINED_DIAGNOSTICS_TOO_VERBOSE: compact gate status/default verification snapshots must not expose retained diagnostics",
			).toBeUndefined();
			expect(summaryJson).not.toContain(PLAYWRIGHT_ERROR_CONTEXT_MARKER);

			const defaultInspectRes = await inspectGate(goalId, "playwright-artifacts-gate", "verification");
			expect(defaultInspectRes.status).toBe(200);
			const defaultInspect = await defaultInspectRes.json();
			expect(
				defaultInspect.steps[0].diagnostics,
				"GATE_INSPECT_DEFAULT_RETAINED_DIAGNOSTICS_TOO_VERBOSE: implicit/default gate_inspect should stay compact unless a mode is explicit",
			).toBeUndefined();
			expect(JSON.stringify(defaultInspect.steps)).not.toContain(PLAYWRIGHT_ERROR_CONTEXT_MARKER);

			const explicitRes = await inspectGate(goalId, "playwright-artifacts-gate", "verification", { mode: "full" });
			expect(explicitRes.status).toBe(200);
			const explicit = await explicitRes.json();
			const explicitJson = JSON.stringify(explicit.steps);
			const diagnostics = explicit.steps[0].diagnostics;
			expect(
				diagnostics,
				"GATE_INSPECT_EXPLICIT_DIAGNOSTICS_MISSING: explicit gate_inspect must expose retained diagnostic and artifact metadata",
			).toMatchObject({
				outputSource: "retained-logs",
				logs: { stderr: { bytes: Buffer.byteLength(PLAYWRIGHT_STYLE_FAILURE_SUMMARY), lines: 1 } },
				artifacts: { count: 3, files: expect.any(Array) },
				inspectHints: expect.any(Array),
			});
			expect(diagnostics.inspectHints).toEqual(expect.arrayContaining([
				expect.stringMatching(/section="verification".*step="playwright-style failure"/),
				expect.stringMatching(/section="artifact".*artifact="retain-artifact-fixture"/),
			]));
			expect(explicitJson).not.toContain(PLAYWRIGHT_ERROR_CONTEXT_MARKER);
			for (const file of diagnostics.artifacts.files) {
				expect(file).not.toHaveProperty("content");
				expect(file).not.toHaveProperty("path");
				expect(file).not.toHaveProperty("contentRef");
			}

			const retainedArtifact = diagnostics.artifacts.files.find((file: any) => file.relativePath.endsWith("error-context.md"));
			const retainedRes = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", {
				step: "playwright-style failure",
				artifact: retainedArtifact.id,
				mode: "grep",
				pattern: PLAYWRIGHT_ERROR_CONTEXT_MARKER,
				context: 0,
			});
			expect(retainedRes.status).toBe(200);
			expect((await retainedRes.json()).text).toContain(authoritativeMarkerLine);
		});
	});

	test("caps retained command logs and exposes cap metadata in explicit inspection", async () => {
		await withGoal(async (goalId) => {
			await signalAndWaitFailed(goalId, "huge-retained-log-gate", {});

			const inspectRes = await inspectGate(goalId, "huge-retained-log-gate", "verification", { mode: "full" });
			expect(inspectRes.status).toBe(200);
			const body = await inspectRes.json();
			const step = body.steps[0];
			const diagnosticsJson = JSON.stringify(step.diagnostics ?? {});
			expect(
				step.diagnostics?.logs?.stdout?.bytes,
				"RETAINED_LOG_CAP_MISSING: retained stdout bytes should be smaller than the emitted output instead of growing without bound",
			).toBeLessThan(HUGE_RETAINED_LOG_EMITTED_BYTES);
			expect(
				diagnosticsJson,
				"RETAINED_LOG_TRUNCATION_METADATA_MISSING: explicit inspection must expose retained-log cap/truncation metadata, not only selected-output truncation",
			).toMatch(/truncat|cap|bounded/i);
			expect(step.selection?.truncated || body.selection?.truncated).toBe(true);

			const grepRes = await inspectGate(goalId, "huge-retained-log-gate", "verification", {
				mode: "grep",
				pattern: RETAINED_LOG_CAP_MARKER,
			});
			expect(grepRes.status).toBe(200);
			const grepBody = await grepRes.json();
			expect(JSON.stringify(grepBody)).toContain(RETAINED_LOG_CAP_MARKER);
		});
	});

	test("scopes verification to a single named step and rejects unknown/misplaced step params", async () => {
		await withGoal(async (goalId) => {
			await signalAndWait(goalId, "multi-verify-gate", {});

			// step=<name> returns exactly one step.
			const oneRes = await inspectGate(goalId, "multi-verify-gate", "verification", { step: "lint", mode: "full" });
			expect(oneRes.status).toBe(200);
			const oneBody = await oneRes.json();
			expect(oneBody.steps).toHaveLength(1);
			expect(oneBody.steps[0].name).toBe("lint");
			expect(oneBody.steps[0].output).toContain("lint ok line");
			expect(oneBody.summary).toBe("1 passed");
			expect(oneBody.counts).toMatchObject({ passed: 1, failed: 0 });

			// step + mode=grep scopes grep to that one step.
			const grepRes = await inspectGate(goalId, "multi-verify-gate", "verification", {
				step: "unit",
				mode: "grep",
				pattern: "ERROR|failed",
				context: 1,
			});
			expect(grepRes.status).toBe(200);
			const grepBody = await grepRes.json();
			expect(grepBody.steps).toHaveLength(1);
			expect(grepBody.steps[0].name).toBe("unit");
			expect(grepBody.steps[0].output).toContain("ERROR failed sentinel line 125");
			expect(grepBody.steps[0].output).not.toMatch(/\bnoise line 1\b/);
			expect(grepBody.steps[0].selection).toMatchObject({ mode: "grep" });

			// Unknown step name → 400 listing available names.
			const unknownRes = await inspectGate(goalId, "multi-verify-gate", "verification", { step: "nope" });
			expect(unknownRes.status).toBe(400);
			const unknownBody = await unknownRes.json();
			expect(unknownBody.error).toMatch(/Unknown verification step "nope"/);
			expect(unknownBody.error).toContain("build");
			expect(unknownBody.error).toContain("unit");
			expect(unknownBody.error).toContain("lint");

			// step + section=content → 400.
			const wrongSectionRes = await inspectGate(goalId, "multi-verify-gate", "content", { step: "unit" });
			expect(wrongSectionRes.status).toBe(400);
			const wrongSectionBody = await wrongSectionRes.json();
			expect(wrongSectionBody.error).toMatch(/step is only valid with section=.*verification.*artifact/i);
		});
	});

	test("keeps signals[] present but bounded and reports totals", async () => {
		await withGoal(async (goalId) => {
			for (let i = 1; i <= 12; i++) {
				await signalAndWait(goalId, "signals-gate", { content: `signal-${i}` });
			}

			const res = await inspectGate(goalId, "signals-gate", "signals", { mode: "tail", lines: 5 });
			expect(res.status).toBe(200);
			const body = await res.json();

			expect(body.gateId).toBe("signals-gate");
			expect(body.section).toBe("signals");
			expect(Array.isArray(body.signals)).toBe(true);
			expect(body.signalsTotal).toBe(12);
			expect(body.signalsShown).toBe(body.signals.length);
			expect(body.signalsShown).toBeGreaterThan(0);
			expect(body.signalsShown).toBeLessThan(body.signalsTotal);
			expect(body.signalsTruncated).toBe(true);
			expect(typeof body.text).toBe("string");
			expect(body.selection).toMatchObject({ mode: "tail", totalLines: 12 });
			expect(body.signals.at(-1).index).toBe(11);
			expect(body.signals[0].index).toBeGreaterThanOrEqual(7);
			expect(body.signals[0]).toEqual(expect.objectContaining({ id: expect.any(String), timestamp: expect.any(Number) }));
		});
	});

	test("specific signal inspection preserves signalId and signalIndex metadata", async () => {
		await withGoal(async (goalId) => {
			const first = await signalAndWait(goalId, "content-gate", { content: "first content" });
			await signalAndWait(goalId, "content-gate", { content: "second content" });

			const contentRes = await inspectGate(goalId, "content-gate", "content", { signal_index: 0, mode: "full" });
			expect(contentRes.status).toBe(200);
			const content = await contentRes.json();
			expect(content.signalIndex).toBe(0);
			expect(content.signalId).toBe(first.signal.id);
			expect(content.text).toContain("first content");
			expect(content.text).not.toContain("second content");
			expect(content.selection.mode).toBe("full");

			const verify = await signalAndWait(goalId, "verify-gate", {});
			const verificationRes = await inspectGate(goalId, "verify-gate", "verification", { signal_index: 0, mode: "tail", lines: 3 });
			expect(verificationRes.status).toBe(200);
			const verification = await verificationRes.json();
			expect(verification.signalIndex).toBe(0);
			expect(verification.signalId).toBe(verify.signal.id);
			expect(verification.steps[0].selection).toMatchObject({ mode: "tail", range: { from: 158, to: 160 } });
		});
	});

	test("uses stable ordinals and reports an explicit retained-history gap", async () => {
		await withGoal(async (goalId) => {
			const first = await signalAndWait(goalId, "content-gate", { content: "retained ordinal ten" });
			const second = await signalAndWait(goalId, "content-gate", { content: "retained ordinal eleven" });
			const gate = gatewayFixture.projectContextManager.getContextForGoal(goalId)?.gateStore.getGate(goalId, "content-gate");
			if (!gate) throw new Error("missing content gate for ordinal-gap fixture");
			gate.signals[0]!.persistenceOrdinal = 10;
			gate.signals[1]!.persistenceOrdinal = 11;
			gate.earliestRetainedOrdinal = 10;
			gate.prunedSignalRanges = [{ from: 0, to: 9, reason: "count", compactedAt: gatewayFixture.clock.now() }];

			const gapRes = await inspectGate(goalId, "content-gate", "content", { signal_index: 0, mode: "full" });
			expect(gapRes.status).toBe(410);
			expect(await gapRes.json()).toMatchObject({
				code: "GATE_SIGNAL_HISTORY_PRUNED",
				gateId: "content-gate",
				signalIndex: 0,
				earliestRetainedOrdinal: 10,
				prunedRange: { from: 0, to: 9, reason: "count" },
			});

			const retainedRes = await inspectGate(goalId, "content-gate", "content", { signal_index: 10, mode: "full" });
			expect(retainedRes.status).toBe(200);
			expect(await retainedRes.json()).toMatchObject({ signalIndex: 10, signalId: first.signal.id, text: "retained ordinal ten" });

			const latestRes = await inspectGate(goalId, "content-gate", "content", { signal_index: -1, mode: "full" });
			expect(latestRes.status).toBe(200);
			expect(await latestRes.json()).toMatchObject({ signalIndex: 11, signalId: second.signal.id, text: "retained ordinal eleven" });

			const signalsRes = await inspectGate(goalId, "content-gate", "signals", { mode: "full" });
			expect(signalsRes.status).toBe(200);
			expect(await signalsRes.json()).toMatchObject({
				earliestRetainedOrdinal: 10,
				prunedSignalRanges: [{ from: 0, to: 9, reason: "count" }],
				signals: [{ index: 10 }, { index: 11 }],
			});
		});
	});

	test("matches long-line prefixes and read-boundary markers across inline, managed, retained-log, and artifact bodies", async () => {
		await withGoal(async (goalId) => {
			const inlineMarker = "INLINE-LONG-LINE-PREFIX";
			await signalAndWait(goalId, "content-gate", { content: `${inlineMarker}${"i".repeat(96 * 1024)}` });
			const inline = await inspectGate(goalId, "content-gate", "content", { mode: "grep", pattern: inlineMarker });
			expect(inline.status).toBe(200);
			expect(await inline.json()).toMatchObject({ selection: { matchCount: 1, shownMatches: 1, range: { from: 1, to: 1 } } });

			const managedMarker = "MANAGED-CHUNK-BOUNDARY";
			const context = gatewayFixture.projectContextManager.getContextForGoal(goalId)!;
			context.gateStore.recordSignal({
				id: "long-line-managed-content",
				goalId,
				gateId: "content-gate",
				sessionId: "long-line-managed-session",
				timestamp: gatewayFixture.clock.now(),
				commitSha: "long-line-managed-commit",
				content: `${"m".repeat(64 * 1024 - 7)}${managedMarker}${"m".repeat(600 * 1024)}`,
				metadata: { bypass: "true" },
				verification: { status: "passed", steps: [] },
			});
			await context.gateStore.flush();
			const reloaded = new GateStore(inspectStateDir);
			Object.defineProperty(context, "gateStore", { configurable: true, value: reloaded, writable: true });
			const managedSignal = reloaded.getGate(goalId, "content-gate")!.signals.at(-1)!;
			expect(managedSignal.contentRef).toBeDefined();
			const managed = await inspectGate(goalId, "content-gate", "content", { signal_index: -1, mode: "grep", pattern: managedMarker });
			expect(managed.status).toBe(200);
			expect(await managed.json()).toMatchObject({ selection: { matchCount: 1, shownMatches: 1 } });

			const retained = await signalAndWaitFailed(goalId, "failed-retained-diagnostics-gate", {});
			const retainedSignal = reloaded.getGate(goalId, "failed-retained-diagnostics-gate")?.signals.find((row: GateSignal) => row.id === retained.signal.id)!;
			const logMarker = "RETAINED-LOG-BOUNDARY";
			fs.writeFileSync(retainedSignal.verification.steps[0]!.diagnostics!.stdout!.path, `${"l".repeat(64 * 1024 - 5)}${logMarker}${"l".repeat(72 * 1024)}`, "utf8");
			const retainedResult = await inspectGate(goalId, "failed-retained-diagnostics-gate", "verification", { mode: "grep", pattern: logMarker });
			expect(retainedResult.status).toBe(200);
			expect((await retainedResult.json()).steps[0].selection).toMatchObject({ matchCount: 1, shownMatches: 1 });

			const artifactResult = await signalAndWaitFailed(goalId, "playwright-artifacts-gate", {});
			const artifactSignal = reloaded.getGate(goalId, "playwright-artifacts-gate")?.signals.find((row: GateSignal) => row.id === artifactResult.signal.id)!;
			const artifact = artifactSignal.verification.steps[0]!.diagnostics!.artifacts![0]!;
			const artifactMarker = "RETAINED-ARTIFACT-BOUNDARY";
			fs.writeFileSync(artifact.path, `${"a".repeat(64 * 1024 - 9)}${artifactMarker}${"a".repeat(72 * 1024)}`, "utf8");
			const artifactInspect = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", { artifact: artifact.relativePath, mode: "grep", pattern: artifactMarker });
			expect(artifactInspect.status).toBe(200);
			expect(await artifactInspect.json()).toMatchObject({ selection: { matchCount: 1, shownMatches: 1 } });
		});
	});

	test("times out catastrophic inspection regexes off-loop and remains healthy", async () => {
		await withGoal(async (goalId) => {
			const nonmatch = `${"a".repeat(64 * 1024 - 1)}!`;
			await signalAndWait(goalId, "content-gate", { content: nonmatch });
			const heartbeat = inspectHeartbeat();
			const timeoutRes = await inspectGate(goalId, "content-gate", "content", { mode: "grep", pattern: "(a+)+$" });
			await new Promise(resolve => setTimeout(resolve, 15));
			const maxLag = heartbeat.stop();
			expect(timeoutRes.status).toBe(408);
			expect(await timeoutRes.json()).toMatchObject({ code: "GATE_INSPECT_REGEX_TIMEOUT" });
			expect(maxLag, `GATE_INSPECT_REGEX_EVENT_LOOP_STALL: catastrophic regex stalled ${maxLag.toFixed(1)}ms`).toBeLessThanOrEqual(75);

			const retained = await signalAndWaitFailed(goalId, "failed-retained-diagnostics-gate", {});
			const retainedSignal = gatewayFixture.projectContextManager.getContextForGoal(goalId)?.gateStore
				.getGate(goalId, "failed-retained-diagnostics-gate")?.signals.find((row: GateSignal) => row.id === retained.signal.id)!;
			fs.writeFileSync(retainedSignal.verification.steps[0]!.diagnostics!.stdout!.path, nonmatch, "utf8");
			const retainedTimeout = await inspectGate(goalId, "failed-retained-diagnostics-gate", "verification", { mode: "grep", pattern: "(a+)+$" });
			expect(retainedTimeout.status).toBe(408);
			expect(await retainedTimeout.json()).toMatchObject({ code: "GATE_INSPECT_REGEX_TIMEOUT" });

			const artifactSignalResult = await signalAndWaitFailed(goalId, "playwright-artifacts-gate", {});
			const artifactSignal = gatewayFixture.projectContextManager.getContextForGoal(goalId)?.gateStore
				.getGate(goalId, "playwright-artifacts-gate")?.signals.find((row: GateSignal) => row.id === artifactSignalResult.signal.id)!;
			const retainedArtifact = artifactSignal.verification.steps[0]!.diagnostics!.artifacts![0]!;
			fs.writeFileSync(retainedArtifact.path, nonmatch, "utf8");
			const artifactTimeout = await inspectGate(goalId, "playwright-artifacts-gate", "artifact", { artifact: retainedArtifact.relativePath, mode: "grep", pattern: "(a+)+$" });
			expect(artifactTimeout.status).toBe(408);
			expect(await artifactTimeout.json()).toMatchObject({ code: "GATE_INSPECT_REGEX_TIMEOUT" });

			await signalAndWait(goalId, "content-gate", { content: "subsequent worker health!" });
			const healthy = await inspectGate(goalId, "content-gate", "content", { signal_index: -1, mode: "grep", pattern: "!$" });
			expect(healthy.status).toBe(200);
			expect((await healthy.json()).text).toContain("subsequent worker health!");
		});
	});

	test("returns clear 4xx validation errors for invalid and oversized regexes and slice ranges", async () => {
		await withGoal(async (goalId) => {
			await signalAndWait(goalId, "content-gate", { content: contentLines(5) });

			const regexRes = await inspectGate(goalId, "content-gate", "content", { mode: "grep", pattern: "(" });
			expect(regexRes.status).toBe(400);
			const regexBody = await regexRes.json();
			expect(regexBody.error).toMatch(/invalid regex|regular expression|unterminated/i);

			const lengthRes = await inspectGate(goalId, "content-gate", "content", { mode: "grep", pattern: "x".repeat(1025) });
			expect(lengthRes.status).toBe(400);
			expect(await lengthRes.json()).toMatchObject({ code: "GATE_INSPECT_REGEX_TOO_LONG" });

			const rangeRes = await inspectGate(goalId, "content-gate", "content", { mode: "slice", from: 4, to: 2 });
			expect(rangeRes.status).toBe(400);
			const rangeBody = await rangeRes.json();
			expect(rangeBody.error).toMatch(/invalid.*range|from.*to|slice/i);
		});
	});
});
