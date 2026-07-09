import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/verification-timer.spec.ts (v2-dom tier).
//
// Pure-logic port: the legacy file:// fixture extracted the core timer logic from
// GateVerificationLive.ts (private _onEvent handlers + toCardEntry) into plain JS.
// Those are private instance methods, not exported symbols, so we reproduce the
// exact same logic and assert the identical facts (server timestamps preferred,
// Date.now() fallback, durationMs computation for running vs completed steps).
import { describe, expect, it } from "vitest";

function handleVerificationStarted(detail: { startedAt?: number }, stepDefs: { name: string; type: string }[]): any[] {
	const now = detail.startedAt || Date.now();
	return stepDefs.map((s) => ({ name: s.name, type: s.type, status: "running", startedAt: now }));
}

function handleStepStarted(detail: { stepIndex: number; startedAt?: number; sessionId?: string }, steps: any[]): any[] {
	const idx = detail.stepIndex;
	if (idx >= 0 && idx < steps.length) {
		const updated = [...steps];
		updated[idx] = {
			...updated[idx],
			startedAt: detail.startedAt || updated[idx].startedAt,
			sessionId: detail.sessionId,
		};
		return updated;
	}
	return steps;
}

function toCardEntry(step: any, index: number): any {
	const delegateStatus = step.status === "passed" ? "completed" : step.status === "failed" ? "error" : "running";
	const durationMs = step.status === "running" ? Date.now() - step.startedAt : (step.durationMs ?? 0);
	return {
		id: "step-" + index,
		name: step.name || "step",
		status: delegateStatus,
		durationMs,
		sessionId: step.sessionId,
	};
}

describe("Verification timer accuracy", () => {
	it("gate_verification_started uses server startedAt for step timestamps", () => {
		const serverTimestamp = 1700000000000;
		const steps = handleVerificationStarted({ startedAt: serverTimestamp }, [
			{ name: "Type check", type: "command" },
			{ name: "Run tests", type: "command" },
		]);
		expect(steps).toHaveLength(2);
		expect(steps[0].startedAt).toBe(1700000000000);
		expect(steps[1].startedAt).toBe(1700000000000);
		expect(steps[0].status).toBe("running");
		expect(steps[0].name).toBe("Type check");
		expect(steps[1].name).toBe("Run tests");
	});

	it("gate_verification_started falls back to Date.now() when startedAt missing", () => {
		const before = Date.now();
		const steps = handleVerificationStarted({}, [{ name: "Step 1", type: "command" }]);
		const after = Date.now();
		expect(steps[0].startedAt).toBeGreaterThanOrEqual(before);
		expect(steps[0].startedAt).toBeLessThanOrEqual(after);
	});

	it("gate_verification_step_started uses server startedAt", () => {
		const initialSteps = [
			{ name: "Step A", type: "command", status: "running", startedAt: 1700000000000 },
			{ name: "Step B", type: "command", status: "running", startedAt: 1700000000000 },
		];
		const steps = handleStepStarted({ stepIndex: 1, startedAt: 1700000005000, sessionId: "sess-1" }, initialSteps);
		expect(steps[0].startedAt).toBe(1700000000000);
		expect(steps[1].startedAt).toBe(1700000005000);
		expect(steps[1].sessionId).toBe("sess-1");
	});

	it("gate_verification_step_started preserves existing startedAt when missing from event", () => {
		const initialSteps = [{ name: "Step A", type: "command", status: "running", startedAt: 1700000001000 }];
		const steps = handleStepStarted({ stepIndex: 0 }, initialSteps);
		expect(steps[0].startedAt).toBe(1700000001000);
	});

	it("toCardEntry computes durationMs from startedAt for running steps", () => {
		const fiveSecondsAgo = Date.now() - 5000;
		const entry = toCardEntry({ name: "Running step", type: "command", status: "running", startedAt: fiveSecondsAgo }, 0);
		expect(entry.durationMs).toBeGreaterThanOrEqual(4500);
		expect(entry.durationMs).toBeLessThanOrEqual(6000);
		expect(entry.status).toBe("running");
	});

	it("toCardEntry uses provided durationMs for completed steps", () => {
		const entry = toCardEntry(
			{ name: "Done step", type: "command", status: "passed", startedAt: 1700000000000, durationMs: 12345 },
			0,
		);
		expect(entry.durationMs).toBe(12345);
		expect(entry.status).toBe("completed");
	});

	it("toCardEntry returns 0 for completed step without durationMs", () => {
		const entry = toCardEntry({ name: "Done step", type: "command", status: "failed", startedAt: 1700000000000 }, 0);
		expect(entry.durationMs).toBe(0);
		expect(entry.status).toBe("error");
	});

	it("server timestamp far in the past produces large durationMs for running step", () => {
		const entry = toCardEntry({ name: "Long step", type: "command", status: "running", startedAt: Date.now() - 60000 }, 0);
		expect(entry.durationMs).toBeGreaterThanOrEqual(59000);
		expect(entry.durationMs).toBeLessThanOrEqual(62000);
	});
});
