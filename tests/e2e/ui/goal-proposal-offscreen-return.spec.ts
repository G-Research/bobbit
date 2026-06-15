/**
 * Reproducer — FAILURE MODE B: a `propose_goal` raised while the user is
 * viewing a DIFFERENT session never appears when they return to the goal
 * assistant session.
 *
 * Root cause (docs/design/goal-proposal-panel-fix-analysis.md §2): an
 * off-screen proposal is dropped by the `activeSessionId()` guards in both the
 * unified `onProposal` and the legacy `onGoalProposal`, and the client goal
 * draft is never saved. On return, every rehydrate path repopulates the
 * unified slot ONLY (`state.activeProposals.goal.fields`) and never the legacy
 * form-mirror (`state.previewTitle` / `state.previewSpec`) that the
 * goal-ASSISTANT panel renders from. So the panel stays empty.
 *
 * This spec covers all three return paths the analysis calls out:
 *   (a) fast-path switch-back (cached chatPanel reuse → REST rehydrate),
 *   (b) slow-path fresh WS connect (cache wiped → WS-auth rehydrate broadcast),
 *   (c) reload directly into the session (boot connect + snapshot replay).
 *
 * Each asserts the user-visible contract: the goal-assistant title/spec inputs
 * are populated on return. They FAIL on the current HEAD (panel empty) and
 * PASS once the unified `onProposal` mirrors the merged goal fields into the
 * form-mirror (which also repairs the never-written client draft).
 *
 * Plus regression guards: a DISMISSED off-screen proposal must stay hidden on
 * return, and returning must never surface another session's proposal.
 *
 * Modeled on goal-proposal-dismiss-reload.spec.ts and
 * proposal-spec-survives-navigate.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, createSessionViaUI, navigateToHash } from "./ui-helpers.js";
import {
	apiFetch,
	connectWs,
	agentEndPredicate,
	readE2ETokenAsync,
	base,
	waitForHealth,
} from "../e2e-setup.js";

const GOAL_TITLE = "E2E Test Goal";
const GOAL_SPEC_TAIL = "It validates the goal creation UI.";

async function activeSessionId(page: Page): Promise<string> {
	const sid = await page.evaluate(
		() => (window as any).bobbitState?.selectedSessionId ?? null,
	);
	if (!sid) throw new Error("no active session id");
	return sid;
}

/** Open a fresh goal-assistant session via the "+ New Goal" button. */
async function openGoalAssistantSession(page: Page): Promise<string> {
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
	await newGoalBtn.click();
	await page.waitForURL(/#\/session\//, { timeout: 15_000 });
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	return activeSessionId(page);
}

/** Drive an OFF-SCREEN propose_goal on `sid` via a back-channel WS prompt. */
async function driveOffscreenProposal(sid: string): Promise<void> {
	const ws = await connectWs(sid);
	try {
		ws.send({ type: "prompt", text: "Please create a GOAL_PROPOSAL while I am away" });
		await ws.waitFor(agentEndPredicate(), 30_000);
	} finally {
		ws.close();
	}
}

/** Poll the server until the goal proposal file is parsed + available. */
async function waitForServerGoalProposal(sid: string): Promise<Record<string, unknown>> {
	let fields: Record<string, unknown> | null = null;
	await expect(async () => {
		const resp = await apiFetch(`/api/sessions/${sid}/proposals`);
		expect(resp.ok).toBe(true);
		const body = await resp.json() as { proposals?: Array<{ proposalType: string; fields: Record<string, unknown> }> };
		const goal = body.proposals?.find((p) => p.proposalType === "goal");
		expect(goal?.fields?.title, "server must have persisted the off-screen goal proposal").toBe(GOAL_TITLE);
		fields = goal!.fields;
	}).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });
	return fields!;
}

/**
 * Common setup: open S1 (goal assistant), switch to S2 (plain session), then
 * raise an off-screen propose_goal on S1 while focused on S2.
 * Returns { sidA, sidB }.
 */
async function setupOffscreen(page: Page): Promise<{ sidA: string; sidB: string }> {
	test.setTimeout(150_000);
	await openApp(page);

	// S1 — goal assistant.
	const sidA = await openGoalAssistantSession(page);

	// S2 — a plain session. This focuses S2 and caches S1.
	// createSessionViaUI only waits for the textarea, NOT for the client to
	// finish switching window.bobbitState.selectedSessionId to the new session.
	// Under full-suite parallel load, reading activeSessionId() immediately can
	// still observe sidA, making sidB === sidA → false negative. Wait until the
	// active session id actually changes away from sidA before reading it.
	await createSessionViaUI(page);
	await page.waitForFunction(
		(prev: string) => {
			const sid = (window as any).bobbitState?.selectedSessionId ?? null;
			return !!sid && sid !== prev;
		},
		sidA,
		{ timeout: 20_000, polling: 100 },
	);
	const sidB = await activeSessionId(page);
	expect(sidB, "S2 must be a different session").not.toBe(sidA);

	// Off-screen: drive S1's agent to emit propose_goal while we view S2.
	await driveOffscreenProposal(sidA);
	await waitForServerGoalProposal(sidA);

	// Cross-session leakage guard: the plain S2 must NOT show a goal panel.
	await expect(page.locator('[data-panel="goal-proposal"]')).toHaveCount(0);

	return { sidA, sidB };
}

/** Assert the goal-assistant panel is populated with the off-screen proposal. */
async function expectGoalPanelPopulated(page: Page): Promise<void> {
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 20_000 });
	await expect(titleInput).toHaveValue(GOAL_TITLE, { timeout: 15_000 });
	await expect(async () => {
		const spec = await page.evaluate(
			() => ((window as any).bobbitState?.previewSpec as string) ?? "",
		);
		expect(spec, "off-screen proposal spec must be restored on return").toContain(GOAL_SPEC_TAIL);
	}).toPass({ timeout: 15_000, intervals: [500, 1000, 2000] });
}

test.describe("Goal proposal off-screen return @repro", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("(a) fast-path switch-back surfaces the off-screen proposal", async ({ page }) => {
		const { sidA } = await setupOffscreen(page);

		// Fast path: S1 is cached → navigate back reuses the chat panel and
		// rehydrates via REST. CURRENTLY FAILS on master: panel stays empty.
		await navigateToHash(page, `#/session/${sidA}`);
		await page.waitForFunction(
			(sidArg: string) => (window as any).bobbitState?.selectedSessionId === sidArg,
			sidA,
			{ timeout: 15_000 },
		);
		await expectGoalPanelPopulated(page);
	});

	test("(b) slow-path fresh WS connect surfaces the off-screen proposal", async ({ page }) => {
		const { sidA } = await setupOffscreen(page);

		// Slow path: wipe the in-memory session cache by reloading to the
		// landing page, then connect to S1 fresh (cache miss → new WebSocket →
		// WS-auth rehydrate broadcast). CURRENTLY FAILS on master.
		await openApp(page);
		await navigateToHash(page, `#/session/${sidA}`);
		await page.waitForFunction(
			(sidArg: string) => (window as any).bobbitState?.selectedSessionId === sidArg,
			sidA,
			{ timeout: 20_000 },
		);
		await expectGoalPanelPopulated(page);
	});

	test("(c) reload directly into the session surfaces the off-screen proposal", async ({ page }) => {
		const { sidA } = await setupOffscreen(page);

		// Reload straight into S1 — boot connect + snapshot replay +
		// _processedProposalIds dedup path. CURRENTLY FAILS on master.
		const token = await readE2ETokenAsync();
		await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sidA}`);
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });
		await page.waitForFunction(
			(sidArg: string) => (window as any).bobbitState?.selectedSessionId === sidArg,
			sidA,
			{ timeout: 20_000 },
		);
		await expectGoalPanelPopulated(page);
	});

	// ── Finding 2 (Gap Analysis, HIGH) — fast-path switch-back stale-draft race.
	//
	// On fast-path switch-back, rehydrate (populates the unified slot + form-mirror)
	// and restoreGoalDraft (restores the client draft) fire with no ordering. For an
	// OFF-SCREEN proposal the client draft was never saved, so the on-disk draft has
	// NO activeGoalProposal: restoreGoalDraft's restore() then (a) DELETES the slot
	// rehydrate just populated and (b) blanks previewTitle/previewSpec from the empty
	// draft. Whichever of {rehydrate, restore} writes LAST wins — a genuine race.
	//
	// We make it DETERMINISTIC by force-ordering restore AFTER rehydrate: delay the
	// goal-draft GET so it resolves last. On the first-impl HEAD that means restore
	// is the final writer → slot deleted + form blank (FAILS). After the fix, the
	// fast path waits for BOTH then re-reconciles the slot into the form (and
	// restore() never deletes a current-session slot), so the proposal survives.
	test("(d) fast-path switch-back with a stale/empty client draft must not drop the proposal", async ({ page }) => {
		const { sidA } = await setupOffscreen(page);

		// Deterministically place an EMPTY goal draft (no activeGoalProposal) on
		// disk for S1 — the exact state an off-screen proposal leaves behind.
		const putResp = await apiFetch(`/api/sessions/${sidA}/draft`, {
			method: "PUT",
			body: JSON.stringify({
				type: "goal",
				data: {
					sessionId: sidA,
					activeGoalProposal: undefined,
					previewTitle: "",
					previewSpec: "",
					previewCwd: "",
					previewProjectId: "",
					previewTitleEdited: false,
					previewSpecEdited: false,
					previewCwdEdited: false,
					hasReceivedProposal: false,
					goalAssistantTab: "chat",
				},
			}),
		});
		expect(putResp.ok, "empty goal draft must be persisted for S1").toBe(true);

		// Force the goal-draft GET to be the LAST writer deterministically (no
		// inline sleep): hold the draft GET until the proposals GET (rehydrate)
		// has been fulfilled to the page. Single-threaded JS then guarantees the
		// rehydrate onProposal dispatch (slot + form-mirror) runs BEFORE
		// restoreGoalDraft processes the draft response. On the first-impl HEAD
		// restore's else-branch then deletes the slot + blanks the form (FAILS);
		// after the fix the slot survives and is re-reconciled.
		let resolveProposalsDelivered!: () => void;
		const proposalsDelivered = new Promise<void>((res) => { resolveProposalsDelivered = res; });
		await page.route(`**/api/sessions/${sidA}/proposals`, async (route) => {
			const resp = await route.fetch();
			await route.fulfill({ response: resp });
			resolveProposalsDelivered();
		});
		await page.route(`**/api/sessions/${sidA}/draft?type=goal`, async (route) => {
			if (route.request().method() === "GET") {
				await proposalsDelivered;
			}
			await route.continue();
		});

		// Fast path: S1 is cached → navigate back reuses the chat panel.
		await navigateToHash(page, `#/session/${sidA}`);
		await page.waitForFunction(
			(sidArg: string) => (window as any).bobbitState?.selectedSessionId === sidArg,
			sidA,
			{ timeout: 15_000 },
		);

		// The slot must survive the stale-draft restore, and the form-mirror must
		// be populated from it. CURRENTLY FAILS on HEAD: restore deletes the slot
		// and blanks the form.
		await expect(async () => {
			const slotTitle = await page.evaluate(
				() => ((window as any).bobbitState?.activeProposals?.goal?.fields?.title as string | undefined) ?? null,
			);
			expect(slotTitle, "the rehydrated slot must NOT be deleted by the stale-draft restore").toBe(GOAL_TITLE);
		}).toPass({ timeout: 15_000, intervals: [500, 1000, 2000] });
		await expectGoalPanelPopulated(page);
		await page.unroute(`**/api/sessions/${sidA}/draft?type=goal`);
		await page.unroute(`**/api/sessions/${sidA}/proposals`);
	});

	test("regression: a dismissed off-screen proposal stays hidden on return", async ({ page }) => {
		const { sidA } = await setupOffscreen(page);
		const fields = await waitForServerGoalProposal(sidA);

		// Pre-write the dismissal fingerprint for S1 exactly as production does
		// (proposal-helpers.ts: right-trim goal `spec`, sort keys, JSON.stringify).
		// This is what the user dismissing the proposal would have stored.
		await page.evaluate(
			({ sidArg, fieldsArg }: { sidArg: string; fieldsArg: Record<string, unknown> }) => {
				const norm: Record<string, unknown> = { ...fieldsArg };
				if (typeof norm.spec === "string") norm.spec = (norm.spec as string).replace(/\s+$/u, "");
				const ordered: Record<string, unknown> = {};
				for (const k of Object.keys(norm).sort()) ordered[k] = norm[k];
				localStorage.setItem(
					`bobbit-goal-proposal-dismissed-${sidArg}`,
					JSON.stringify(ordered),
				);
			},
			{ sidArg: sidA, fieldsArg: fields },
		);

		// Return to S1 (fast path). The dismissal short-circuit must keep the
		// proposal hidden — the fix must not weaken this guard.
		await navigateToHash(page, `#/session/${sidA}`);
		await page.waitForFunction(
			(sidArg: string) => (window as any).bobbitState?.selectedSessionId === sidArg,
			sidA,
			{ timeout: 15_000 },
		);

		// Give any async rehydrate a chance to (wrongly) populate the slot.
		await page
			.waitForFunction(
				() => !!(window as any).bobbitState?.activeProposals?.goal?.fields?.title,
				null,
				{ timeout: 4_000 },
			)
			.catch(() => { /* expected: stays empty */ });

		const slot = await page.evaluate(
			() => (window as any).bobbitState?.activeProposals?.goal ?? null,
		);
		expect(slot, "dismissed off-screen proposal must NOT repopulate the slot").toBeNull();

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		if (await titleInput.count()) {
			await expect(titleInput).not.toHaveValue(GOAL_TITLE, { timeout: 3_000 });
		}
	});
});
