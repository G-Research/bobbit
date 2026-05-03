/**
 * Reproducing test for goal "Production-grade PWA resume" §6.1 + §9.4.
 *
 * The fix introduces a NEW module `src/app/ui-snapshot.ts` that
 * serializes a slice of UI state into localStorage (debounced, byte-budgeted
 * to ~512 KB, LRU-trimmed per-session message arrays capped at the last 200,
 * keyed by gateway URL + token-fingerprint + BUILD_ID). The hydrate path
 * round-trips that JSON back into a `state`-shaped projection that the
 * bootstrap can dispatch as `{type:"snapshot",messages}` through the
 * existing reducer.
 *
 * THIS TEST FAILS TODAY because `src/app/ui-snapshot.ts` does not exist —
 * the import below throws `Cannot find module` (or a tsx/Node ERR_MODULE_NOT_FOUND).
 * The error string contains the literal text `ui-snapshot` which the
 * team-lead will register as part of the `error_pattern` regex on the
 * `reproducing-test` gate.
 *
 * After the fix lands the module resolves, the round-trip + LRU-trim +
 * byte-budget assertions below take over and gate the implementation's
 * correctness.
 *
 * Run: `npx tsx --test tests/pwa-ui-snapshot.test.ts`
 *
 * Expected error today (substring): `Cannot find module` ... `ui-snapshot`
 *                              OR : `ERR_MODULE_NOT_FOUND` ... `ui-snapshot`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Intentional unresolved import — the module ships in Stream A of the fix.
// The import error IS the reproducing failure today. Do NOT change the path
// without coordinating with the implementation agent.
//
// @ts-expect-error -- module added by the implementation; absence is the repro.
import * as snapshot from "../src/app/ui-snapshot.ts";

// Minimal in-memory localStorage shim so the module's writer can run under
// node --test with no DOM. The implementation MUST accept either a real
// `Storage` object or a shim conforming to the `Storage`-interface subset
// (getItem / setItem / removeItem / key / length).
function makeStorage(): Storage {
	const map = new Map<string, string>();
	const s: any = {
		get length() { return map.size; },
		key: (i: number) => Array.from(map.keys())[i] ?? null,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => { map.set(k, String(v)); },
		removeItem: (k: string) => { map.delete(k); },
		clear: () => { map.clear(); },
	};
	return s as Storage;
}

// Build a representative state projection: 5 000 messages — each a small
// assistant text row carrying a unique id + toolCallId. Total raw JSON
// is ~600 KB, well above the 512 KB cap → must be LRU-trimmed.
function buildHugeState() {
	const messages: any[] = [];
	for (let i = 0; i < 5000; i++) {
		messages.push({
			id: `msg-${i}`,
			role: "assistant",
			content: [{ type: "toolCall", id: `tc-${i}`, name: "noop", input: {} }],
			text: `m${i}-${"x".repeat(50)}`,
		});
	}
	return {
		projects: [{ id: "p1", name: "Test" }],
		activeProjectId: "p1",
		goals: [],
		archivedSessions: [],
		selectedSessionId: "s1",
		hashRoute: "#/session/s1",
		sessions: { s1: {
			id: "s1",
			title: "Test session",
			model: "anthropic/claude-3-5-sonnet",
			connectionStatus: "connected",
			pendingToolCalls: [],
			scrollTop: 1234,
			messages,
		} },
	};
}

describe("ui-snapshot module — snapshot module not found is the reproducing failure", () => {
	it("module exports the expected serializer surface", () => {
		// Some name in this set must exist — the exact API is the
		// implementation agent's call, but a serialize/hydrate pair is
		// the contract written into the issue analysis.
		const exported = Object.keys(snapshot ?? {});
		assert.ok(
			exported.length > 0,
			`snapshot module not found / empty exports — expected serialize+hydrate API. got: ${JSON.stringify(exported)}`,
		);
	});

	it("serialize → hydrate round-trips a representative state under the 512 KB cap", () => {
		const storage = makeStorage();
		const state = buildHugeState();

		const serialize = (snapshot as any).serialize ?? (snapshot as any).writeSnapshot ?? (snapshot as any).default;
		const hydrate = (snapshot as any).hydrate ?? (snapshot as any).readSnapshot;
		assert.equal(typeof serialize, "function", "snapshot module not found: serialize/writeSnapshot export missing");
		assert.equal(typeof hydrate, "function", "snapshot module not found: hydrate/readSnapshot export missing");

		// Implementation may take (state, storage, key?) or (state, {storage,key}) —
		// try the most common shape, fall back to the alternative.
		try {
			serialize(state, { storage, key: "bobbit.ui-snapshot.v1" });
		} catch {
			serialize(state, storage, "bobbit.ui-snapshot.v1");
		}

		// Inspect every value the impl wrote and assert the 512 KB cap holds
		// for the persisted blob (one or many keys; cumulative is what matters).
		let totalBytes = 0;
		for (let i = 0; i < storage.length; i++) {
			const k = storage.key(i)!;
			const v = storage.getItem(k);
			if (v != null) totalBytes += v.length;
		}
		assert.ok(
			totalBytes < 512 * 1024,
			`snapshot byte-budget exceeded: ${totalBytes} bytes > 512 KB cap`,
		);
		assert.ok(totalBytes > 0, "snapshot serializer produced no output");

		// Hydrate it back.
		let restored: any;
		try {
			restored = hydrate({ storage, key: "bobbit.ui-snapshot.v1" });
		} catch {
			restored = hydrate(storage, "bobbit.ui-snapshot.v1");
		}
		assert.ok(restored, "snapshot hydrate returned null/undefined");

		// LRU trim: per-session messages array is capped at the last 200.
		const restoredMessages: any[] | undefined =
			restored?.sessions?.s1?.messages ?? restored?.activeSession?.messages ?? restored?.messages;
		assert.ok(Array.isArray(restoredMessages), "hydrated state missing messages array");
		assert.ok(
			restoredMessages!.length <= 200,
			`LRU trim violated: hydrated message count ${restoredMessages!.length} > 200 cap`,
		);
		// The TAIL must be preserved (the most recent 200 messages, not the head).
		const last = restoredMessages![restoredMessages!.length - 1];
		assert.equal(last.id, "msg-4999", `expected last message id msg-4999 — LRU dropped the tail instead of the head: got ${last.id}`);
		// Dedup keys (id, toolCallId) preserved on every survivor.
		for (const m of restoredMessages!) {
			assert.ok(typeof m.id === "string" && m.id.length > 0, "snapshot dropped message id during round-trip");
			const tc = Array.isArray(m.content) ? m.content.find((b: any) => b.type === "toolCall") : null;
			if (tc) assert.ok(typeof tc.id === "string", "snapshot dropped toolCall.id during round-trip");
		}
	});

	it("hydrate returns null when no snapshot is present (cold start)", () => {
		const storage = makeStorage();
		const hydrate = (snapshot as any).hydrate ?? (snapshot as any).readSnapshot;
		assert.equal(typeof hydrate, "function", "snapshot module not found: hydrate export missing");
		let restored: any;
		try {
			restored = hydrate({ storage, key: "bobbit.ui-snapshot.v1" });
		} catch {
			restored = hydrate(storage, "bobbit.ui-snapshot.v1");
		}
		assert.ok(restored === null || restored === undefined, "expected null on cold-start hydrate");
	});
});
