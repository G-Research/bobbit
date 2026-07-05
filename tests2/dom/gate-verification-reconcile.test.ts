// Migrated from tests/gate-verification-reconcile.spec.ts (v2-dom tier).
// The legacy Playwright fixture exposed a set of pure reconciliation functions
// on `window` (a faithful copy of the logic that lives, module-private, inside
// GateVerificationLive.ts). Those helpers are not exported from src, so — as
// the legacy spec did — we exercise the same pure functions directly. No DOM.
import { describe, expect, it } from "vitest";

// --- Reconciliation logic under test (verbatim from the legacy fixture) ---

function shouldReconcile(overallStatus: string, goalId: string, gateId: string, signalId: string): boolean {
	if (overallStatus !== "running" && overallStatus !== "idle") return false;
	if (!goalId || !gateId || !signalId) return false;
	return true;
}

function normalizeStepStatus(gateStep: any, fallback?: string): string {
	fallback = fallback || "running";
	if (typeof gateStep.status === "string") {
		const key = gateStep.status.toLowerCase().replace(/_/g, "-");
		if (key === "passed" || key === "success" || key === "completed") return "passed";
		if (key === "failed" || key === "failure" || key === "error" || key === "timeout") return "failed";
		if (key === "skipped") return "skipped";
		if (key === "waiting" || key === "pending" || key === "queued" || key === "yet-to-run") return "waiting";
		if (key === "blocked" || key === "blocked-by-earlier-failure") return "blocked";
		if (key === "running" || key === "in-progress" || key === "starting") return "running";
	}
	if (gateStep.skipped) return "skipped";
	if (gateStep.passed === true) return "passed";
	if (gateStep.passed === false) return fallback;
	if (gateStep.passed === null) return "running";
	return fallback;
}

function hasExplicitStepStatus(gateStep: any): boolean {
	return typeof gateStep.status === "string" && gateStep.status.length > 0;
}

function mapGateSignalStep(gateStep: any, fallback?: string): any {
	const status = normalizeStepStatus(gateStep, fallback || "failed");
	const durationMs = gateStep.durationMs ?? gateStep.duration_ms ?? 0;
	const startedAt = gateStep.startedAt || (durationMs > 0 ? Date.now() - durationMs : status === "running" ? Date.now() : 0);

	return {
		name: gateStep.name,
		type: gateStep.type,
		status: status,
		durationMs: durationMs,
		output: gateStep.output,
		startedAt: startedAt,
		sessionId: gateStep.sessionId,
	};
}

function reconcileFromGateData(componentState: any, gateData: any, signalId: string): any {
	if (componentState.overallStatus === "passed" || componentState.overallStatus === "failed") {
		return { steps: componentState.steps, overallStatus: componentState.overallStatus };
	}

	const signals = gateData.signals || [];
	const signal = signals.find((s: any) => s.id === signalId);
	if (!signal || !signal.verification) {
		return { steps: componentState.steps, overallStatus: componentState.overallStatus };
	}

	const verificationStatus = signal.verification.status;
	const signalSteps = signal.verification.steps || [];

	if (verificationStatus === "passed" || verificationStatus === "failed") {
		const fallback = verificationStatus === "passed" ? "passed" : "failed";
		return {
			steps: signalSteps.map((s: any) => mapGateSignalStep(s, fallback)),
			overallStatus: verificationStatus,
		};
	}

	if (verificationStatus === "running" && signalSteps.some(hasExplicitStepStatus)) {
		return {
			steps: signalSteps.map((s: any) => mapGateSignalStep(s, "running")),
			overallStatus: "running",
		};
	}

	return { steps: componentState.steps, overallStatus: componentState.overallStatus };
}

describe("Gate verification reconciliation", () => {
	it("reconciles stuck running component to passed when REST shows passed", () => {
		const componentState = {
			steps: [
				{ name: "Type check", type: "command", status: "running", startedAt: Date.now() - 5000 },
				{ name: "Run tests", type: "command", status: "running", startedAt: Date.now() - 5000 },
			],
			overallStatus: "running",
		};
		const gateData = {
			signals: [{
				id: "signal-123",
				verification: {
					status: "passed",
					steps: [
						{ name: "Type check", type: "command", passed: true, output: "OK", duration_ms: 3200 },
						{ name: "Run tests", type: "command", passed: true, output: "12 passed", duration_ms: 8500 },
					],
				},
			}],
		};
		const result = reconcileFromGateData(componentState, gateData, "signal-123");

		expect(result.overallStatus).toBe("passed");
		expect(result.steps).toHaveLength(2);
		expect(result.steps[0].status).toBe("passed");
		expect(result.steps[0].name).toBe("Type check");
		expect(result.steps[0].durationMs).toBe(3200);
		expect(result.steps[0].output).toBe("OK");
		expect(result.steps[1].status).toBe("passed");
		expect(result.steps[1].name).toBe("Run tests");
		expect(result.steps[1].durationMs).toBe(8500);
		expect(result.steps[1].output).toBe("12 passed");
	});

	it("reconciles stuck running component to failed when REST shows failure", () => {
		const componentState = {
			steps: [
				{ name: "Type check", type: "command", status: "running", startedAt: Date.now() - 10000 },
				{ name: "Run tests", type: "command", status: "running", startedAt: Date.now() - 10000 },
			],
			overallStatus: "running",
		};
		const gateData = {
			signals: [{
				id: "signal-456",
				verification: {
					status: "failed",
					steps: [
						{ name: "Type check", type: "command", passed: true, output: "OK", duration_ms: 2100 },
						{ name: "Run tests", type: "command", passed: false, output: "3 failed", duration_ms: 5000 },
					],
				},
			}],
		};
		const result = reconcileFromGateData(componentState, gateData, "signal-456");

		expect(result.overallStatus).toBe("failed");
		expect(result.steps).toHaveLength(2);
		expect(result.steps[0].status).toBe("passed");
		expect(result.steps[1].status).toBe("failed");
		expect(result.steps[1].output).toBe("3 failed");
	});

	it("skips reconciliation when already in terminal state", () => {
		const originalSteps = [
			{ name: "Type check", type: "command", status: "passed", durationMs: 1500, startedAt: 0 },
		];
		const componentState = { steps: originalSteps, overallStatus: "passed" };
		const gateData = {
			signals: [{
				id: "signal-789",
				verification: {
					status: "passed",
					steps: [
						{ name: "Type check", type: "command", passed: true, output: "OK", duration_ms: 1500 },
					],
				},
			}],
		};
		const reconciled = reconcileFromGateData(componentState, gateData, "signal-789");

		expect(reconciled.overallStatus).toBe("passed");
		expect(reconciled.steps === originalSteps).toBe(true);
	});

	it("skips reconciliation when signalId is missing", () => {
		expect(shouldReconcile("running", "goal-1", "gate-1", "")).toBe(false);
	});

	it("skips reconciliation when goalId is missing", () => {
		expect(shouldReconcile("running", "", "gate-1", "signal-1")).toBe(false);
	});

	it("shouldReconcile returns true when status is running and all IDs present", () => {
		expect(shouldReconcile("running", "goal-1", "gate-1", "signal-1")).toBe(true);
	});

	it("shouldReconcile returns true when status is idle and all IDs present", () => {
		expect(shouldReconcile("idle", "goal-1", "gate-1", "signal-1")).toBe(true);
	});

	it("shouldReconcile returns false when already passed", () => {
		expect(shouldReconcile("passed", "goal-1", "gate-1", "signal-1")).toBe(false);
	});

	it("maps GateSignalStep fields correctly", () => {
		const result = mapGateSignalStep({
			name: "Analysis quality",
			type: "llm-review",
			passed: true,
			output: "Looks good\nAll criteria met",
			duration_ms: 53119,
		});

		expect(result.name).toBe("Analysis quality");
		expect(result.type).toBe("llm-review");
		expect(result.status).toBe("passed");
		expect(result.durationMs).toBe(53119);
		expect(result.output).toBe("Looks good\nAll criteria met");
		expect(result.startedAt).toBeGreaterThan(0);
	});

	it("maps passed=false to status failed", () => {
		const result = mapGateSignalStep({
			name: "Tests", type: "command", passed: false, output: "FAIL", duration_ms: 1000,
		});
		expect(result.status).toBe("failed");
	});

	it("explicit waiting status overrides passed=false placeholder", () => {
		const result = mapGateSignalStep({
			name: "Review", type: "llm-review", status: "waiting", passed: false, output: "", duration_ms: 0,
		}, "running");
		expect(result.status).toBe("waiting");
		expect(result.durationMs).toBe(0);
	});

	it("maps passed=null to status running", () => {
		const result = mapGateSignalStep({
			name: "Tests", type: "command", passed: null, output: "", duration_ms: 0,
		});
		expect(result.status).toBe("running");
	});

	it("does not reconcile running REST placeholders without explicit status", () => {
		const componentState = {
			steps: [
				{ name: "Step 1", type: "command", status: "running", startedAt: Date.now() - 2000 },
			],
			overallStatus: "running",
		};
		const gateData = {
			signals: [{
				id: "signal-still-running",
				verification: {
					status: "running",
					steps: [
						{ name: "Step 1", type: "command", passed: false, duration_ms: 0, output: "" },
						{ name: "Step 2", type: "llm-review", passed: false, duration_ms: 0, output: "" },
					],
				},
			}],
		};
		const result = reconcileFromGateData(componentState, gateData, "signal-still-running");

		expect(result.overallStatus).toBe("running");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0].status).toBe("running");
	});

	it("reconciles running REST active snapshot when explicit statuses are present", () => {
		const componentState = {
			steps: [
				{ name: "Step 1", type: "command", status: "running", startedAt: Date.now() - 2000 },
			],
			overallStatus: "running",
		};
		const gateData = {
			signals: [{
				id: "signal-active-snapshot",
				verification: {
					status: "running",
					steps: [
						{ name: "Typecheck", type: "command", status: "passed", passed: true, duration_ms: 1400, output: "OK" },
						{ name: "Tests", type: "command", status: "running", passed: false, duration_ms: 2500, output: "tail" },
						{ name: "Review", type: "llm-review", status: "waiting", passed: false, duration_ms: 0, output: "" },
					],
				},
			}],
		};
		const result = reconcileFromGateData(componentState, gateData, "signal-active-snapshot");

		expect(result.overallStatus).toBe("running");
		expect(result.steps.map((s: any) => s.status)).toEqual(["passed", "running", "waiting"]);
		expect(result.steps[1].durationMs).toBe(2500);
	});

	it("maps skipped=true with passed=true to status skipped (optional step)", () => {
		const result = mapGateSignalStep({
			name: "QA Testing", type: "agent-qa", passed: true, skipped: true,
			output: "Skipped — not enabled for this goal", duration_ms: 0,
		});
		expect(result.status).toBe("skipped");
	});

	it("maps skipped=true with passed=false to status skipped (phase failure)", () => {
		const result = mapGateSignalStep({
			name: "Code review", type: "llm-review", passed: false, skipped: true,
			output: "Skipped — earlier phase failed", duration_ms: 0,
		});
		expect(result.status).toBe("skipped");
	});

	it("handles missing signal in gate data gracefully", () => {
		const componentState = {
			steps: [{ name: "Step 1", type: "command", status: "running", startedAt: Date.now() }],
			overallStatus: "running",
		};
		const gateData = {
			signals: [{
				id: "other-signal",
				verification: { status: "passed", steps: [] },
			}],
		};
		const result = reconcileFromGateData(componentState, gateData, "signal-not-found");

		expect(result.overallStatus).toBe("running");
	});
});
