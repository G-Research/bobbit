/**
 * Workflow editor — UI YAML/UI parity & human-signoff coverage.
 *
 * Pins every schema field on `VerifyStep` and `WorkflowGate` to a settable
 * editor surface. Catches the regression that shipped in PR #644 where the
 * editor's step-type dropdown was missing the `human-signoff` option and
 * forced authors into the `command` default (silent auto-skip).
 *
 * Canonical pattern: tests/e2e/ui/workflow-page-scope.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, rawApiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createProjectDir(): string {
	const dir = mkdtempSync(join(tmpdir(), `bobbit-wf-editor-${process.env.E2E_PORT}-`));
	mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	return dir;
}

test.describe("Workflow editor UI/YAML parity @smoke", () => {
	let projectId: string;
	let tmpDir: string;

	test.beforeAll(async () => {
		tmpDir = createProjectDir();
		const res = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "WF Editor Project", rootPath: tmpDir, __e2e_seed_skip__: true }),
		});
		expect(res.status).toBe(201);
		projectId = (await res.json()).id;
	});

	test.afterAll(async () => {
		await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		rmSync(tmpDir, { recursive: true, force: true });
	});

	async function gotoNewEditor(page: import("@playwright/test").Page, wfId: string, gates: any[]): Promise<void> {
		const res = await rawApiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				projectId,
				id: wfId,
				name: `Test Workflow ${wfId}`,
				description: "editor parity",
				gates,
			}),
		});
		expect(res.status).toBe(201);

		await openApp(page);
		await navigateToHash(page, `#/settings/${projectId}/workflows`);
		const tab = page.locator("[data-testid='workflows-tab']").first();
		await expect(tab).toBeVisible({ timeout: 10_000 });
		await tab.getByText(`Test Workflow ${wfId}`).first().click();
		// Wait for edit view to render
		await expect(page.locator(".wf-edit-container")).toBeVisible({ timeout: 10_000 });
	}

	async function expandFirstGate(page: import("@playwright/test").Page): Promise<void> {
		const header = page.locator(".wf-gate-header").first();
		await header.click();
		await expect(page.locator(".wf-gate-card.expanded").first()).toBeVisible();
	}

	async function expandFirstStep(page: import("@playwright/test").Page): Promise<void> {
		const header = page.locator(".wf-vstep-collapsed-header").first();
		await header.click();
		await expect(page.locator(".wf-vstep-card.vstep-expanded").first()).toBeVisible();
	}

	async function expandFirstStepAdvanced(page: import("@playwright/test").Page): Promise<void> {
		const details = page.locator(".wf-vstep-card.vstep-expanded details.wf-vstep-advanced").first();
		await expect(details.locator("summary")).toBeVisible();
		if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
			await details.locator("summary").click();
		}
		await expect(page.locator(".wf-vstep-card.vstep-expanded .wf-vstep-advanced-fields").first()).toBeVisible();
	}

	async function clickSaveAndWait(page: import("@playwright/test").Page, wfId: string): Promise<void> {
		const responsePromise = page.waitForResponse((res) =>
			res.request().method() === "PUT"
			&& res.url().includes(`/api/workflows/${wfId}`)
			&& res.status() < 500,
			{ timeout: 10_000 },
		).catch(() => null);
		await page.getByRole("button", { name: /^Save$/ }).click();
		const response = await responsePromise;
		expect(response, "workflow save should issue a PUT request").not.toBeNull();
	}

	async function fillAndExpect(locator: import("@playwright/test").Locator, value: string): Promise<void> {
		await locator.fill(value);
		await expect(locator).toHaveValue(value);
	}

	async function switchToNamedCommand(page: import("@playwright/test").Page): Promise<void> {
		const button = page.locator("[data-testid='wf-cmd-mode-command']").first();
		const commandInput = page.locator("[data-testid='wf-step-command']").first();
		for (let i = 0; i < 3; i++) {
			await button.click();
			if (await commandInput.isVisible().catch(() => false)) return;
			await page.waitForTimeout(100);
		}
		await expect(commandInput).toBeVisible();
	}

	test("type dropdown lists all four step types (including human-signoff)", async ({ page }) => {
		const wfId = "type-dropdown-" + Date.now();
		await gotoNewEditor(page, wfId, [{
			id: "g1", name: "Gate 1", depends_on: [],
			verify: [{ name: "Step", type: "command", run: "echo ok" }],
		}]);
		await expandFirstGate(page);
		await expandFirstStep(page);

		const select = page.locator("[data-testid='wf-step-type']").first();
		await expect(select).toBeVisible();
		const optionValues = await select.locator("option").evaluateAll((els) =>
			(els as HTMLOptionElement[]).map(o => o.value),
		);
		expect(optionValues).toEqual(["command", "llm-review", "agent-qa", "human-signoff"]);

		await apiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
	});

	test("human-signoff step round-trips: label, prompt, role, description, optionalLabel", async ({ page }) => {
		const wfId = "signoff-rt-" + Date.now();
		await gotoNewEditor(page, wfId, [{
			id: "g1", name: "Approval", depends_on: [],
			verify: [{ name: "Approve", type: "command", run: "echo placeholder" }],
		}]);
		await expandFirstGate(page);
		await expandFirstStep(page);

		// Switch type to human-signoff (also strips run/expect, initialises label/prompt)
		await page.locator("[data-testid='wf-step-type']").first().selectOption("human-signoff");
		await expect(page.locator("[data-testid='wf-step-label']").first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("[data-testid='wf-step-prompt']").first()).toBeVisible();

		// Fill required + advanced fields. Role/description live inside the collapsed
		// Advanced <details> section, so open it before targeting those controls.
		await fillAndExpect(page.locator("[data-testid='wf-step-name']").first(), "Design Approval");
		await fillAndExpect(page.locator("[data-testid='wf-step-label']").first(), "Approve design doc");
		await fillAndExpect(page.locator("[data-testid='wf-step-prompt']").first(), "Please review and approve the design.");
		await page.locator("[data-testid='wf-step-optional']").first().check();
		await expect(page.locator("[data-testid='wf-step-optional']").first()).toBeChecked();
		await fillAndExpect(page.locator("[data-testid='wf-step-optional-label']").first(), "Require design approval");
		await expandFirstStepAdvanced(page);
		await fillAndExpect(page.locator("[data-testid='wf-step-role']").first(), "architect");
		await fillAndExpect(page.locator("[data-testid='wf-step-description']").first(), "Final architectural sign-off.");
		// Re-assert the first identity field last; rapid rerenders while filling
		// adjacent fields previously made this test flaky on Windows/WebKit timing.
		await fillAndExpect(page.locator("[data-testid='wf-step-name']").first(), "Design Approval");

		// Save, then reload the edit route to prove the fields round-trip through
		// persistence rather than staying only in client-side edit state.
		await clickSaveAndWait(page, wfId);
		await navigateToHash(page, `#/settings/${projectId}/workflows`);
		await page.reload();
		const tab = page.locator("[data-testid='workflows-tab']").first();
		await expect(tab).toBeVisible({ timeout: 10_000 });
		await tab.getByText(`Test Workflow ${wfId}`).first().click();
		await expect(page.locator(".wf-edit-container")).toBeVisible({ timeout: 10_000 });
		await expandFirstGate(page);
		await expandFirstStep(page);

		// Round-trip assertions
		await expect(page.locator("[data-testid='wf-step-type']").first()).toHaveValue("human-signoff");
		await expect(page.locator("[data-testid='wf-step-name']").first()).toHaveValue("Design Approval");
		await expect(page.locator("[data-testid='wf-step-label']").first()).toHaveValue("Approve design doc");
		await expect(page.locator("[data-testid='wf-step-prompt']").first()).toHaveValue("Please review and approve the design.");
		await expect(page.locator("[data-testid='wf-step-optional']").first()).toBeChecked();
		await expect(page.locator("[data-testid='wf-step-optional-label']").first()).toHaveValue("Require design approval");
		await expect(page.locator("[data-testid='wf-step-role']").first()).toHaveValue("architect");
		await expect(page.locator("[data-testid='wf-step-description']").first()).toHaveValue("Final architectural sign-off.");

		// Underlying YAML must NOT carry a stale `run` field (human-signoff strips it)
		const r = await rawApiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "GET" });
		const wf = await r.json();
		const step = wf.gates[0].verify[0];
		expect(step.type).toBe("human-signoff");
		expect(step.run).toBeUndefined();
		expect(step.expect).toBeUndefined();
		expect(step.label).toBe("Approve design doc");
		expect(step.optionalLabel).toBe("Require design approval");
		expect(step.prompt).toBe("Please review and approve the design.");

		await apiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
	});

	test("validation: human-signoff with empty prompt blocks save and surfaces inline error", async ({ page }) => {
		const wfId = "signoff-validate-" + Date.now();
		await gotoNewEditor(page, wfId, [{
			id: "g1", name: "Approval", depends_on: [],
			verify: [{ name: "S", type: "command", run: "echo x" }],
		}]);
		await expandFirstGate(page);
		await expandFirstStep(page);

		await page.locator("[data-testid='wf-step-type']").first().selectOption("human-signoff");
		await page.locator("[data-testid='wf-step-name']").first().fill("Approval");
		// intentionally leave label & prompt empty

		await page.getByRole("button", { name: /^Save$/ }).click();

		// Banner must appear, inline errors must be visible.
		await expect(page.locator("[data-testid='wf-save-error-banner']")).toBeVisible();
		await expect(page.locator("[data-testid='wf-step-prompt-error']").first()).toBeVisible();
		await expect(page.locator("[data-testid='wf-step-label-error']").first()).toBeVisible();

		// Underlying YAML must NOT have been mutated by the failed save.
		const r = await rawApiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "GET" });
		const wf = await r.json();
		// Original was `command` with `run: echo x` — must still be that.
		expect(wf.gates[0].verify[0].type).toBe("command");
		expect(wf.gates[0].verify[0].run).toBe("echo x");

		await apiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
	});

	test("type-switch from command to human-signoff strips run/expect", async ({ page }) => {
		const wfId = "type-switch-" + Date.now();
		await gotoNewEditor(page, wfId, [{
			id: "g1", name: "Gate", depends_on: [],
			verify: [{ name: "Step", type: "command", run: "make test", expect: "success" }],
		}]);
		await expandFirstGate(page);
		await expandFirstStep(page);

		// Switch type → human-signoff
		await page.locator("[data-testid='wf-step-type']").first().selectOption("human-signoff");
		await expect(page.locator("[data-testid='wf-step-type']").first()).toHaveValue("human-signoff");
		await expect(page.locator("[data-testid='wf-step-label']").first()).toBeVisible({ timeout: 10_000 });
		// Free-form `run` input must no longer be visible.
		await expect(page.locator("[data-testid='wf-step-run']")).toHaveCount(0);
		// Prompt textarea now visible.
		await expect(page.locator("[data-testid='wf-step-prompt']").first()).toBeVisible();

		// Fill required fields and save.
		await fillAndExpect(page.locator("[data-testid='wf-step-label']").first(), "Approve");
		await fillAndExpect(page.locator("[data-testid='wf-step-prompt']").first(), "Please approve.");
		await expect(page.locator("[data-testid='wf-save-error-banner']")).toHaveCount(0);
		await clickSaveAndWait(page, wfId);

		// Re-fetch YAML — step must be human-signoff with no run/expect.
		const r = await rawApiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "GET" });
		const wf = await r.json();
		expect(wf.gates[0].verify[0].type).toBe("human-signoff");
		expect(wf.gates[0].verify[0].run).toBeUndefined();
		expect(wf.gates[0].verify[0].expect).toBeUndefined();
		expect(wf.gates[0].verify[0].label).toBe("Approve");

		await apiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
	});

	test("gate-level fields round-trip: optional, manual, metadata", async ({ page }) => {
		const wfId = "gate-fields-" + Date.now();
		await gotoNewEditor(page, wfId, [{
			id: "g1", name: "Gate 1", depends_on: [],
			verify: [{ name: "S1", type: "command", run: "echo a" }],
		}]);
		await expandFirstGate(page);

		// Toggle optional + manual
		await page.locator("[data-testid='wf-gate-optional']").first().check();
		await page.locator("[data-testid='wf-gate-manual']").first().check();

		// Add two metadata entries
		await page.locator("[data-testid='wf-metadata-add']").first().click();
		await expect(page.locator("[data-testid='wf-metadata-row']")).toHaveCount(1);
		await page.locator("[data-testid='wf-metadata-add']").first().click();
		await expect(page.locator("[data-testid='wf-metadata-row']")).toHaveCount(2);
		const keyInputs = page.locator("[data-testid='wf-metadata-key']");
		const valInputs = page.locator("[data-testid='wf-metadata-value']");
		await fillAndExpect(keyInputs.nth(0), "priority");
		await fillAndExpect(valInputs.nth(0), "high");
		await fillAndExpect(keyInputs.nth(1), "team");
		await fillAndExpect(valInputs.nth(1), "backend");

		await clickSaveAndWait(page, wfId);

		const r = await rawApiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "GET" });
		const wf = await r.json();
		expect(wf.gates[0].optional).toBe(true);
		expect(wf.gates[0].manual).toBe(true);
		expect(wf.gates[0].metadata).toEqual({ priority: "high", team: "backend" });

		await apiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
	});

	test("dependsOn chips set explicit gate dependencies", async ({ page }) => {
		const wfId = "depends-on-" + Date.now();
		// Two gates so chip-toggling has something to point at.
		await gotoNewEditor(page, wfId, [
			{ id: "first", name: "First", depends_on: [], verify: [{ name: "S", type: "command", run: "echo 1" }] },
			{ id: "second", name: "Second", depends_on: [], verify: [{ name: "S", type: "command", run: "echo 2" }] },
		]);

		// Expand the second gate (idx 1).
		const headers = page.locator(".wf-gate-header");
		await headers.nth(1).click();

		// Toggle the "first" chip ON inside the second gate's body.
		const chipInsideSecond = page.locator(".wf-gate-card.expanded [data-testid='wf-dep-chip-first']").first();
		await expect(chipInsideSecond).toBeVisible();
		await chipInsideSecond.click();
		await expect(chipInsideSecond).toHaveClass(/wf-dep-toggle-chip--active/);

		await clickSaveAndWait(page, wfId);

		const r = await rawApiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "GET" });
		const wf = await r.json();
		expect(wf.gates[1].dependsOn).toEqual(["first"]);

		await apiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
	});

	test("label/optionalLabel migration: old shape on optional non-signoff step migrates on save", async ({ page }) => {
		const wfId = "migrate-label-" + Date.now();
		// Seed YAML with the OLD shape: optional+label on an agent-qa step.
		// (workflow-store normalizer should migrate to optionalLabel transparently.)
		await gotoNewEditor(page, wfId, [{
			id: "g1", name: "QA Gate", depends_on: [],
			verify: [{
				name: "QA",
				type: "agent-qa",
				prompt: "Test the thing.",
				optional: true,
				label: "Enable QA Testing",
			}],
		}]);
		await expandFirstGate(page);
		await expandFirstStep(page);

		// The migrated UI must show the value in optionalLabel, NOT in label.
		await expect(page.locator("[data-testid='wf-step-optional-label']").first())
			.toHaveValue("Enable QA Testing");
		// `label` is for human-signoff card title only — must not render for agent-qa.
		await expect(page.locator("[data-testid='wf-step-label']")).toHaveCount(0);

		// Save (no UI changes). Resulting YAML must emit optionalLabel, not label.
		await clickSaveAndWait(page, wfId);

		const r = await rawApiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "GET" });
		const wf = await r.json();
		const step = wf.gates[0].verify[0];
		expect(step.optionalLabel).toBe("Enable QA Testing");
		expect(step.label).toBeUndefined();

		await apiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
	});

	test("command step: timeout, component (text), and named-command toggle round-trip", async ({ page }) => {
		const wfId = "cmd-fields-" + Date.now();
		await gotoNewEditor(page, wfId, [{
			id: "g1", name: "Gate", depends_on: [],
			verify: [{ name: "Build", type: "command", run: "make build" }],
		}]);
		await expandFirstGate(page);
		await expandFirstStep(page);

		// Set timeout. Timeout/component live inside the collapsed Advanced section.
		await expandFirstStepAdvanced(page);
		await fillAndExpect(page.locator("[data-testid='wf-step-timeout']").first(), "120");
		// Switch to named-command mode.
		await switchToNamedCommand(page);
		await fillAndExpect(page.locator("[data-testid='wf-step-command']").first(), "build");
		// Set component. The editor renders a select when the project has structured
		// components, and a free-text fallback when it does not.
		const componentControl = page.locator("[data-testid='wf-step-component']").first();
		const componentTag = await componentControl.evaluate((el) => el.tagName.toLowerCase());
		let expectedComponent = "server";
		if (componentTag === "select") {
			const optionValues = await componentControl.locator("option").evaluateAll((els) =>
				(els as HTMLOptionElement[]).map(o => o.value).filter(Boolean),
			);
			expect(optionValues.length).toBeGreaterThan(0);
			expectedComponent = optionValues[0];
			await componentControl.selectOption(expectedComponent);
		} else {
			await componentControl.fill(expectedComponent);
		}

		await clickSaveAndWait(page, wfId);

		const r = await rawApiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "GET" });
		const wf = await r.json();
		const step = wf.gates[0].verify[0];
		expect(step.timeout).toBe(120);
		expect(step.component).toBe(expectedComponent);
		expect(step.command).toBe("build");
		// `run` should have been stripped by the named-command toggle.
		expect(step.run).toBeUndefined();

		await apiFetch(`/api/workflows/${wfId}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
	});
});
