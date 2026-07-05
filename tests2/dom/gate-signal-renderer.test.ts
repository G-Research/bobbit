// Migrated from tests/gate-signal-renderer.spec.ts (v2-dom tier).
// Renders the REAL GateSignalRenderer via lit into a happy-dom container,
// replacing the esbuild-bundled file:// fixture. The gate-verification-live
// custom element is stubbed exactly as the legacy entry did.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { GateSignalRenderer } from "../../src/ui/tools/renderers/GateToolRenderers.js";
// Statically import the real <gate-verification-live> so the module (and its
// LiveTimer side-effect define) is evaluated synchronously while happy-dom's
// customElements global is live. The renderer's lazy ensureGateVerificationLive()
// then hits the cached module instead of firing an unhandled async import whose
// top-level define would race teardown.
import "../../src/ui/tools/renderers/GateVerificationLive.js";

const AGENT_REMINDER =
	"Gate signal accepted. Verification is running asynchronously. Do not poll with `gate_status` or `gate_inspect`. Go idle now and wait for the server to deliver verification results or further instructions.";

const toolResult = (data: any) => ({ isError: false, content: [{ type: "text", text: JSON.stringify(data) }] });

async function renderSignal(params: any, data: any) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const out = new GateSignalRenderer().render(params, toolResult(data) as any);
	render(out.content, container);
	const live = container.querySelector("gate-verification-live") as any;
	if (live?.updateComplete) await live.updateComplete;
	return {
		text: container.textContent || "",
		hasLive: !!live,
		goalId: live?.goalId || "",
		gateId: live?.gateId || "",
		signalId: live?.signalId || "",
		initialSteps: live?.initialSteps || [],
		finalStatus: live?.finalStatus,
	};
}

afterEach(() => { document.body.innerHTML = ""; });

describe("GateSignalRenderer", () => {
	it("renders live gate signal UI without exposing the top-level agent reminder", async () => {
		const result = await renderSignal({ gate_id: "implementation" }, {
			signal: {
				id: "signal-123", goalId: "goal-abc", gateId: "implementation", status: "running",
				steps: [
					{ name: "typecheck", type: "command", status: "running", duration_ms: 2500, output: "checking" },
					{ name: "review", type: "llm-review", status: "waiting" },
				],
			},
			agentReminder: AGENT_REMINDER,
		});
		expect(result.hasLive).toBe(true);
		expect(result.text).toContain("Signaled implementation");
		expect(result.text).not.toContain(AGENT_REMINDER);
		expect(result.goalId).toBe("goal-abc");
		expect(result.gateId).toBe("implementation");
		expect(result.signalId).toBe("signal-123");
		expect(result.initialSteps.map((s: any) => s.status)).toEqual(["running", "waiting"]);
		expect(result.finalStatus).toBeUndefined();
	});

	for (const finalStatus of ["passed", "failed"] as const) {
		it(`passes terminal verification.steps as initialSteps for completed ${finalStatus} signals`, async () => {
			const terminalSteps = [
				{ name: "Build", type: "command", status: "passed", phase: 0, passed: true },
				{ name: "Optional deploy", type: "command", status: "skipped", phase: 1, passed: true, skipped: true },
			];
			const result = await renderSignal({ gate_id: "implementation" }, {
				signal: {
					id: `signal-${finalStatus}`, goalId: "goal-terminal", gateId: "implementation", status: finalStatus,
					verification: { status: finalStatus, steps: terminalSteps },
				},
			});
			expect(result.hasLive).toBe(true);
			expect(result.goalId).toBe("goal-terminal");
			expect(result.gateId).toBe("implementation");
			expect(result.signalId).toBe(`signal-${finalStatus}`);
			expect(result.finalStatus).toBe(finalStatus);
			expect(result.initialSteps).toEqual(terminalSteps);
		});
	}
});
