import fs from "node:fs";
import path from "node:path";

import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, defaultProjectStateDir, deleteGoal, nonGitCwd } from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

const VERIFY_LOG_CMD = `node -e "for (let i=1;i<=160;i++) console.log((i===125?'ERROR failed sentinel line '+i:'noise line '+i))"`;
const RETAINED_DIAGNOSTICS_MARKER = "RETAINED_GATE_DIAGNOSTICS_EARLY_MARKER stack frame";
const FAILED_RETAINED_DIAGNOSTICS_CMD = `node -e "for (let i=1;i<=80;i++) console.log('prelude line '+i+' '+ 'x'.repeat(100)); console.log('${RETAINED_DIAGNOSTICS_MARKER}'); for (let i=81;i<=260;i++) console.log('tail line '+i+' '+ 'y'.repeat(100)); process.exit(1)"`;
const PLAYWRIGHT_ERROR_CONTEXT_MARKER = "PLAYWRIGHT_ERROR_CONTEXT_FILE_RETAINED_MARKER";
const PLAYWRIGHT_STYLE_ARTIFACT_CMD = `node -e "const fs=require('fs'),path=require('path'); const dir=path.join('test-results','retain-artifact-fixture'); fs.mkdirSync(dir,{recursive:true}); const body=['# Instructions','You are given a Playwright error context.','','## Test failure','${PLAYWRIGHT_ERROR_CONTEXT_MARKER}','locator(\\\"text=Missing\\\") failed after retry',...Array.from({length:2600},(_,i)=>'artifact detail line '+(i+1)+' '+ 'z'.repeat(40))].join('\\n'); fs.writeFileSync(path.join(dir,'error-context.md'),body); fs.writeFileSync(path.join(dir,'trace.zip'),'trace placeholder'); fs.writeFileSync(path.join(dir,'screenshot.png'),'png placeholder'); console.error('PLAYWRIGHT_STYLE_FAILURE_SUMMARY: expect(locator).toBeVisible failed; see test-results/retain-artifact-fixture/error-context.md'); process.exit(1)"`;
const RETAINED_LOG_CAP_MARKER = "RETAINED_GATE_DIAGNOSTICS_CAP_MARKER";
const HUGE_RETAINED_LOG_CHUNKS = 3072;
const HUGE_RETAINED_LOG_CHUNK_BYTES = 2048;
const HUGE_RETAINED_LOG_EMITTED_BYTES = HUGE_RETAINED_LOG_CHUNKS * ("CAP-FILL ".length + HUGE_RETAINED_LOG_CHUNK_BYTES + 1);
const HUGE_RETAINED_LOG_CMD = `node -e "const chunk='CAP-FILL '+ 'x'.repeat(${HUGE_RETAINED_LOG_CHUNK_BYTES})+'\\n'; for (let i=0;i<${HUGE_RETAINED_LOG_CHUNKS};i++) process.stdout.write(chunk); console.error('${RETAINED_LOG_CAP_MARKER}'); process.exit(1)"`;

function makeWorkflowId(): string {
	return `gate-inspect-slicing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function removeTree(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 10 : 0, retryDelay: 100 });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// A completed Windows command can retain its former cwd lease briefly. The
		// fork-scoped gateway root owns this subtree and removes it at teardown; the
		// retention assertions above must not fail solely on eager temp cleanup.
		if (process.platform === "win32" && (code === "EPERM" || code === "EBUSY")) return;
		throw err;
	}
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
					verify: [{ name: "Large command output", type: "command", run: VERIFY_LOG_CMD }],
				},
				{
					id: "multi-verify-gate",
					name: "Multi Verification Gate",
					verify: [
						{ name: "build", type: "command", run: `node -e "console.log('build ok line')"` },
						{ name: "unit", type: "command", run: VERIFY_LOG_CMD },
						{ name: "lint", type: "command", run: `node -e "console.log('lint ok line')"` },
					],
				},
				{
					id: "failed-retained-diagnostics-gate",
					name: "Failed Retained Diagnostics Gate",
					verify: [{ name: "failing verbose command", type: "command", run: FAILED_RETAINED_DIAGNOSTICS_CMD }],
				},
				{
					id: "playwright-artifacts-gate",
					name: "Playwright Artifacts Gate",
					verify: [{ name: "playwright-style failure", type: "command", run: PLAYWRIGHT_STYLE_ARTIFACT_CMD }],
				},
				{
					id: "huge-retained-log-gate",
					name: "Huge Retained Log Gate",
					verify: [{ name: "huge retained log failure", type: "command", run: HUGE_RETAINED_LOG_CMD }],
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

async function signalGate(goalId: string, gateId: string, body: Record<string, unknown>): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	if (res.status !== 201) {
		throw new Error(`signal ${gateId} failed: ${res.status} ${await res.text().catch(() => "")}`);
	}
	return res.json();
}

async function waitForSignalVerificationStatus(
	goalId: string,
	gateId: string,
	signalId: string,
	status: "passed" | "failed",
): Promise<void> {
	let lastStatuses = "unavailable";
	try {
		await pollUntil(async () => {
			const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signals`);
			const body = await res.json();
			const signals = Array.isArray(body.signals) ? body.signals : [];
			lastStatuses = signals
				.map((s: any) => `${s.id}:${s.verification?.status ?? "missing"}`)
				.join(", ") || "none";
			const postedSignal = signals.find((s: any) => s.id === signalId);
			return postedSignal?.verification?.status === status ? postedSignal : null;
		}, { timeoutMs: 45_000, intervalMs: 100, label: `${gateId} signal ${signalId} verification ${status}` });
	} catch (err) {
		throw new Error(`${(err as Error).message}; last signal statuses: ${lastStatuses}`);
	}
}

async function signalAndWait(goalId: string, gateId: string, body: Record<string, unknown>): Promise<any> {
	const signal = await signalGate(goalId, gateId, body);
	await waitForSignalVerificationStatus(goalId, gateId, signal.signal.id, "passed");
	return signal;
}

async function signalAndWaitFailed(goalId: string, gateId: string, body: Record<string, unknown>): Promise<any> {
	const signal = await signalGate(goalId, gateId, body);
	await waitForSignalVerificationStatus(goalId, gateId, signal.signal.id, "failed");
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
	const workflowId = makeWorkflowId();
	await createInspectWorkflow(workflowId);
	const goal = await createGoal({ title: `Gate Inspect Slicing ${Date.now()}`, workflowId });
	try {
		return await run(goal.id);
	} finally {
		await deleteGoal(goal.id);
		await deleteInspectWorkflow(workflowId);
	}
}

function findFiles(root: string, predicate: (file: string) => boolean): string[] {
	const matches: string[] = [];
	const visit = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
			} else if (entry.isFile() && predicate(fullPath)) {
				matches.push(fullPath);
			}
		}
	};
	visit(root);
	return matches;
}

function findFilesContaining(root: string, marker: string): string[] {
	return findFiles(root, (file) => {
		try {
			return fs.readFileSync(file, "utf8").includes(marker);
		} catch {
			// Binary or transient files are irrelevant for this marker search.
			return false;
		}
	});
}

function findPersistedGateStoreDir(root: string, goalId: string): string | undefined {
	return findFiles(root, file => path.basename(file) === "gates.json")
		.find(file => {
			try {
				return fs.readFileSync(file, "utf8").includes(goalId);
			} catch {
				return false;
			}
		})
		?.replace(/[\\/]gates\.json$/, "");
}

test.describe("gate inspect slicing", () => {
	test.setTimeout(60_000);

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
			const { GateStore } = await import("../../src/server/agent/gate-store.js");
			const { buildGateVerificationSnapshot } = await import("../../src/server/gate-verification-snapshot.js");
			const gateStoreDir = findPersistedGateStoreDir(await defaultProjectStateDir(), goalId);
			expect(gateStoreDir, "RETAINED_GATE_DIAGNOSTICS_GATE_STORE_FILE_MISSING: persisted gates.json for the failed signal must be reconstructable after restart").toBeTruthy();
			const reloadedGateStore = new GateStore(gateStoreDir!);
			const reloadedGate = reloadedGateStore.getGate(goalId, "failed-retained-diagnostics-gate");
			const reloadedSignal = reloadedGate?.signals.find((signal: any) => signal.id === post.signal.id);
			expect(reloadedSignal, "RETAINED_GATE_DIAGNOSTICS_RELOAD_MISSING: failed signal must survive gate-store reconstruction").toBeTruthy();

			const snapshot = buildGateVerificationSnapshot({
				goalId,
				gateId: "failed-retained-diagnostics-gate",
				signalId: post.signal.id,
				verification: reloadedSignal!.verification,
				selectionOptions: { mode: "grep", pattern: "RETAINED_GATE_DIAGNOSTICS_EARLY_MARKER", context: 1 },
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

	test("copies Playwright-style artifacts as metadata and retrieves bounded artifact content on demand", async () => {
		const workflowId = makeWorkflowId();
		const cwd = fs.mkdtempSync(path.join(nonGitCwd(), `playwright-artifacts-${Date.now()}-`));
		await createInspectWorkflow(workflowId);
		const goal = await createGoal({ title: `Gate Inspect Playwright Artifacts ${Date.now()}`, workflowId, cwd });
		try {
			await signalAndWaitFailed(goal.id, "playwright-artifacts-gate", {});
			fs.rmSync(path.join(cwd, "test-results"), { recursive: true, force: true });

			const inspectRes = await inspectGate(goal.id, "playwright-artifacts-gate", "verification", { mode: "full" });
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
				kind: "test-results",
				path: expect.stringContaining("gate-diagnostics"),
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
			expect(artifact).not.toHaveProperty("content");

			const byIdRes = await inspectGate(goal.id, "playwright-artifacts-gate", "artifact", {
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
			expect(byId.text).toContain(PLAYWRIGHT_ERROR_CONTEXT_MARKER);
			expect(byId.text).toContain("locator");
			expect(byId.text).not.toContain("artifact detail line 100");
			expect(byId.text).not.toContain("# Instructions");
			expect(byId.selection).toMatchObject({ mode: "grep", matchCount: 1, shownMatches: 1 });

			const traceRes = await inspectGate(goal.id, "playwright-artifacts-gate", "artifact", {
				step: "playwright-style failure",
				artifact: traceArtifact.id,
				mode: "tail",
			});
			expect(traceRes.status).toBe(400);
			expect((await traceRes.json()).error).toMatch(/not a text artifact/i);

			const byPathRes = await inspectGate(goal.id, "playwright-artifacts-gate", "artifact", {
				step: "playwright-style failure",
				artifact: artifact.relativePath,
				mode: "slice",
				from: 1,
				to: 4,
			});
			expect(byPathRes.status).toBe(200);
			const byPath = await byPathRes.json();
			expect(byPath.artifact.relativePath).toBe(artifact.relativePath);
			expect(byPath.text).toContain(PLAYWRIGHT_ERROR_CONTEXT_MARKER);
			expect(byPath.text).toContain("artifact detail line 1");
			expect(byPath.text).not.toContain("artifact detail line 5");
			expect(byPath.text).not.toContain("# Instructions");
			expect(byPath.selection).toMatchObject({ mode: "slice", range: { from: 1, to: 4 } });

			const stateMarkerFiles = findFilesContaining(await defaultProjectStateDir(), PLAYWRIGHT_ERROR_CONTEXT_MARKER)
				.filter(file => !file.endsWith("gates.json"));
			expect(
				stateMarkerFiles,
				"PLAYWRIGHT_ARTIFACT_COPY_MISSING: error-context.md content must be copied under Bobbit state outside gates.json so worktree cleanup/restart does not destroy diagnostics. This focused E2E covers the host-visible command cwd path; Docker sandbox transfer needs manual/docker coverage.",
			).not.toEqual([]);
		} finally {
			await deleteGoal(goal.id);
			await deleteInspectWorkflow(workflowId);
			removeTree(cwd);
		}
	});

	test("bounds artifact grep tail slice full modes and rejects invalid artifact requests", async () => {
		const workflowId = makeWorkflowId();
		const cwd = fs.mkdtempSync(path.join(nonGitCwd(), `playwright-artifact-selection-${Date.now()}-`));
		await createInspectWorkflow(workflowId);
		const goal = await createGoal({ title: `Gate Inspect Artifact Selection ${Date.now()}`, workflowId, cwd });
		try {
			await signalAndWaitFailed(goal.id, "playwright-artifacts-gate", {});
			fs.rmSync(path.join(cwd, "test-results"), { recursive: true, force: true });

			const inspectRes = await inspectGate(goal.id, "playwright-artifacts-gate", "verification", { mode: "full" });
			expect(inspectRes.status).toBe(200);
			const inspect = await inspectRes.json();
			const artifact = inspect.steps[0].diagnostics.artifacts.files.find((file: any) => file.relativePath.endsWith("error-context.md"));
			expect(artifact?.id).toBe("retain-artifact-fixture");

			const grepRes = await inspectGate(goal.id, "playwright-artifacts-gate", "artifact", {
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

			const tailRes = await inspectGate(goal.id, "playwright-artifacts-gate", "artifact", {
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

			const sliceRes = await inspectGate(goal.id, "playwright-artifacts-gate", "artifact", {
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

			const fullRes = await inspectGate(goal.id, "playwright-artifacts-gate", "artifact", {
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

			const missingRes = await inspectGate(goal.id, "playwright-artifacts-gate", "artifact", { mode: "tail" });
			expect(missingRes.status).toBe(400);
			expect((await missingRes.json()).error).toMatch(/artifact/i);

			const unknownRes = await inspectGate(goal.id, "playwright-artifacts-gate", "artifact", { artifact: "missing-artifact-id" });
			expect(unknownRes.status).toBe(400);
			const unknown = await unknownRes.json();
			expect(unknown.error).toMatch(/unknown|not found|artifact/i);
			expect(JSON.stringify(unknown)).toContain("retain-artifact-fixture");

			const traversalRes = await inspectGate(goal.id, "playwright-artifacts-gate", "artifact", { artifact: "../secrets.txt" });
			expect(traversalRes.status).toBe(400);
			expect((await traversalRes.json()).error).toMatch(/artifact|path|traversal|invalid/i);
		} finally {
			await deleteGoal(goal.id);
			await deleteInspectWorkflow(workflowId);
			removeTree(cwd);
		}
	});

	test("keeps gate status compact while explicit inspection exposes retained diagnostics", async () => {
		const workflowId = makeWorkflowId();
		const cwd = fs.mkdtempSync(path.join(nonGitCwd(), `compact-artifacts-${Date.now()}-`));
		await createInspectWorkflow(workflowId);
		const goal = await createGoal({ title: `Gate Status Compact Diagnostics ${Date.now()}`, workflowId, cwd });
		try {
			await signalAndWaitFailed(goal.id, "playwright-artifacts-gate", {});
			fs.rmSync(path.join(cwd, "test-results"), { recursive: true, force: true });

			const summary = await gateSummary(goal.id, "playwright-artifacts-gate");
			const summaryJson = JSON.stringify(summary.latestSignal?.verification ?? summary);
			expect(summary.latestSignal?.verification?.status).toBe("failed");
			expect(
				summaryJson,
				"GATE_STATUS_RETAINED_DIAGNOSTICS_TOO_VERBOSE: compact gate status/default verification snapshots must not expose retained log paths or bulky Playwright artifact file lists",
			).not.toMatch(/stdout\.log|stderr\.log|trace\.zip|screenshot\.png|gate-diagnostics|PLAYWRIGHT_ERROR_CONTEXT_FILE_RETAINED_MARKER/i);

			const defaultInspectRes = await inspectGate(goal.id, "playwright-artifacts-gate", "verification");
			expect(defaultInspectRes.status).toBe(200);
			const defaultInspect = await defaultInspectRes.json();
			expect(
				JSON.stringify(defaultInspect.steps),
				"GATE_INSPECT_DEFAULT_RETAINED_DIAGNOSTICS_TOO_VERBOSE: implicit/default gate_inspect should stay compact unless a mode is explicit",
			).not.toMatch(/stdout\.log|stderr\.log|trace\.zip|screenshot\.png|gate-diagnostics|PLAYWRIGHT_ERROR_CONTEXT_FILE_RETAINED_MARKER/i);

			const explicitRes = await inspectGate(goal.id, "playwright-artifacts-gate", "verification", { mode: "full" });
			expect(explicitRes.status).toBe(200);
			const explicit = await explicitRes.json();
			const explicitJson = JSON.stringify(explicit.steps);
			expect(
				explicitJson,
				"GATE_INSPECT_EXPLICIT_DIAGNOSTICS_MISSING: explicit gate_inspect must expose retained diagnostic log/artifact metadata",
			).toMatch(/stdout\.log|stderr\.log|gate-diagnostics/i);
			expect(explicitJson).toContain("error-context.md");
			expect(explicitJson).not.toContain(PLAYWRIGHT_ERROR_CONTEXT_MARKER);
			expect(explicit.steps[0].diagnostics.artifacts.files[0]).not.toHaveProperty("content");

			const stateMarkerFiles = findFilesContaining(await defaultProjectStateDir(), PLAYWRIGHT_ERROR_CONTEXT_MARKER)
				.filter(file => !file.endsWith("gates.json"));
			expect(stateMarkerFiles).not.toEqual([]);
		} finally {
			await deleteGoal(goal.id);
			await deleteInspectWorkflow(workflowId);
			removeTree(cwd);
		}
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

	test("returns clear 400 validation errors for invalid regex and slice ranges", async () => {
		await withGoal(async (goalId) => {
			await signalAndWait(goalId, "content-gate", { content: contentLines(5) });

			const regexRes = await inspectGate(goalId, "content-gate", "content", { mode: "grep", pattern: "(" });
			expect(regexRes.status).toBe(400);
			const regexBody = await regexRes.json();
			expect(regexBody.error).toMatch(/invalid regex|regular expression|unterminated/i);

			const rangeRes = await inspectGate(goalId, "content-gate", "content", { mode: "slice", from: 4, to: 2 });
			expect(rangeRes.status).toBe(400);
			const rangeBody = await rangeRes.json();
			expect(rangeBody.error).toMatch(/invalid.*range|from.*to|slice/i);
		});
	});
});
