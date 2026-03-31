import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTransientReviewError } from "../src/server/agent/verification-harness.js";

describe("isTransientReviewError", () => {
	it("detects 'Agent process not running'", () => {
		assert.ok(isTransientReviewError("LLM review failed: Agent process not running"));
	});

	it("detects timeout errors", () => {
		assert.ok(isTransientReviewError("LLM review timed out after 600s."));
	});

	it("detects missing verdict tag", () => {
		assert.ok(isTransientReviewError("LLM review failed: no <verdict> tag found in sub-agent output."));
	});

	it("detects process exit errors", () => {
		assert.ok(isTransientReviewError("LLM review failed: process exited with code 1"));
	});

	it("detects ECONNRESET", () => {
		assert.ok(isTransientReviewError("LLM review failed: ECONNRESET"));
	});

	it("detects EPIPE", () => {
		assert.ok(isTransientReviewError("LLM review failed: EPIPE"));
	});

	it("detects socket hang up", () => {
		assert.ok(isTransientReviewError("LLM review failed: socket hang up"));
	});

	it("detects spawn UNKNOWN", () => {
		assert.ok(isTransientReviewError("LLM review failed: spawn UNKNOWN"));
	});

	it("detects ECONNREFUSED", () => {
		assert.ok(isTransientReviewError("connect ECONNREFUSED 127.0.0.1:3001"));
	});

	it("does NOT match real review failures", () => {
		assert.ok(!isTransientReviewError("LLM review failed: 'reviewer' role not found in role store."));
	});

	it("does NOT match a passing review", () => {
		assert.ok(!isTransientReviewError("## Summary\nAll good.\n<verdict>pass</verdict>"));
	});

	it("does NOT match a failing review with actual findings", () => {
		assert.ok(!isTransientReviewError("[critical] src/foo.ts:42 — SQL injection\n<verdict>fail</verdict>"));
	});
});
