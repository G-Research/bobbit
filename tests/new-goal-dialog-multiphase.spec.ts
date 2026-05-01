/**
 * New Goal dialog — Advanced disclosure + multi-phase suggestion banner.
 *
 * Drives the dialog from a file:// fixture (no server needed). Verifies:
 *   1. Banner appears when the spec matches the multi-phase heuristic.
 *   2. "Use Parent Goal" sets the workflow picker to `parent`, opens
 *      Advanced, and pre-fills concurrency=3 / policy=balanced.
 *   3. "Keep current" dismisses the banner and persists per-project to
 *      localStorage under `bobbit-multiphase-banner-dismissed-<projectId>`.
 *   4. Banner reacts to spec textarea input (live re-render).
 *
 * See `docs/design/nested-goals.md` §10.4 + §14.2 + §12 task 4.4.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/new-goal-dialog-multiphase.html");
const BUNDLE = path.resolve("tests/fixtures/new-goal-dialog-multiphase-bundle.js");
const ENTRY = path.resolve("tests/fixtures/new-goal-dialog-multiphase-entry.ts");
const DIALOGS_SRC = path.resolve("src/app/dialogs.ts");
const HELPERS_SRC = path.resolve("src/app/dialog-helpers.ts");
const SHARED_SRC = path.resolve("src/shared/acceptance-criteria.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(DIALOGS_SRC).mtimeMs,
		fs.statSync(HELPERS_SRC).mtimeMs,
		fs.statSync(SHARED_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;
const PROJECT_ID = "test-project-multiphase";
const DISMISS_KEY = `bobbit-multiphase-banner-dismissed-${PROJECT_ID}`;

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 1024 });
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	// Clean dismissal key so each test starts from a known-empty state.
	await page.evaluate((key) => {
		try { localStorage.removeItem(key); } catch { /* ignore */ }
	}, DISMISS_KEY);
});

// Click the first button matching `text` inside `selector`'s first match.
// Bypasses Playwright's strict viewport checks because the dialog uses an
// internal scroll container which Playwright won't auto-scroll.
async function clickButtonByText(page: any, selector: string, text: string): Promise<boolean> {
	return await page.evaluate(
		({ sel, t }: { sel: string; t: string }) => {
			const host = document.querySelector(sel);
			if (!host) return false;
			const btns = Array.from(host.querySelectorAll("button")) as HTMLButtonElement[];
			for (const b of btns) {
				if ((b.textContent || "").trim().includes(t)) { b.click(); return true; }
			}
			return false;
		},
		{ sel: selector, t: text },
	);
}

async function openDialog(page: any) {
	// Fire and forget — dialog returns a Promise we resolve via Cancel/Create.
	await page.evaluate((projectId) => {
		const p = (window as any).__showNewGoalDialog({ projectId });
		(window as any).__dialogPromise = p;
	}, PROJECT_ID);
	await page.waitForSelector("[data-testid='goal-spec-textarea']");
}

test.describe("New Goal dialog — multi-phase banner", () => {
	test("banner is hidden for a short single-feature spec", async ({ page }) => {
		await openDialog(page);
		await page.locator("[data-testid='goal-spec-textarea']").fill("Add a dark-mode toggle that persists across reloads.");
		await expect(page.locator("[data-testid='multiphase-banner']")).toHaveCount(0);
	});

	test("banner appears for a multi-phase spec (version + criteria signals)", async ({ page }) => {
		await openDialog(page);
		const spec = `# Build agent-memory v0.1 → v1.0

## Phase 1: API stub (v0.1)
Basic CRUD.

## Phase 2: vector backend (v0.5)
Upgrade to embeddings.

## Acceptance criteria
- Memory survives session restart.
- API exposes search / write / forget.
- Vector backend swappable.
- Latency under 200ms p95.
- Metrics dashboards land in v1.0.
`;
		await page.locator("[data-testid='goal-spec-textarea']").fill(spec);
		await expect(page.locator("[data-testid='multiphase-banner']")).toBeVisible();
		await expect(page.locator("[data-testid='multiphase-banner']")).toContainText("multi-phase delivery");
		await expect(page.locator("[data-testid='multiphase-banner']")).toContainText("Parent Goal");
	});

	test("banner reacts live to spec edits", async ({ page }) => {
		await openDialog(page);
		const textarea = page.locator("[data-testid='goal-spec-textarea']");

		// Initially short — no banner.
		await textarea.fill("short note");
		await expect(page.locator("[data-testid='multiphase-banner']")).toHaveCount(0);

		// Add a "phase 1" trigger — banner appears.
		await textarea.fill("This is phase 1 of a migration.");
		await expect(page.locator("[data-testid='multiphase-banner']")).toBeVisible();

		// Remove the trigger — banner disappears.
		await textarea.fill("just a note");
		await expect(page.locator("[data-testid='multiphase-banner']")).toHaveCount(0);
	});

	test("'Use Parent Goal' sets workflow=parent, opens Advanced, pre-fills concurrency=3 / policy=balanced", async ({ page }) => {
		await openDialog(page);
		await page.locator("[data-testid='goal-spec-textarea']").fill("Migration: phase 1 then phase 2.");
		await expect(page.locator("[data-testid='multiphase-banner']")).toBeVisible();

		// The picker may not have a `parent` option in the fallback (no server),
		// but we still set workflowId — verify via the underlying value attr.
		expect(await clickButtonByText(page, "[data-testid='multiphase-banner']", "Use Parent Goal")).toBe(true);

		// Advanced disclosure opens.
		const adv = page.locator("[data-testid='advanced-disclosure']");
		await expect(adv).toHaveAttribute("open", /.*/);

		// Concurrency slider reads 3.
		const slider = page.locator("[data-testid='max-concurrent-slider']");
		await expect(slider).toHaveValue("3");
		await expect(page.locator("[data-testid='max-concurrent-value']")).toHaveText("3");

		// Policy radio reads balanced.
		const balanced = page.locator("[data-testid='policy-balanced']");
		await expect(balanced).toBeChecked();

		// Workflow picker is set to "parent" via the .value bind.
		const wfValue = await page.locator("[data-testid='workflow-picker']").evaluate(
			(el) => (el as HTMLSelectElement).value,
		);
		expect(wfValue).toBe("parent");
	});

	test("'Keep current' dismisses banner and persists per-project to localStorage", async ({ page }) => {
		await openDialog(page);
		await page.locator("[data-testid='goal-spec-textarea']").fill("Phase 1 then Phase 2.");
		await expect(page.locator("[data-testid='multiphase-banner']")).toBeVisible();

		expect(await clickButtonByText(page, "[data-testid='multiphase-banner']", "Keep current")).toBe(true);
		await expect(page.locator("[data-testid='multiphase-banner']")).toHaveCount(0);

		// localStorage carries the dismissal flag.
		const stored = await page.evaluate(
			(key) => (window as any).__readLocalStorage(key),
			DISMISS_KEY,
		);
		expect(stored).toBe("1");

		// And critically: even if the spec is edited again to re-trigger the
		// heuristic, the banner stays hidden in the same session because the
		// flag is set.
		await page.locator("[data-testid='goal-spec-textarea']").fill("Phase 3 of the migration starts soon.");
		await expect(page.locator("[data-testid='multiphase-banner']")).toHaveCount(0);
	});

	test("dismissal persists across dialog re-open (per-project localStorage)", async ({ page }) => {
		await openDialog(page);
		await page.locator("[data-testid='goal-spec-textarea']").fill("Phase 1 then Phase 2.");
		expect(await clickButtonByText(page, "[data-testid='multiphase-banner']", "Keep current")).toBe(true);
		// Cancel out of the dialog to fully tear it down.
		await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
			for (const b of btns) if ((b.textContent || "").trim() === "Cancel") { b.click(); break; }
		});

		// Re-open with a multi-phase spec — banner should NOT appear because
		// the per-project dismissal is still set.
		await openDialog(page);
		await page.locator("[data-testid='goal-spec-textarea']").fill("Phase 1 of the new plan.");
		await expect(page.locator("[data-testid='multiphase-banner']")).toHaveCount(0);
	});

	test("Advanced disclosure starts closed and opens on summary click", async ({ page }) => {
		await openDialog(page);
		const adv = page.locator("[data-testid='advanced-disclosure']");
		await expect(adv).not.toHaveAttribute("open", /.*/);

		await adv.locator("summary").click();
		await expect(adv).toHaveAttribute("open", /.*/);

		// All four controls render once open.
		await expect(page.locator("[data-testid='divergence-policy-radio']")).toBeVisible();
		await expect(page.locator("[data-testid='max-concurrent-slider']")).toBeVisible();
		await expect(page.locator("[data-testid='inline-workflow-yaml']")).toBeVisible();
		await expect(page.locator("[data-testid='inline-roles-yaml']")).toBeVisible();
	});

	test("default Advanced values: policy=strict, concurrency=3", async ({ page }) => {
		await openDialog(page);
		await page.locator("[data-testid='advanced-disclosure'] summary").click();
		await expect(page.locator("[data-testid='policy-strict']")).toBeChecked();
		await expect(page.locator("[data-testid='max-concurrent-slider']")).toHaveValue("3");
	});
});

// Child-goal flow (F1) — docs/design/nested-goals.md §10.4. Verifies the
// dialog rebrands as "Add Child Goal", surfaces a parent banner, defaults
// the workflow picker to `feature`, and round-trips `parentGoalId` on the
// resolved result.
test.describe("New Goal dialog — Add child goal flow", () => {
	test("opens with parent banner, 'Add Child Goal' header, and feature workflow default", async ({ page }) => {
		await page.evaluate((projectId) => {
			const p = (window as any).__showNewGoalDialog({ projectId, parentGoalId: "parent-abc" });
			(window as any).__dialogPromise = p;
		}, PROJECT_ID);
		await page.waitForSelector("[data-testid='goal-spec-textarea']");

		// Header rebrands to "Add Child Goal".
		await expect(page.locator("text=Add Child Goal")).toBeVisible();
		// Parent context banner is visible and names the parent id.
		await expect(page.locator("[data-testid='new-goal-parent-banner']")).toBeVisible();
		await expect(page.locator("[data-testid='new-goal-parent-id']")).toHaveText("parent-abc");
		// Workflow picker defaults to `feature` (children are usually leaf goals).
		const wfValue = await page.locator("[data-testid='workflow-picker']").evaluate(
			(el) => (el as HTMLSelectElement).value,
		);
		expect(wfValue).toBe("feature");
	});

	test("submitting Create round-trips parentGoalId on the result", async ({ page }) => {
		await page.evaluate((projectId) => {
			const p = (window as any).__showNewGoalDialog({ projectId, parentGoalId: "parent-xyz" });
			(window as any).__dialogPromise = p.then((res: any) => {
				(window as any).__dialogResult = res;
				return res;
			});
		}, PROJECT_ID);
		await page.waitForSelector("[data-testid='goal-spec-textarea']");

		// Title is required for Create to enable. The title @input handler
		// intentionally does NOT call renderDialog (see dialogs.ts), so we
		// trigger a re-render by also filling the spec textarea — same
		// pattern used by inline-workflow-validation.spec.ts.
		await page.locator("input[placeholder='Goal title']").first().fill("Child task");
		await page.locator("[data-testid='goal-spec-textarea']").fill("x");

		// Click Create.
		await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
			for (const b of btns) {
				if ((b.textContent || "").trim() === "Create") { b.click(); return; }
			}
		});
		await page.waitForFunction(() => (window as any).__dialogResult !== undefined, null, { timeout: 5000 });
		const result: any = await page.evaluate(() => (window as any).__dialogResult);
		expect(result).not.toBeNull();
		expect(result.parentGoalId).toBe("parent-xyz");
		expect(result.workflowId).toBe("feature");
		expect(result.title).toBe("Child task");
	});

	test("top-level (no parentGoalId) keeps legacy 'New Goal' header and 'general' default", async ({ page }) => {
		await page.evaluate((projectId) => {
			const p = (window as any).__showNewGoalDialog({ projectId });
			(window as any).__dialogPromise = p;
		}, PROJECT_ID);
		await page.waitForSelector("[data-testid='goal-spec-textarea']");

		await expect(page.locator("text=New Goal")).toBeVisible();
		await expect(page.locator("[data-testid='new-goal-parent-banner']")).toHaveCount(0);
		const wfValue = await page.locator("[data-testid='workflow-picker']").evaluate(
			(el) => (el as HTMLSelectElement).value,
		);
		expect(wfValue).toBe("general");
	});
});

// Workflow-id coercion (commit `058c17ea`) — brand-new projects (post
// `864ae63d` / #413 "No default workflow scaffold") may not have
// `general` or `feature` available. The dialog historically defaulted
// `workflowId` to those values without checking, leading to opaque
// `400 Workflow not found: general` toasts on Accept. The fix coerces
// to the first available workflow once `fetchWorkflows()` resolves.
test.describe("New Goal dialog — workflow id coercion (regression)", () => {
	test("coerces top-level default 'general' to first available when 'general' is missing", async ({ page }) => {
		// Brand-new project that registered with only a custom workflow.
		await page.evaluate(() => {
			(window as any).__nextWorkflowsResponse = [
				{ id: "agent-memory-build", name: "Agent-Memory Build", gates: [], description: "" },
			];
		});
		await page.evaluate((projectId) => {
			(window as any).__dialogPromise = (window as any).__showNewGoalDialog({ projectId });
		}, PROJECT_ID);
		await page.waitForSelector("[data-testid='goal-spec-textarea']");
		// Wait for the workflow picker to settle on the coerced id (the
		// fetchWorkflows() promise resolves async — the dialog re-renders).
		await expect.poll(async () => await page.locator("[data-testid='workflow-picker']").evaluate(
			(el) => (el as HTMLSelectElement).value,
		)).toBe("agent-memory-build");
	});

	test("keeps 'general' when 'general' IS in the project's workflow list", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).__nextWorkflowsResponse = [
				{ id: "general", name: "General", gates: [], description: "" },
				{ id: "feature", name: "Feature", gates: [], description: "" },
			];
		});
		await page.evaluate((projectId) => {
			(window as any).__dialogPromise = (window as any).__showNewGoalDialog({ projectId });
		}, PROJECT_ID);
		await page.waitForSelector("[data-testid='goal-spec-textarea']");
		// Picker stays on the legacy default — no coercion happens when
		// the preferred id is in the list.
		await expect.poll(async () => await page.locator("[data-testid='workflow-picker']").evaluate(
			(el) => (el as HTMLSelectElement).value,
		)).toBe("general");
	});

	test("coerces child-goal default 'feature' to first available when 'feature' is missing", async ({ page }) => {
		// Sibling regression for the child-goal flow (design §10.4) which
		// defaults `workflowId` to `feature`.
		await page.evaluate(() => {
			(window as any).__nextWorkflowsResponse = [
				{ id: "general", name: "General", gates: [], description: "" },
				{ id: "parent", name: "Parent", gates: [], description: "" },
			];
		});
		await page.evaluate((projectId) => {
			(window as any).__dialogPromise = (window as any).__showNewGoalDialog({
				projectId,
				parentGoalId: "parent-abc",
			});
		}, PROJECT_ID);
		await page.waitForSelector("[data-testid='goal-spec-textarea']");
		await expect.poll(async () => await page.locator("[data-testid='workflow-picker']").evaluate(
			(el) => (el as HTMLSelectElement).value,
		)).toBe("general");
	});

	test("empty workflow list — picker shows fallback options, workflowId stays at 'general'", async ({ page }) => {
		// When `fetchWorkflows()` returns [] (brand-new project, file:// fixture,
		// or network error), the dialog falls back to `[general, parent]` for
		// display so the picker remains usable. `coerceWorkflowId` is a no-op
		// on empty lists — the preferred id is returned unchanged. The eventual
		// 400 from POST /api/goals is surfaced via `formatGatewayError`, not
		// pre-empted with a client-side alert (which would also misfire on
		// file:// fixtures that don't stub fetchWorkflows).
		await page.evaluate(() => {
			(window as any).__nextWorkflowsResponse = [];
		});
		await page.evaluate((projectId) => {
			(window as any).__dialogPromise = (window as any).__showNewGoalDialog({ projectId });
		}, PROJECT_ID);
		await page.waitForSelector("[data-testid='goal-spec-textarea']");
		const wfValue = await page.locator("[data-testid='workflow-picker']").evaluate(
			(el) => (el as HTMLSelectElement).value,
		);
		expect(wfValue).toBe("general");
	});
});
