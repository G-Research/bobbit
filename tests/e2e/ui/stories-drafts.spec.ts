/**
 * Draft Preservation stories — CT-02 (full coverage)
 *
 * These stories ARE the specification. Each test reads as a behavioral
 * requirement and runs as a Playwright E2E test.
 *
 * Phase annotations control what gets tracked in the spec graph:
 *   setup  → preconditions, incidental navigation (not tracked)
 *   act    → the user actions under test (tracked)
 *   assert → the expected outcomes (tracked)
 *   cleanup → teardown (not tracked)
 *
 * Migrated from stories-draft-preservation.spec.ts with 3 new gap stories:
 *   CT-02-e: goal-dashboard-detour
 *   CT-02-g: reconnect-after-disconnect
 */
import { test, expect } from "../gateway-harness.js";
import { waitForHealth, createGoal, deleteGoal, apiFetch } from "../e2e-setup.js";
import {
	SpecContext,
	defineStory,
} from "./spec-framework.js";
import { CT_02, CT_05, CT_13, CT_15 } from "./spec-contracts.js";
import { navigateToHash } from "./ui-helpers.js";

// ---------------------------------------------------------------
// Reproducing-test helpers (composer draft-loss regression).
//
// All assertions in the @repro stories below carry the stable marker
// "composer draft lost" so the reproducing-test gate can match a single,
// identifiable error_pattern against combined stdout+stderr instead of a
// generic Playwright locator failure.
// ---------------------------------------------------------------

/** Assert the composer currently shows exactly one attachment tile, polling
 *  until any async draft-restore settles. On buggy builds the tile is dropped
 *  whenever the <message-editor> instance is recreated, so the count stays 0
 *  and this fails with the "composer draft lost" marker after the timeout. */
async function expectAttachmentPresent(
	page: import("@playwright/test").Page,
	scenario: string,
): Promise<void> {
	await expect(
		page.locator("attachment-tile"),
		`composer draft lost: pasted image attachment missing after ${scenario}`,
	).toHaveCount(1, { timeout: 10_000 });
}

test.describe("CT-02: Draft preservation", () => {
	let s: SpecContext;

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.beforeEach(async ({ page, gateway }) => {
		s = new SpecContext(page, gateway);
		await s.createTestSession("A");
		await s.createTestSession("B");
		await s.open();
	});

	test.afterEach(async () => {
		await s.cleanup();
	});

	// ---------------------------------------------------------------
	// Stories
	// ---------------------------------------------------------------

	test("CT-02-a: Draft survives rapid session switching @smoke", async () => {
		s.begin(defineStory({
			id: "CT-02-a",
			title: "Draft survives rapid session switching",
			contracts: [CT_02],
			covers: ["rapid-session-switch"],
		}));

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act
		s.act();
		await s.type_in(s.editor, "my work in progress");
		await s.wait_for_draft_saved("A", "my work in progress");
		await s.navigate_to("session", "B");
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.contains_text("my work in progress");
		await s.editor.is_focused();
	});

	// ---------------------------------------------------------------
	// CT-02-b / CT-02-f / CT-02-h — composer draft-loss reproducers.
	// These are EXPECTED TO FAIL on the buggy build (reproducing-test gate);
	// they pass once attachment persistence + gen-seeding are implemented.
	// ---------------------------------------------------------------

	test("CT-02-b: Pasted image draft survives fast switch and reload @repro", async () => {
		s.begin(defineStory({
			id: "CT-02-b",
			title: "Pasted image draft survives fast switch and reload",
			contracts: [CT_02, CT_05],
			covers: ["attachment-added"],
		}));

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act — attach an image (mirrors a pasted screenshot: same attachments[] path)
		s.act();
		await s.attach_file("pasted-screenshot.png", "image");

		// (1) fast path: A → B → A. The cached <message-editor> instance survives,
		// so this sub-case can pass even on the buggy build — it is the control.
		await s.navigate_to("session", "B");
		await s.navigate_to("session", "A");

		// assert fast-path persistence
		s.assert();
		await expectAttachmentPresent(s.page, "fast switch A->B->A");

		// (3) page reload — the editor is recreated from scratch. On the buggy
		// build the attachment is gone (component-local only); after the fix it
		// is restored from the draft attachment store.
		s.act();
		await s.reload();
		await s.navigate_to("session", "A");

		s.assert();
		await expectAttachmentPresent(s.page, "page reload");
	});

	test("CT-02-f: Pasted image draft survives cache-evicted slow-path switch @repro", async () => {
		// Creating enough sessions to exceed SESSION_CACHE_MAX (10) is heavier
		// than the default 30s budget for one test.
		test.setTimeout(120_000);

		s.begin(defineStory({
			id: "CT-02-f",
			title: "Pasted image draft survives cache-evicted slow-path switch",
			contracts: [CT_02, CT_05],
			covers: ["attachment-added"],
		}));

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act — attach an image to session A
		s.act();
		await s.attach_file("evicted-screenshot.png", "image");

		// Visit 11 OTHER sessions so A is pushed out of the LRU sessionCache
		// (SESSION_CACHE_MAX = 10). Caching happens on switch-AWAY: leaving A
		// caches A, then leaving each Evict<i> caches it; the 11th cached entry
		// evicts the oldest (A). Returning to A then takes the slow path and
		// recreates the <message-editor> from scratch.
		const evictNames = Array.from({ length: 11 }, (_, i) => `Evict${i}`);
		await Promise.all(evictNames.map((name) => s.createTestSession(name)));
		for (const name of evictNames) {
			await s.navigate_to("session", name);
		}

		// (2) slow path: return to A (now evicted from cache)
		await s.navigate_to("session", "A");

		// assert slow-path persistence
		s.assert();
		await expectAttachmentPresent(s.page, "cache-evicted slow-path switch");
	});

	test("CT-02-h: Text survives gen-desync round-trips @repro", async () => {
		s.begin(defineStory({
			id: "CT-02-h",
			title: "Text survives gen-desync round-trips",
			contracts: [CT_02, CT_05],
			covers: ["rapid-session-switch"],
		}));

		const para1 = "paragraph one ALPHA";
		const para2 = "paragraph two BRAVO";
		const both = `${para1}\n${para2}`;
		const aId = s.session("A").sessionId;

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// Climb the server-side draft generation counter with a few debounced
		// saves in the FIRST visit. This is what accumulates as a user edits a
		// draft. It makes the bug deterministic: after returning to the session
		// the buggy client resets its _draftGen to 0, so EVERY save it then makes
		// (gen 1, gen 2, ...) is below the server's stored gen and is silently
		// discarded by the staleness guard — independent of the 100ms debounce
		// timing.
		s.act();
		await s.type_in(s.editor, "draft seed v1");
		await s.wait_for_draft_saved("A", "draft seed v1");
		await s.type_in(s.editor, "draft seed v2");
		await s.wait_for_draft_saved("A", "draft seed v2");
		await s.type_in(s.editor, para1);
		await s.wait_for_draft_saved("A", para1);

		// First round-trip (no send): switch away and back.
		await s.navigate_to("session", "B");
		await s.navigate_to("session", "A");
		await s.editor.contains_text(para1); // sanity: first paragraph restored

		// Append a second paragraph, then immediately switch away — all in one
		// synchronous step so the composer is never momentarily cleared (a
		// Playwright fill() clears first, whose empty-value input can trigger a
		// non-gen-guarded server delete and mask the bug). We set the full text
		// and dispatch a SINGLE input event, then change the hash in the same
		// tick. On the buggy build the resulting save(s) carry gen 1/2 < the
		// server's gen and are rejected; the later restore then clobbers the
		// editor with the stale server text, dropping para2 from both the editor
		// and the server draft.
		const bId = s.session("B").sessionId;
		await s.page.evaluate(({ text, bId }) => {
			const ta = document.querySelector("message-editor textarea") as HTMLTextAreaElement | null;
			if (!ta) throw new Error("composer textarea not found");
			ta.value = text;
			ta.dispatchEvent(new Event("input", { bubbles: true }));
			window.location.hash = `#/session/${bId}`;
		}, { text: both, bId });
		await s.page.waitForFunction((id) => window.location.hash.includes(id), bId, { timeout: 10_000 });
		await expect(s.page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		await s.navigate_to("session", "A");

		// assert — both paragraphs must survive the round-trips.
		s.assert();

		// (a) Deterministic server-state check: the freshly-appended paragraph
		// must have been persisted, not silently discarded by the gen guard.
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${aId}/draft?type=prompt`);
			expect(resp.status).toBe(200);
			const body = await resp.json() as { data?: { text?: string } };
			const text = body.data?.text ?? "";
			expect(
				text,
				"composer draft lost: paragraph one not persisted to server after gen-desync round-trip",
			).toContain(para1);
			expect(
				text,
				"composer draft lost: paragraph two not persisted to server after gen-desync round-trip",
			).toContain(para2);
		}).toPass({ intervals: [300, 500, 1000, 1000, 2000], timeout: 15_000 });

		// (b) The editor itself must show both paragraphs (the restore must not
		// have clobbered fresher local content). The async restore can briefly
		// leave the cached editor showing both paragraphs before overwriting it
		// with the stale server draft, so we only evaluate the paragraph-two
		// assertion once the editor has SETTLED to match the server's persisted
		// draft — this is event-driven (no fixed sleep) and avoids the transient.
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${aId}/draft?type=prompt`);
			expect(resp.status).toBe(200);
			const body = await resp.json() as { data?: { text?: string } };
			const serverText = body.data?.text ?? "";
			const editorValue = await s.page
				.locator("message-editor textarea").first().inputValue();
			// Gate: wait until the editor reflects the server draft (restore done).
			expect(editorValue, "composer draft: editor not yet settled to server draft").toBe(serverText);
			expect(
				editorValue,
				"composer draft lost: paragraph one missing from editor after gen-desync round-trip",
			).toContain(para1);
			expect(
				editorValue,
				"composer draft lost: paragraph two missing from editor after gen-desync round-trip",
			).toContain(para2);
		}).toPass({ intervals: [300, 500, 1000, 1000, 2000], timeout: 15_000 });
	});

	test("CT-02-c: Draft survives model change", async () => {
		s.begin(defineStory({
			id: "CT-02-c",
			title: "Draft survives model change",
			contracts: [CT_02, CT_15],
			covers: ["model-change"],
		}));

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act
		s.act();
		await s.type_in(s.editor, "important thought");
		await s.change_setting("model", "claude-opus");

		// assert
		s.assert();
		await s.editor.contains_text("important thought");
	});

	test("CT-02-d: Draft survives page reload @smoke", async () => {
		s.begin(defineStory({
			id: "CT-02-d",
			title: "Draft survives page reload",
			contracts: [CT_02, CT_05],
			covers: ["page-reload"],
		}));

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act
		s.act();
		await s.type_in(s.editor, "unsent draft");
		await s.wait_for_draft_saved("A", "unsent draft");
		await s.reload();
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.contains_text("unsent draft");
	});

	test("CT-02-e: Draft survives goal dashboard detour", async () => {
		let goalId: string | undefined;

		s.begin(defineStory({
			id: "CT-02-e",
			title: "Draft survives goal dashboard detour",
			contracts: [CT_02],
			covers: ["goal-dashboard-detour"],
		}));

		// setup
		const goal = await createGoal({ title: "Draft test goal" });
		goalId = goal.id;
		const goalHandle = s.goal("TestGoal");
		goalHandle.goalId = goalId;

		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act
		s.act();
		await s.type_in(s.editor, "dashboard detour draft");
		await s.wait_for_draft_saved("A", "dashboard detour draft");

		// Navigate to goal dashboard via hash — use direct navigation
		// because the dashboard container class varies across layouts
		await navigateToHash(s.page, `#/goal/${goalId}`);
		await s.page.waitForFunction(
			(id) => window.location.hash.includes(id!),
			goalId,
			{ timeout: 10_000 },
		);
		await expect(s.page.locator(".dashboard-container").first())
			.toBeVisible({ timeout: 15_000 });

		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.contains_text("dashboard detour draft");

		// cleanup
		if (goalId) await deleteGoal(goalId);
	});

	test("CT-02-g: Draft survives reconnect after disconnect", async () => {
		s.begin(defineStory({
			id: "CT-02-g",
			title: "Draft survives reconnect after disconnect",
			contracts: [CT_02, CT_05],
			covers: ["reconnect-after-disconnect"],
		}));

		// setup
		await s.navigate_to("session", "A");
		await s.session("A").in_state("active");

		// act
		s.act();
		await s.type_in(s.editor, "disconnect draft");
		await s.wait_for_draft_saved("A", "disconnect draft");

		// Force-close the WebSocket connection
		await s.event.disconnect();

		// Reload to reconnect
		await s.reload();
		await s.navigate_to("session", "A");

		// assert
		s.assert();
		await s.editor.contains_text("disconnect draft");
	});
});


