/**
 * Phase 5b — tree cost rollup E2E.
 *
 * The Phase 6 server endpoint `GET /api/goals/:id/tree-cost` returns a
 * `breakdown[]` shaped sum across the descendant tree. This test verifies
 * that the dashboard:
 *  1. Calls the endpoint when a parent goal is loaded.
 *  2. Renders the "Tree cost" row (testid `tree-cost-row`).
 *  3. Click expands the per-child breakdown table (testid `tree-cost-breakdown`).
 *
 * The cost values themselves are zero in this fixture (no LLM ran), but the
 * row STILL renders for parent goals with children — the breakdown table
 * surfaces the structure even when totals are $0.00.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId, seedTeamLeadHeader } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

/**
 * Spawn a child via the ORCHESTRATION-class endpoint. spawn-child requires a
 * team-lead-matching X-Bobbit-Spawning-Session header (the cookie does NOT
 * bypass), so seed a team-lead on the parent and send the matching header.
 */
function spawnChild(gateway: any, parentId: string, body: Record<string, unknown>): Promise<Response> {
	return apiFetch(`/api/goals/${parentId}/spawn-child`, {
		method: "POST",
		headers: seedTeamLeadHeader(gateway, parentId),
		body: JSON.stringify(body),
	});
}

test.describe("Phase 5b — tree cost rollup", () => {
	test("parent dashboard renders Tree cost row + per-child breakdown", async ({ page, gateway }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Tree-cost parent", projectId, team: false });
		const r1 = await spawnChild(gateway, parent.id, { planId: "p1", title: "Tree-cost child 1", spec: "tree-cost UI test child 1: padded to meet spec validator minimum length." });
		const c1 = (await r1.json()).id as string;
		const r2 = await spawnChild(gateway, parent.id, { planId: "p2", title: "Tree-cost child 2", spec: "tree-cost UI test child 2: padded to meet spec validator minimum length." });
		const c2 = (await r2.json()).id as string;

		// Sanity: REST endpoint returns the structured rollup.
		const treeRes = await apiFetch(`/api/goals/${parent.id}/tree-cost`);
		expect(treeRes.status).toBe(200);
		const tree = await treeRes.json();
		expect(tree.rootGoalId).toBe(parent.id);
		expect(Array.isArray(tree.breakdown)).toBe(true);
		// Three goals in the tree: parent + 2 children.
		expect(tree.breakdown.length).toBeGreaterThanOrEqual(1);

		await openApp(page);
		await navigateToHash(page, `#/goal/${parent.id as string}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		// The tree-cost row should appear once the fetch completes (zero or non-zero
		// total). The render guard requires `breakdown.length > 1` OR `total > 0`;
		// our 3-goal tree exceeds the threshold.
		const treeCostRow = page.locator('[data-testid="tree-cost-row"]').first();
		await expect(treeCostRow).toBeVisible({ timeout: 10_000 });

		// Click toggle → breakdown table appears.
		const toggle = page.locator('[data-testid="tree-cost-toggle"]').first();
		await toggle.click();
		const breakdown = page.locator('[data-testid="tree-cost-breakdown"]').first();
		await expect(breakdown).toBeVisible({ timeout: 5_000 });

		// Expanded breakdown is wrapped in a scroll container with bounded
		// height + overflow:auto so long lists are reachable. Without this
		// the panel just grows indefinitely and rows below the fold are
		// inaccessible — the user-reported scroll bug.
		const scroll = page.locator('[data-testid="tree-cost-breakdown-scroll"]').first();
		await expect(scroll).toBeVisible();
		const overflowY = await scroll.evaluate((el) => getComputedStyle(el as HTMLElement).overflowY);
		expect(overflowY).toBe("auto");
		const maxHeightPx = await scroll.evaluate((el) => parseFloat(getComputedStyle(el as HTMLElement).maxHeight) || Infinity);
		expect(maxHeightPx).toBeLessThan(Infinity);

		// Cleanup.
		await apiFetch(`/api/goals/${parent.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
		// Avoid unused-var lint
		void c1; void c2;
	});

	test("Tree cost row stays visible when all children are archived", async ({ page, gateway }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Tree-cost archived-children parent", projectId, team: false });
		const r1 = await spawnChild(gateway, parent.id, { planId: "p1", title: "Tree-cost child 1", spec: "tree-cost archived-children UI test child 1: padded to meet validator length." });
		const c1 = (await r1.json()).id as string;
		const r2 = await spawnChild(gateway, parent.id, { planId: "p2", title: "Tree-cost child 2", spec: "tree-cost archived-children UI test child 2: padded to meet validator length." });
		const c2 = (await r2.json()).id as string;

		// Archive both children (they're leaves, so cascade=false is fine).
		const d1 = await apiFetch(`/api/goals/${c1}?cascade=false`, { method: "DELETE" });
		expect(d1.status).toBeLessThan(400);
		const d2 = await apiFetch(`/api/goals/${c2}?cascade=false`, { method: "DELETE" });
		expect(d2.status).toBeLessThan(400);

		// The server-side tree-cost rollup still walks archived descendants.
		const treeRes = await apiFetch(`/api/goals/${parent.id}/tree-cost`);
		expect(treeRes.status).toBe(200);
		const tree = await treeRes.json();
		expect(tree.breakdown.length).toBeGreaterThan(1);

		await openApp(page);
		await navigateToHash(page, `#/goal/${parent.id as string}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		// Row should still be visible despite all children being archived
		// and "See Archived" being OFF (default state).
		const treeCostRow = page.locator('[data-testid="tree-cost-row"]').first();
		await expect(treeCostRow).toBeVisible({ timeout: 10_000 });

		// Cleanup.
		await apiFetch(`/api/goals/${parent.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
	});

	// ───────────────────────────────────────────────────────────────────────
	// Subtree-rooted rollup — `/tree-cost` must aggregate from the requested
	// goal DOWNWARD, not from the topmost ancestor. Bug repro: opening any
	// descendant's dashboard previously showed the whole-tree rollup because
	// the handler resolved `rootGoalId = goal.rootGoalId ?? goal.id`.
	//
	// Server fix lives in `src/server/server.ts` (GET /api/goals/:id/tree-cost)
	// and is pinned at the unit level by `tests/api-goals-tree-cost.test.ts`.
	// This block pins the user-visible behaviour: the dashboard header value
	// (`data-testid="tree-cost-total"`) must reflect the requested subgoal's
	// subtree sum, not the project-wide grand total.
	// ───────────────────────────────────────────────────────────────────────
	test("dashboard tree-cost-total is rooted at the requested subgoal (parent / child / grandchild)", async ({ page, gateway }) => {
		const projectId = await defaultProjectId();
		if (!projectId) throw new Error("defaultProjectId() returned undefined");

		// Build a 3-deep chain: parent → child → grandchild.
		const parent = await createGoal({ title: "Tree-cost subtree parent", projectId, team: false });
		const rChild = await spawnChild(gateway, parent.id, { planId: "sub-c", title: "Tree-cost subtree child", spec: "tree-cost subtree-rooted E2E child: padded to meet spec validator minimum length." });
		expect(rChild.status).toBe(201);
		const childId = (await rChild.json()).id as string;
		const rGrand = await spawnChild(gateway, childId, { planId: "sub-g", title: "Tree-cost subtree grandchild", spec: "tree-cost subtree-rooted E2E grandchild: padded to meet spec validator minimum length." });
		expect(rGrand.status).toBe(201);
		const grandId = (await rGrand.json()).id as string;

		// Seed distinct, easy-to-read costs on each goal directly through the
		// cost tracker. Picked so each subtree total has a unique two-decimal
		// rendering AND every level is strictly less than its ancestor:
		//   grandchild only        =        0.05
		//   child + grandchild     = 0.20 + 0.05 = 0.25
		//   parent + child + grand = 0.50 + 0.20 + 0.05 = 0.75
		const costTracker = (gateway.sessionManager as any).getCostTracker(projectId);
		const seedRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		costTracker.recordUsage(`tc-seed-parent-${seedRunId}`, { cost: 0.50, inputTokens: 1_000, outputTokens: 500 }, parent.id);
		costTracker.recordUsage(`tc-seed-child-${seedRunId}`,  { cost: 0.20, inputTokens:   400, outputTokens: 200 }, childId);
		costTracker.recordUsage(`tc-seed-grand-${seedRunId}`,  { cost: 0.05, inputTokens:   100, outputTokens:  50 }, grandId);

		// ── REST sanity: endpoint must root the rollup at the requested goal ──
		async function fetchTree(goalId: string): Promise<{ rootGoalId: string; totalCostUsd: number; breakdown: Array<{ goalId: string }> }> {
			const r = await apiFetch(`/api/goals/${goalId}/tree-cost`);
			expect(r.status, `GET /tree-cost ${goalId}`).toBe(200);
			return r.json();
		}
		const parentTree = await fetchTree(parent.id);
		const childTree  = await fetchTree(childId);
		const grandTree  = await fetchTree(grandId);

		// rootGoalId must be the REQUESTED goal — not the topmost ancestor.
		expect(parentTree.rootGoalId).toBe(parent.id);
		expect(childTree.rootGoalId, "child request must root rollup at the child, not the parent").toBe(childId);
		expect(grandTree.rootGoalId, "grandchild request must root rollup at the grandchild, not an ancestor").toBe(grandId);

		// Subtree totals (within float-rounding tolerance).
		expect(parentTree.totalCostUsd).toBeCloseTo(0.75, 6);
		expect(childTree.totalCostUsd).toBeCloseTo(0.25, 6);
		expect(grandTree.totalCostUsd).toBeCloseTo(0.05, 6);

		// Strict ordering: each descendant's subtree total must be < its ancestor's.
		expect(childTree.totalCostUsd).toBeLessThan(parentTree.totalCostUsd);
		expect(grandTree.totalCostUsd).toBeLessThan(childTree.totalCostUsd);
		expect(grandTree.totalCostUsd).toBeLessThan(parentTree.totalCostUsd);

		// Breakdown shape: grandchild sees only itself; child sees itself + grand;
		// parent sees all three. Confirms `computeTreeCost` walked from the requested
		// goal downward rather than from the audit root.
		expect(grandTree.breakdown.map(b => b.goalId).sort()).toEqual([grandId].sort());
		expect(childTree.breakdown.map(b => b.goalId).sort()).toEqual([childId, grandId].sort());
		expect(parentTree.breakdown.map(b => b.goalId).sort()).toEqual([parent.id, childId, grandId].sort());
		// Negative containment — the requested goal's ancestor must NOT appear
		// in the breakdown. This is exactly the pre-fix bug shape.
		expect(childTree.breakdown.map(b => b.goalId)).not.toContain(parent.id);
		expect(grandTree.breakdown.map(b => b.goalId)).not.toContain(parent.id);
		expect(grandTree.breakdown.map(b => b.goalId)).not.toContain(childId);

		// ── Dashboard rendering: tree-cost-total must match the subtree sum ──
		await openApp(page);

		// The dashboard formats `totalCostUsd` with `toFixed(2)` (see
		// `renderTreeCostRow` in `src/app/goal-dashboard.ts`), so the rendered
		// text is the canonical two-decimal dollar amount. The dashboard reset
		// clears `treeCost = null` on goal switch and re-fetches async, so we
		// poll on the expected value rather than snapshot once — otherwise a
		// stale render between goal switches can produce a flaky read.
		async function assertTreeCostTotal(goalId: string, expected: string): Promise<string> {
			await navigateToHash(page, `#/goal/${goalId}`);
			await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });
			const total = page.locator('[data-testid="tree-cost-total"]').first();
			await expect(total).toBeVisible({ timeout: 10_000 });
			await expect(total).toHaveText(expected, { timeout: 10_000 });
			return (await total.textContent() ?? "").trim();
		}

		const parentText = await assertTreeCostTotal(parent.id, "$0.75");
		const childText  = await assertTreeCostTotal(childId,  "$0.25");
		const grandText  = await assertTreeCostTotal(grandId,  "$0.05");

		// Strict-less-than parsed against the rendered text — guards against a
		// regression where every descendant displays the parent's value.
		function parseUsd(s: string): number { return parseFloat(s.replace(/[^\d.]/g, "")); }
		expect(parseUsd(childText)).toBeLessThan(parseUsd(parentText));
		expect(parseUsd(grandText)).toBeLessThan(parseUsd(childText));
		expect(parseUsd(grandText)).toBeLessThan(parseUsd(parentText));

		// Cleanup.
		await apiFetch(`/api/goals/${parent.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
	});

	// ───────────────────────────────────────────────────────────────────────
	// Legacy-zero child row UX — pinned by design doc
	// `Design: transcript-pass cost backfill + legacy-zero UI`.
	//
	// When a child goal predates per-goal cost tracking AND its breakdown
	// entry is exactly zero AND the `unattributableLegacy` bucket is non-zero,
	// the dashboard must render that child row as muted+italic with a
	// `(legacy)` marker and a tooltip pointing the user at the residual
	// bucket. The bottom Unattributable (legacy) row itself must keep
	// rendering unchanged so the existing data-testid pin still holds.
	//
	// Production dependencies are implemented in this goal: server publishes
	// `unattributableLegacy.firstSeenAt`, and the dashboard applies
	// `isLegacyUnattributableTreeCostRow(...)` to per-child breakdown rows.
	// ───────────────────────────────────────────────────────────────────────
	test("legacy-zero child row renders muted italic with (legacy) marker; bottom bucket unchanged", async ({ page, gateway }) => {
		const projectId = await defaultProjectId();
		if (!projectId) throw new Error("defaultProjectId() returned undefined");

		// Parent + one child. The child will be backdated to predate the
		// sidecar-era threshold and intentionally left with zero spend.
		const parent = await createGoal({ title: "Tree-cost legacy-zero parent", projectId, team: false });
		const rChild = await spawnChild(gateway, parent.id, { planId: "legacy-c", title: "Tree-cost legacy child", spec: "tree-cost legacy-zero E2E child: padded to meet spec validator minimum length requirement." });
		expect(rChild.status).toBe(201);
		const childId = (await rChild.json()).id as string;

		// Backdate the child's createdAt well before any plausible sidecar
		// `firstSeenAt`. Goal-store `update()` deliberately excludes
		// `createdAt`, so reach for `put()` with a cloned-and-mutated record.
		const pcm = (gateway.sessionManager as { getProjectContextManager?: () => unknown }).getProjectContextManager?.() as {
			getOrCreate: (pid: string) => { goalStore: { get: (id: string) => unknown; put: (g: unknown) => void } };
		};
		const ctx = pcm.getOrCreate(projectId);
		const existing = ctx.goalStore.get(childId) as { createdAt: number } & Record<string, unknown> | undefined;
		if (!existing) throw new Error(`goalStore missing child ${childId}`);
		// Two years ago — predates per-goal cost tracking comfortably.
		const backdatedCreatedAt = Date.now() - 2 * 365 * 24 * 3600 * 1000;
		ctx.goalStore.put({ ...existing, createdAt: backdatedCreatedAt });

		// Seed an unattributable legacy cost — `recordUsage` without `goalId`
		// flows directly into `getUnattributableLegacyCost()`.
		const costTracker = (gateway.sessionManager as { getCostTracker: (pid: string) => { recordUsage: (sid: string, u: { cost: number; inputTokens: number; outputTokens: number }, goalId?: string) => void } }).getCostTracker(projectId);
		const seedRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		costTracker.recordUsage(`tc-legacy-orphan-${seedRunId}`, { cost: 1.23, inputTokens: 2_000, outputTokens: 1_000 });

		// REST sanity — endpoint must expose the residual bucket with a
		// `firstSeenAt` the UI can use as a threshold.
		const treeRes = await apiFetch(`/api/goals/${parent.id}/tree-cost`);
		expect(treeRes.status).toBe(200);
		const tree = await treeRes.json();
		expect(tree.unattributableLegacy, "non-empty unattributableLegacy bucket").toBeTruthy();
		expect(tree.unattributableLegacy.costUsd).toBeGreaterThan(0);
		expect(typeof tree.unattributableLegacy.firstSeenAt, "server must publish firstSeenAt for UI threshold").toBe("number");
		expect(tree.unattributableLegacy.firstSeenAt).toBeGreaterThan(backdatedCreatedAt);

		// Child must appear in breakdown with strict-zero cost/tokens — that
		// is the classification precondition for the (legacy) treatment.
		const childRow = tree.breakdown.find((b: { goalId: string }) => b.goalId === childId) as { costUsd: number; tokensIn: number; tokensOut: number } | undefined;
		expect(childRow, "child must appear in breakdown").toBeTruthy();
		expect(childRow!.costUsd).toBe(0);
		expect(childRow!.tokensIn).toBe(0);
		expect(childRow!.tokensOut).toBe(0);

		// ── UI ──
		await openApp(page);
		await navigateToHash(page, `#/goal/${parent.id as string}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		const toggle = page.locator('[data-testid="tree-cost-toggle"]').first();
		await toggle.click();
		const breakdown = page.locator('[data-testid="tree-cost-breakdown"]').first();
		await expect(breakdown).toBeVisible({ timeout: 5_000 });

		// Legacy child row — testid is preserved per design doc.
		const legacyRow = page.locator(`[data-testid="tree-cost-row-${childId}"]`).first();
		await expect(legacyRow).toBeVisible({ timeout: 5_000 });

		// Muted-italic styling. Implementation may apply italic to the row
		// or to any inner cell; assert at least one resolves to italic.
		const rowFontStyle = await legacyRow.evaluate((el) => getComputedStyle(el as HTMLElement).fontStyle);
		const cellFontStyle = await legacyRow.locator("td").first().evaluate((el) => getComputedStyle(el as HTMLElement).fontStyle);
		expect([rowFontStyle, cellFontStyle], "legacy-zero row must be italic somewhere").toContain("italic");

		// `(legacy)` marker appears in the row text (title or cost cell).
		const rowText = (await legacyRow.textContent() ?? "").toLowerCase();
		expect(rowText).toContain("(legacy)");

		// Tooltip points the user at the bottom bucket. The `title` attr
		// is acceptable on the row or any descendant cell.
		const tooltips = await legacyRow.evaluate((el) => {
			const self = (el as HTMLElement).getAttribute("title") ?? "";
			const children = Array.from((el as HTMLElement).querySelectorAll("[title]")).map(c => c.getAttribute("title") ?? "");
			return [self, ...children].filter(Boolean).join(" | ");
		});
		expect(tooltips.toLowerCase()).toContain("legacy");
		expect(tooltips.toLowerCase()).toMatch(/unattributable|bottom of this list|predates/);

		// The existing bottom Unattributable (legacy) row MUST still render
		// unchanged — its testid pin is the single source of truth for that
		// invariant and must not regress.
		const bottomBucket = page.locator('[data-testid="tree-cost-row-unattributable-legacy"]').first();
		await expect(bottomBucket).toBeVisible({ timeout: 5_000 });
		const bottomText = (await bottomBucket.textContent() ?? "");
		expect(bottomText.toLowerCase()).toContain("unattributable");
		expect(bottomText).toMatch(/\$\d/);

		// Cleanup.
		await apiFetch(`/api/goals/${parent.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
	});
});
