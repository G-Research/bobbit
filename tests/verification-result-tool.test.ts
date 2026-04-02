/**
 * Unit tests for the verification_result tool infrastructure:
 * - generateVerificationResultExtension()
 * - VERIFICATION_RESULT_REMINDER constant
 * - isTransientReviewError after verdict-tag cleanup
 */
import { describe, it } from "node:test";
import assert from "node:assert";

describe("generateVerificationResultExtension", () => {
  it("generates valid extension code with sessionId embedded", async () => {
    const { generateVerificationResultExtension } = await import("../dist/server/agent/verification-harness.js");
    const code = generateVerificationResultExtension("test-session-123");
    assert.ok(code.includes("test-session-123"), "should embed sessionId");
    assert.ok(code.includes("verification_result"), "should register verification_result tool");
    assert.ok(code.includes("pi.registerTool"), "should call pi.registerTool");
    assert.ok(code.includes("verdict"), "should have verdict parameter");
    assert.ok(code.includes("summary"), "should have summary parameter");
    assert.ok(code.includes("report_html"), "should have report_html parameter");
    assert.ok(code.includes("/api/internal/verification-result"), "should call internal API");
  });

  it("escapes special characters in sessionId", async () => {
    const { generateVerificationResultExtension } = await import("../dist/server/agent/verification-harness.js");
    const code = generateVerificationResultExtension('test"session');
    assert.ok(code.includes("test"), "should contain sessionId");
    // Should be properly JSON-stringified — quotes escaped
    assert.ok(!code.includes('test"session'), "should escape quotes");
  });
});

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
