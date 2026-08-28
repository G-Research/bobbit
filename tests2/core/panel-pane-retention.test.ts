// v2-native — pure policy coverage for side-panel pane retention (design §4.1, §10).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PANEL_PANE_RETENTION_LIMIT,
	panePaneKey,
	parsePanePaneKey,
	resetPanelPaneRetention,
	retainedPanePlan,
} from "../../src/app/panel-pane-retention.js";

interface Tab {
	id: string;
}

const K = (session: string, tab: string) => panePaneKey(session, tab);

/** Resolve every key in `live` to a stable tab object; anything else is dead. */
function resolverFor(live: string[]): (key: string) => Tab | undefined {
	const tabs = new Map<string, Tab>();
	return (key) => {
		if (!live.includes(key)) return undefined;
		const parsed = parsePanePaneKey(key);
		if (!parsed) return undefined;
		let tab = tabs.get(key);
		if (!tab) {
			tab = { id: parsed.tabId };
			tabs.set(key, tab);
		}
		return tab;
	};
}

beforeEach(() => {
	resetPanelPaneRetention();
});

describe("panePaneKey / parsePanePaneKey", () => {
	it("round-trips ordinary and unusual tab ids", () => {
		for (const [sessionKey, tabId] of [
			["session-1", "tab-1"],
			["__no-session__", "pack:vscode-panel/editor?path=/a b/c#frag"],
			["session-2", "tab with spaces, emoji 🙂 and \\u0001 control"],
			["session-3", "a".repeat(300)],
		] as const) {
			const key = panePaneKey(sessionKey, tabId);
			expect(parsePanePaneKey(key)).toEqual({ sessionKey, tabId });
		}
	});

	it("returns undefined for malformed keys", () => {
		expect(parsePanePaneKey("")).toBeUndefined();
		expect(parsePanePaneKey("session-1:tab-1")).toBeUndefined();
		expect(parsePanePaneKey("session-1")).toBeUndefined();
		expect(parsePanePaneKey("session-1\u0000")).toBeUndefined();
		expect(parsePanePaneKey("session-1\u0000tab\u00001")).toBeUndefined();
	});

	it("keeps the retention limit at active + 2 hidden", () => {
		expect(PANEL_PANE_RETENTION_LIMIT).toBe(3);
	});
});

describe("retainedPanePlan insertion order", () => {
	it("is append-only and stable while the active key moves back and forth", () => {
		const a = K("s1", "t1");
		const b = K("s2", "t2");
		const resolve = resolverFor([a, b]);

		expect(retainedPanePlan({ activeKey: a, resolve }).map((s) => s.key)).toEqual([a]);
		expect(retainedPanePlan({ activeKey: b, resolve }).map((s) => s.key)).toEqual([a, b]);
		expect(retainedPanePlan({ activeKey: a, resolve }).map((s) => s.key)).toEqual([a, b]);
		expect(retainedPanePlan({ activeKey: b, resolve }).map((s) => s.key)).toEqual([a, b]);
		expect(retainedPanePlan({ activeKey: a, resolve }).map((s) => s.key)).toEqual([a, b]);
	});

	it("exposes the parsed session key and resolved tab per slot", () => {
		const a = K("s1", "t1");
		const b = K("s2", "t2");
		const resolve = resolverFor([a, b]);

		retainedPanePlan({ activeKey: a, resolve });
		const slots = retainedPanePlan({ activeKey: b, resolve });

		expect(slots).toEqual([
			{ key: a, sessionKey: "s1", tab: { id: "t1" }, hidden: true },
			{ key: b, sessionKey: "s2", tab: { id: "t2" }, hidden: false },
		]);
		expect(slots[0]?.tab).toBe(resolve(a));
	});

	it("marks exactly the active key visible and every other survivor hidden", () => {
		const keys = [K("s1", "t1"), K("s1", "t2"), K("s2", "t1")];
		const resolve = resolverFor(keys);
		for (const key of keys) retainedPanePlan({ activeKey: key, resolve });

		const slots = retainedPanePlan({ activeKey: keys[1], resolve });

		expect(slots.filter((slot) => !slot.hidden).map((slot) => slot.key)).toEqual([keys[1]]);
		expect(slots.filter((slot) => slot.hidden).map((slot) => slot.key)).toEqual([keys[0], keys[2]]);
	});

	it("hides every survivor when there is no active key", () => {
		const a = K("s1", "t1");
		const resolve = resolverFor([a]);
		retainedPanePlan({ activeKey: a, resolve });

		const slots = retainedPanePlan({ resolve });

		expect(slots.map((slot) => [slot.key, slot.hidden])).toEqual([[a, true]]);
	});

	it("is idempotent when called twice with the same input", () => {
		const keys = [K("s1", "t1"), K("s1", "t2"), K("s2", "t1")];
		const resolve = resolverFor(keys);
		for (const key of keys) retainedPanePlan({ activeKey: key, resolve });

		const first = retainedPanePlan({ activeKey: keys[0], resolve });
		const second = retainedPanePlan({ activeKey: keys[0], resolve });

		expect(second).toEqual(first);
		expect(second.map((slot) => slot.key)).toEqual(keys);
	});

	it("resolves every tracked key on each plan", () => {
		const keys = [K("s1", "t1"), K("s1", "t2")];
		const resolve = vi.fn(resolverFor(keys));
		retainedPanePlan({ activeKey: keys[0], resolve });
		retainedPanePlan({ activeKey: keys[1], resolve });
		resolve.mockClear();

		retainedPanePlan({ activeKey: keys[0], resolve });

		expect(resolve.mock.calls.map(([key]) => key)).toEqual(keys);
	});
});

describe("retainedPanePlan pruning", () => {
	it("drops a key whose resolve returns undefined", () => {
		const a = K("s1", "t1");
		const b = K("s1", "t2");
		const live = [a, b];
		const resolve = resolverFor(live);
		retainedPanePlan({ activeKey: a, resolve });
		retainedPanePlan({ activeKey: b, resolve });

		live.splice(live.indexOf(a), 1); // tab closed / pack uninstalled / session gone

		expect(retainedPanePlan({ activeKey: b, resolve }).map((s) => s.key)).toEqual([b]);
	});

	it("drops the active key too when it resolves dead", () => {
		const a = K("s1", "t1");
		const resolve = resolverFor([]);

		expect(retainedPanePlan({ activeKey: a, resolve })).toEqual([]);
	});

	it("re-adds a reopened key at the tail rather than resurrecting its old position", () => {
		const a = K("s1", "t1");
		const b = K("s1", "t2");
		const live = [a, b];
		const resolve = resolverFor(live);
		retainedPanePlan({ activeKey: a, resolve });
		retainedPanePlan({ activeKey: b, resolve });

		live.splice(live.indexOf(a), 1);
		expect(retainedPanePlan({ activeKey: b, resolve }).map((s) => s.key)).toEqual([b]);

		live.push(a); // reopened
		expect(retainedPanePlan({ activeKey: a, resolve }).map((s) => s.key)).toEqual([b, a]);
	});

	it("does not count pruned keys against the retention limit", () => {
		const keys = [K("s1", "t1"), K("s1", "t2"), K("s1", "t3")];
		const live = [...keys];
		const resolve = resolverFor(live);
		for (const key of keys) retainedPanePlan({ activeKey: key, resolve });

		live.length = 0;
		live.push(keys[2]);
		const fresh = K("s2", "t9");
		live.push(fresh);

		expect(retainedPanePlan({ activeKey: fresh, resolve }).map((s) => s.key)).toEqual([keys[2], fresh]);
	});
});

describe("retainedPanePlan eviction", () => {
	it("evicts the least-recently-active key and never the active key", () => {
		const [a, b, c, d] = [K("s1", "t1"), K("s1", "t2"), K("s1", "t3"), K("s1", "t4")];
		const resolve = resolverFor([a, b, c, d]);
		retainedPanePlan({ activeKey: a, resolve });
		retainedPanePlan({ activeKey: b, resolve });
		retainedPanePlan({ activeKey: c, resolve });
		retainedPanePlan({ activeKey: a, resolve }); // a becomes most recent, b is now oldest

		const slots = retainedPanePlan({ activeKey: d, resolve });

		expect(slots.map((s) => s.key)).toEqual([a, c, d]);
		expect(slots.find((s) => !s.hidden)?.key).toBe(d);
	});

	it("keeps exactly `limit` survivors including the active key", () => {
		const keys = [1, 2, 3, 4, 5].map((n) => K("s1", `t${n}`));
		const resolve = resolverFor(keys);

		let slots: ReturnType<typeof retainedPanePlan<Tab>> = [];
		for (const key of keys) slots = retainedPanePlan({ activeKey: key, resolve, limit: 3 });

		expect(slots).toHaveLength(3);
		expect(slots.map((s) => s.key)).toEqual([keys[2], keys[3], keys[4]]);
		expect(slots.find((s) => !s.hidden)?.key).toBe(keys[4]);
	});

	it("defaults to PANEL_PANE_RETENTION_LIMIT survivors", () => {
		const keys = [1, 2, 3, 4].map((n) => K("s1", `t${n}`));
		const resolve = resolverFor(keys);

		let slots: ReturnType<typeof retainedPanePlan<Tab>> = [];
		for (const key of keys) slots = retainedPanePlan({ activeKey: key, resolve });

		expect(slots).toHaveLength(PANEL_PANE_RETENTION_LIMIT);
		expect(slots.map((s) => s.key)).toEqual(keys.slice(1));
	});

	it("evicts down to the active key alone when the limit is 1", () => {
		const a = K("s1", "t1");
		const b = K("s1", "t2");
		const resolve = resolverFor([a, b]);
		retainedPanePlan({ activeKey: a, resolve, limit: 1 });

		expect(retainedPanePlan({ activeKey: b, resolve, limit: 1 }).map((s) => s.key)).toEqual([b]);
	});

	it("keeps insertion order after a middle eviction", () => {
		const [a, b, c, d] = [K("s1", "t1"), K("s1", "t2"), K("s1", "t3"), K("s1", "t4")];
		const resolve = resolverFor([a, b, c, d]);
		retainedPanePlan({ activeKey: a, resolve, limit: 3 });
		retainedPanePlan({ activeKey: b, resolve, limit: 3 });
		retainedPanePlan({ activeKey: c, resolve, limit: 3 });
		retainedPanePlan({ activeKey: a, resolve, limit: 3 });
		retainedPanePlan({ activeKey: c, resolve, limit: 3 }); // b is least recently active

		expect(retainedPanePlan({ activeKey: d, resolve, limit: 3 }).map((s) => s.key)).toEqual([a, c, d]);
	});
});

describe("retainedPanePlan observedKeys", () => {
	it("retains already-mounted observed keys in stable append order", () => {
		const p1 = K("sA", "t1");
		const p2 = K("sA", "t2");
		const b = K("sB", "t1");
		const resolve = resolverFor([p1, p2, b]);

		// Session A: p1 active, p2 open-but-inactive and already mounted.
		expect(retainedPanePlan({ activeKey: p1, observedKeys: [p1, p2], resolve }).map((s) => s.key)).toEqual([p1, p2]);

		// Switching to B must not drop p2 — it is under the limit.
		const slots = retainedPanePlan({ activeKey: b, observedKeys: [b], resolve });
		expect(slots.map((s) => s.key)).toEqual([p1, p2, b]);
		expect(slots.filter((s) => !s.hidden).map((s) => s.key)).toEqual([b]);

		// … and back to A, with the insertion order untouched.
		expect(retainedPanePlan({ activeKey: p1, observedKeys: [p1, p2], resolve }).map((s) => s.key)).toEqual([p1, p2, b]);
	});

	it("appends the active key before observed newcomers and dedupes", () => {
		const a = K("sA", "t1");
		const b = K("sA", "t2");
		const c = K("sA", "t3");
		const resolve = resolverFor([a, b, c]);

		// `a` is both the active key and an observed key: tracked exactly once.
		expect(retainedPanePlan({ activeKey: a, observedKeys: [b, a, c, b], resolve }).map((s) => s.key)).toEqual([a, b, c]);
	});

	it("marks observed non-active keys hidden", () => {
		const p1 = K("sA", "t1");
		const p2 = K("sA", "t2");
		const resolve = resolverFor([p1, p2]);

		const slots = retainedPanePlan({ activeKey: p2, observedKeys: [p1, p2], resolve });

		expect(slots.map((s) => [s.key, s.hidden])).toEqual([[p2, false], [p1, true]]);
	});

	it("gives observed keys no recency of their own, so they are evicted first", () => {
		const p1 = K("sA", "t1");
		const p2 = K("sA", "t2");
		const b = K("sB", "t1");
		const c = K("sC", "t1");
		const resolve = resolverFor([p1, p2, b, c]);

		retainedPanePlan({ activeKey: p1, observedKeys: [p1, p2], resolve, limit: 3 });
		retainedPanePlan({ activeKey: b, observedKeys: [b], resolve, limit: 3 });

		// p2 was never active, so it is the least-recently-active survivor.
		expect(retainedPanePlan({ activeKey: c, observedKeys: [c], resolve, limit: 3 }).map((s) => s.key)).toEqual([p1, b, c]);
	});

	it("still evicts down to the limit when every key is observed", () => {
		const keys = [1, 2, 3, 4].map((n) => K("sA", `t${n}`));
		const resolve = resolverFor(keys);

		// keys[0] is active, so tracking order is exactly tab order here.
		const slots = retainedPanePlan({ activeKey: keys[0], observedKeys: keys, resolve, limit: 3 });

		expect(slots).toHaveLength(3);
		// Only the active key has recency; the observed ones tie at 0, so the victim
		// is the earliest-inserted non-active key. The active key is never evicted.
		expect(slots.map((s) => s.key)).toEqual([keys[0], keys[2], keys[3]]);
		expect(slots.find((s) => !s.hidden)?.key).toBe(keys[0]);
	});

	it("tracks the active key ahead of observed newcomers on first sight", () => {
		const p1 = K("sA", "t1");
		const p2 = K("sA", "t2");
		const resolve = resolverFor([p1, p2]);

		// Documented contract: `activeKey` is appended first, then observed keys in
		// the given order. Retention order is NOT a visual order — the mobile track
		// keeps its own append-only DOM order and expresses tab order with CSS
		// `order` — so this only has to be deterministic.
		expect(retainedPanePlan({ activeKey: p2, observedKeys: [p1, p2], resolve }).map((s) => s.key)).toEqual([p2, p1]);
	});

	it("prunes a dead observed key", () => {
		const p1 = K("sA", "t1");
		const p2 = K("sA", "t2");
		const live = [p1, p2];
		const resolve = resolverFor(live);
		retainedPanePlan({ activeKey: p1, observedKeys: [p1, p2], resolve });

		live.splice(live.indexOf(p2), 1); // p2's tab closed

		expect(retainedPanePlan({ activeKey: p1, observedKeys: [p1], resolve }).map((s) => s.key)).toEqual([p1]);
	});
});

describe("resetPanelPaneRetention", () => {
	it("clears all tracked keys and recency", () => {
		const keys = [K("s1", "t1"), K("s1", "t2")];
		const resolve = resolverFor(keys);
		for (const key of keys) retainedPanePlan({ activeKey: key, resolve });

		resetPanelPaneRetention();

		expect(retainedPanePlan({ resolve })).toEqual([]);
		expect(retainedPanePlan({ activeKey: keys[1], resolve }).map((s) => s.key)).toEqual([keys[1]]);
	});
});
