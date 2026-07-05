/**
 * In-proc-bridge eligibility-signal, step 2 (docs/design/in-process-bridge-spike.md
 * "Go/no-go recommendation for step-2 productionization"): pins
 * `reviewerEligibilityCensus` (`verification-harness.ts`), the function now
 * called at every verification reviewer/QA spawn site — `runLlmReviewViaSession`,
 * the agent-qa session path, and the legacy direct-RpcBridge fallback — to
 * derive and log the read-only signal for the highest-volume reviewer
 * fan-out (previously: nothing logged this anywhere, so the eligible
 * population was unmeasurable without re-deriving it by hand).
 *
 * Scope: this file pins the DERIVATION at the spawn seam in isolation (no
 * SessionManager/RpcBridge spun up — that's already covered by the
 * `runLlmReview*`/`runAgentQa*` integration tests elsewhere, which stub the
 * step entirely and never exercise real tool resolution). It also re-pins
 * (alongside `tests/in-process-bridge-spike.test.ts`) that recording the
 * signal is pure observation: it never flips eligibility itself, and the
 * default (`BOBBIT_INPROC_BRIDGE` unset) path is untouched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { reviewerEligibilityCensus } = await import("../src/server/agent/verification-harness.ts");
const { isInProcessBridgeEligible } = await import("../src/server/agent/in-process-bridge-eligibility.ts");

function captureDebug(): { calls: string[]; restore: () => void } {
	const calls: string[] = [];
	const original = console.debug;
	console.debug = (...args: unknown[]) => { calls.push(args.map(String).join(" ")); };
	return { calls, restore: () => { console.debug = original; } };
}

describe("reviewerEligibilityCensus (spawn-seam derivation)", () => {
	it("an allowlist carrying bash -> false (today's real built-in reviewer shape)", () => {
		const cap = captureDebug();
		try {
			const result = reviewerEligibilityCensus("llm-review", "code-reviewer", "sess-1", ["read", "grep", "bash", "write"]);
			assert.equal(result, false);
		} finally { cap.restore(); }
	});

	it("a pure-read allowlist -> true", () => {
		const cap = captureDebug();
		try {
			const result = reviewerEligibilityCensus("agent-qa", "qa-tester", "sess-2", ["read", "grep", "find", "ls"]);
			assert.equal(result, true);
		} finally { cap.restore(); }
	});

	it("an MCP tool present -> false (fail-closed, same as isReadOnlyToolPolicy)", () => {
		const cap = captureDebug();
		try {
			const result = reviewerEligibilityCensus("llm-review", "reviewer", "sess-3", ["read", "grep", "mcp__github__create_pr"]);
			assert.equal(result, false);
		} finally { cap.restore(); }
	});

	it("undefined (unrestricted allowlist — the shape createSession sees when nothing threads allowedTools) -> false, fails closed", () => {
		const cap = captureDebug();
		try {
			const result = reviewerEligibilityCensus("llm-review", "reviewer", "sess-4", undefined);
			assert.equal(result, false);
		} finally { cap.restore(); }
	});

	it("logs a single debug-level census line carrying kind/role/session/readOnly", () => {
		const cap = captureDebug();
		try {
			reviewerEligibilityCensus("agent-qa", "test-engineer", "sess-5", ["read", "grep"]);
			assert.equal(cap.calls.length, 1);
			const line = cap.calls[0];
			assert.match(line, /\[verification\] in-proc-bridge census:/);
			assert.match(line, /kind=agent-qa/);
			assert.match(line, /role=test-engineer/);
			assert.match(line, /session=sess-5/);
			assert.match(line, /readOnly=true/);
		} finally { cap.restore(); }
	});

	it("logs tools=unrestricted when allowedTools is undefined", () => {
		const cap = captureDebug();
		try {
			reviewerEligibilityCensus("llm-review", "reviewer", "sess-6", undefined);
			assert.match(cap.calls[0], /tools=unrestricted/);
			assert.match(cap.calls[0], /readOnly=false/);
		} finally { cap.restore(); }
	});
});

describe("byte-identical default behavior (BOBBIT_INPROC_BRIDGE unset)", () => {
	const originalFlag = process.env.BOBBIT_INPROC_BRIDGE;
	function restoreFlag() {
		if (originalFlag === undefined) delete process.env.BOBBIT_INPROC_BRIDGE;
		else process.env.BOBBIT_INPROC_BRIDGE = originalFlag;
	}

	it("recording the census signal (readOnly derived + logged) never flips eligibility when the flag is unset", () => {
		delete process.env.BOBBIT_INPROC_BRIDGE;
		try {
			const cap = captureDebug();
			let derived: boolean;
			try {
				derived = reviewerEligibilityCensus("llm-review", "reviewer", "sess-7", ["read", "grep"]);
			} finally { cap.restore(); }
			assert.equal(derived, true, "the allowlist itself is genuinely read-only");
			// Passing the exact same signal (readOnly: true) into
			// isInProcessBridgeEligible must still be ineligible with the flag
			// unset — the census function's job is observation, not a second
			// eligibility gate.
			assert.equal(isInProcessBridgeEligible({ readOnly: derived, allowedTools: ["read", "grep"] }), false);
		} finally { restoreFlag(); }
	});

	it("readOnly not passed (undefined, today's default at every createSession call site) is ignored without the flag, same as before this lane", () => {
		delete process.env.BOBBIT_INPROC_BRIDGE;
		try {
			assert.equal(isInProcessBridgeEligible({}), false);
			assert.equal(isInProcessBridgeEligible({ allowedTools: ["read", "grep"] }), false);
		} finally { restoreFlag(); }
	});
});
