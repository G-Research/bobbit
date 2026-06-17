import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

const VERIFY_LOG_CMD = `node -e "for (let i=1;i<=160;i++) console.log((i===125?'ERROR failed sentinel line '+i:'noise line '+i))"`;

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

async function inspectGate(goalId: string, gateId: string, section: string, params: Record<string, string | number> = {}): Promise<Response> {
	const qs = new URLSearchParams({ section });
	for (const [key, value] of Object.entries(params)) qs.set(key, String(value));
	return apiFetch(`/api/goals/${goalId}/gates/${gateId}/inspect?${qs.toString()}`);
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
			expect(wrongSectionBody.error).toMatch(/step is only valid with section='verification'/);
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
