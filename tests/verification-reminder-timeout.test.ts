/**
 * Reviewer reminder/timeout regression tests for VerificationHarness.
 *
 * Defence-in-depth around the reviewer-tool-not-registered class of bug:
 * even when `verification_result` is registered, the harness must not stay
 * stuck if the model refuses to invoke it. After MAX_VERIFICATION_REMINDERS
 * reminders, the gate fails with `reviewer_did_not_call_verification_result`.
 *
 * These tests exercise the public exports surrounding the loop (the constants
 * and tag string) — drilling into the private session-bound paths requires a
 * full SessionManager, which is covered by the existing E2E tests. The unit
 * tests here lock in:
 *   1. The reminder cap is exactly 3 (changing this is a behaviour change
 *      that must be deliberate).
 *   2. The failure tag is the exact string the docs and verifiers grep for.
 *   3. Both LLM-review and QA paths reference the same tag, so a single grep
 *      across mission and goal verification finds every stuck-reviewer
 *      failure mode.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	MAX_VERIFICATION_REMINDERS,
	REVIEWER_DID_NOT_CALL_TAG,
	VERIFICATION_RESULT_REMINDER,
} from "../src/server/agent/verification-harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessFile = path.resolve(__dirname, "../src/server/agent/verification-harness.ts");

test("MAX_VERIFICATION_REMINDERS is exactly 3", () => {
	assert.equal(MAX_VERIFICATION_REMINDERS, 3);
});

test("REVIEWER_DID_NOT_CALL_TAG is the documented grep tag", () => {
	assert.equal(REVIEWER_DID_NOT_CALL_TAG, "reviewer_did_not_call_verification_result");
});

test("VERIFICATION_RESULT_REMINDER mentions the tool name", () => {
	assert.match(VERIFICATION_RESULT_REMINDER, /verification_result/);
});

test("verification-harness.ts: both LLM-review and QA reminder loops fail with REVIEWER_DID_NOT_CALL_TAG", () => {
	// Source-level check that both code paths consume the shared tag and the
	// shared cap. We can't easily black-box the loops without a full session
	// runtime, so we lock in the wiring at source.
	const text = fs.readFileSync(harnessFile, "utf-8");

	// Must reference the cap constant in at least two distinct loops.
	const capRefs = (text.match(/MAX_VERIFICATION_REMINDERS/g) || []).length;
	assert.ok(capRefs >= 4, `expected >=4 references to MAX_VERIFICATION_REMINDERS (declaration + at least 2 loop bounds + log lines), got ${capRefs}`);

	// Must reference the failure tag in both paths (LLM-review + QA).
	const tagRefs = (text.match(/REVIEWER_DID_NOT_CALL_TAG/g) || []).length;
	assert.ok(tagRefs >= 3, `expected >=3 references to REVIEWER_DID_NOT_CALL_TAG (declaration + LLM-review fail + QA fail), got ${tagRefs}`);

	// Must NOT have the legacy single-reminder fail string (regression guard).
	assert.doesNotMatch(text,
		/Agent did not call verification_result after reminder\.\b/,
		"legacy single-reminder fail string still present \u2014 reminder loop regressed");
});

test("verification-harness.ts: mission gate path goes through runLlmReviewStep (which contains the reminder loop)", () => {
	const text = fs.readFileSync(harnessFile, "utf-8");
	// verifyMissionGateSignal must call runLlmReviewStep so it picks up the
	// reminder loop \u2014 regression guard for the case where someone forks the
	// path and forgets the reminders.
	const missionPathStart = text.indexOf("async verifyMissionGateSignal");
	assert.ok(missionPathStart >= 0, "verifyMissionGateSignal not found");
	const missionPathEnd = text.indexOf("\n\t/**", missionPathStart + 1);
	const missionBody = text.slice(missionPathStart, missionPathEnd > 0 ? missionPathEnd : missionPathStart + 8000);
	assert.match(missionBody, /runLlmReviewStep/,
		"verifyMissionGateSignal must route LLM reviews through runLlmReviewStep so the reminder loop applies to mission gates as well");
});
