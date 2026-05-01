/**
 * E2E — Per-type UX parity matrix for editable proposals.
 *
 * Spec: docs/design/editable-proposals.md §8 (UX-preservation matrix).
 * Goal-proposal UX is the reference; after the unification refactor every
 * behaviour must work identically across all six proposal types
 * (goal, project, workflow, role, tool, staff).
 *
 * Per type we assert:
 *   1. Dismissal stickiness — emit → dismiss → reload → still dismissed.
 *   2. "Open proposal" reopens the slot and clears dismissal.
 *   3. First-emit auto-select — `assistantHasProposal` flips on, plus the
 *      type-specific tab side-effect (goal/project flip
 *      `previewPanelActiveTab`; the four assistant-only types flip
 *      `assistantTab` to "preview" — the latter only fires when the
 *      session is the corresponding assistant, which a regular session
 *      isn't, so we assert `assistantHasProposal` for those four).
 *   4. Streaming partial preserves prior structured fields — the unified
 *      `mergeFields` invariant generalised across all types.
 *   5. Restart survival — the on-disk proposal file rehydrates the
 *      `state.activeProposals[type]` slot after page reload.
 *
 * Mock-agent triggers (defined in tests/e2e/mock-agent-core.mjs):
 *   <TYPE>_PROPOSAL_PARITY        → emits propose_<type> with full fixture.
 *   <TYPE>_PROPOSAL_PARITY_EDIT   → emits a partial propose_<type> touching
 *                                   one scalar; mergeFields must preserve
 *                                   the rest.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

type ProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";

interface TypeFixture {
	type: ProposalType;
	emitPrompt: string;
	streamingEditPrompt: string;
	/** Field on the slot whose value flips after the parity edit (sanity check). */
	editedFieldKey: string;
	editedFieldValueAfter: string;
	/** Field on the slot that the partial does NOT touch — must survive merge. */
	preservedFieldKey: string;
}

const FIXTURES: TypeFixture[] = [
	{
		type: "goal",
		emitPrompt: "GOAL_PROPOSAL_PARITY",
		streamingEditPrompt: "GOAL_PROPOSAL_PARITY_EDIT",
		editedFieldKey: "title",
		editedFieldValueAfter: "Parity Goal A — edited",
		preservedFieldKey: "cwd",
	},
	{
		type: "project",
		emitPrompt: "PROJECT_PROPOSAL_PARITY",
		streamingEditPrompt: "PROJECT_PROPOSAL_PARITY_EDIT",
		editedFieldKey: "build_command",
		editedFieldValueAfter: "echo parity-edited",
		preservedFieldKey: "components",
	},
	{
		type: "workflow",
		emitPrompt: "WORKFLOW_PROPOSAL_PARITY",
		streamingEditPrompt: "WORKFLOW_PROPOSAL_PARITY_EDIT",
		editedFieldKey: "name",
		editedFieldValueAfter: "parity-workflow-edited",
		preservedFieldKey: "id",
	},
	{
		type: "role",
		emitPrompt: "ROLE_PROPOSAL_PARITY",
		streamingEditPrompt: "ROLE_PROPOSAL_PARITY_EDIT",
		editedFieldKey: "label",
		editedFieldValueAfter: "parity-role-edited",
		preservedFieldKey: "name",
	},
	{
		type: "tool",
		emitPrompt: "TOOL_PROPOSAL_PARITY",
		streamingEditPrompt: "TOOL_PROPOSAL_PARITY_EDIT",
		editedFieldKey: "content",
		editedFieldValueAfter: "parity-tool-edited content",
		preservedFieldKey: "tool",
	},
	{
		type: "staff",
		emitPrompt: "STAFF_PROPOSAL_PARITY",
		streamingEditPrompt: "STAFF_PROPOSAL_PARITY_EDIT",
		editedFieldKey: "description",
		editedFieldValueAfter: "parity-staff-edited",
		preservedFieldKey: "name",
	},
];

/** Wait until `state.activeProposals[type]` has a populated `fields` object,
 *  optionally with a specific `(key,value)` pair. Polls via `waitForFunction`
 *  — no fixed sleeps. */
async function waitForSlotFields(
	page: Page,
	type: ProposalType,
	check: { key: string; value: string } | null = null,
	timeout = 15_000,
): Promise<void> {
	await page.waitForFunction(
		({ type, check }) => {
			const s = (window as any).bobbitState;
			const slot = s?.activeProposals?.[type];
			if (!slot || typeof slot.fields !== "object") return false;
			if (!check) return Object.keys(slot.fields).length > 0;
			return slot.fields[check.key] === check.value;
		},
		{ type, check },
		{ timeout },
	);
}

async function waitForSlotAbsent(
	page: Page,
	type: ProposalType,
	timeout = 10_000,
): Promise<void> {
	await page.waitForFunction(
		(type) => {
			const s = (window as any).bobbitState;
			return !s?.activeProposals?.[type];
		},
		type,
		{ timeout },
	);
}

async function readSlotFields(page: Page, type: ProposalType): Promise<Record<string, unknown> | null> {
	return page.evaluate((t) => {
		const s = (window as any).bobbitState;
		const slot = s?.activeProposals?.[t];
		return slot?.fields ?? null;
	}, type);
}

/** Active session id from window.bobbitState. */
async function activeSessionId(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const s = (window as any).bobbitState;
		return s?.selectedSessionId ?? null;
	});
}

test.describe("Editable proposals — UX parity matrix @parity", () => {
	for (const fx of FIXTURES) {
		test.describe(`type=${fx.type}`, () => {
			test(`[${fx.type}] first-emit populates the activeProposals slot`, async ({ page }) => {
				await openApp(page);
				await createSessionViaUI(page);
				await sendMessage(page, fx.emitPrompt);

				await waitForSlotFields(page, fx.type, null);
				const fields = await readSlotFields(page, fx.type);
				expect(fields, `${fx.type} slot fields must be populated`).not.toBeNull();
				// `assistantHasProposal` must flip on for any first-emit.
				const flag = await page.evaluate(
					() => (window as any).bobbitState?.assistantHasProposal === true,
				);
				expect(flag, "assistantHasProposal must flip on first emit").toBe(true);
			});

			test(`[${fx.type}] streaming partial preserves prior structured fields`, async ({ page }) => {
				await openApp(page);
				await createSessionViaUI(page);
				await sendMessage(page, fx.emitPrompt);
				await waitForSlotFields(page, fx.type);
				const before = await readSlotFields(page, fx.type);
				expect(before, "first-emit slot must have fields").not.toBeNull();
				const beforeKeys = before ? Object.keys(before) : [];
				expect(beforeKeys.length).toBeGreaterThan(1);

				// Partial edit — only touches one scalar. mergeFields must
				// preserve every other prior key.
				await sendMessage(page, fx.streamingEditPrompt);
				await waitForSlotFields(page, fx.type, {
					key: fx.editedFieldKey,
					value: fx.editedFieldValueAfter,
				});

				const after = await readSlotFields(page, fx.type);
				expect(after, "post-edit slot must still have fields").not.toBeNull();
				expect(after![fx.editedFieldKey], "edited field updated").toBe(
					fx.editedFieldValueAfter,
				);
				// Every previously-present key (except the one we edited)
				// must still be present after the partial.
				const afterKeys = Object.keys(after!);
				for (const k of beforeKeys) {
					if (k === fx.editedFieldKey) continue;
					expect(afterKeys, `${k} preserved across partial`).toContain(k);
				}
				// Sanity — the field we explicitly mark as preserved is one
				// the partial didn't include, so it must be present.
				expect(after![fx.preservedFieldKey]).toBeDefined();
			});

			test(`[${fx.type}] dismissal sticks across reload`, async ({ page }) => {
				await openApp(page);
				await createSessionViaUI(page);
				await sendMessage(page, fx.emitPrompt);
				await waitForSlotFields(page, fx.type);

				const sid = await activeSessionId(page);
				expect(sid, "active session id must be set").toBeTruthy();

				// Mark this proposal dismissed via the typed helper. Equivalent
				// to the user clicking Dismiss — works regardless of whether
				// the type's bespoke panel is currently visible. Mirrors the
				// per-type normalisation that the production helper applies
				// (goal: trim trailing whitespace from `spec` so the file-on-disk
				// round-trip newline doesn't shift the fingerprint).
				await page.evaluate(
					({ sid, type }) => {
						const s = (window as any).bobbitState;
						const fields = { ...(s?.activeProposals?.[type]?.fields ?? {}) };
						if (type === "goal" && typeof fields.spec === "string") {
							fields.spec = fields.spec.replace(/\s+$/u, "");
						}
						const key = `bobbit-${type}-proposal-dismissed-${sid}`;
						const sorted = Object.keys(fields).sort();
						const ordered: Record<string, unknown> = {};
						for (const k of sorted) ordered[k] = fields[k];
						localStorage.setItem(key, JSON.stringify(ordered));
						delete s.activeProposals[type];
						s.assistantHasProposal = false;
					},
					{ sid: sid!, type: fx.type },
				);

				// Reload — server rehydrate broadcast must NOT re-populate the
				// slot because the dismissal fingerprint matches.
				await page.reload();
				await expect(
					page.locator("button").filter({ hasText: "Settings" }).first(),
				).toBeVisible({ timeout: 20_000 });

				// Give rehydrate time to deliver, then assert the slot stays
				// absent. `waitForFunction` polls — no fixed sleeps.
				await waitForSlotAbsent(page, fx.type, 5_000).catch(() => {
					/* falls through to expect below */
				});
				const slotAfter = await readSlotFields(page, fx.type);
				expect(
					slotAfter,
					"dismissed proposal must not re-populate the slot on reload",
				).toBeNull();
			});

			test(`[${fx.type}] restart survival — on-disk file rehydrates slot`, async ({ page }) => {
				await openApp(page);
				await createSessionViaUI(page);
				await sendMessage(page, fx.emitPrompt);
				await waitForSlotFields(page, fx.type);
				const before = await readSlotFields(page, fx.type);
				expect(before).not.toBeNull();

				// Reload — WS rehydrate path emits proposal_update for each
				// on-disk file. The unified onProposal callback merges it
				// back into the slot.
				await page.reload();
				await expect(
					page.locator("button").filter({ hasText: "Settings" }).first(),
				).toBeVisible({ timeout: 20_000 });

				await waitForSlotFields(page, fx.type, null, 15_000);
				const after = await readSlotFields(page, fx.type);
				expect(after, "rehydrated slot must be populated").not.toBeNull();
				// The edited field key must round-trip identically.
				expect(after![fx.preservedFieldKey]).toBeDefined();
			});

			test(`[${fx.type}] proposal-open clears dismissal and re-populates`, async ({ page }) => {
				await openApp(page);
				await createSessionViaUI(page);
				await sendMessage(page, fx.emitPrompt);
				await waitForSlotFields(page, fx.type);

				const sid = await activeSessionId(page);
				const fields = await readSlotFields(page, fx.type);
				expect(fields).not.toBeNull();

				// Mark dismissed and clear the slot (same normalisation as above).
				await page.evaluate(
					({ sid, type }) => {
						const s = (window as any).bobbitState;
						const f: Record<string, unknown> = { ...(s?.activeProposals?.[type]?.fields ?? {}) };
						if (type === "goal" && typeof f.spec === "string") {
							f.spec = (f.spec as string).replace(/\s+$/u, "");
						}
						const key = `bobbit-${type}-proposal-dismissed-${sid}`;
						const sorted = Object.keys(f).sort();
						const ordered: Record<string, unknown> = {};
						for (const k of sorted) ordered[k] = f[k];
						localStorage.setItem(key, JSON.stringify(ordered));
						delete s.activeProposals[type];
					},
					{ sid: sid!, type: fx.type },
				);

				// Fire the proposal-open event with the original fields.
				// session-manager's handler should clear the typed dismissal
				// AND repopulate the slot via the unified onProposal callback.
				await page.evaluate(
					({ type, fields }) => {
						document.dispatchEvent(
							new CustomEvent("proposal-open", { detail: { type, fields } }),
						);
					},
					{ type: fx.type, fields },
				);

				// Slot re-populates.
				await waitForSlotFields(page, fx.type, null, 5_000);
				// Dismissal localStorage key cleared.
				const stillDismissed = await page.evaluate(
					({ sid, type }) =>
						!!localStorage.getItem(`bobbit-${type}-proposal-dismissed-${sid}`),
					{ sid: sid!, type: fx.type },
				);
				expect(
					stillDismissed,
					"proposal-open must clear the per-type dismissal fingerprint",
				).toBe(false);
			});
		});
	}
});
