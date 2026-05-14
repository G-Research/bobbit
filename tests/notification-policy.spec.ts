/**
 * Pinning tests for `needsHumanAttention` — the shared notification predicate
 * consulted by the polling beep (api.ts), the active-session `agent_end` beep
 * (remote-agent.ts), and the sidebar unread dot (render-helpers.ts).
 *
 * Each test row corresponds to a row in the goal's design-doc rule table.
 * If you change the predicate, edit `src/app/notification-policy.ts` and
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

test.describe("needsHumanAttention — notification scoping policy", () => {
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
