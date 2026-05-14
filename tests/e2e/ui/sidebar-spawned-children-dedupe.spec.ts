/**
 * E2E for the spawned-children sidebar render path's defensive shaping.
 *
 * Reproduces the visible symptoms in the user's image #41:
 *  - Multiple subgoals with identical titles under the same parent.
 *  - Both must render (different ids = legitimate distinct goals).
 *  - Order must be deterministic across renders (createdAt asc, id asc).
 *  - The render must NOT inject duplicate rows for the same id.
 *
 * The original render path had no dedupe-by-id and no stable sort, so two
 * goals with the same title shuffled order on every render and any
 * accidental duplicate id produced two visible rows.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

async function deleteGoalQuiet(id: string): Promise<void> {
	try {
		await apiFetch(`/api/goals/${id}?cascade=true`, { method: "DELETE" });
	} catch { /* best-effort */ }
}

/**
 * Ensure a goal row is expanded in the sidebar.
 *
 * With subgoals enabled (the E2E harness default), child goal rows only render
 * when the parent's expansion chevron is open. Auto-expand fires for new goals
 * that have sessions, but the WS message ordering (goals vs sessions) is
 * non-deterministic, making the expansion timing-sensitive. This helper makes
 * the precondition explicit: wait for the parent row, then click-to-expand if
 * it's currently collapsed.
 */
async function ensureGoalExpanded(page: Page, goalId: string): Promise<void> {
	const row = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${goalId}"]`);
	await expect(row).toBeVisible({ timeout: 20_000 });
	// The chevron span has title="Expand goal" when collapsed.
	const expandChevron = row.locator('span[title="Expand goal"]');
	if (await expandChevron.isVisible({ timeout: 1_000 }).catch(() => false)) {
		// Click the goal's nav row to toggle expansion (the @click handler is on
		// the [data-nav-id="goal:<id>"] div inside sidebar-goal-row).
		await row.locator(`[data-nav-id="goal\\:${goalId}"]`).click();
	}
}

test.describe("sidebar spawned-children — dedupe + stable sort", () => {
	let parentId = "";
	let child1Id = "";
	let child2Id = "";

	test.beforeEach(async () => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Parent of duplicates", projectId, team: false });
		parentId = parent.id as string;
		// Two children with IDENTICAL titles — distinct ids. The renderer must
		// show both (not collapse them into one row).
		const r1 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({
				planId: "plan-dup-1",
				title: "AUDIT: SAME TITLE",
				spec: "E2E test child goal — first instance with distinct id for dedupe verification.",
			}),
		});
		expect(r1.status).toBe(201);
		child1Id = (await r1.json()).id as string;

		const r2 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({
				planId: "plan-dup-2",
				title: "AUDIT: SAME TITLE",
				spec: "E2E test child goal — second instance with distinct id for dedupe verification.",
			}),
		});
		expect(r2.status).toBe(201);
		child2Id = (await r2.json()).id as string;
	});

	test.afterEach(async () => {
		await deleteGoalQuiet(parentId);
	});

	test("two distinct children with identical titles BOTH render (not merged)", async ({ page }) => {
		await openApp(page);
		await ensureGoalExpanded(page, parentId);

		const child1Row = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${child1Id}"]`).first();
		const child2Row = page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${child2Id}"]`).first();

		// Both rows must exist — title-collision is NOT a cycle.
		await expect(child1Row).toBeVisible({ timeout: 15_000 });
		await expect(child2Row).toBeVisible({ timeout: 15_000 });

		// And no loop-placeholder should appear: these are distinct ids, not
		// a self-referencing cycle.
		const loopRows = page.locator(`[data-testid="sidebar-spawned-child-row-loop"]`);
		await expect(loopRows).toHaveCount(0);
	});

	test("rendered order is deterministic across reloads (stable sort)", async ({ page }) => {
		test.slow(); // Spawned child goals trigger team-lead setup; give extra headroom.
		await openApp(page);
		await ensureGoalExpanded(page, parentId);

		// Wait for both rows to be present before snapshotting order.
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${child1Id}"]`).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${child2Id}"]`).first()).toBeVisible({ timeout: 15_000 });

		const orderFromDom = async (): Promise<string[]> => {
			return await page.locator(`[data-testid="sidebar-nested-row"]`)
				.evaluateAll(els =>
					els
						.map(el => (el as HTMLElement).getAttribute("data-goal-id") || "")
						.filter(id => id),
				);
		};

		const first = await orderFromDom();
		// Reload and re-check: order must match. The pre-fix render path had
		// no stable sort, so two same-titled siblings shuffled on every render.
		await page.reload();
		// After reload the sidebar re-fetches goals. The parent may again be
		// collapsed (if WS sessions haven't arrived yet when auto-expand fires),
		// so explicitly expand it again before asserting on child rows.
		await ensureGoalExpanded(page, parentId);
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${child1Id}"]`).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${child2Id}"]`).first()).toBeVisible({ timeout: 15_000 });
		const second = await orderFromDom();

		expect(second).toEqual(first);

		// Both child ids are present in some deterministic order — we don't
		// assert which is first because back-to-back creates can produce
		// identical createdAt values, in which case the id-asc tiebreak
		// decides. Determinism is the invariant; specific ordering between
		// the two depends on the random uuids.
		expect(first).toContain(child1Id);
		expect(first).toContain(child2Id);
	});

	test("dedupe: a goal id appears at most once in the spawned-child rows", async ({ page }) => {
		test.slow(); // Spawned child goals trigger team-lead setup; give extra headroom.
		await openApp(page);
		await ensureGoalExpanded(page, parentId);
		await expect(page.locator(`[data-testid="sidebar-nested-row"][data-goal-id="${child1Id}"]`).first()).toBeVisible({ timeout: 15_000 });

		// Use toPass to retry the evaluateAll in case a concurrent WS-driven re-render
		// momentarily removes and re-inserts elements between the visibility check and
		// the DOM snapshot.
		await expect(async () => {
			const counts = await page.locator(`[data-testid="sidebar-nested-row"]`)
				.evaluateAll(els => {
					const m = new Map<string, number>();
					for (const el of els) {
						const id = (el as HTMLElement).getAttribute("data-goal-id") || "";
						m.set(id, (m.get(id) ?? 0) + 1);
					}
					return Object.fromEntries(m);
				});
			// Each spawned-child id appears exactly once.
			expect(counts[child1Id]).toBe(1);
			expect(counts[child2Id]).toBe(1);
		}).toPass({ timeout: 10_000 });
	});
});
