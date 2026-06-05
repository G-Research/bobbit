/**
 * Reproducer — FAILURE MODE A: goal-assistant proposal panel shows stale
 * content after a revision (a 2nd `propose_goal` or an `edit_proposal
 * type=goal`). The panel only flips to the newest content after the user
 * manually clicks "Open proposal".
 *
 * Root cause (docs/design/goal-proposal-panel-fix-analysis.md §0/§1): the
 * goal-ASSISTANT panel (`goalPreviewPanel`) renders from the legacy
 * form-mirror state `state.previewTitle` / `state.previewSpec`, which is
 * written ONLY by the legacy `onGoalProposal` callback. The unified
 * `onProposal` path — the sole consumer of `proposal_update {source:"edit"}`
 * frames and of rehydrate — updates `state.activeProposals.goal.fields` but
 * never the form-mirror. So:
 *
 *   - `edit_proposal type=goal` is not a `propose_*` tool, so the legacy
 *     callback never fires → only the unified slot updates → the assistant
 *     panel keeps showing the pre-edit spec. DETERMINISTIC.
 *   - On reload, the WS-auth rehydrate broadcast repopulates the unified slot
 *     only; `restoreGoalDraft` restores the stale client draft (the edit was
 *     never persisted to it), so the panel reverts to pre-edit content.
 *
 * These tests assert the user-visible contract: a revision auto-updates the
 * goal-assistant panel IN PLACE with no "Open proposal" click. They FAIL on
 * the current HEAD (panel shows stale content) and PASS once the unified
 * `onProposal` mirrors the merged goal fields into the form-mirror.
 *
 * Modeled on goal-proposal-dismiss-reload.spec.ts and proposal-edit-flow.spec.ts.
 * Mock-agent triggers: GOAL_PROPOSAL (initial), GOAL_PROPOSAL_REV2 (2nd
 * propose_goal), GOAL_EDITABLE_EDIT (edit_proposal type=goal).
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, sendMessage } from "./ui-helpers.js";

const INITIAL_SPEC_TAIL = "It validates the goal creation UI.";
const INITIAL_SPEC_HEAD = "This is a test goal created via the assistant flow.";
const REV2_SPEC_BODY = "Revised body for revision two.";
const EDITED_SPEC_BODY = "EDITED SPEC BODY for Mode A repro.";

async function activeSessionId(page: Page): Promise<string> {
	const sid = await page.evaluate(
		() => (window as any).bobbitState?.selectedSessionId ?? null,
	);
	if (!sid) throw new Error("no active session id");
	return sid;
}

/**
 * The goal-assistant spec is rendered from `state.previewSpec` (the form-mirror)
 * into `<commentable-markdown>.markdown`. Reading `state.previewSpec` is the
 * deterministic form-mirror signal; the rendered markdown is the user-visible
 * surface. We assert both.
 */
async function previewSpec(page: Page): Promise<string> {
	return page.evaluate(
		() => ((window as any).bobbitState?.previewSpec as string) ?? "",
	);
}
async function renderedSpecMarkdown(page: Page): Promise<string> {
	return page.evaluate(() => {
		const cm = document.querySelector("commentable-markdown") as any;
		return (cm?.markdown as string) ?? "";
	});
}
async function slotSpec(page: Page): Promise<string> {
	return page.evaluate(
		() => ((window as any).bobbitState?.activeProposals?.goal?.fields?.spec as string) ?? "",
	);
}

/** Open a goal-assistant session and drive the initial GOAL_PROPOSAL. */
async function openGoalAssistant(page: Page): Promise<string> {
	test.setTimeout(120_000);
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
	await newGoalBtn.click();

	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 30_000 });

	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 20_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

	// The initial spec must be live in the form-mirror before we revise.
	await expect(async () => {
		expect(await previewSpec(page)).toContain(INITIAL_SPEC_TAIL);
	}).toPass({ timeout: 15_000, intervals: [250, 500, 1000] });

	return activeSessionId(page);
}

test.describe("Goal proposal revision auto-update @repro", () => {
	test("2nd propose_goal + edit_proposal auto-update the panel in place (no Open-proposal click)", async ({ page }) => {
		await openGoalAssistant(page);
		const titleInput = page.locator("input[placeholder='Goal title']").first();

		// ── 2nd propose_goal (a full revision with a different title/spec) ──
		await sendMessage(page, "Now revise it: GOAL_PROPOSAL_REV2");

		// Slot reflects the revision (unified path — works on master).
		await page.waitForFunction(
			() => (window as any).bobbitState?.activeProposals?.goal?.fields?.title === "Revised Goal Title",
			null,
			{ timeout: 20_000 },
		);

		// User-visible: the assistant panel auto-updates WITHOUT an "Open
		// proposal" click — title flips and the spec preview shows the new body.
		await expect(titleInput).toHaveValue("Revised Goal Title", { timeout: 15_000 });
		await expect(async () => {
			expect(await previewSpec(page)).toContain(REV2_SPEC_BODY);
			expect(await renderedSpecMarkdown(page)).toContain(REV2_SPEC_BODY);
		}).toPass({ timeout: 15_000, intervals: [250, 500, 1000] });

		// ── edit_proposal type=goal (surgical revision; the deterministic
		//    Mode-A repro). Not a propose_* tool, so the legacy callback never
		//    fires; only the unified proposal_update{edit} path runs. ──
		await sendMessage(page, "Apply GOAL_EDITABLE_EDIT to the spec");

		// Confirm the edit really applied via the unified slot (proves the
		// server edit landed; this part works on master too).
		await page.waitForFunction(
			(needle: string) =>
				((window as any).bobbitState?.activeProposals?.goal?.fields?.spec as string | undefined)?.includes(needle) ?? false,
			EDITED_SPEC_BODY,
			{ timeout: 20_000 },
		);
		expect(await slotSpec(page)).toContain(EDITED_SPEC_BODY);

		// The assistant panel MUST reflect the edit with NO manual click.
		// CURRENTLY FAILS on master: previewSpec/rendered markdown still show
		// the pre-edit content because the unified edit path never writes the
		// form-mirror.
		await expect(async () => {
			const spec = await previewSpec(page);
			const rendered = await renderedSpecMarkdown(page);
			expect(spec, "previewSpec must show the edited body").toContain(EDITED_SPEC_BODY);
			expect(rendered, "rendered spec must show the edited body").toContain(EDITED_SPEC_BODY);
			// The replaced sentence must be gone from the live panel.
			expect(spec, "previewSpec must not retain the replaced sentence").not.toContain(INITIAL_SPEC_TAIL);
		}).toPass({ timeout: 12_000, intervals: [250, 500, 1000] });

		// Negative: the live current-proposal tab must never show a superseded
		// revision (the original first-proposal spec head is gone for good).
		expect(await previewSpec(page)).not.toContain(INITIAL_SPEC_HEAD);
		await expect(titleInput).toHaveValue("Revised Goal Title");
	});

	test("edited goal spec persists across reload (rehydrate restores newest content)", async ({ page }) => {
		const sid = await openGoalAssistant(page);

		// Edit the (initial) proposal spec via edit_proposal type=goal.
		await sendMessage(page, "Apply GOAL_EDITABLE_EDIT to the spec");

		// The edit landed in the unified slot (works on master).
		await page.waitForFunction(
			(needle: string) =>
				((window as any).bobbitState?.activeProposals?.goal?.fields?.spec as string | undefined)?.includes(needle) ?? false,
			EDITED_SPEC_BODY,
			{ timeout: 20_000 },
		);

		// Reload — boots straight back into the goal-assistant session, taking
		// the WS-auth rehydrate broadcast + snapshot-replay path. On master the
		// form-mirror is restored from the stale client draft (the edit was
		// never persisted to it) → the panel reverts to pre-edit content.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });
		await page.waitForFunction(
			(sidArg: string) => (window as any).bobbitState?.selectedSessionId === sidArg,
			sid,
			{ timeout: 20_000 },
		);

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 15_000 });

		// CURRENTLY FAILS on master: the spec reverts to the pre-edit body.
		await expect(async () => {
			const spec = await previewSpec(page);
			expect(spec, "previewSpec after reload must show the edited body").toContain(EDITED_SPEC_BODY);
			expect(spec, "previewSpec after reload must not retain the replaced sentence").not.toContain(INITIAL_SPEC_TAIL);
		}).toPass({ timeout: 15_000, intervals: [500, 1000, 2000] });
		await expect(titleInput).toHaveValue("E2E Test Goal");
	});
});
