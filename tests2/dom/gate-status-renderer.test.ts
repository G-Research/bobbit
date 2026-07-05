// Migrated from tests/gate-status-renderer.spec.ts (v2-dom tier).
// Renders the REAL GateStatusRenderer via lit into happy-dom (was an esbuild
// file:// bundle). gate-verification-live is stubbed as in the legacy entry.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { GateStatusRenderer } from "../../src/ui/tools/renderers/GateToolRenderers.js";
// Static import of the real element — see gate-signal-renderer.test.ts for why
// (avoids the lazy loader's unhandled async import racing env teardown).
import "../../src/ui/tools/renderers/GateVerificationLive.js";

const toolResult = (data: any) => ({ isError: false, content: [{ type: "text", text: JSON.stringify(data) }] });

async function renderStatus(params: any, data: any) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const out = new GateStatusRenderer().render(params, toolResult(data) as any);
	render(out.content, container);
	const live = container.querySelector("gate-verification-live") as any;
	if (live?.updateComplete) await live.updateComplete;
	return {
		hasLive: !!live,
		goalId: live?.goalId || "",
		gateId: live?.gateId || "",
		signalId: live?.signalId || "",
		initialSteps: live?.initialSteps || [],
		finalStatus: live?.finalStatus,
	};
}

afterEach(() => { document.body.innerHTML = ""; });

describe("GateStatusRenderer", () => {
	it("renders active latestSignal summary through gate-verification-live", async () => {
		const result = await renderStatus({ gate_id: "implementation" }, {
			goalId: "goal-123", gateId: "implementation", name: "Implementation", status: "pending",
			latestSignal: {
				id: "signal-123",
				verification: {
					status: "running",
					steps: [
						{ name: "Review", status: "running", duration_ms: 1200, output: "tail" },
						{ name: "QA", status: "waiting" },
					],
				},
			},
		});
		expect(result.hasLive).toBe(true);
		expect(result.goalId).toBe("goal-123");
		expect(result.gateId).toBe("implementation");
		expect(result.signalId).toBe("signal-123");
		expect(result.initialSteps.map((s: any) => s.status)).toEqual(["running", "waiting"]);
		expect(result.finalStatus).toBeUndefined();
	});

	it("keeps legacy signals[] support and only passes terminal finalStatus", async () => {
		const result = await renderStatus({ gate_id: "design-doc" }, {
			goalId: "goal-legacy", gateId: "design-doc", status: "passed",
			signals: [{
				id: "signal-legacy",
				verification: { status: "passed", steps: [{ name: "Check", status: "passed", passed: true, duration_ms: 10 }] },
			}],
		});
		expect(result.hasLive).toBe(true);
		expect(result.goalId).toBe("goal-legacy");
		expect(result.gateId).toBe("design-doc");
		expect(result.signalId).toBe("signal-legacy");
		expect(result.initialSteps).toHaveLength(1);
		expect(result.finalStatus).toBe("passed");
	});
});
