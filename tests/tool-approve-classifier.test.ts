// CLF-W2: pinning tests for the tool-approve decision seam's pure helpers —
// `isToolApproveArg`, `isToolApproveEnforceMode`, and `isAutoDenyDecision`.
// See src/server/agent/tool-approve-classifier.ts's header comment for the
// full design/scope (this wave ships the seam harness only; no production
// classifier is registered).
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isToolApproveArg,
	isToolApproveEnforceMode,
	isAutoDenyDecision,
	TOOL_APPROVE_POINT,
	TOOL_APPROVE_KIND,
} from "../src/server/agent/tool-approve-classifier.ts";

describe("TOOL_APPROVE_POINT / TOOL_APPROVE_KIND", () => {
	it("is (tool-call, tool-approve) per the design doc's tool seam (§8.3)", () => {
		assert.equal(TOOL_APPROVE_POINT, "tool-call");
		assert.equal(TOOL_APPROVE_KIND, "tool-approve");
	});
});

describe("isToolApproveArg", () => {
	it("accepts a well-formed arg with toolName + toolGroup", () => {
		assert.equal(isToolApproveArg({ toolName: "bash_bg", toolGroup: "shell" }), true);
	});

	it("accepts an arg with the optional roleName present", () => {
		assert.equal(isToolApproveArg({ toolName: "bash_bg", toolGroup: "shell", roleName: "writer" }), true);
	});

	it("rejects a missing toolGroup", () => {
		assert.equal(isToolApproveArg({ toolName: "bash_bg" }), false);
	});

	it("rejects null/undefined/non-object values", () => {
		assert.equal(isToolApproveArg(null), false);
		assert.equal(isToolApproveArg(undefined), false);
		assert.equal(isToolApproveArg("bash_bg"), false);
		assert.equal(isToolApproveArg(42), false);
	});
});

describe("isToolApproveEnforceMode", () => {
	afterEach(() => {
		delete process.env.BOBBIT_CLF_TOOL_APPROVE;
	});

	it("is false (observe) when unset", () => {
		delete process.env.BOBBIT_CLF_TOOL_APPROVE;
		assert.equal(isToolApproveEnforceMode(), false);
	});

	it("is true only for the exact string 'enforce'", () => {
		process.env.BOBBIT_CLF_TOOL_APPROVE = "enforce";
		assert.equal(isToolApproveEnforceMode(), true);
	});

	it("stays observe for any other value — no truthy-string coercion", () => {
		for (const value of ["1", "true", "Enforce", "ENFORCE", "observe", ""]) {
			process.env.BOBBIT_CLF_TOOL_APPROVE = value;
			assert.equal(isToolApproveEnforceMode(), false, `expected observe for value ${JSON.stringify(value)}`);
		}
	});
});

describe("isAutoDenyDecision", () => {
	it("is true only for select(choice: 'deny')", () => {
		assert.equal(isAutoDenyDecision({ kind: "select", choice: "deny" }), true);
	});

	it("is false for select(choice: 'allow') — allow never auto-applies this wave", () => {
		assert.equal(isAutoDenyDecision({ kind: "select", choice: "allow" }), false);
	});

	it("is false for abstain", () => {
		assert.equal(isAutoDenyDecision({ kind: "abstain" }), false);
	});

	it("is false for undefined (no decision produced)", () => {
		assert.equal(isAutoDenyDecision(undefined), false);
	});
});
