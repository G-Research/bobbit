/**
 * Lesson 4.8 — Context-rich reminder for live (not resumed) reviewers.
 *
 * The two-sentence legacy reminder didn't elicit a tool call when reviewers
 * emitted their verdict as chat-text and ended turn. The new
 * `buildContextRichReminder(originalKickoff)` rebuilds the kickoff prompt so
 * the agent has its task spec back in context.
 *
 * This test pins the rendered shape of the reminder so future authoring
 * changes (model upgrades, prompt tuning) don't silently regress the four
 * required ingredients:
 *
 *   1. STOP-prefixed header so the agent treats it as a hard correction.
 *   2. Statement that chat-text verdicts are INVISIBLE to the gate.
 *   3. Instruction to call the tool with the already-formed opinion.
 *   4. Original kickoff appended verbatim after a `---` separator.
 */
import { strict as assert } from "node:assert";
import test, { describe } from "node:test";
import { buildContextRichReminder } from "../src/server/agent/verification-harness.js";

describe("buildContextRichReminder", () => {
	const ORIGINAL_KICKOFF = "Review the following diff for code quality:\n\ndiff --git a/foo b/foo\nindex 1234..5678 100644";

	test("starts with STOP header so the agent treats this as a hard correction", () => {
		const reminder = buildContextRichReminder(ORIGINAL_KICKOFF);
		assert.ok(
			reminder.startsWith("## STOP — verification_result not called"),
			"reminder must lead with STOP header to break the chat-text continuation pattern",
		);
	});

	test("declares chat-text verdicts INVISIBLE", () => {
		const reminder = buildContextRichReminder(ORIGINAL_KICKOFF);
		assert.match(reminder, /INVISIBLE/);
		assert.match(reminder, /chat-text/);
	});

	test("instructs the agent to call verification_result with the ALREADY FORMED opinion", () => {
		const reminder = buildContextRichReminder(ORIGINAL_KICKOFF);
		assert.match(reminder, /verification_result/);
		assert.match(reminder, /ALREADY FORMED/);
		assert.match(reminder, /do not re-investigate/i);
	});

	test("appends the original kickoff verbatim after a `---` separator", () => {
		const reminder = buildContextRichReminder(ORIGINAL_KICKOFF);
		const sepIdx = reminder.indexOf("\n---\n");
		assert.ok(sepIdx >= 0, "expected a `---` separator on its own line");
		const tail = reminder.slice(sepIdx + "\n---\n".length).trimStart();
		assert.equal(tail, ORIGINAL_KICKOFF);
	});

	test("snapshot — full rendered reminder for an empty kickoff", () => {
		const out = buildContextRichReminder("");
		const expected = `## STOP — verification_result not called

Your previous turn ended without calling \`verification_result\`. Any chat-text verdict is INVISIBLE to the gate.

Call \`verification_result\` now with whatever opinion you ALREADY FORMED — do not re-investigate. Use status="pass" if your investigation was satisfactory, "fail" otherwise.

---

`;
		assert.equal(out, expected);
	});

	test("preserves multi-line kickoff content unchanged", () => {
		const kickoff = "line one\nline two\n  indented\n\nfinal line";
		const out = buildContextRichReminder(kickoff);
		assert.ok(out.endsWith(kickoff), "kickoff must be appended verbatim, no trailing transformation");
	});
});
