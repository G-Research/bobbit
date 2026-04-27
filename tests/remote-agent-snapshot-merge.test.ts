/**
 * Bug 2 — synthetic compaction message (and stale permission cards) trail
 * after newer ones when a `messages` snapshot replaces the local list.
 *
 * Reproduces the bug in src/app/remote-agent.ts (~lines 803–840):
 *
 *   case "messages": {
 *     this._state.messages = msgs.map(enrichUserMessage);
 *     ...
 *     if (this._compactionSyntheticMessages.length > 0) {
 *       this._state.messages = [...this._state.messages, ...this._compactionSyntheticMessages];
 *     }
 *     if (this._pendingPermissionCards.length > 0) {
 *       this._state.messages = [...this._state.messages, ...this._pendingPermissionCards];
 *     }
 *   }
 *
 * The buckets are appended unconditionally after the server snapshot is
 * applied. When the snapshot already contains a server-persisted copy of
 * the compaction marker (or a permission card whose grant has already
 * been reflected server-side) the synthetic copy lands AFTER subsequent
 * messages — exactly matching the user's "old messages rendered after the
 * latest" symptom.
 *
 * The expected post-fix behaviour: snapshot is authoritative for any id it
 * contains (or, for the compaction marker, for any assistant message whose
 * text starts with "Context compacted"). Buckets only fill in messages
 * whose ids the snapshot lacks; final result keeps server snapshot order.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// ── Minimal browser-API shims ─────────────────────────────────────────
// remote-agent.ts and its transitive imports (state.ts, favicon-badge.ts,
// AnnotationStore.ts, …) touch `window`, `document`, `localStorage`,
// `WebSocket`, `fetch` at module-eval time. Provide just enough so the
// import doesn't throw. We never connect a real socket in these tests —
// we feed frames straight into `handleServerMessage` via reflection.
const g = globalThis as any;
if (typeof g.localStorage === "undefined") {
	const store = new Map<string, string>();
	g.localStorage = {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => store.set(k, String(v)),
		removeItem: (k: string) => store.delete(k),
		clear: () => store.clear(),
		key: (i: number) => Array.from(store.keys())[i] ?? null,
		get length() { return store.size; },
	};
}
if (typeof g.window === "undefined") {
	g.window = {
		innerWidth: 1024,
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => true,
		location: { hash: "" },
	};
}
if (typeof g.document === "undefined") {
	// Lit-html (pulled in transitively via custom-messages.ts) inspects
	// `document.createTreeWalker` at module-eval. Provide enough of the API
	// to satisfy module init; we never actually render anything in the test.
	g.document = new Proxy({
		addEventListener: () => {},
		removeEventListener: () => {},
		visibilityState: "visible",
		documentElement: { style: { setProperty: () => {} } },
		createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
		createElement: () => ({ setAttribute: () => {}, append: () => {}, appendChild: () => {} }),
		createElementNS: () => ({ setAttribute: () => {}, append: () => {}, appendChild: () => {} }),
		createTextNode: () => ({}),
		createDocumentFragment: () => ({ appendChild: () => {}, append: () => {} }),
		createComment: () => ({}),
		body: null,
		head: null,
	}, {
		get(target, prop) {
			if (prop in target) return (target as any)[prop];
			return () => undefined;
		},
	});
}
if (typeof g.Node === "undefined") {
	g.Node = class {} as any;
	(g.Node as any).ELEMENT_NODE = 1;
	(g.Node as any).TEXT_NODE = 3;
	(g.Node as any).COMMENT_NODE = 8;
}
if (typeof g.HTMLElement === "undefined") g.HTMLElement = class {};
if (typeof g.Element === "undefined") g.Element = class {};
if (typeof g.WebSocket === "undefined") {
	g.WebSocket = class { static OPEN = 1; readyState = 0; };
}
if (typeof g.fetch === "undefined") {
	g.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
}
if (typeof g.HashChangeEvent === "undefined") {
	g.HashChangeEvent = class { constructor(_: string) {} };
}
if (typeof g.CustomEvent === "undefined") {
	g.CustomEvent = class { constructor(public type: string, public detail?: any) {} };
}

// Dynamic import — must come AFTER the shims above are in place.
let RemoteAgentCtor: any;
before(async () => {
	const mod = await import("../src/app/remote-agent.ts");
	RemoteAgentCtor = mod.RemoteAgent;
});

function makeServerFrame(messages: any[]) {
	// Matches the production client-side WS frame shape.
	return { type: "messages", data: messages };
}

function dispatch(remote: any, frame: any): Promise<void> {
	// `handleServerMessage` is private but `unknown`-cast access is fine for
	// a client-side unit test — RemoteAgent has no DI seam for this path.
	return remote.handleServerMessage(frame);
}

describe("RemoteAgent — `messages` snapshot merge", () => {
	it("does not duplicate the synthetic compaction marker when the server snapshot already contains it (with newer messages after)", async () => {
		const remote: any = new RemoteAgentCtor();

		// Synthetic compaction-end result the client pushed when /compact
		// finished. Stable client-generated id `compact_done_1`.
		const synthetic = {
			id: "compact_done_1",
			role: "assistant",
			content: "Context compacted from 12k tokens.",
			timestamp: 1_000,
		};
		remote._compactionSyntheticMessages = [synthetic];

		// Server transcript: m1, server-persisted compaction marker, then two
		// newer assistant/user messages that arrived AFTER compaction. Order
		// is the authoritative chronological order.
		const m1 = { id: "u_1", role: "user", content: "first user message", timestamp: 500 };
		const serverCompactionMarker = {
			id: "asst_compact_server_1",
			role: "assistant",
			content: "Context compacted from 12k tokens.",
			timestamp: 1_000,
		};
		const mPost1 = { id: "u_2", role: "user", content: "post-compaction question", timestamp: 1_500 };
		const mPost2 = { id: "asst_2", role: "assistant", content: "post-compaction answer", timestamp: 2_000 };
		const serverMessages = [m1, serverCompactionMarker, mPost1, mPost2];

		await dispatch(remote, makeServerFrame(serverMessages));

		const result = remote.state.messages as any[];

		// (1) Length matches the server snapshot — no trailing synthetic.
		assert.strictEqual(
			result.length,
			4,
			`messages.length should equal the server snapshot length (4); got ${result.length}. Trailing synthetic compaction message detected at index ${result.length - 1}: ${JSON.stringify(result[result.length - 1])}`,
		);

		// (2) The client's synthetic id `compact_done_1` is not present —
		// the server-persisted copy is authoritative.
		assert.ok(
			!result.some((m: any) => m.id === "compact_done_1"),
			`synthetic id 'compact_done_1' must be dropped because the server snapshot already contains the compaction marker; got ids: ${result.map((m: any) => m.id).join(", ")}`,
		);

		// (3) Order matches the server snapshot exactly.
		assert.deepStrictEqual(
			result.map((m: any) => m.id),
			serverMessages.map((m) => m.id),
			"messages order should match the server snapshot exactly",
		);
	});

	it("does not append a stale pending permission card after the server snapshot's newer messages", async () => {
		const remote: any = new RemoteAgentCtor();

		// A permission card whose grant has already been reflected server-side
		// (e.g. timeout, parallel session, or restart). The id is the stable
		// client-generated `perm_*` shape.
		const staleCard = {
			id: "perm_stale_1",
			role: "tool_permission_needed",
			content: "Allow Bash to run 'rm -rf /'?",
			timestamp: 800,
		};
		remote._pendingPermissionCards = [staleCard];

		// Server snapshot: contains the resolution and two newer messages.
		const m1 = { id: "u_1", role: "user", content: "do the thing", timestamp: 500 };
		const resolved = { id: "tool_result_1", role: "tool", content: "denied", timestamp: 900 };
		const mPost1 = { id: "u_2", role: "user", content: "ok try again", timestamp: 1_500 };
		const mPost2 = { id: "asst_2", role: "assistant", content: "sure", timestamp: 2_000 };
		const serverMessages = [m1, resolved, mPost1, mPost2];

		await dispatch(remote, makeServerFrame(serverMessages));

		const result = remote.state.messages as any[];

		// Length must equal server snapshot — no trailing stale card.
		assert.strictEqual(
			result.length,
			4,
			`messages.length should equal the server snapshot length (4); got ${result.length}. Trailing stale permission card at end: ${JSON.stringify(result[result.length - 1])}`,
		);

		// Stale card is not present.
		assert.ok(
			!result.some((m: any) => m.id === "perm_stale_1"),
			`stale permission card 'perm_stale_1' must be dropped when the snapshot reflects its resolution; got ids: ${result.map((m: any) => m.id).join(", ")}`,
		);

		// Order matches server snapshot.
		assert.deepStrictEqual(
			result.map((m: any) => m.id),
			serverMessages.map((m) => m.id),
			"messages order should match the server snapshot exactly",
		);
	});
});
