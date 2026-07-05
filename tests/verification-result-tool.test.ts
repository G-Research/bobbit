/**
 * Unit tests for the verification_result tool infrastructure:
 * - VERIFICATION_RESULT_REMINDER constant
 * - isTransientReviewError after verdict-tag cleanup
 */
import { describe, it } from "node:test";
import assert from "node:assert";

describe("VERIFICATION_RESULT_REMINDER", () => {
  it("includes verification_result tool reference", async () => {
    const { VERIFICATION_RESULT_REMINDER } = await import("../src/server/agent/verification-harness.ts");
    assert.ok(typeof VERIFICATION_RESULT_REMINDER === "string");
    assert.ok(VERIFICATION_RESULT_REMINDER.includes("verification_result"));
  });
});

describe("sanitizeVerificationFindings (F3 — structured findings)", () => {
  it("returns undefined for missing/non-array input", async () => {
    const { sanitizeVerificationFindings } = await import("../src/server/agent/verification-harness.ts");
    assert.equal(sanitizeVerificationFindings(undefined), undefined);
    assert.equal(sanitizeVerificationFindings(null), undefined);
    assert.equal(sanitizeVerificationFindings("nope"), undefined);
    assert.equal(sanitizeVerificationFindings([]), undefined);
  });

  it("passes through well-formed findings", async () => {
    const { sanitizeVerificationFindings } = await import("../src/server/agent/verification-harness.ts");
    const out = sanitizeVerificationFindings([
      { severity: "blocker", summary: "SQL injection", file: "src/db.ts", line: 42 },
      { severity: "minor", summary: "nit" },
    ]);
    assert.deepEqual(out, [
      { severity: "blocker", summary: "SQL injection", file: "src/db.ts", line: 42 },
      { severity: "minor", summary: "nit" },
    ]);
  });

  it("drops entries with an invalid severity", async () => {
    const { sanitizeVerificationFindings } = await import("../src/server/agent/verification-harness.ts");
    const out = sanitizeVerificationFindings([
      { severity: "catastrophic", summary: "bad severity" },
      { severity: "major", summary: "kept" },
    ]);
    assert.deepEqual(out, [{ severity: "major", summary: "kept" }]);
  });

  it("drops entries missing or with an empty summary", async () => {
    const { sanitizeVerificationFindings } = await import("../src/server/agent/verification-harness.ts");
    const out = sanitizeVerificationFindings([
      { severity: "major" },
      { severity: "major", summary: "" },
      { severity: "major", summary: "kept" },
    ]);
    assert.deepEqual(out, [{ severity: "major", summary: "kept" }]);
  });

  it("drops non-object entries", async () => {
    const { sanitizeVerificationFindings } = await import("../src/server/agent/verification-harness.ts");
    const out = sanitizeVerificationFindings(["a string", 42, null, { severity: "minor", summary: "ok" }]);
    assert.deepEqual(out, [{ severity: "minor", summary: "ok" }]);
  });

  it("truncates an oversized summary to the schema's maxLength", async () => {
    const { sanitizeVerificationFindings } = await import("../src/server/agent/verification-harness.ts");
    const longSummary = "x".repeat(500);
    const out = sanitizeVerificationFindings([{ severity: "blocker", summary: longSummary }]);
    assert.equal(out?.[0]?.summary.length, 300);
  });

  it("ignores non-string file and non-number line", async () => {
    const { sanitizeVerificationFindings } = await import("../src/server/agent/verification-harness.ts");
    const out = sanitizeVerificationFindings([{ severity: "minor", summary: "ok", file: 5, line: "nope" }]);
    assert.deepEqual(out, [{ severity: "minor", summary: "ok" }]);
  });

  it("returns undefined when every entry is malformed", async () => {
    const { sanitizeVerificationFindings } = await import("../src/server/agent/verification-harness.ts");
    assert.equal(sanitizeVerificationFindings([{ severity: "nope" }, "bad", 1]), undefined);
  });
});

describe("isTransientReviewError after cleanup", () => {
  it("does not treat verification_result failure as transient", async () => {
    const { isTransientReviewError } = await import("../src/server/agent/verification-harness.ts");
    assert.ok(!isTransientReviewError("Agent did not call verification_result after reminder."));
  });

  it("still treats timeout as transient", async () => {
    const { isTransientReviewError } = await import("../src/server/agent/verification-harness.ts");
    assert.ok(isTransientReviewError("Agent timed out waiting for response"));
  });

  it("still treats connection reset as transient", async () => {
    const { isTransientReviewError } = await import("../src/server/agent/verification-harness.ts");
    assert.ok(isTransientReviewError("ECONNRESET"));
  });
});
