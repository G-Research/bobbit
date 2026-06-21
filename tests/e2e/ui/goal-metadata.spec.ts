/**
 * Goal-creation dialog — per-goal metadata key/value editor (browser E2E).
 *
 * Supersedes the removed per-goal worktree-setup controls (PR #816). Verifies:
 *  - the tabbed goal proposal panel exposes the key/value metadata editor on
 *    the dedicated Metadata tab (data-testid goal-proposal-tab-metadata /
 *    goal-proposal-panel-metadata plus goal-form-metadata and
 *    goal-metadata-{add,row,key,value});
 *  - manually-entered rows are forwarded to goal creation, JSON-parsed where
 *    possible, persist on the server-side goal, and survive a page reload;
 *  - an empty editor sends NO `metadata` override (backward-compatible goal);
 *  - the legacy per-goal worktree-setup controls are GONE;
 *  - a propose_goal-seeded proposal (mock trigger GOAL_PROPOSAL_METADATA)
 *    mirrors its `metadata` into the Metadata tab editor, retains edits across
 *    tab switches, and preserves the final rows through acceptance + reload.
 *
 * Mirrors tests/e2e/ui/goal-creation.spec.ts (assistant proposal flow + mock
 * agent). Persistence is asserted against the server-side goal via the API,
 * which is the durable record that survives a reload.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, sendMessage, createSessionViaUI } from "./ui-helpers.js";

const GOAL_TAB_TESTID = "[data-testid='goal-proposal-tab-goal']";
const GOAL_PANEL_TESTID = "[data-testid='goal-proposal-panel-goal']";
const METADATA_TAB_TESTID = "[data-testid='goal-proposal-tab-metadata']";
const METADATA_PANEL_TESTID = "[data-testid='goal-proposal-panel-metadata']";
const METADATA_TESTID = "[data-testid='goal-form-metadata']";
const ADD_TESTID = "[data-testid='goal-metadata-add']";
const ROW_TESTID = "[data-testid='goal-metadata-row']";
const KEY_TESTID = "[data-testid='goal-metadata-key']";
const VALUE_TESTID = "[data-testid='goal-metadata-value']";
const REMOVE_TESTID = "[data-testid='goal-metadata-remove']";

// Legacy per-goal worktree-setup controls that MUST be gone after PR #816 is
// superseded by the metadata + goalProvisioned lifecycle hook path.
const LEGACY_CMD_TESTID = "[data-testid='goal-form-worktree-setup-command']";
const LEGACY_TIMEOUT_TESTID = "[data-testid='goal-form-worktree-setup-timeout-ms']";

/**
 * Open the goal assistant, send `trigger`, and wait for the populated proposal
 * title input. Mirrors goal-creation.spec.ts's helper; `trigger` selects which
 * mock-agent propose_goal path fires.
 */
async function openGoalAssistant(page: import("@playwright/test").Page, trigger: string) {
	test.setTimeout(90_000);
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
	const sessionCreated = page.waitForResponse(
		(resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: 60_000 },
	);
	await newGoalBtn.click();
	await sessionCreated;
	await page.waitForURL(/#\/session\//, { timeout: 10_000 });
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 10_000 });
	await sendMessage(page, trigger);
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 10_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

async function openRegularSessionProposal(page: import("@playwright/test").Page, trigger: string) {
	test.setTimeout(90_000);
	await openApp(page);
	await createSessionViaUI(page);
	await sendMessage(page, trigger);
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 20_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

/** Re-fetch a goal by id (the durable server record). Returns undefined if
 *  the goal no longer exists. Using the id (not the shared "E2E Test Goal"
 *  title) keeps the assertions collision-free under parallel workers. */
async function findGoalById(goalId: string): Promise<any | undefined> {
	const resp = await apiFetch("/api/goals");
	const data = await resp.json();
	const goals = data.goals || data;
	return (goals as any[]).find((g) => g.id === goalId);
}

async function deleteGoal(goalId: string) {
	await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
}

/**
 * Click "Create Goal", await the POST /api/goals response, and return the
 * created goal's id parsed from the response body. The id is captured directly
 * from the create response — not matched by title — so parallel tests creating
 * goals with the same mock title never collide.
 */
async function clickCreate(page: import("@playwright/test").Page): Promise<string> {
	const createPromise = page.waitForResponse(
		(resp) => resp.url().includes("/api/goals") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: 15_000 },
	);
	await page.locator("button").filter({ hasText: "Create Goal" }).first().click();
	const resp = await createPromise;
	const goal = await resp.json();
	expect(goal?.id, "create response must carry the new goal id").toBeTruthy();
	await expect(page).toHaveURL(/#\/goal(-dashboard)?\//, { timeout: 15_000 });
	return goal.id as string;
}

async function openMetadataTab(page: import("@playwright/test").Page) {
	const tab = page.locator(METADATA_TAB_TESTID);
	await expect(tab).toBeVisible({ timeout: 10_000 });
	await expect(tab).toHaveAttribute("id", "goal-proposal-tab-metadata");
	await expect(tab).toHaveAttribute("aria-controls", "goal-proposal-panel-metadata");
	await tab.click();
	await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
	await expect(page.locator(METADATA_PANEL_TESTID)).toBeVisible({ timeout: 10_000 });
	await expect(page.locator(METADATA_PANEL_TESTID)).toHaveAttribute("id", "goal-proposal-panel-metadata");
	await expect(page.locator(METADATA_PANEL_TESTID)).toHaveAttribute("aria-labelledby", "goal-proposal-tab-metadata");
	await expect(page.locator(METADATA_TESTID).first()).toBeVisible({ timeout: 5_000 });
}

async function readMetadataRows(page: import("@playwright/test").Page): Promise<Record<string, string>> {
	const keyInputs = page.locator(KEY_TESTID);
	const valueInputs = page.locator(VALUE_TESTID);
	const rowCount = await keyInputs.count();
	const rows: Record<string, string> = {};
	for (let i = 0; i < rowCount; i++) {
		const key = await keyInputs.nth(i).inputValue();
		rows[key] = await valueInputs.nth(i).inputValue();
	}
	return rows;
}

async function metadataRowIndex(page: import("@playwright/test").Page, key: string): Promise<number> {
	const keyInputs = page.locator(KEY_TESTID);
	const rowCount = await keyInputs.count();
	for (let i = 0; i < rowCount; i++) {
		if ((await keyInputs.nth(i).inputValue()) === key) return i;
	}
	return -1;
}

/**
 * Append a metadata key/value pair via the editor. Adds a fresh row, then fills
 * the just-created (last) row's key + value inputs. Re-reads the row count
 * before/after the add so we don't depend on a fixed starting position.
 */
async function addMetadataRow(page: import("@playwright/test").Page, key: string, value: string) {
	const before = await page.locator(ROW_TESTID).count();
	await page.locator(ADD_TESTID).first().click();
	await expect(page.locator(ROW_TESTID)).toHaveCount(before + 1, { timeout: 5_000 });
	const idx = before; // newly-added row is last (0-based index == previous count)
	const keyInput = page.locator(KEY_TESTID).nth(idx);
	const valueInput = page.locator(VALUE_TESTID).nth(idx);
	await keyInput.fill(key);
	await expect(keyInput).toHaveValue(key);
	await valueInput.fill(value);
	await expect(valueInput).toHaveValue(value);
}

test.describe("Goal proposal — Metadata tab", () => {
	test("legacy worktree-setup controls are gone; metadata editor is present and empty by default", async ({ page }) => {
		await openGoalAssistant(page, "Please create a GOAL_PROPOSAL for testing");

		// Non-tabbed New Goal assistant behavior is preserved: the metadata editor
		// remains in the main form and starts empty.
		const editor = page.locator(METADATA_TESTID).first();
		await expect(editor).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(ROW_TESTID)).toHaveCount(0);
		await expect(page.locator(ADD_TESTID).first()).toBeVisible();

		// The PR #816 per-goal worktree-setup controls must no longer exist.
		await expect(page.locator(LEGACY_CMD_TESTID)).toHaveCount(0);
		await expect(page.locator(LEGACY_TIMEOUT_TESTID)).toHaveCount(0);
	});

	test("empty editor sends no metadata override", async ({ page }) => {
		await openGoalAssistant(page, "Please create a GOAL_PROPOSAL for testing");

		// Leave the editor untouched (empty) — create a backward-compatible goal.
		await expect(page.locator(METADATA_TESTID).first()).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(ROW_TESTID)).toHaveCount(0);

		const goalId = await clickCreate(page);

		const created = await findGoalById(goalId);
		expect(created).toBeTruthy();
		try {
			// No metadata field forwarded ⇒ goal record has no metadata.
			expect(created.metadata).toBeUndefined();
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("blank-key rows are dropped so they don't count as a metadata override", async ({ page }) => {
		await openGoalAssistant(page, "Please create a GOAL_PROPOSAL for testing");

		// Add a row but only fill the value, leaving the key blank. The submit
		// collapse drops blank-key rows, so the goal must carry NO metadata.
		await page.locator(ADD_TESTID).first().click();
		await expect(page.locator(ROW_TESTID)).toHaveCount(1, { timeout: 5_000 });
		await page.locator(VALUE_TESTID).first().fill("orphan-value");
		await expect(page.locator(VALUE_TESTID).first()).toHaveValue("orphan-value");

		const goalId = await clickCreate(page);

		const created = await findGoalById(goalId);
		expect(created).toBeTruthy();
		try {
			expect(created.metadata).toBeUndefined();
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("manually-entered metadata is forwarded, JSON-parsed, and persists across reload", async ({ page }) => {
		await openGoalAssistant(page, "Please create a GOAL_PROPOSAL for testing");
		await expect(page.locator(METADATA_TESTID).first()).toBeVisible({ timeout: 5_000 });

		// A plain text value stays a string; a JSON value parses into an array.
		await addMetadataRow(page, "experiment.flavor", "treatment");
		await addMetadataRow(page, "bobbit.disabledTools", '["browser_navigate"]');

		const goalId = await clickCreate(page);

		const created = await findGoalById(goalId);
		expect(created).toBeTruthy();
		try {
			expect(created.metadata).toBeTruthy();
			expect(created.metadata["experiment.flavor"]).toBe("treatment");
			expect(created.metadata["bobbit.disabledTools"]).toEqual(["browser_navigate"]);

			// Server-side persistence survives a full page reload.
			await page.reload();
			const reloaded = await findGoalById(goalId);
			expect(reloaded).toBeTruthy();
			expect(reloaded.metadata["experiment.flavor"]).toBe("treatment");
			expect(reloaded.metadata["bobbit.disabledTools"]).toEqual(["browser_navigate"]);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("removing a metadata row drops that entry from the created goal", async ({ page }) => {
		await openGoalAssistant(page, "Please create a GOAL_PROPOSAL for testing");
		await expect(page.locator(METADATA_TESTID).first()).toBeVisible({ timeout: 5_000 });

		await addMetadataRow(page, "keep.me", "yes");
		await addMetadataRow(page, "drop.me", "no");
		await expect(page.locator(ROW_TESTID)).toHaveCount(2);

		// Remove the second row (drop.me).
		await page.locator(REMOVE_TESTID).nth(1).click();
		await expect(page.locator(ROW_TESTID)).toHaveCount(1, { timeout: 5_000 });

		const goalId = await clickCreate(page);

		const created = await findGoalById(goalId);
		expect(created).toBeTruthy();
		try {
			expect(created.metadata).toBeTruthy();
			expect(created.metadata["keep.me"]).toBe("yes");
			expect(created.metadata["drop.me"]).toBeUndefined();
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("metadata-seeded proposal supports edit/add/remove, retains rows across tab switches, and persists", async ({ page }) => {
		await openRegularSessionProposal(page, "Please GOAL_PROPOSAL_METADATA now");

		// The tabbed proposal panel keeps metadata out of the Goal tab.
		await expect(page.locator(GOAL_PANEL_TESTID)).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(`${GOAL_PANEL_TESTID} ${METADATA_TESTID}`)).toHaveCount(0);
		await openMetadataTab(page);

		// The agent-seeded metadata must be mirrored into the Metadata tab rows.
		await expect(page.locator(ROW_TESTID)).toHaveCount(2, { timeout: 10_000 });
		let rows = await readMetadataRows(page);
		expect(rows["hindsight.memory.enabled"]).toBe("false");
		expect(rows["bobbit.disabledTools"]).toBe('["browser_navigate"]');

		// Edit one seeded row, add one new row, and remove the other seeded row.
		const memoryIndex = await metadataRowIndex(page, "hindsight.memory.enabled");
		expect(memoryIndex).toBeGreaterThanOrEqual(0);
		await page.locator(VALUE_TESTID).nth(memoryIndex).fill("true");
		await expect(page.locator(VALUE_TESTID).nth(memoryIndex)).toHaveValue("true");

		await addMetadataRow(page, "experiment.flavor", "treatment");

		const disabledToolsIndex = await metadataRowIndex(page, "bobbit.disabledTools");
		expect(disabledToolsIndex).toBeGreaterThanOrEqual(0);
		await page.locator(REMOVE_TESTID).nth(disabledToolsIndex).click();
		await expect(page.locator(ROW_TESTID)).toHaveCount(2, { timeout: 5_000 });

		// Switch away and back: metadata rows are draft state, not panel-local DOM state.
		await page.locator(GOAL_TAB_TESTID).click();
		await expect(page.locator(GOAL_PANEL_TESTID)).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(`${GOAL_PANEL_TESTID} ${METADATA_TESTID}`)).toHaveCount(0);
		await openMetadataTab(page);

		rows = await readMetadataRows(page);
		expect(rows["hindsight.memory.enabled"]).toBe("true");
		expect(rows["experiment.flavor"]).toBe("treatment");
		expect(rows["bobbit.disabledTools"]).toBeUndefined();

		const goalId = await clickCreate(page);

		const created = await findGoalById(goalId);
		expect(created).toBeTruthy();
		try {
			expect(created.metadata).toBeTruthy();
			expect(created.metadata["hindsight.memory.enabled"]).toBe(true);
			expect(created.metadata["experiment.flavor"]).toBe("treatment");
			expect(created.metadata["bobbit.disabledTools"]).toBeUndefined();

			await page.reload();
			const reloaded = await findGoalById(goalId);
			expect(reloaded).toBeTruthy();
			expect(reloaded.metadata["hindsight.memory.enabled"]).toBe(true);
			expect(reloaded.metadata["experiment.flavor"]).toBe("treatment");
			expect(reloaded.metadata["bobbit.disabledTools"]).toBeUndefined();
		} finally {
			await deleteGoal(goalId);
		}
	});
});
