import { beforeAll as syncBeforeAll, describe, expect, it } from "vitest";
import { render } from "lit";
import { syncCustomElements } from "./_setup/custom-elements.js";
import { renderSandboxRequirementStates } from "../../src/app/settings-page.js";
import type { SandboxRequirementsStatus } from "../../src/app/api.js";

syncBeforeAll(() => syncCustomElements());

function requirements(entries: SandboxRequirementsStatus["entries"]): SandboxRequirementsStatus {
	return { fingerprint: "f".repeat(64), profiles: ["python"], entries };
}

function renderStatuses(status: SandboxRequirementsStatus): HTMLElement {
	const root = document.createElement("div");
	document.body.append(root);
	render(renderSandboxRequirementStates(status), root);
	return root;
}

describe("sandbox requirement status UI", () => {
	it("renders every requirement state with accessible labels", () => {
		const root = renderStatuses(requirements([
			{ packId: "alpha", requirementId: "pending", state: "pending" },
			{ packId: "beta", requirementId: "available", state: "available" },
			{ packId: "gamma", requirementId: "failed", state: "failed", code: "build-failed" },
			{ packId: "delta", requirementId: "unsupported", state: "unsupported" },
		]));

		const statuses = root.querySelectorAll('[data-testid="sandbox-requirement-status"]');
		expect(statuses).toHaveLength(4);
		expect(statuses[0]).toHaveAttribute("aria-label", "Sandbox requirement alpha/pending: pending");
		expect(statuses[1]).toHaveAttribute("data-state", "available");
		expect(statuses[2]).toHaveAttribute("aria-label", "Sandbox requirement gamma/failed: failed (build-failed)");
		expect(statuses[3]).toHaveAttribute("data-state", "unsupported");
		root.remove();
	});

	it("bounds the requirement list and reports the overflow", () => {
		const root = renderStatuses(requirements(Array.from({ length: 10 }, (_, index) => ({
			packId: "fixture",
			requirementId: `requirement-${index}`,
			state: "pending" as const,
		}))));

		expect(root.querySelectorAll('[data-testid="sandbox-requirement-status"]')).toHaveLength(8);
		expect(root.querySelector('[data-testid="sandbox-requirement-status-overflow"]')).toHaveTextContent("2 additional requirements");
		root.remove();
	});
});
