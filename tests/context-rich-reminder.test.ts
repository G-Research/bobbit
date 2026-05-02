/**
 * Pinned regression: when an LLM reviewer agent goes idle without
 * calling `verification_result`, the reminder we send re-includes
 * the FULL kickoff prompt, not just two terse sentences.
 *
 * Live test (PR #409 0e4fc54c plan-approval UX + d0c12669 dashboard
 * subgoal): Eve's reviewers AND Gizmo's reviewers consistently
 * failed with "Agent did not call verification_result after
 * reminder". The terse legacy `VERIFICATION_RESULT_REMINDER` is
 * two sentences with zero task context — the reviewer agent often
 * emits its review as chat-text and ends turn, then the reminder
 * arrives without enough context for Opus to recover.
 *
 * Fix: `buildContextRichReminder(originalKickoff)` builds a
 * stronger reminder that:
 *   1. Leads with a "STOP" header making the failure mode explicit
 *   2. Says any chat-text verdict is invisible to the gate
 *   3. Re-attaches the full original kickoff
 *   4. Tells the agent to call the tool with whatever opinion it
 *      has already formed — no re-investigation
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildContextRichReminder, VERIFICATION_RESULT_REMINDER } from "../src/server/agent/verification-harness.ts";

describe("buildContextRichReminder", () => {
	it("includes the original kickoff verbatim", () => {
		const kickoff = "Perform the review for the gate verification step: \"Gap analysis\".\n\nDo X, Y, Z.";
		const reminder = buildContextRichReminder(kickoff);
		assert.ok(reminder.includes(kickoff), "reminder must contain the original kickoff text");
	});

	it("starts with a STOP directive making failure mode explicit", () => {
		const reminder = buildContextRichReminder("");
		assert.ok(reminder.startsWith("## STOP"),
			"reminder must lead with STOP header so the agent doesn't read it as a continuation");
	});

	it("warns that chat-text verdict is invisible to the gate", () => {
		const reminder = buildContextRichReminder("");
		assert.ok(/chat-text|invisible/.test(reminder),
			"reminder must explain WHY just emitting text is wrong");
	});

	it("instructs to call tool with already-formed opinion (no re-investigation)", () => {
		const reminder = buildContextRichReminder("");
		assert.ok(/already formed|do NOT re-investigate/i.test(reminder),
			"reminder must tell agent not to redo work");
	});

	it("is meaningfully longer than the legacy terse reminder (with realistic kickoff)", () => {
		// Real kickoffs are typically 1-3KB; even a small one should make the
		// reminder larger than the terse 200-char legacy reminder.
		const kickoff = "Perform the review.\n\nCheck files for patterns.\n\n## Submitting\n\nCall verification_result with verdict pass/fail.";
		const reminder = buildContextRichReminder(kickoff);
		assert.ok(reminder.length > VERIFICATION_RESULT_REMINDER.length,
			"context-rich reminder must be longer than the terse one (it embeds kickoff + new directive)");
	});

	it("legacy VERIFICATION_RESULT_REMINDER is preserved for the resume path (no kickoff available)", () => {
		// The resume path can't rebuild kickoff (it has no access to the
		// original step.prompt + builtinVars). Keep the terse version
		// available for that one site.
		assert.ok(VERIFICATION_RESULT_REMINDER.includes("verification_result"));
	});

	it("reminder body sections are clearly separated by `---`", () => {
		const reminder = buildContextRichReminder("ORIGINAL KICKOFF");
		assert.ok(reminder.includes("---"),
			"horizontal rule separates the directive from the kickoff body for readability");
	});
});
