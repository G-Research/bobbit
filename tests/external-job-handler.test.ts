/**
 * Unit tests for the external-job verify-step handler — the first plugin-style
 * built-in handler routed through the VerifyHandlerRegistry. Exercises the
 * callback token lifecycle (success, timeout, tampered triple, unknown token).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
	externalJobHandler,
	deliverExternalJobCallback,
	pendingExternalCount,
	_clearPendingExternalForTests,
} from "../src/server/agent/verify-handlers/external-job-handler.ts";
import type { VerifyExecCtx } from "../src/server/agent/verify-handlers/registry.ts";
import type { VerifyStep } from "../src/server/agent/workflow-store.ts";

function ctx(goalId = "g1", gateId = "gate-a", signalId = "sig-1"): VerifyExecCtx {
	return {
		goalId, gateId, signalId,
		signal: {} as any,
		gate: {} as any,
		cwd: "/tmp",
		branch: "feature",
		primaryBranch: "master",
		builtinVars: {},
		projectVars: {},
		agentVars: {},
		substituteVars: (t: string) => t,
		broadcast: () => {},
		persistActive: () => {},
		isCancelled: () => false,
	};
}

function step(timeout?: number): VerifyStep {
	return { name: "Training run", type: "external-job", timeout };
}

describe("external-job handler", () => {
	beforeEach(() => _clearPendingExternalForTests());

	it("execute() registers a pending callback and returns a Promise", async () => {
		const c = ctx();
		const promise = externalJobHandler.execute(c, step(60));
		// The promise hasn't resolved yet; one pending entry exists.
		assert.equal(pendingExternalCount(), 1);
		// Avoid leaking the un-resolved promise — resolve it via callback below.
		void promise;
	});

	it("broadcasts a token that the caller can use to deliver the callback", async () => {
		let receivedToken: string | undefined;
		const c: VerifyExecCtx = {
			...ctx(),
			broadcast: (event: unknown) => {
				const ev = event as Record<string, unknown>;
				if (ev.type === "gate_verification_external_pending" && typeof ev.token === "string") {
					receivedToken = ev.token;
				}
			},
		};
		const promise = externalJobHandler.execute(c, step(60));
		assert.ok(receivedToken, "expected a token in the broadcast event");

		const outcome = deliverExternalJobCallback(receivedToken, {
			goalId: "g1", gateId: "gate-a", signalId: "sig-1",
			passed: true, summary: "Done.",
		});
		assert.deepEqual(outcome, { ok: true });
		const result = await promise;
		assert.equal(result.passed, true);
		assert.equal(result.output, "Done.");
	});

	it("rejects callback when triple does not match", async () => {
		let token: string | undefined;
		const c: VerifyExecCtx = {
			...ctx("g1", "gate-a", "sig-1"),
			broadcast: (ev: any) => { if (ev.token) token = ev.token; },
		};
		const promise = externalJobHandler.execute(c, step(60));
		assert.ok(token);

		const wrongGoal = deliverExternalJobCallback(token, {
			goalId: "g-other", gateId: "gate-a", signalId: "sig-1", passed: true,
		});
		assert.equal(wrongGoal.ok, false);
		assert.equal((wrongGoal as any).status, 403);
		// Original entry is still pending — bad callbacks must not consume it.
		assert.equal(pendingExternalCount(), 1);
		// Clean up the still-pending entry.
		deliverExternalJobCallback(token, {
			goalId: "g1", gateId: "gate-a", signalId: "sig-1", passed: false,
		});
		await promise;
	});

	it("rejects unknown tokens with 404", () => {
		const outcome = deliverExternalJobCallback("does-not-exist", {
			goalId: "g1", gateId: "gate-a", signalId: "sig-1", passed: true,
		});
		assert.equal(outcome.ok, false);
		assert.equal((outcome as any).status, 404);
	});

	it("rejects expired tokens with 410", async () => {
		let token: string | undefined;
		const c: VerifyExecCtx = {
			...ctx(),
			broadcast: (ev: any) => { if (ev.token) token = ev.token; },
		};
		// timeout=1 → callback registered with expiresAt = now + 1s.
		const promise = externalJobHandler.execute(c, step(1));
		assert.ok(token);

		await new Promise(r => setTimeout(r, 1100));
		const outcome = deliverExternalJobCallback(token, {
			goalId: "g1", gateId: "gate-a", signalId: "sig-1", passed: true,
		});
		// Either the timeout already fired (404) or the callback found it expired (410).
		// Both are acceptable — they share the contract that the token is no longer usable.
		assert.equal(outcome.ok, false);
		assert.ok([404, 410].includes((outcome as any).status));
		// The promise resolves to a timeout failure once the timer fires.
		const result = await promise;
		assert.equal(result.passed, false);
		assert.match(result.output, /timed out/);
	});

	it("each callback is single-use — second delivery returns 404", async () => {
		let token: string | undefined;
		const c: VerifyExecCtx = {
			...ctx(),
			broadcast: (ev: any) => { if (ev.token) token = ev.token; },
		};
		const promise = externalJobHandler.execute(c, step(60));
		assert.ok(token);
		const first = deliverExternalJobCallback(token, {
			goalId: "g1", gateId: "gate-a", signalId: "sig-1", passed: true,
		});
		assert.equal(first.ok, true);
		const second = deliverExternalJobCallback(token, {
			goalId: "g1", gateId: "gate-a", signalId: "sig-1", passed: true,
		});
		assert.equal(second.ok, false);
		assert.equal((second as any).status, 404);
		await promise;
	});

	it("passes artifact through to the verify-step result", async () => {
		let token: string | undefined;
		const c: VerifyExecCtx = {
			...ctx(),
			broadcast: (ev: any) => { if (ev.token) token = ev.token; },
		};
		const promise = externalJobHandler.execute(c, step(60));
		assert.ok(token);
		deliverExternalJobCallback(token, {
			goalId: "g1", gateId: "gate-a", signalId: "sig-1",
			passed: true, summary: "ok",
			artifact: { content: "# Training Report\nTop-line: 0.92", contentType: "text/markdown" },
		});
		const result = await promise;
		assert.equal(result.artifact?.contentType, "text/markdown");
		assert.match(result.artifact?.content ?? "", /Top-line/);
	});
});
