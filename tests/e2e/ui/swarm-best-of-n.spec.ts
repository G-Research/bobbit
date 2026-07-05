/**
 * SWARM-W1 — governor strip browser E2E (design/swarm-orchestration.md §8,
 * tracker: "browser E2E (run→render→reconcile→reload-persist)").
 *
 * Flow: fan out a best-of-N swarm via REST (team-lead-authorized, mirrors
 * how a real orchestrating agent would trigger it — the UI itself never
 * calls the ORCHESTRATION-class create route directly, same as
 * spawn-child), drive both siblings to a real terminal state with one
 * planted "winner" file, then drive the REST verify/confirm (human-gated)
 * flow and assert the Agents-tab governor strip:
 *   1. renders once the barrier fires (RUN),
 *   2. reflects the verify pick + lets the operator confirm (RENDER),
 *   3. shows the integrated state after confirm (RECONCILE),
 *   4. still shows the integrated state after a full page reload
 *      (RELOAD-PERSIST).
 * Also asserts a plain (non-swarm) goal's Agents tab renders NOTHING extra —
 * the governor strip must never leak into the normal Agents view.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, deleteGoal, gitCwd, seedTeamLeadHeader } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard } from "./ui-helpers.js";
import { pollUntil } from "../test-utils/cleanup.js";

async function waitSetupReady(goalId: string): Promise<any> {
	return pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${goalId}`);
			if (r.status !== 200) return null;
			const g = await r.json();
			return g.setupStatus === "ready" ? g : null;
		},
		{ timeoutMs: 30_000, intervalMs: 200, label: `goal ${goalId} setup ready` },
	);
}

test.describe("SWARM-W1 governor strip — Agents tab", () => {
	test("run → render → reconcile → reload-persist", async ({ page, gateway }) => {
		const parent = await createGoal({ title: `Swarm strip ${Date.now()}`, cwd: gitCwd(), worktree: true, autoStartTeam: false, workflowId: "feature" });
		const parentId = parent.id as string;
		await waitSetupReady(parentId);

		const createResp = await apiFetch(`/api/goals/${parentId}/swarm/best-of-n`, {
			method: "POST",
			headers: seedTeamLeadHeader(gateway, parentId),
			body: JSON.stringify({
				spec: "Governor-strip browser E2E: implement the fix and add a regression test.",
				n: 2,
				tokenBudgetPerNode: 500_000,
				wallClockMsPerNode: 5 * 60_000,
				verifyCommand: "test -f WINNER_MARKER",
			}),
		});
		expect(createResp.status).toBe(201);
		const created = await createResp.json();
		const swarmGroup = created.swarmGroup as string;
		const [sib0Id, sib1Id] = created.siblingGoalIds as string[];

		try {
			const sib0 = await waitSetupReady(sib0Id);
			await waitSetupReady(sib1Id);
			writeFileSync(join(sib0.worktreePath, "WINNER_MARKER"), "winner\n");
			execFileSync("git", ["add", "."], { cwd: sib0.worktreePath, stdio: "pipe" });
			execFileSync("git", ["commit", "-m", "winning candidate"], { cwd: sib0.worktreePath, stdio: "pipe" });

			await apiFetch(`/api/goals/${sib0Id}?cascade=true&mergedManually=true`, { method: "DELETE" });
			await apiFetch(`/api/goals/${sib1Id}?cascade=true&mergedManually=true`, { method: "DELETE" });

			// ── RUN: open the dashboard, switch to the Agents tab ──
			await openApp(page);
			await navigateToGoalDashboard(page, parentId);
			await page.locator('[data-testid="tab-agents"]').click();

			const strip = page.locator(`.swarm-governor-strip[data-swarm-group="${swarmGroup}"]`);

			// ── RENDER: the strip appears once the barrier has fired, showing 2/2 terminal ──
			await expect(strip).toBeVisible({ timeout: 15_000 });
			await expect(strip.locator(".swarm-governor-count")).toHaveText("2/2 candidates terminal", { timeout: 10_000 });
			const verifyBtn = strip.locator("button", { hasText: "Run verifier" });
			await expect(verifyBtn).toBeVisible();

			// ── RECONCILE (verify): click Run verifier — the human/UI browser
			// session mints a confirmation token server-side; a Confirm button
			// appears once the pick is in.
			await verifyBtn.click();
			const confirmBtn = strip.locator("button", { hasText: "Confirm winner" });
			await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
			await expect(strip.locator(".swarm-governor-scores")).toContainText("picked", { timeout: 5_000 });

			// ── RECONCILE (confirm): click Confirm — REAL git merge happens server-side ──
			await confirmBtn.click();
			await expect(strip.locator(".swarm-governor-integrated")).toBeVisible({ timeout: 15_000 });
			await expect(strip.locator(".swarm-governor-integrated")).toContainText(sib0Id.slice(0, 8));

			// ── RELOAD-PERSIST: a fresh page load still shows the integrated state ──
			await page.reload();
			await navigateToGoalDashboard(page, parentId);
			await page.locator('[data-testid="tab-agents"]').click();
			const stripAfterReload = page.locator(`.swarm-governor-strip[data-swarm-group="${swarmGroup}"]`);
			await expect(stripAfterReload).toBeVisible({ timeout: 15_000 });
			await expect(stripAfterReload.locator(".swarm-governor-integrated")).toBeVisible({ timeout: 10_000 });
			await expect(stripAfterReload.locator(".swarm-governor-integrated")).toContainText(sib0Id.slice(0, 8));
		} finally {
			await deleteGoal(sib0Id).catch(() => {});
			await deleteGoal(sib1Id).catch(() => {});
			await deleteGoal(parentId).catch(() => {});
		}
	});

	test("a plain (non-swarm) goal's Agents tab renders no governor strip — zero leakage into the normal view", async ({ page }) => {
		const parent = await createGoal({ title: `Plain agents tab ${Date.now()}`, autoStartTeam: false });
		const parentId = parent.id as string;
		try {
			await openApp(page);
			await navigateToGoalDashboard(page, parentId);
			await page.locator('[data-testid="tab-agents"]').click();
			await expect(page.locator(".tab-empty")).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(".swarm-governor-strip")).toHaveCount(0);
		} finally {
			await deleteGoal(parentId).catch(() => {});
		}
	});
});
