/**
 * In-process API coverage for goal/workflow assertions that do not need a
 * spawned browser gateway.
 *
 * Browser specs keep real user journeys. Field-level workflow shape and seeded
 * optional-step metadata are pinned here to keep the browser tier smaller.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

function uniqueWorkflowId(): string {
	return `goal-workflow-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function deleteWorkflow(id: string): Promise<void> {
	await apiFetch(`/api/workflows/${id}`, { method: "DELETE" }).catch(() => {});
}

test.describe("Goal/workflow API", () => {
	test("workflow CRUD preserves phase, agent-qa, optional label, and description fields", async () => {
		const id = uniqueWorkflowId();
		try {
			const createResp = await apiFetch("/api/workflows", {
				method: "POST",
				body: JSON.stringify({
					id,
					name: "Goal Workflow API Fields",
					description: "Pins workflow verify step fields migrated out of browser UI specs.",
					gates: [{
						id: "implementation",
						name: "Implementation",
						dependsOn: [],
						verify: [
							{ name: "Build", type: "command", run: "echo build", phase: 0 },
							{
								name: "QA testing",
								type: "agent-qa",
								phase: 1,
								optional: true,
								// Old `label:` on a non-human-signoff optional step is migrated
								// forward to `optionalLabel:` on workflow load — see
								// `workflow-store.ts::normalizeStep` and the design doc for
								// the `label`/`optionalLabel` schema split.
								label: "Enable QA Testing",
								description: "Run a real browser QA pass.",
								prompt: "Validate the goal end-to-end.",
							},
						],
					}],
				}),
			});
			expect(createResp.status).toBe(201);

			const getResp = await apiFetch(`/api/workflows/${id}`);
			expect(getResp.status).toBe(200);
			const workflow = await getResp.json();
			const steps = workflow.gates[0].verify;
			expect(steps).toHaveLength(2);
			expect(steps[0]).toMatchObject({ name: "Build", type: "command", phase: 0 });
			expect(steps[1]).toMatchObject({
				name: "QA testing",
				type: "agent-qa",
				phase: 1,
				optional: true,
				// After the schema split, optional non-human-signoff steps emit
				// `optionalLabel` (not `label`). The POST above intentionally still
				// sends the old shape to pin that `normalizeStep` migrates it.
				optionalLabel: "Enable QA Testing",
				description: "Run a real browser QA pass.",
				prompt: "Validate the goal end-to-end.",
			});
			expect(steps[1].label).toBeUndefined();
		} finally {
			await deleteWorkflow(id);
		}
	});

	test("seeded feature workflow exposes the QA optional-step tooltip metadata", async () => {
		const resp = await apiFetch("/api/workflows");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		const workflows = data.workflows || data;
		const feature = (workflows as any[]).find((workflow) => workflow.id === "feature");
		expect(feature).toBeTruthy();

		const implGate = feature.gates.find((gate: any) => gate.id === "implementation");
		expect(implGate).toBeTruthy();
		const qaStep = implGate.verify.find((step: any) => step.name === "QA testing");
		expect(qaStep).toMatchObject({
			type: "agent-qa",
			optional: true,
			// Seeded `.bobbit/config/project.yaml` migrated forward to the
			// canonical `optionalLabel` shape on workflow load.
			optionalLabel: "Enable QA Testing",
		});
		expect(qaStep.label).toBeUndefined();
		expect(qaStep.description).toMatch(/QA agent/i);
		expect(qaStep.description).toMatch(/ephemeral server/i);
		expect(qaStep.description).toMatch(/browser/i);
		expect(qaStep.description).toMatch(/end-to-end/i);
	});
});
