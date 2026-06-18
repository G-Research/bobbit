// Unit tests for the Hindsight memory provider (market-packs/hindsight/src/provider.ts)
// and the parts of the pack routes that share the provider's pack-scoped store.
//
// Fully self-contained: a fake client is injected via `__setClientFactory` (so the
// real REST client module need not exist) and the pack store is an in-memory Map.
// Pins: dormancy (no client constructed without externalUrl), auto-tag taxonomy,
// recallScope tag filter, retry-queue retry/cap/drain, status/provider store
// sharing, and the recall block shape. See docs/design/hindsight-pack-external.md §9.2.

import test from "node:test";
import assert from "node:assert/strict";

import provider, { __setClientFactory } from "../market-packs/hindsight/src/provider.ts";
import { routes } from "../market-packs/hindsight/src/routes.ts";
import { CONFIG_KEY, QUEUE_KEY } from "../market-packs/hindsight/src/shared.ts";

// ── Fakes ─────────────────────────────────────────────────────────────────────
function makeStore() {
	const map = new Map<string, unknown>();
	return {
		map,
		get: async (k: string) => (map.has(k) ? structuredClone(map.get(k)) : null),
		put: async (k: string, v: unknown) => {
			map.set(k, structuredClone(v));
		},
		list: async (prefix = "") => [...map.keys()].filter((k) => k.startsWith(prefix)),
	};
}

interface FakeState {
	healthy: boolean;
	memories: { text: string; id?: string; score?: number }[];
	failRecall: boolean;
	failRetain: boolean;
	failEnsureBank: boolean;
}

function makeClient() {
	const state: FakeState = { healthy: true, memories: [], failRecall: false, failRetain: false, failEnsureBank: false };
	const calls = {
		recall: [] as { bank: string; query: string; opts: unknown }[],
		retain: [] as { bank: string; content: string; opts: { tags?: Record<string, string>; sync?: boolean } }[],
		ensureBank: [] as string[],
		reflect: [] as { bank: string; prompt: string }[],
		health: 0,
		listBanks: 0,
	};
	const client = {
		health: async () => {
			calls.health++;
			return { ok: state.healthy };
		},
		ensureBank: async (bank: string) => {
			calls.ensureBank.push(bank);
			if (state.failEnsureBank) throw new Error("ensureBank failed");
		},
		recall: async (bank: string, query: string, opts: unknown) => {
			calls.recall.push({ bank, query, opts });
			if (state.failRecall) throw new Error("recall failed");
			return { memories: state.memories };
		},
		retain: async (bank: string, content: string, opts: { tags?: Record<string, string>; sync?: boolean }) => {
			calls.retain.push({ bank, content, opts });
			if (state.failRetain) throw new Error("retain failed");
		},
		reflect: async (bank: string, prompt: string) => {
			calls.reflect.push({ bank, prompt });
			return { text: "reflection" };
		},
		listBanks: async () => {
			calls.listBanks++;
			return { banks: ["bobbit"] };
		},
	};
	return { client, calls, state };
}

const ACTIVE = {
	mode: "external",
	externalUrl: "http://localhost:8888",
	bank: "bobbit",
	namespace: "default",
	recallScope: "all" as const,
	autoRecall: true,
	autoRetain: true,
	recallBudget: 1200,
	timeoutMs: 1500,
};

function ctx(extra: Record<string, unknown>) {
	const store = makeStore();
	return { store, ctx: { config: { ...ACTIVE }, host: { store }, ...extra } };
}

test("dormant: no externalUrl ⇒ every hook is a no-op and no client is constructed", async () => {
	let factoryCalls = 0;
	__setClientFactory(() => {
		factoryCalls++;
		return makeClient().client;
	});
	try {
		const store = makeStore();
		const base = {
			config: { mode: "external", bank: "bobbit", namespace: "default" }, // externalUrl absent
			host: { store },
			sessionId: "s1",
			projectId: "p1",
			goalId: "g1",
			roleName: "coder",
			prompt: "user said something",
			response: "assistant replied",
		};
		assert.deepEqual(await provider.sessionSetup(base), { blocks: [] });
		assert.deepEqual(await provider.beforePrompt(base), { blocks: [] });
		assert.deepEqual(await provider.afterTurn(base), { blocks: [] });
		assert.deepEqual(await provider.beforeCompact(base), { blocks: [] });
		assert.deepEqual(await provider.sessionShutdown(base), { blocks: [] });
		assert.equal(factoryCalls, 0, "no client should be constructed while dormant");
		assert.equal(store.map.size, 0, "no store writes while dormant");
	} finally {
		__setClientFactory(null);
	}
});

test("recall block shape: memories ⇒ one memory block; empty ⇒ no block", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "alpha" }, { text: "beta" }];
		const { ctx: c } = ctx({ prompt: "how do I parse YAML" });
		const out = await provider.sessionSetup(c);
		assert.equal(out.blocks.length, 1);
		const b = out.blocks[0];
		assert.equal(b.authority, "memory");
		assert.equal(b.title, "Relevant memory");
		assert.equal(b.priority, 50);
		assert.match(b.reason, /Recall for: how do I parse YAML/);
		assert.equal(b.content, "- alpha\n- beta");
		assert.equal(calls.recall.length, 1);

		// Empty recall ⇒ no block.
		state.memories = [];
		const out2 = await provider.beforePrompt(c);
		assert.deepEqual(out2.blocks, []);
	} finally {
		__setClientFactory(null);
	}
});

test("recallScope: 'project' sends a project tag filter; 'all' sends none", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "x" }];
		// all (default)
		const allCtx = { config: { ...ACTIVE, recallScope: "all" }, host: { store: makeStore() }, projectId: "proj-42", prompt: "q1" };
		await provider.beforePrompt(allCtx);
		assert.equal((calls.recall[0].opts as { tags?: unknown }).tags, undefined);

		// project
		const projCtx = { config: { ...ACTIVE, recallScope: "project" }, host: { store: makeStore() }, projectId: "proj-42", prompt: "q2" };
		await provider.beforePrompt(projCtx);
		const o = calls.recall[1].opts as { tags?: Record<string, string>; tagsMatch?: string };
		assert.deepEqual(o.tags, { project: "proj-42" });
		assert.equal(o.tagsMatch, "any");
	} finally {
		__setClientFactory(null);
	}
});

test("afterTurn retains a compact summary with the full auto-tag taxonomy", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		const c = {
			config: { ...ACTIVE },
			host: { store },
			sessionId: "sess-1",
			projectId: "proj-1",
			goalId: "goal-1",
			roleName: "coder",
			prompt: "hello",
			response: "hi there",
		};
		await provider.afterTurn(c);
		assert.equal(calls.retain.length, 1);
		const r = calls.retain[0];
		assert.equal(r.bank, "bobbit");
		assert.equal(r.content, "User: hello\n\nAssistant: hi there");
		assert.equal(r.opts.sync, false);
		assert.deepEqual(r.opts.tags, {
			kind: "turn",
			project: "proj-1",
			goal: "goal-1",
			agent: "coder",
			session: "sess-1",
		});
		// ensureBank is idempotently called before retain.
		assert.deepEqual(calls.ensureBank, ["bobbit"]);
	} finally {
		__setClientFactory(null);
	}
});

test("beforeCompact retains synchronously with kind:compaction", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		const c = { config: { ...ACTIVE }, host: { store }, sessionId: "s", goalId: "g", summary: "lost span text" };
		await provider.beforeCompact(c);
		assert.equal(calls.retain.length, 1);
		assert.equal(calls.retain[0].content, "lost span text");
		assert.equal(calls.retain[0].opts.sync, true);
		assert.equal(calls.retain[0].opts.tags?.kind, "compaction");
	} finally {
		__setClientFactory(null);
	}
});

test("retry queue: failure enqueues, cap drops oldest, drain head, status sharing, shutdown drain", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		// Persist a configured config so the routes treat the store as configured.
		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888" });

		// 105 failing turns ⇒ queue caps at 100, oldest dropped (contents #6..#105).
		state.failRetain = true;
		for (let i = 1; i <= 105; i++) {
			await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "s", prompt: `turn ${i}` });
		}
		let q = (await store.get(QUEUE_KEY)) as { content: string }[];
		assert.equal(q.length, 100, "queue capped at 100");
		assert.equal(q[0].content, "User: turn 6", "oldest entries FIFO-evicted");

		// status route reads the SAME pack-store queue + reports healthy.
		const st = (await routes.status({ host: { store } } as never)) as { configured: boolean; healthy: boolean; queueDepth: number };
		assert.equal(st.configured, true);
		assert.equal(st.healthy, true);
		assert.equal(st.queueDepth, 100);

		// Recover: a later afterTurn drains the queue HEAD (one entry) before its own
		// (now-succeeding) retain.
		state.failRetain = false;
		const retainsBefore = calls.retain.length;
		await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "s", prompt: "turn 106" });
		q = (await store.get(QUEUE_KEY)) as { content: string }[];
		assert.equal(q.length, 99, "one queued head drained");
		assert.equal(q[0].content, "User: turn 7", "head removed FIFO");
		// drain head retained #6 + the new turn #106 ⇒ at least 2 successful retains.
		assert.ok(calls.retain.length >= retainsBefore + 2);

		// sessionShutdown does a one-pass drain of the rest.
		await provider.sessionShutdown({ config: { ...ACTIVE }, host: { store }, sessionId: "s" });
		q = (await store.get(QUEUE_KEY)) as unknown[];
		assert.equal(q.length, 0, "shutdown drained the remaining queue");
	} finally {
		__setClientFactory(null);
	}
});

test("routes: dormant store ⇒ clean configured:false signals, no client constructed", async () => {
	let factoryCalls = 0;
	__setClientFactory(() => {
		factoryCalls++;
		return makeClient().client;
	});
	try {
		const store = makeStore(); // no config persisted
		const cfg = (await routes.config({ host: { store } } as never, { method: "GET" } as never)) as { configured: boolean; config: Record<string, unknown> };
		assert.equal(cfg.configured, false);
		assert.equal(cfg.config.apiKeySet, false, "secret redacted to a boolean");
		assert.equal(cfg.config.bank, "bobbit");

		assert.deepEqual(await routes.recall({ host: { store } } as never, { body: { query: "x" } } as never), { configured: false, memories: [] });
		assert.deepEqual(await routes.banks({ host: { store } } as never), { configured: false, banks: [] });
		assert.equal(factoryCalls, 0, "no client constructed while unconfigured");
	} finally {
		__setClientFactory(null);
	}
});

test("routes config SET validates, persists, and redacts the secret", async () => {
	__setClientFactory(() => makeClient().client);
	try {
		const store = makeStore();
		const bad = (await routes.config({ host: { store } } as never, { method: "POST", body: { recallScope: "nope" } } as never)) as { ok: boolean; error?: string };
		assert.equal(bad.ok, false);
		assert.equal(bad.error, "CONFIG_INVALID");

		const ok = (await routes.config(
			{ host: { store } } as never,
			{ method: "POST", body: { externalUrl: "http://localhost:8888", apiKey: "secret", recallScope: "project" } } as never,
		)) as { ok: boolean; configured: boolean; config: Record<string, unknown> };
		assert.equal(ok.ok, true);
		assert.equal(ok.configured, true);
		assert.equal(ok.config.recallScope, "project");
		assert.equal(ok.config.apiKeySet, true);
		assert.equal("apiKey" in ok.config, false, "raw secret never echoed");
		// Persisted under CONFIG_KEY (the key the loader overlays).
		const stored = (await store.get(CONFIG_KEY)) as Record<string, unknown>;
		assert.equal(stored.externalUrl, "http://localhost:8888");
		assert.equal(stored.apiKey, "secret");
	} finally {
		__setClientFactory(null);
	}
});
