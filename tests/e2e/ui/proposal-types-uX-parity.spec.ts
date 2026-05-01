/**
 * E2E — Per-type UX parity matrix for editable proposals.
 *
 * Spec: docs/design/editable-proposals.md §8 (UX-preservation matrix).
 * Goal-proposal UX is the reference; after the unification refactor every
 * behaviour must work identically across all six proposal types
 * (goal, project, workflow, role, tool, staff).
 *
 * Per type this spec asserts:
 *   1. Dismissal stickiness — emit → dismiss → reload → still dismissed.
 *   2. "Open proposal" reopens cleanly and clears the dismissal.
 *   3. First-emit auto-select — the right tab/panel is selected on first
 *      arrival (goal/project → previewPanelActiveTab; role/tool/staff/workflow
 *      → assistantTab="preview").
 *   4. Streaming partial does NOT clobber prior structured fields
 *      (regression test for Bug C in the project staleness debug entry,
 *      generalised to all types).
 *   5. Restart survival — the on-disk proposal file rehydrates the panel
 *      after a simulated reconnect.
 *
 * NOTE — Slice F is authored against the spec; runtime correctness depends on
 * Slices B+C+D+E. Each parametrised case is currently `test.fixme()` with a
 * TODO. Remove the fixmes once Slice E lands AND the mock agent grows the
 * per-type triggers documented at the bottom of this file.
 *
 * Reference patterns:
 *   - tests/e2e/ui/mid-session-project-proposal.spec.ts (project parity)
 *   - tests/e2e/ui/proposal-tools.spec.ts (Open proposal button)
 *   - tests/goal-proposal-dismiss.spec.ts (dismiss stickiness)
 *   - tests/e2e/ui/proposal-panel-streaming.spec.ts (streaming partials)
 */
import { test, expect, type GatewayInfo } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

type ProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";

interface TypeFixture {
	type: ProposalType;
	/** Mock-agent prompt that triggers a `propose_<type>` tool call. */
	emitPrompt: string;
	/** Mock-agent prompt that triggers a streaming partial-edit
	 *  (`edit_proposal type=<type> old_text=… new_text=…`). Used by case 4. */
	streamingEditPrompt: string;
	/** Locator for an element that proves the panel is open and populated. */
	panelLocator: (page: Page) => ReturnType<Page["locator"]>;
	/** A short text snippet the panel must contain after the initial emit. */
	expectedInitialText: string;
	/** A text snippet that must replace `expectedInitialText` after the
	 *  streaming partial in case 4 — proves shallow-merge preserved prior
	 *  structured fields (the partial only touched one scalar). */
	expectedStreamingEditText: string;
	/** First-emit auto-select destination. For goal/project the unified preview
	 *  panel switches `previewPanelActiveTab`. For role/tool/staff/workflow
	 *  the assistant flow flips `assistantTab` to "preview" (see §8 row
	 *  "First-proposal auto-select"). */
	autoSelectAssertion: (page: Page) => Promise<void>;
}

/** Read `window.bobbitState` slice — a thin diagnostic hook published by
 *  src/app/state.ts on `window`. Used to assert auto-select side-effects
 *  without coupling to the bespoke per-type DOM. */
async function readState<T>(page: Page, key: string): Promise<T | undefined> {
	return page.evaluate((k) => {
		const s = (window as any).bobbitState;
		return s ? s[k] : undefined;
	}, key) as Promise<T | undefined>;
}

const FIXTURES: TypeFixture[] = [
	{
		type: "goal",
		emitPrompt: "GOAL_PROPOSAL_PARITY",
		streamingEditPrompt: "GOAL_PROPOSAL_PARITY_EDIT",
		panelLocator: (page) =>
			page.locator("input[placeholder='Goal title']").first(),
		expectedInitialText: "Parity Goal A",
		expectedStreamingEditText: "Parity Goal A — edited",
		autoSelectAssertion: async (page) => {
			const tab = await readState<string>(page, "previewPanelActiveTab");
			expect(tab).toBe("goal");
		},
	},
	{
		type: "project",
		emitPrompt: "PROJECT_PROPOSAL_PARITY",
		streamingEditPrompt: "PROJECT_PROPOSAL_PARITY_EDIT",
		panelLocator: (page) =>
			page.locator('[data-panel="project-proposal"]').first(),
		expectedInitialText: "echo parity",
		expectedStreamingEditText: "echo parity-edited",
		autoSelectAssertion: async (page) => {
			const tab = await readState<string>(page, "previewPanelActiveTab");
			expect(tab).toBe("project");
		},
	},
	{
		type: "workflow",
		emitPrompt: "WORKFLOW_PROPOSAL_PARITY",
		streamingEditPrompt: "WORKFLOW_PROPOSAL_PARITY_EDIT",
		panelLocator: (page) =>
			page.locator('[data-panel="workflow-proposal"]').first(),
		expectedInitialText: "parity-workflow",
		expectedStreamingEditText: "parity-workflow-edited",
		autoSelectAssertion: async (page) => {
			const tab = await readState<string>(page, "assistantTab");
			expect(tab).toBe("preview");
		},
	},
	{
		type: "role",
		emitPrompt: "ROLE_PROPOSAL_PARITY",
		streamingEditPrompt: "ROLE_PROPOSAL_PARITY_EDIT",
		panelLocator: (page) =>
			page.locator('[data-panel="role-proposal"]').first(),
		expectedInitialText: "parity-role",
		expectedStreamingEditText: "parity-role-edited",
		autoSelectAssertion: async (page) => {
			const tab = await readState<string>(page, "assistantTab");
			expect(tab).toBe("preview");
		},
	},
	{
		type: "tool",
		emitPrompt: "TOOL_PROPOSAL_PARITY",
		streamingEditPrompt: "TOOL_PROPOSAL_PARITY_EDIT",
		panelLocator: (page) =>
			page.locator('[data-panel="tool-proposal"]').first(),
		expectedInitialText: "parity-tool",
		expectedStreamingEditText: "parity-tool-edited",
		autoSelectAssertion: async (page) => {
			const tab = await readState<string>(page, "assistantTab");
			expect(tab).toBe("preview");
		},
	},
	{
		type: "staff",
		emitPrompt: "STAFF_PROPOSAL_PARITY",
		streamingEditPrompt: "STAFF_PROPOSAL_PARITY_EDIT",
		panelLocator: (page) =>
			page.locator('[data-panel="staff-proposal"]').first(),
		expectedInitialText: "parity-staff",
		expectedStreamingEditText: "parity-staff-edited",
		autoSelectAssertion: async (page) => {
			const tab = await readState<string>(page, "assistantTab");
			expect(tab).toBe("preview");
		},
	},
];

test.describe("Editable proposals — UX parity matrix @parity", () => {
	for (const fx of FIXTURES) {
		test.describe(`type=${fx.type}`, () => {
			test.fixme(
				`[${fx.type}] dismissal sticks across page reload`,
				async ({ page }) => {
					// TODO(slice-E): per-type dismissal helpers (§7.5
					// `markProposalDismissed`) and per-type triggers must land
					// before this can pass. The goal case is the reference and
					// already covered by tests/goal-proposal-dismiss.spec.ts;
					// this test exercises the unified helper for the other types.
					await openApp(page);
					await createSessionViaUI(page);

					await sendMessage(page, fx.emitPrompt);

					const panel = fx.panelLocator(page);
					await expect(panel).toBeVisible({ timeout: 15_000 });

					const dismissBtn = page
						.locator("button")
						.filter({ hasText: "Dismiss" })
						.first();
					await expect(dismissBtn).toBeVisible({ timeout: 10_000 });
					await dismissBtn.click();
					await expect(panel).toBeHidden({ timeout: 10_000 });

					// Reload — the dismissal fingerprint is stored under
					// `bobbit-${type}-proposal-dismissed-<sid>` (see §7.5),
					// keyed by a stable JSON.stringify(fields) hash. After
					// reload the proposal_update rehydrate event must NOT
					// reopen the panel.
					await page.reload();
					await expect(
						page.locator("button").filter({ hasText: "Settings" }).first(),
					).toBeVisible({ timeout: 20_000 });

					// Rehydrate path lands inline with the WS handshake; the
					// dismissal-fingerprint check runs synchronously when
					// session-manager processes the proposal_update event.
					await expect(panel).toBeHidden({ timeout: 5_000 });
				},
			);

			test.fixme(
				`[${fx.type}] "Open proposal" reopens cleanly and clears dismissal`,
				async ({ page }) => {
					// TODO(slice-E): the unified `proposal-open` DOM event
					// dispatch must route through onProposal AND clear the
					// per-type dismissal fingerprint. Until then only goal
					// works (existing proposal-tools.spec.ts coverage).
					await openApp(page);
					await createSessionViaUI(page);
					await sendMessage(page, fx.emitPrompt);

					const panel = fx.panelLocator(page);
					await expect(panel).toBeVisible({ timeout: 15_000 });

					// Dismiss.
					await page
						.locator("button")
						.filter({ hasText: "Dismiss" })
						.first()
						.click();
					await expect(panel).toBeHidden({ timeout: 10_000 });

					// The completed tool card carries an "Open proposal" button.
					const openBtn = page.getByText("Open proposal").first();
					await expect(openBtn).toBeVisible({ timeout: 10_000 });
					await openBtn.click();

					// Panel reappears and reflects the original fields.
					await expect(panel).toBeVisible({ timeout: 10_000 });
					await expect(panel).toContainText(fx.expectedInitialText, {
						timeout: 10_000,
					});

					// A subsequent reload should NOT re-hide it — clicking
					// "Open proposal" must clear the dismissal fingerprint.
					await page.reload();
					await expect(
						page.locator("button").filter({ hasText: "Settings" }).first(),
					).toBeVisible({ timeout: 20_000 });
					await expect(panel).toBeVisible({ timeout: 15_000 });
				},
			);

			test.fixme(
				`[${fx.type}] first-emit auto-selects the right tab`,
				async ({ page }) => {
					// TODO(slice-E): plugin.onFirstEmit per type lifts the
					// goal/project previewPanelActiveTab logic and the
					// role/tool/staff/workflow assistantTab logic into the
					// registry. This test asserts the post-refactor side
					// effect via the diagnostic state hook on `window`.
					await openApp(page);
					await createSessionViaUI(page);
					await sendMessage(page, fx.emitPrompt);

					const panel = fx.panelLocator(page);
					await expect(panel).toBeVisible({ timeout: 15_000 });

					await fx.autoSelectAssertion(page);
				},
			);

			test.fixme(
				`[${fx.type}] streaming partial preserves prior structured fields`,
				async ({ page }) => {
					// TODO(slice-E): plugin.mergeFields — project keeps the
					// existing components/workflows shallow-merge; the others
					// use plain object spread; goal adds frontmatter-aware
					// merge so a streaming spec body doesn't blank
					// title/cwd/workflow. This test sends a partial that only
					// touches one scalar and asserts the other fields survive.
					await openApp(page);
					await createSessionViaUI(page);

					// Initial full emit.
					await sendMessage(page, fx.emitPrompt);
					const panel = fx.panelLocator(page);
					await expect(panel).toBeVisible({ timeout: 15_000 });
					await expect(panel).toContainText(fx.expectedInitialText, {
						timeout: 10_000,
					});

					// Streaming partial — `edit_proposal` touching ONLY the
					// scalar that maps to expectedStreamingEditText. All other
					// fields (title, components, workflows, gates etc.) must
					// remain populated.
					await sendMessage(page, fx.streamingEditPrompt);
					await expect(panel).toContainText(fx.expectedStreamingEditText, {
						timeout: 10_000,
					});

					// Assert at least one OTHER field — surfaced via the
					// initial fixture text — still present. This is the
					// shallow-merge invariant. We re-check the whole
					// expectedInitialText only when the edit didn't replace
					// it; for fixtures where the edit replaces a substring
					// of expectedInitialText, the second assertion would
					// false-positive, so we read the slot's `fields` count
					// from `window.bobbitState` instead.
					const slotFieldCount = await page.evaluate((t) => {
						const s = (window as any).bobbitState;
						const slot = s?.activeProposals?.[t];
						return slot?.fields ? Object.keys(slot.fields).length : 0;
					}, fx.type);
					expect(slotFieldCount,
						`fields object must retain prior keys after partial`,
					).toBeGreaterThan(1);
				},
			);

			test.fixme(
				`[${fx.type}] restart survival — proposal rehydrates after reload`,
				async ({ page, gateway }) => {
					// TODO(slice-E): the on-disk file at
					// .bobbit/state/proposal-drafts/<sessionId>/<type>.{md,yaml}
					// is the source of truth. On reload the WS handler emits
					// `proposal_update { source: "rehydrate" }` for each file.
					// Until Slices B (file layer + WS) and D (client subscribe)
					// land, the panel disappears on reload.
					await openApp(page);
					await createSessionViaUI(page);
					await sendMessage(page, fx.emitPrompt);

					const panel = fx.panelLocator(page);
					await expect(panel).toBeVisible({ timeout: 15_000 });
					await expect(panel).toContainText(fx.expectedInitialText, {
						timeout: 10_000,
					});

					// Simulate a reconnect via full page reload. The on-disk
					// proposal file survives. The WS attach should re-emit
					// the proposal_update event and the panel must reappear.
					await page.reload();
					await expect(
						page.locator("button").filter({ hasText: "Settings" }).first(),
					).toBeVisible({ timeout: 20_000 });

					await expect(panel).toBeVisible({ timeout: 15_000 });
					await expect(panel).toContainText(fx.expectedInitialText, {
						timeout: 10_000,
					});

					// Sanity — the gateway info fixture is wired up. Touch it
					// so the parameter isn't lint-flagged unused; future
					// hardenings of this test (e.g. asserting the file on disk
					// directly via fs.readFile under gateway.bobbitDir) will
					// use it. void to avoid TS6133.
					void (gateway as GatewayInfo);
				},
			);
		});
	}
});

/*
 * Mock-agent triggers required by this spec (added in Slice F or Slice C
 * alongside the editable-proposals tooling).
 *
 * For each TYPE in {goal, project, workflow, role, tool, staff} two prompts:
 *
 *   <TYPE>_PROPOSAL_PARITY      → emits one propose_<type> with a known fixture
 *                                 whose canonical text contains
 *                                 fx.expectedInitialText.
 *   <TYPE>_PROPOSAL_PARITY_EDIT → emits one edit_proposal { type, old_text,
 *                                 new_text } that surgically replaces a
 *                                 scalar so the panel now contains
 *                                 fx.expectedStreamingEditText. Other fields
 *                                 from the initial emit must be preserved
 *                                 server-side via the file-on-disk source of
 *                                 truth — the agent does NOT re-emit the
 *                                 full payload.
 *
 * Suggested canonical fixtures (kept brief — extend in mock-agent-core.mjs):
 *
 *   goal:     title="Parity Goal A", spec="…"
 *             edit replaces "Parity Goal A" → "Parity Goal A — edited"
 *   project:  build_command="echo parity"
 *             edit replaces "echo parity" → "echo parity-edited"
 *   workflow: id="parity-workflow"
 *             edit replaces "parity-workflow" → "parity-workflow-edited"
 *             (in name field; id is immutable)
 *   role:     name="parity-role"
 *             edit replaces "parity-role" label → "parity-role-edited"
 *   tool:     tool="parity-tool"
 *             edit replaces description → "parity-tool-edited"
 *   staff:    name="parity-staff"
 *             edit replaces description → "parity-staff-edited"
 *
 * The `data-panel="<type>-proposal"` selectors used above must be added by
 * Slice E render.ts updates for the four types that don't have one today
 * (workflow, role, tool, staff). The project + goal panels already carry
 * stable selectors. If Slice E uses different testids, update the fixtures
 * accordingly.
 */
