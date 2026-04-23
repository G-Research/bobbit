/**
 * Reproducing test for "Fix review/naming models under AI Gateway".
 *
 * Asserts the DESIRED contract of applyReviewModelOverrides — currently
 * implemented as a silent-swallow stub mirroring today's bug in
 * verification-harness.ts. These tests are expected to FAIL until the
 * helper is implemented properly (implementation gate).
 *
 * Run with:
 *   npx tsx --test --test-force-exit tests/review-model-override.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	applyReviewModelOverrides,
	type ReviewModelRpc,
	type ReviewModelPrefs,
} from "../src/server/agent/review-model-override.ts";

function makePrefs(values: Record<string, string | undefined>): ReviewModelPrefs {
	return { get: (k: string) => values[k] };
}

function makeRpc(overrides: Partial<ReviewModelRpc> = {}): ReviewModelRpc & {
	setModelCalls: Array<[string, string]>;
	getStateCalls: number;
} {
	const setModelCalls: Array<[string, string]> = [];
	let getStateCalls = 0;
	const rpc: any = {
		setModelCalls,
		get getStateCalls() { return getStateCalls; },
		async setModel(provider: string, modelId: string) {
			setModelCalls.push([provider, modelId]);
			return undefined;
		},
		async getState() {
			getStateCalls++;
			const last = setModelCalls[setModelCalls.length - 1];
			if (!last) return { model: { id: "unknown", provider: "unknown" } };
			return { model: { id: last[1], provider: last[0] } };
		},
		...overrides,
	};
	Object.defineProperty(rpc, "getStateCalls", { get: () => getStateCalls });
	return rpc;
}

describe("applyReviewModelOverrides — desired contract", () => {
	it("(a) re-throws when setModel rejects (setModel must throw)", async () => {
		const rpc = makeRpc({
			async setModel() { throw new Error("agent rejected set_model: unknown model"); },
		});
		const prefs = makePrefs({ "default.reviewModel": "aigw/us.anthropic.claude-haiku-4-5" });

		await assert.rejects(
			applyReviewModelOverrides(rpc, { prefs }),
			/setModel must throw|set.?model|unknown model|reject/i,
			"helper must propagate setModel failures — silent swallow is the bug",
		);
	});

	it("(b) throws on read-back mismatch when getState reports a different bound model", async () => {
		const rpc = makeRpc({
			async setModel() { /* pretend success */ return undefined; },
			async getState() {
				// Agent is still bound to session model, not the requested review model —
				// this is the exact scenario the bug produces under AI Gateway.
				return { model: { id: "us.anthropic.claude-opus-4-5", provider: "aigw" } };
			},
		});
		const prefs = makePrefs({ "default.reviewModel": "aigw/us.anthropic.claude-haiku-4-5" });

		await assert.rejects(
			applyReviewModelOverrides(rpc, { prefs }),
			/read-back mismatch|mismatch|bound model|does not match/i,
			"helper must read-back getState and throw on mismatch",
		);
	});

	it("(c) happy path — setModel succeeds and getState matches — resolves", async () => {
		const rpc = makeRpc();
		const prefs = makePrefs({ "default.reviewModel": "aigw/us.anthropic.claude-haiku-4-5" });

		await applyReviewModelOverrides(rpc, { prefs });
		assert.deepEqual(rpc.setModelCalls, [["aigw", "us.anthropic.claude-haiku-4-5"]]);
	});

	it("(d) unset pref — returns without calling setModel", async () => {
		const rpc = makeRpc();
		const prefs = makePrefs({});

		await applyReviewModelOverrides(rpc, { prefs });
		assert.equal(rpc.setModelCalls.length, 0, "setModel must not be called when pref is unset");
	});

	it("(e) malformed pref (no slash) — throws", async () => {
		const rpc = makeRpc();
		const prefs = makePrefs({ "default.reviewModel": "not-a-valid-pref" });

		await assert.rejects(
			applyReviewModelOverrides(rpc, { prefs }),
			/malformed|invalid|slash|format/i,
			"helper must reject malformed prefs rather than silently ignoring",
		);
		assert.equal(rpc.setModelCalls.length, 0);
	});
});
