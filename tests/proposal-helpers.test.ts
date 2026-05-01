/**
 * Unit tests for `src/app/proposal-helpers.ts`.
 *
 * The dismissal half (fingerprint, key shape, legacy migration) is pure DOM
 * — only `localStorage`. The draft half lazily imports `./api.js` which in
 * turn lazily reaches `fetch`. We stub both up-front so the helpers run
 * cleanly under node:test.
 */

// ---- Module-load shims (must run before importing the module under test) ----

interface FakeStorage {
	getItem(k: string): string | null;
	setItem(k: string, v: string): void;
	removeItem(k: string): void;
	clear(): void;
}

function makeFakeStorage(): FakeStorage {
	const m = new Map<string, string>();
	return {
		getItem(k) { return m.get(k) ?? null; },
		setItem(k, v) { m.set(k, v); },
		removeItem(k) { m.delete(k); },
		clear() { m.clear(); },
	};
}

(globalThis as any).localStorage = makeFakeStorage();
(globalThis as any).window = { location: { origin: "http://localhost" }, addEventListener: () => {} };
(globalThis as any).document = { documentElement: { dataset: {} }, addEventListener: () => {}, dispatchEvent: () => {} };

interface FetchCall { url: string; method: string; body?: string }
const fetchCalls: FetchCall[] = [];
const fakeDraftStore = new Map<string, unknown>();

(globalThis as any).fetch = async (url: string | URL, opts: any = {}): Promise<Response> => {
	const u = new URL(String(url), "http://localhost");
	const call: FetchCall = { url: u.pathname + u.search, method: opts.method || "GET", body: opts.body };
	fetchCalls.push(call);
	const m = u.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (m) {
		const sid = m[1];
		if (call.method === "PUT") {
			const parsed = JSON.parse(opts.body);
			fakeDraftStore.set(`${sid}|${parsed.type}`, parsed.data);
			return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (call.method === "DELETE") {
			const type = u.searchParams.get("type");
			fakeDraftStore.delete(`${sid}|${type}`);
			return new Response("", { status: 204 });
		}
		const type = u.searchParams.get("type");
		const data = fakeDraftStore.get(`${sid}|${type}`);
		if (data === undefined) {
			return new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } });
		}
		return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
	}
	return new Response(JSON.stringify({}), { status: 404 });
};

// ---- Module under test ----

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const helpers = await import("../src/app/proposal-helpers.ts");
const {
	isProposalDismissed,
	markProposalDismissed,
	clearProposalDismissed,
	saveProposalDraft,
	loadProposalDraft,
	deleteProposalDraft,
	_cancelAllPendingProposalDraftSaves,
} = helpers;

const TYPES = ["goal", "project", "workflow", "role", "tool", "staff"] as const;

describe("proposal-helpers — dismissal fingerprint", () => {
	beforeEach(() => {
		(localStorage as any).clear();
		_cancelAllPendingProposalDraftSaves();
	});

	it("storage key is `bobbit-${type}-proposal-dismissed-${sessionId}`", () => {
		const sid = "sess-123";
		markProposalDismissed(sid, "goal", { title: "T", spec: "B" });
		// The legacy goal key pattern is byte-equal to the new schema; that's
		// the explicit migration story documented in proposal-helpers.ts.
		const raw = localStorage.getItem(`bobbit-goal-proposal-dismissed-${sid}`);
		assert.ok(raw, "expected fingerprint stored under the canonical key");

		markProposalDismissed(sid, "project", { name: "p" });
		const projRaw = localStorage.getItem(`bobbit-project-proposal-dismissed-${sid}`);
		assert.ok(projRaw, "expected project fingerprint under namespaced key");

		// goal and project keys must not collide
		assert.notEqual(raw, projRaw);
	});

	it("round-trip mark / check / clear works for every type", () => {
		const sid = "sess-rt";
		const fields = { a: 1, b: "two" };
		for (const t of TYPES) {
			assert.equal(isProposalDismissed(sid, t, fields), false, `${t}: clean state`);
			markProposalDismissed(sid, t, fields);
			assert.equal(isProposalDismissed(sid, t, fields), true, `${t}: marked sticks`);
			assert.equal(
				isProposalDismissed(sid, t, { a: 1, b: "different" }),
				false,
				`${t}: different fields don't match`,
			);
			clearProposalDismissed(sid, t);
			assert.equal(isProposalDismissed(sid, t, fields), false, `${t}: cleared`);
		}
	});

	it("fingerprint is order-independent", () => {
		const sid = "sess-order";
		markProposalDismissed(sid, "goal", { title: "X", spec: "Y" });
		assert.equal(isProposalDismissed(sid, "goal", { spec: "Y", title: "X" }), true);
	});

	it("dismissals are session-scoped", () => {
		markProposalDismissed("s1", "goal", { title: "T" });
		assert.equal(isProposalDismissed("s1", "goal", { title: "T" }), true);
		assert.equal(isProposalDismissed("s2", "goal", { title: "T" }), false);
	});

	it("legacy goal-key value reads through cleanly via the new helper", () => {
		// The legacy schema's storage key format is identical to the new one
		// for the `goal` type. A pre-existing legacy value must therefore be
		// honoured without a migration write.
		const sid = "legacy-sess";
		const fields = { title: "Legacy", spec: "B" };
		// Pre-seed with the canonical fingerprint as if written by the old code.
		const expectedFp = JSON.stringify({ spec: "B", title: "Legacy" });
		localStorage.setItem(`bobbit-goal-proposal-dismissed-${sid}`, expectedFp);
		assert.equal(isProposalDismissed(sid, "goal", fields), true);
	});

	it("dismissal helpers tolerate missing localStorage entries", () => {
		// `removeItem` on a non-existent key is a no-op everywhere; the helper
		// must not throw. (Defensive coverage for the try/catch.)
		assert.doesNotThrow(() => clearProposalDismissed("nope", "goal"));
		assert.equal(isProposalDismissed("nope", "goal", { title: "x" }), false);
	});
});

describe("proposal-helpers — draft load/save/delete", () => {
	before(() => {
		// Drop any debounced timers from a prior describe block.
		_cancelAllPendingProposalDraftSaves();
	});

	beforeEach(() => {
		fakeDraftStore.clear();
		fetchCalls.length = 0;
		_cancelAllPendingProposalDraftSaves();
	});

	function flushDebounceWait(ms = 400): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	it("save → load round-trip per type", async () => {
		for (const type of TYPES) {
			const sid = `sess-${type}`;
			const body = { hello: type, count: 42 };
			saveProposalDraft(sid, type, body);
			await flushDebounceWait();
			const loaded = await loadProposalDraft(sid, type);
			assert.deepEqual(loaded, body, `${type}: round-trip body`);
		}
	});

	it("load returns null when no draft exists", async () => {
		const out = await loadProposalDraft("never-saved", "goal");
		assert.equal(out, null);
	});

	it("delete removes the draft", async () => {
		const sid = "sess-del";
		saveProposalDraft(sid, "project", { name: "p" });
		await flushDebounceWait();
		assert.notEqual(await loadProposalDraft(sid, "project"), null);
		deleteProposalDraft(sid, "project");
		// delete is fire-and-forget; let the microtask flush.
		await flushDebounceWait(50);
		assert.equal(await loadProposalDraft(sid, "project"), null);
	});

	it("save uses the namespaced draft type", async () => {
		const sid = "sess-namespace";
		saveProposalDraft(sid, "workflow", { id: "wf" });
		await flushDebounceWait();
		const put = fetchCalls.find((c) => c.method === "PUT" && c.url.includes(sid));
		assert.ok(put, "expected a PUT for the workflow draft");
		const body = JSON.parse(put!.body || "{}");
		assert.equal(body.type, "workflow-proposal");
		assert.deepEqual(body.data, { id: "wf" });
	});

	it("rapid saves coalesce via the debouncer", async () => {
		const sid = "sess-debounce";
		fetchCalls.length = 0;
		saveProposalDraft(sid, "role", { v: 1 });
		saveProposalDraft(sid, "role", { v: 2 });
		saveProposalDraft(sid, "role", { v: 3 });
		await flushDebounceWait();
		const puts = fetchCalls.filter((c) => c.method === "PUT" && c.url.includes(sid));
		assert.equal(puts.length, 1, "expected debounced calls to coalesce to one PUT");
		const body = JSON.parse(puts[0].body || "{}");
		assert.deepEqual(body.data, { v: 3 });
	});

	it("delete cancels a pending debounced save", async () => {
		const sid = "sess-cancel";
		fetchCalls.length = 0;
		saveProposalDraft(sid, "tool", { v: 99 });
		// Cancel before debounce fires
		deleteProposalDraft(sid, "tool");
		await flushDebounceWait();
		const puts = fetchCalls.filter((c) => c.method === "PUT" && c.url.includes(sid));
		assert.equal(puts.length, 0, "expected no PUT after delete-cancels-debounce");
	});
});
