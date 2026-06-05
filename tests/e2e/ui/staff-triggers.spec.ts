/**
 * Staff trigger editor — goal_created / goal_archived browser E2E.
 *
 * Pins the UI surface for the goal lifecycle trigger types in the staff edit
 * page (design: goal lifecycle staff triggers — Task B):
 *   - Trigger type dropdown lists goal_created and goal_archived.
 *   - For goal-* triggers the prompt label flips to "Wake prompt (required)"
 *     and an inline error renders when the prompt is empty.
 *   - The Save button is disabled while any goal-* trigger has an empty prompt.
 *   - Once a prompt is filled in, save round-trips through PUT /api/staff/:id
 *     and the trigger persists across a hard page reload.
 *
 * Failure pattern: STAFF_GOAL_TRIGGER_BROWSER_<thing>.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch, defaultProject } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

type StaffRecord = {
	id: string;
	name: string;
	currentSessionId?: string | null;
	triggers?: Array<{ type: string; prompt?: string; enabled?: boolean; config?: Record<string, unknown> }>;
};

const PROMPT_TEXT = "Investigate the freshly created goal and brief the team.";

function triggerSelect(page: Page) {
	// The trigger editor renders one <select> per trigger card inside the
	// staff edit form; we only ever add a single trigger in this test so the
	// first match is the right one.
	return page.locator('[data-testid="trigger-type-select"]').filter({ hasText: "Goal created" }).first();
}

function triggerPromptTextarea(page: Page) {
	return page.locator('[data-testid="trigger-prompt-0"]').first();
}

function saveButton(page: Page) {
	return page.getByRole("button", { name: "Save Changes" });
}

async function createStaff(name: string): Promise<StaffRecord> {
	const project = await defaultProject();
	const resp = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name,
			description: "Goal trigger editor browser fixture.",
			systemPrompt: "Persist goal_created/goal_archived trigger types.",
			cwd: project.rootPath,
			projectId: project.id,
			worktree: false,
			sandboxed: false,
		}),
	});
	expect(
		resp.status,
		`STAFF_GOAL_TRIGGER_BROWSER_CREATE: staff create failed: ${await resp.clone().text().catch(() => "")}`,
	).toBe(201);
	return await resp.json() as StaffRecord;
}

async function readStaff(id: string): Promise<StaffRecord> {
	const res = await apiFetch(`/api/staff/${id}`);
	expect(res.ok, `STAFF_GOAL_TRIGGER_BROWSER_READ: GET /api/staff/${id} should succeed`).toBe(true);
	return await res.json() as StaffRecord;
}

test.describe("Staff goal lifecycle trigger editor", () => {
	let staff: StaffRecord | undefined;
	const sessionsToDelete = new Set<string>();

	test.afterAll(async () => {
		if (staff?.id) {
			await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" }).catch(() => {});
		}
		for (const sessionId of sessionsToDelete) {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("goal_created trigger requires non-empty prompt, persists across reload", async ({ page }) => {
		staff = await createStaff(`StaffGoalTrig${Date.now().toString(36)}`);
		if (staff.currentSessionId) sessionsToDelete.add(staff.currentSessionId);

		await openApp(page);
		await navigateToHash(page, `#/staff/${staff.id}`);
		await expect(
			page.getByRole("heading", { name: staff.name }),
			"STAFF_GOAL_TRIGGER_BROWSER_HEADER: staff edit header should render",
		).toBeVisible({ timeout: 15_000 });

		// Add a trigger via the "+ Add trigger" button.
		await page.getByRole("button", { name: "+ Add trigger" }).click();

		// New trigger defaults to schedule — switch to goal_created.
		const select = page.locator('[data-testid="trigger-type-select"]').first();
		await expect(
			select,
			"STAFF_GOAL_TRIGGER_BROWSER_SELECT_VISIBLE: trigger type select should render",
		).toBeVisible({ timeout: 5_000 });

		// The dropdown must offer goal_created/goal_archived options.
		const optionValues = await select.locator("option").evaluateAll(
			(els) => (els as HTMLOptionElement[]).map((o) => o.value),
		);
		expect(
			optionValues,
			"STAFF_GOAL_TRIGGER_BROWSER_OPTIONS: dropdown should list both goal lifecycle trigger types",
		).toEqual(expect.arrayContaining(["schedule", "git", "manual", "goal_created", "goal_archived"]));

		await select.selectOption("goal_created");

		// Reading the value back proves the controlled select committed the change.
		await expect
			.poll(
				async () => await select.evaluate((el) => (el as HTMLSelectElement).value),
				{
					timeout: 5_000,
					message: "STAFF_GOAL_TRIGGER_BROWSER_SELECT_VALUE: select should reflect goal_created after change",
				},
			)
			.toBe("goal_created");

		// The prompt textarea must be labelled "Wake prompt (required)" and show the inline error.
		await expect(
			page.getByText("Wake prompt (required)").first(),
			"STAFF_GOAL_TRIGGER_BROWSER_REQUIRED_LABEL: required-prompt label should render for goal_created",
		).toBeVisible({ timeout: 5_000 });
		await expect(
			page.locator('[data-testid="trigger-prompt-error-0"]'),
			"STAFF_GOAL_TRIGGER_BROWSER_INLINE_ERROR: inline error should render while prompt is empty",
		).toBeVisible({ timeout: 5_000 });

		// Save button must be disabled while the prompt is empty.
		await expect(
			saveButton(page),
			"STAFF_GOAL_TRIGGER_BROWSER_SAVE_DISABLED: save should be disabled while a goal-* trigger has no prompt",
		).toBeDisabled({ timeout: 5_000 });

		// Fill in the prompt; the inline error should disappear and Save should enable.
		const textarea = triggerPromptTextarea(page);
		await textarea.fill(PROMPT_TEXT);
		await expect(
			page.locator('[data-testid="trigger-prompt-error-0"]'),
			"STAFF_GOAL_TRIGGER_BROWSER_ERROR_CLEARED: inline error should clear once prompt is populated",
		).toHaveCount(0, { timeout: 5_000 });
		await expect(
			saveButton(page),
			"STAFF_GOAL_TRIGGER_BROWSER_SAVE_ENABLED: save should re-enable once prompt is populated",
		).toBeEnabled({ timeout: 5_000 });

		// Save: capture the PUT payload to confirm the UI submits the new trigger type and prompt.
		const updateResponse = page.waitForResponse((resp) =>
			resp.request().method() === "PUT" && resp.url().includes(`/api/staff/${staff!.id}`),
		);
		await saveButton(page).click();
		const updateResp = await updateResponse;
		expect(
			updateResp.ok(),
			`STAFF_GOAL_TRIGGER_BROWSER_PUT_OK: PUT /api/staff/${staff.id} should succeed: ${updateResp.status()} ${await updateResp.text().catch(() => "")}`,
		).toBe(true);
		const payload = updateResp.request().postDataJSON() as { triggers?: Array<{ type?: string; prompt?: string }> };
		const submittedTriggers = payload.triggers || [];
		expect(
			submittedTriggers,
			"STAFF_GOAL_TRIGGER_BROWSER_PUT_PAYLOAD: PUT payload should include the new trigger",
		).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "goal_created", prompt: PROMPT_TEXT }),
		]));

		// Confirm the server persisted the trigger.
		const persisted = await readStaff(staff.id);
		const persistedGoalTrigger = (persisted.triggers || []).find((t) => t.type === "goal_created");
		expect(
			persistedGoalTrigger,
			"STAFF_GOAL_TRIGGER_BROWSER_SERVER_PERSISTED: server should persist a goal_created trigger",
		).toBeDefined();
		expect(
			persistedGoalTrigger?.prompt,
			"STAFF_GOAL_TRIGGER_BROWSER_SERVER_PROMPT: persisted trigger should carry the wake prompt",
		).toBe(PROMPT_TEXT);

		// Hard reload — the trigger should round-trip into the editor with its prompt intact.
		await page.reload();
		await navigateToHash(page, `#/staff/${staff.id}`);
		await expect(page.getByRole("heading", { name: staff.name })).toBeVisible({ timeout: 15_000 });

		const reloadedSelect = triggerSelect(page);
		await expect(
			reloadedSelect,
			"STAFF_GOAL_TRIGGER_BROWSER_RELOAD_SELECT: dropdown should re-show goal_created on reload",
		).toBeVisible({ timeout: 10_000 });
		await expect
			.poll(
				async () => await reloadedSelect.evaluate((el) => (el as HTMLSelectElement).value),
				{
					timeout: 10_000,
					message: "STAFF_GOAL_TRIGGER_BROWSER_RELOAD_VALUE: select value should round-trip as goal_created",
				},
			)
			.toBe("goal_created");
		await expect
			.poll(
				async () => await triggerPromptTextarea(page).inputValue(),
				{
					timeout: 10_000,
					message: "STAFF_GOAL_TRIGGER_BROWSER_RELOAD_PROMPT: prompt should round-trip across reload",
				},
			)
			.toBe(PROMPT_TEXT);
		await expect(
			page.locator('[data-testid="trigger-prompt-error-0"]'),
			"STAFF_GOAL_TRIGGER_BROWSER_RELOAD_NO_ERROR: inline error should not appear when prompt persisted",
		).toHaveCount(0);
	});
});
