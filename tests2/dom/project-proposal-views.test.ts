import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/project-proposal-views.spec.ts (v2-dom tier).
// Renders the REAL lit templates from src/app/project-proposal-views.ts into a
// happy-dom container (replacing the esbuild file:// bundle + window globals).
// No geometry — pure lit render + data-testid/text assertions.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { viewTabs, componentsView, workflowsView } from "../../src/app/project-proposal-views.js";

function host(): HTMLElement {
	let el = document.getElementById("host");
	if (!el) {
		el = document.createElement("div");
		el.id = "host";
		document.body.appendChild(el);
	}
	el.innerHTML = "";
	return el;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("project proposal views", () => {
	it("componentsView renders one card per component with data-only badge for command-less components", () => {
		const el = host();
		render(componentsView([
			{ name: "api", repo: ".", commands: { build: "npm run build", test: "npm test" } } as any,
			{ name: "docs", repo: "docs" } as any,
		]), el);
		expect(el.querySelectorAll('[data-testid="component-card-api"]').length).toBe(1);
		expect(el.querySelectorAll('[data-testid="component-card-docs"]').length).toBe(1);
		expect(el.querySelectorAll('[data-testid="component-card-docs"] [data-testid="data-only-badge"]').length).toBe(1);
		expect(el.querySelectorAll('[data-testid="component-card-api"] [data-testid="data-only-badge"]').length).toBe(0);
	});

	it("componentsView empty state", () => {
		const el = host();
		render(componentsView([]), el);
		expect(el.textContent).toContain("No components proposed");
	});

	it("workflowsView renders one card per workflow with gate count", () => {
		const el = host();
		const wfs = {
			feature: {
				id: "feature",
				name: "Feature",
				description: "Full feature flow",
				gates: [
					{ id: "design-doc", name: "Design", content: true, verify: [{ name: "Design review", type: "llm-review", role: "architect", prompt: "Review the design." }] },
					{ id: "implementation", name: "Impl", depends_on: ["design-doc"], description: "Ralph loop", verify: [
						{ name: "Build", type: "command", phase: 0, component: "api", command: "build" },
						{ name: "Type check", type: "command", phase: 1, component: "api", command: "check" },
					] },
					{ id: "ready-to-merge", name: "Ready", depends_on: ["implementation"] },
				],
			},
			"quick-fix": { id: "quick-fix", name: "Quick fix", gates: [{ id: "implementation", name: "Impl" }] },
		};
		render(workflowsView(wfs as any, [{ name: "api", repo: "." }] as any), el);
		expect(el.querySelectorAll('[data-testid="workflow-card-feature"]').length).toBe(1);
		expect(el.querySelectorAll('[data-testid="workflow-card-quick-fix"]').length).toBe(1);
		expect(el.querySelectorAll('[data-testid="workflow-card-feature"] [data-testid^="gate-node-"]').length).toBe(3);
		expect(el.querySelector('[data-testid="workflow-card-feature"] [data-testid="gate-node-implementation"]')?.textContent).toContain("design-doc");
	});

	it("viewTabs renders Components / Workflows / Settings", () => {
		const el = host();
		render(viewTabs("components" as any, () => {}, {} as any), el);
		expect(el.querySelectorAll('[data-testid="view-tab-components"]').length).toBe(1);
		expect(el.querySelectorAll('[data-testid="view-tab-workflows"]').length).toBe(1);
		expect(el.querySelectorAll('[data-testid="view-tab-settings"]').length).toBe(1);
		expect(el.querySelectorAll('[data-testid="view-tab-diff"]').length).toBe(0);
	});

	it("viewTabs renders count badges next to Components and Workflows", () => {
		const el = host();
		render(viewTabs("components" as any, () => {}, { components: 3, workflows: 2 } as any), el);
		expect(el.querySelector('[data-testid="view-tab-count-components"]')?.textContent).toContain("3");
		expect(el.querySelector('[data-testid="view-tab-count-workflows"]')?.textContent).toContain("2");
	});
});
