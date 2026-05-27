/**
 * Pinning tests for `needsHumanAttention` + `needsImmediateHumanAttention` —
 * the shared notification predicates consulted by the polling beep (api.ts),
 * the active-session `agent_end` beep (remote-agent.ts), and the sidebar
 * unread dot (render-helpers.ts).
 *
 * Each test row corresponds to a row in the goal's design-doc rule table
 * (§2.3 of the Human Sign-Off Gates design doc).
 *
 * Read-filter split:
 *   • `needsHumanAttention`           — rules 1 + 4 (read-state-filterable)
 *   • `needsImmediateHumanAttention`  — rules 2 + 3 (bypass read-state filter)
 *   • `__check`                       — OR of both (mirrors the call sites)
 *   • `__checkSplit`                  — { filterable, immediate } breakdown
 *
 * If you change the policy, edit `src/app/notification-policy.ts` and
 * update / extend these rows — do NOT re-implement the rules at a call site.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/notification-policy.html");
const BUNDLE = path.resolve("tests/fixtures/notification-policy-bundle.js");
const ENTRY = path.resolve("tests/fixtures/notification-policy-entry.ts");
const POLICY_SRC = path.resolve("src/app/notification-policy.ts");
const STATE_SRC = path.resolve("src/app/state.ts");

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, POLICY_SRC, STATE_SRC],
	});
});

const PAGE = `file://${FIXTURE.replace(/\\/g, "/")}`;

test.describe("notification policy — legacy rule rows (pre-rewrite parity)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(PAGE);
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	});

	test("Row 1: standalone idle session → notify", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [{ id: "s1", status: "idle" }],
			});
			return (window as any).__check("s1");
		});
		expect(result).toBe(true);
	});

	test("Row 2: delegate session (delegateOf set) → silent", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "parent", status: "idle" },
					{ id: "delegate", status: "idle", delegateOf: "parent" },
				],
			});
			return (window as any).__check("delegate");
		});
		expect(result).toBe(false);
	});

	test("Row 3: team member (role=coder, teamLeadSessionId set) → silent", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__check("coder");
		});
		expect(result).toBe(false);
	});

	test("Row 4: team member (role=reviewer in team goal) → silent", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
					{ id: "rev", role: "reviewer", teamGoalId: "g1", status: "idle" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__check("rev");
		});
		expect(result).toBe(false);
	});

	test("Row 5: team lead idle mid-goal, sibling coder streaming → silent", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__check("lead");
		});
		expect(result).toBe(false);
	});

	test("Row 6: team lead idle mid-goal, all members idle, no verification → notify (stuck)", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__check("lead");
		});
		expect(result).toBe(true);
	});

	test("Row 7: team lead idle mid-goal, verification running → silent", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
				gateStatusCache: [{ goalId: "g1", verifying: true }],
			});
			return (window as any).__check("lead");
		});
		expect(result).toBe(false);
	});

	test("Row 8: team lead idle, goal complete → notify", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
				],
				goals: [{ id: "g1", state: "complete" }],
			});
			return (window as any).__check("lead");
		});
		expect(result).toBe(true);
	});

	test("Row 9: team lead idle, goal complete, sibling member still streaming → notify (goal-complete wins)", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
				],
				goals: [{ id: "g1", state: "complete" }],
			});
			return (window as any).__check("lead");
		});
		expect(result).toBe(true);
	});

	test("Bonus: team member compacting counts as live downstream work", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle", isCompacting: true },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__check("lead");
		});
		expect(result).toBe(false);
	});
});

test.describe("notification policy — four-rule team-lead disjunction (post-rewrite)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(PAGE);
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	});

	// ── Rule 1: goal complete ─────────────────────────────────────

	test("Rule 1: goal complete fires via the read-filterable predicate", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" }],
				goals: [{ id: "g1", state: "complete" }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result).toEqual({ filterable: true, immediate: false });
	});

	// ── Rule 2: pending human sign-off (read-filter bypass) ────────

	test("Rule 2: pending sign-off fires via the immediate predicate (bypasses read filter)", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now(), lastReadAt: Date.now() },
				],
				goals: [{ id: "g1", state: "in-progress" }],
				gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result.immediate).toBe(true);
	});

	test("Rule 2: pending sign-off ignored when session is a delegate (escalation invariant)", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "parent", role: "team-lead", goalId: "g1", status: "idle" },
					{ id: "del", goalId: "g1", status: "idle", delegateOf: "parent" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
				gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
			});
			return (window as any).__check("del");
		});
		expect(result).toBe(false);
	});

	test("Rule 2: pending sign-off ignored when session is a team member (escalation invariant)", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
				gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
			});
			return (window as any).__check("coder");
		});
		expect(result).toBe(false);
	});

	// ── Rule 3: errored-and-parked (read-filter bypass) ────────────

	test("Rule 3: 3 consecutive errored turns + lastTurnErrored fires via the immediate predicate", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastTurnErrored: true, consecutiveErrorTurns: 3 },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result.immediate).toBe(true);
	});

	test("Rule 3: 2 consecutive errored turns is below the threshold → silent", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now(), lastTurnErrored: true, consecutiveErrorTurns: 2 },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result).toEqual({ filterable: false, immediate: false });
	});

	test("Rule 3: lastTurnErrored=false with high count → silent (must be currently errored)", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now(), lastTurnErrored: false, consecutiveErrorTurns: 5 },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result.immediate).toBe(false);
	});

	test("Rule 3: also applies to standalone (non-lead) sessions", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [{ id: "s1", status: "idle", lastTurnErrored: true, consecutiveErrorTurns: 4 }],
			});
			return (window as any).__checkSplit("s1");
		});
		expect(result.immediate).toBe(true);
	});

	// ── Rule 4: idle stuck (debounced) ─────────────────────────────

	test("Rule 4: idle for <10s with no live siblings → silent (debounce kicks in)", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 5_000 },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result).toEqual({ filterable: false, immediate: false });
	});

	test("Rule 4: idle for >10s with no live siblings → notify", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 11_000 },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result.filterable).toBe(true);
	});

	test("Rule 4 suppressor — live sibling: lead idle >10s but sibling streaming → silent", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result).toEqual({ filterable: false, immediate: false });
	});

	test("Rule 4 suppressor — sibling compacting: lead idle >10s but sibling compacting → silent", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 },
					{ id: "coder", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "idle", isCompacting: true },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result).toEqual({ filterable: false, immediate: false });
	});

	test("Rule 4 suppressor — verification running: lead idle >10s but cache.verifying → silent", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 },
				],
				goals: [{ id: "g1", state: "in-progress" }],
				gateStatusCache: [{ goalId: "g1", verifying: true }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result.filterable).toBe(false);
	});

	test("Rule 4 suppressor — pending sign-off: lead idle >10s but cache.awaitingHumanSignoff → filterable false (immediate fires instead)", async ({ page }) => {
		// Rule 2 (immediate) handles the sign-off case so rule 4 (filterable)
		// must not also fire, otherwise the unread dot would persist past the
		// read filter once the user visits and resolves the sign-off.
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: Date.now() - 60_000 },
				],
				goals: [{ id: "g1", state: "in-progress" }],
				gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result.filterable).toBe(false);
		expect(result.immediate).toBe(true);
	});

	test("Rule 4 suppressor — lead itself live: lead status=streaming → silent (filterable false)", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "streaming", lastActivity: Date.now() - 60_000 },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result.filterable).toBe(false);
	});

	test("Rule 4 suppressor — lead compacting: lead.isCompacting → silent", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", isCompacting: true, lastActivity: Date.now() - 60_000 },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result.filterable).toBe(false);
	});

	// ── Spawn-handoff false-positive regression ────────────────────

	test("Spawn handoff: old sibling terminated, new sibling streaming within 500ms → predicate stays false throughout", async ({ page }) => {
		const result = await page.evaluate(() => {
			const seed = (window as any).__seed;
			const check = (window as any).__checkSplit;

			// T0: old delegate alive (streaming), lead has just had activity.
			const leadActiveAt = Date.now() - 2_000;
			seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: leadActiveAt },
					{ id: "del-old", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			const r0 = check("lead");

			// T1: old delegate terminated, no new delegate yet (handoff race window).
			// Lead's lastActivity is recent (2s ago) so the debounce holds.
			seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: leadActiveAt },
					{ id: "del-old", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "terminated" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			const r1 = check("lead");

			// T2: new delegate has started streaming within 500ms.
			seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle", lastActivity: leadActiveAt },
					{ id: "del-old", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "terminated" },
					{ id: "del-new", role: "coder", teamGoalId: "g1", teamLeadSessionId: "lead", status: "streaming" },
				],
				goals: [{ id: "g1", state: "in-progress" }],
			});
			const r2 = check("lead");

			return { r0, r1, r2 };
		});
		// Predicate must remain quiet across the entire handoff window.
		expect(result.r0).toEqual({ filterable: false, immediate: false });
		expect(result.r1).toEqual({ filterable: false, immediate: false });
		expect(result.r2).toEqual({ filterable: false, immediate: false });
	});

	// ── Combined Rule 1 + Rule 2: complete goal with pending sign-off ──

	test("Rule 1 + 2 combined: goal complete with pending sign-off → both predicates fire", async ({ page }) => {
		const result = await page.evaluate(() => {
			(window as any).__seed({
				sessions: [
					{ id: "lead", role: "team-lead", goalId: "g1", status: "idle" },
				],
				goals: [{ id: "g1", state: "complete" }],
				gateStatusCache: [{ goalId: "g1", awaitingHumanSignoff: true }],
			});
			return (window as any).__checkSplit("lead");
		});
		expect(result.filterable).toBe(true);
		expect(result.immediate).toBe(true);
	});
});
