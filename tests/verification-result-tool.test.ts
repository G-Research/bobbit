/**
 * Unit tests for the verification_result tool infrastructure:
 * - VERIFICATION_RESULT_REMINDER constant
 * - isTransientReviewError after verdict-tag cleanup
 */
import { describe, it } from "node:test";
import assert from "node:assert";

describe("VERIFICATION_RESULT_REMINDER", () => {
  it("includes verification_result tool reference", async () => {
    const { VERIFICATION_RESULT_REMINDER } = await import("../dist/server/agent/verification-harness.js");
    assert.ok(typeof VERIFICATION_RESULT_REMINDER === "string");
    assert.ok(VERIFICATION_RESULT_REMINDER.includes("verification_result"));
  });
});

describe("isTransientReviewError after cleanup", () => {
  it("does not treat verification_result failure as transient", async () => {
    const { isTransientReviewError } = await import("../dist/server/agent/verification-harness.js");
    assert.ok(!isTransientReviewError("Agent did not call verification_result after reminder."));
  });

  it("still treats timeout as transient", async () => {
    const { isTransientReviewError } = await import("../dist/server/agent/verification-harness.js");
    assert.ok(isTransientReviewError("Agent timed out waiting for response"));
  });

  it("still treats connection reset as transient", async () => {
    const { isTransientReviewError } = await import("../dist/server/agent/verification-harness.js");
    assert.ok(isTransientReviewError("ECONNRESET"));
  });
});
