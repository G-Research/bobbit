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
import {
	CONFIG_DEFAULTS,
	CONFIG_KEY,
	LAST_ERROR_KEY,
	PROJECT_RECALL_TAGS_MATCH,
	QUEUE_KEY,
	RECALL_QUERY_CHARS_PER_TOKEN,
	RECALL_QUERY_SAFE_CHAR_CEILING,
	RECALL_QUERY_TOKEN_CAP,
	clampRecallQuery,
	isQueryTooLongError,
	loadEffectiveConfig,
	projectConfigKey,
	recallTagFilter,
	validateConfigOverrides,
	validateProjectOverride,
} from "../market-packs/hindsight/src/shared.ts";

// ── recallTagFilter — the shared project/all tag-scope source of truth ─────────
test("recallTagFilter: project scope + real id ⇒ project tag with the include-untagged match", () => {
	// PROJECT_RECALL_TAGS_MATCH is "any" = "OR, includes untagged": project-tagged +
	// untagged/global, excluding other projects (verified end-to-end in the client test).
	assert.equal(PROJECT_RECALL_TAGS_MATCH, "any");
	assert.deepEqual(recallTagFilter("project", "proj-7"), {
		tags: { project: "proj-7" },
		tagsMatch: "any",
	});
	// Whitespace-padded ids are trimmed; blank/whitespace ids ⇒ no filter.
	assert.deepEqual(recallTagFilter("project", "  proj-7  "), {
		tags: { project: "proj-7" },
		tagsMatch: "any",
	});
});

test("recallTagFilter: 'all' scope, or project scope with no id ⇒ no tag filter", () => {
	assert.equal(recallTagFilter("all", "proj-7"), undefined);
	assert.equal(recallTagFilter("project", undefined), undefined);
	assert.equal(recallTagFilter("project", ""), undefined);
	assert.equal(recallTagFilter("project", "   "), undefined);
});

// ── clampRecallQuery — pure helper (core fix for the 500-token "Query too long") ─
test("clampRecallQuery: short unchanged, long truncated to min(maxChars, token-safe ceiling)", () => {
	// Short query (and whitespace-trimmed) passes through unchanged.
	assert.equal(clampRecallQuery("hello", 1200), "hello");
	assert.equal(clampRecallQuery("  hello  ", 1200), "hello");
	// Long query is sliced to at most maxChars characters (below the ceiling).
	const long = "x".repeat(5000);
	assert.equal(clampRecallQuery(long, 1200).length, 1200);
	assert.equal(clampRecallQuery(long, 50).length, 50);
	// Never throws on nullish input.
	assert.equal(clampRecallQuery(undefined as unknown as string, 100), "");
});

test("clampRecallQuery: ALWAYS enforces the token-safe ceiling, even with a high/disabled maxChars", () => {
	const long = "x".repeat(5000);
	// A configured maxChars far above the ceiling (e.g. the 3000 default) is capped
	// at the token-safe ceiling so a dense query can never exceed the 500-token cap.
	assert.equal(clampRecallQuery(long, 3000).length, RECALL_QUERY_SAFE_CHAR_CEILING);
	assert.equal(clampRecallQuery(long, 100000).length, RECALL_QUERY_SAFE_CHAR_CEILING);
	// Disabled char-clamping (<= 0 / non-finite) STILL enforces the token-safe ceiling.
	assert.equal(clampRecallQuery(long, 0).length, RECALL_QUERY_SAFE_CHAR_CEILING);
	assert.equal(clampRecallQuery(long, -10).length, RECALL_QUERY_SAFE_CHAR_CEILING);
	assert.equal(clampRecallQuery(long, Number.NaN).length, RECALL_QUERY_SAFE_CHAR_CEILING);
	// The ceiling sits comfortably under the 500-token cap at the conservative ratio.
	assert.ok(RECALL_QUERY_SAFE_CHAR_CEILING / RECALL_QUERY_CHARS_PER_TOKEN < RECALL_QUERY_TOKEN_CAP);
});

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
	mentalModel: Record<string, unknown> | null;
	failRecall: boolean;
	/** When set, recall throws THIS value (e.g. a HindsightError-shaped 400). */
	recallError: unknown;
	failRetain: boolean;
	failEnsureBank: boolean;
	failUpdateBankConfig: boolean;
}

function makeClient() {
	const state: FakeState = { healthy: true, memories: [], mentalModel: null, failRecall: false, recallError: undefined, failRetain: false, failEnsureBank: false, failUpdateBankConfig: false };
	const calls = {
		recall: [] as { bank: string; query: string; opts: unknown }[],
		retain: [] as { bank: string; content: string; opts: Record<string, unknown> & { tags?: Record<string, string>; sync?: boolean } }[],
		ensureBank: [] as string[],
		reflect: [] as { bank: string; prompt: string; opts?: { tags?: Record<string, string>; tagsMatch?: string } }[],
		updateBankConfig: [] as { bank: string; updates: Record<string, string> }[],
		ensureMentalModel: [] as { bank: string; spec: Record<string, unknown> }[],
		getMentalModel: [] as { bank: string; id: string }[],
		refreshMentalModel: [] as { bank: string; id: string }[],
		listDirectives: [] as string[],
		createDirective: [] as { bank: string; directive: Record<string, unknown> }[],
		updateDirective: [] as { bank: string; id: string; patch: Record<string, unknown> }[],
		health: 0,
		llmHealth: [] as string[],
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
			if (state.recallError !== undefined) throw state.recallError;
			if (state.failRecall) throw new Error("recall failed");
			return { memories: state.memories };
		},
		retain: async (bank: string, content: string, opts: Record<string, unknown> & { tags?: Record<string, string>; sync?: boolean }) => {
			calls.retain.push({ bank, content, opts });
			if (state.failRetain) throw new Error("retain failed");
		},
		reflect: async (bank: string, prompt: string, opts?: { tags?: Record<string, string>; tagsMatch?: string }) => {
			calls.reflect.push({ bank, prompt, opts });
			return { text: "reflection" };
		},
		listBanks: async () => {
			calls.listBanks++;
			return { banks: ["bobbit"] };
		},
		updateBankConfig: async (bank: string, updates: Record<string, string>) => {
			calls.updateBankConfig.push({ bank, updates });
			if (state.failUpdateBankConfig) throw new Error("updateBankConfig failed");
		},
		ensureMentalModel: async (bank: string, spec: Record<string, unknown>) => {
			calls.ensureMentalModel.push({ bank, spec });
			return { operation_id: "op-1" };
		},
		getMentalModel: async (bank: string, id: string) => {
			calls.getMentalModel.push({ bank, id });
			return state.mentalModel;
		},
		refreshMentalModel: async (bank: string, id: string) => {
			calls.refreshMentalModel.push({ bank, id });
			return { operation_id: "refresh-1" };
		},
		listDirectives: async (bank: string) => {
			calls.listDirectives.push(bank);
			return { items: [] };
		},
		createDirective: async (bank: string, directive: Record<string, unknown>) => {
			calls.createDirective.push({ bank, directive });
			return { id: String(directive.name ?? "directive-1"), ...directive };
		},
		updateDirective: async (bank: string, id: string, patch: Record<string, unknown>) => {
			calls.updateDirective.push({ bank, id, patch });
			return { id, ...patch };
		},
		llmHealth: async (bank: string) => {
			calls.llmHealth.push(bank);
			return { retain: { ok: state.healthy }, consolidation: { ok: state.healthy }, reflect: { ok: state.healthy } };
		},
	};
	return { client, calls, state };
}

// retainEveryNTurns:1 + retainOverlapTurns:0 keeps these tests on the OLD per-turn
// behavior (each turn flushes a single-turn aggregate = the turn summary verbatim).
// Batching (default 5), max-delay, and overlap are exercised by dedicated tests below.
const ACTIVE = {
	mode: "external",
	externalUrl: "http://localhost:8888",
	bank: "bobbit",
	namespace: "default",
	recallScope: "all" as const,
	tagsMatch: "any" as const,
	autoRecall: true,
	autoRetain: true,
	retainEveryNTurns: 1,
	retainMaxDelayMs: 1_800_000,
	retainOverlapTurns: 0,
	recallBudget: 1200,
	timeoutMs: 4000,
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

test("doRecall clamps a long query to recallMaxInputChars before calling the client", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "m" }];
		const longPrompt = "q".repeat(5000);
		const c = { config: { ...ACTIVE, recallMaxInputChars: 64 }, host: { store: makeStore() }, prompt: longPrompt };
		await provider.beforePrompt(c);
		assert.equal(calls.recall.length, 1);
		assert.ok(calls.recall[0].query.length <= 64, "clamped query is at most recallMaxInputChars chars");
		assert.equal(calls.recall[0].query.length, 64);
	} finally {
		__setClientFactory(null);
	}
});

test("routes recall clamps a long query to recallMaxInputChars before calling the client", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "m" }];
		const store = makeStore();
		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888", recallMaxInputChars: 80 });
		const longQuery = "z".repeat(5000);
		await routes.recall({ host: { store } } as never, { body: { query: longQuery } } as never);
		assert.equal(calls.recall.length, 1);
		assert.ok(calls.recall[0].query.length <= 80, "route clamps the resolved query");
		assert.equal(calls.recall[0].query.length, 80);
	} finally {
		__setClientFactory(null);
	}
});

test("sticky lastError is cleared after a SUCCESSFUL recall (provider + route)", async () => {
	const { client, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "m" }];
		// Provider: a prior error in the store is cleared on the next successful recall.
		const pStore = makeStore();
		await pStore.put(LAST_ERROR_KEY, { message: "Query too long", ts: 1 });
		await provider.beforePrompt({ config: { ...ACTIVE }, host: { store: pStore }, prompt: "q" });
		assert.equal(await pStore.get(LAST_ERROR_KEY), null, "provider clears lastError on recall success");

		// Route: same behavior via the recall route.
		const rStore = makeStore();
		await rStore.put(CONFIG_KEY, { externalUrl: "http://localhost:8888" });
		await rStore.put(LAST_ERROR_KEY, { message: "Query too long", ts: 1 });
		await routes.recall({ host: { store: rStore } } as never, { body: { query: "q" } } as never);
		assert.equal(await rStore.get(LAST_ERROR_KEY), null, "route clears lastError on recall success");
	} finally {
		__setClientFactory(null);
	}
});

test("lastError is NOT cleared when recall fails", async () => {
	const { client, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.failRecall = true;
		const store = makeStore();
		await provider.beforePrompt({ config: { ...ACTIVE }, host: { store }, prompt: "q" });
		const err = (await store.get(LAST_ERROR_KEY)) as { message: string } | null;
		assert.ok(err && /recall failed/.test(err.message), "failure records (does not clear) lastError");
	} finally {
		__setClientFactory(null);
	}
});

// ── Soft-skip the data plane's 500-token "Query too long" 400 (defence in depth) ─
test("isQueryTooLongError: only kind:http status:400 query token-limit errors match", () => {
	// The exact shape the client throws (status + detail surfaced in the message).
	assert.equal(isQueryTooLongError({ kind: "http", status: 400, message: "Hindsight HTTP 400 for POST .../recall: Query too long: 620 tokens exceeds maximum of 500" }), true);
	assert.equal(isQueryTooLongError({ kind: "http", status: 400, message: "...query exceeds limit" }), true);
	assert.equal(isQueryTooLongError({ kind: "http", status: 400, message: "query token count exceeded" }), true);
	// Genuine errors are NOT soft-skipped: other statuses, kinds, and unrelated 400s.
	assert.equal(isQueryTooLongError({ kind: "http", status: 500, message: "Query too long" }), false);
	assert.equal(isQueryTooLongError({ kind: "http", status: 401, message: "unauthorized" }), false);
	assert.equal(isQueryTooLongError({ kind: "timeout", message: "Query too long" }), false);
	assert.equal(isQueryTooLongError({ kind: "http", status: 400, message: "bad request" }), false);
	assert.equal(isQueryTooLongError({ kind: "http", status: 400, message: "invalid query syntax" }), false);
	assert.equal(isQueryTooLongError({ kind: "http", status: 400, message: "query parameter is required" }), false);
	assert.equal(isQueryTooLongError({ kind: "http", status: 400, message: "prompt too long" }), false);
	assert.equal(isQueryTooLongError(new Error("Query too long")), false);
	assert.equal(isQueryTooLongError(null), false);
	assert.equal(isQueryTooLongError("Query too long"), false);
});

test("doRecall SOFT-skips a 400 'Query too long' (empty recall, no sticky lastError, prior cleared)", async () => {
	const { client, state } = makeClient();
	__setClientFactory(() => client);
	try {
		// HindsightError-shaped 400 carrying the upstream "Query too long" detail.
		state.recallError = { kind: "http", status: 400, message: "Hindsight HTTP 400 for POST .../recall: Query too long: 620 tokens exceeds maximum of 500" };
		const store = makeStore();
		// A prior sticky error is CLEARED by the soft-skip so the banner can't persist.
		await store.put(LAST_ERROR_KEY, { message: "stale Query too long", ts: 1 });
		const out = await provider.beforePrompt({ config: { ...ACTIVE }, host: { store }, prompt: "q" });
		assert.deepEqual(out.blocks, [], "query-too-long ⇒ empty recall (non-fatal)");
		assert.equal(await store.get(LAST_ERROR_KEY), null, "no sticky lastError recorded; prior one cleared");
	} finally {
		__setClientFactory(null);
	}
});

test("routes recall SOFT-skips a 400 'Query too long' (clean empty, no error field, prior cleared)", async () => {
	const { client, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.recallError = { kind: "http", status: 400, message: "Query too long: 700 tokens exceeds maximum of 500" };
		const store = makeStore();
		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888" });
		await store.put(LAST_ERROR_KEY, { message: "stale", ts: 1 });
		const res = (await routes.recall({ host: { store } } as never, { body: { query: "q" } } as never)) as {
			configured: boolean; memories: unknown[]; error?: string;
		};
		assert.deepEqual(res, { configured: true, memories: [] }, "soft-skip ⇒ clean empty result with NO error field");
		assert.equal(await store.get(LAST_ERROR_KEY), null, "prior sticky error cleared by the soft-skip");
	} finally {
		__setClientFactory(null);
	}
});

test("recall still surfaces GENUINE errors (a non-query 5xx is recorded / returned)", async () => {
	const { client, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.recallError = { kind: "http", status: 500, message: "Hindsight HTTP 500 for POST .../recall: boom" };
		// Provider: a genuine error is recorded as lastError (not soft-skipped).
		const pStore = makeStore();
		await provider.beforePrompt({ config: { ...ACTIVE }, host: { store: pStore }, prompt: "q" });
		const err = (await pStore.get(LAST_ERROR_KEY)) as { message: string } | null;
		assert.ok(err && /HTTP 500/.test(err.message), "genuine 5xx records lastError");
		// Route: a genuine error is returned in the `error` field.
		const rStore = makeStore();
		await rStore.put(CONFIG_KEY, { externalUrl: "http://localhost:8888" });
		const res = (await routes.recall({ host: { store: rStore } } as never, { body: { query: "q" } } as never)) as { error?: string };
		assert.ok(res.error && /HTTP 500/.test(res.error), "genuine 5xx returned in the route error field");
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

test("provider hooks cap configured client timeout below the provider budget", async () => {
	const cap = captureClientBaseUrl();
	try {
		cap.state.memories = [{ text: "m" }];
		await provider.beforePrompt({
			config: { ...ACTIVE, timeoutMs: 15_000 },
			host: { store: makeStore() },
			prompt: "q",
		});
		assert.equal(cap.cfg()?.timeoutMs, 4000, "hook-path client timeout is capped below the 4500ms provider budget");
		assert.equal(cap.calls.recall.length, 1);
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

		// sessionShutdown does a bounded one-pass drain by default.
		await provider.sessionShutdown({ config: { ...ACTIVE }, host: { store }, sessionId: "s" });
		q = (await store.get(QUEUE_KEY)) as unknown[];
		assert.equal(q.length, 89, "shutdown drains at most the default bound of 10 entries");
	} finally {
		__setClientFactory(null);
	}
});

test("retry queue: a failed retain replays into its ORIGINAL bank, not the next hook's per-project bank", async () => {
	// Per-project bank overrides mean two projects share ONE pack-store retry queue but
	// route to DIFFERENT banks. A failed retain from project A must replay into A's
	// bank even when the draining hook belongs to project B (B's cfg.bank differs).
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		// Project overlays: projA → bankA, projB → bankB (overlay can set `bank`).
		await store.put(projectConfigKey("projA"), { bank: "bankA" });
		await store.put(projectConfigKey("projB"), { bank: "bankB" });

		// Project A's retain FAILS ⇒ durably queued, captured against bankA/default.
		state.failRetain = true;
		await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "sA", projectId: "projA", prompt: "from A" });
		let q = (await store.get(QUEUE_KEY)) as { content: string; bank?: string; namespace?: string }[];
		assert.equal(q.length, 1, "project A's failed retain is queued");
		assert.equal(q[0].bank, "bankA", "queue entry captures the ORIGINAL target bank");
		assert.equal(q[0].namespace, "default", "queue entry captures the ORIGINAL namespace");

		// Project B's next (succeeding) turn drains the queue HEAD before its own retain.
		// The replay MUST land in bankA — never project B's bankB.
		state.failRetain = false;
		calls.retain.length = 0;
		calls.ensureBank.length = 0;
		await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "sB", projectId: "projB", prompt: "from B" });
		const replay = calls.retain.find((r) => /from A/.test(r.content));
		assert.ok(replay, "the queued project-A entry was replayed");
		assert.equal(replay!.bank, "bankA", "replay lands in the ORIGINAL bank (bankA), not project B's bankB");
		// The replay ensured bankA (not bankB) before retaining.
		assert.ok(calls.ensureBank.includes("bankA"), "ensureBank targets the original bankA on replay");
		// Project B's OWN retain still goes to its own bankB.
		const own = calls.retain.find((r) => /from B/.test(r.content));
		assert.ok(own, "project B's own turn retained");
		assert.equal(own!.bank, "bankB", "project B's own retain uses bankB");
		// Queue fully drained.
		q = (await store.get(QUEUE_KEY)) as unknown[];
		assert.equal(q.length, 0, "head drained");
	} finally {
		__setClientFactory(null);
	}
});

test("sessionShutdown drain replays each entry into its OWN captured bank (mixed-bank queue)", async () => {
	// A single shutdown drain must route each queued entry to the bank it was enqueued
	// against — a mixed-bank queue (projA→bankA, projB→bankB) must not collapse onto
	// the draining hook's cfg.bank.
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888" });
		await store.put(projectConfigKey("projA"), { bank: "bankA" });
		await store.put(projectConfigKey("projB"), { bank: "bankB" });
		state.failRetain = true;
		await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "sA", projectId: "projA", prompt: "alpha" });
		await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "sB", projectId: "projB", prompt: "beta" });
		assert.equal(((await store.get(QUEUE_KEY)) as unknown[]).length, 2);

		state.failRetain = false;
		calls.retain.length = 0;
		// Drain from a NEUTRAL hook (no project overlay ⇒ cfg.bank = bobbit).
		await provider.sessionShutdown({ config: { ...ACTIVE }, host: { store }, sessionId: "sC" });
		const a = calls.retain.find((r) => /alpha/.test(r.content));
		const b = calls.retain.find((r) => /beta/.test(r.content));
		assert.equal(a?.bank, "bankA", "alpha replays into bankA");
		assert.equal(b?.bank, "bankB", "beta replays into bankB");
		assert.equal(((await store.get(QUEUE_KEY)) as unknown[]).length, 0, "queue drained");
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

test("routes config: llmApiKey is a persisted, redacted secret field (finding #1)", async () => {
	// The managed Hindsight runtime requires HINDSIGHT_API_LLM_API_KEY. The provider
	// exposes it as the `llmApiKey` config secret so the host can forward it onto the
	// runtime env. It must round-trip through the config route: PUT persists it, GET
	// redacts it to an `llmApiKeySet` boolean (never echoing the raw value).
	const store = makeStore();
	const put = (await routes.config(
		{ host: { store } } as never,
		{ method: "PUT", body: { mode: "managed", llmApiKey: "sk-secret-123" } } as never,
	)) as { ok: boolean; config: Record<string, unknown> };
	assert.equal(put.ok, true);
	// The raw value is NEVER echoed back; only the presence boolean.
	assert.equal(put.config.llmApiKeySet, true);
	assert.equal(put.config.llmApiKey, undefined);

	// Persisted under the provider-config store key so the host's managed-enable path
	// (deploymentConfig overlay) can read + forward it.
	const persisted = (await store.get(CONFIG_KEY)) as Record<string, unknown>;
	assert.equal(persisted.llmApiKey, "sk-secret-123");

	const get = (await routes.config({ host: { store } } as never, { method: "GET" } as never)) as { config: Record<string, unknown> };
	assert.equal(get.config.llmApiKeySet, true);
	assert.equal(get.config.llmApiKey, undefined);
});

test("routes recall: project scope uses the REAL ctx.projectId; absent ⇒ no project filter", async () => {
	// Regression: the recall route used to send a fabricated { project: "current" }
	// tag. It must use the actual project id from the route ctx, and apply NO
	// project filter when the ctx carries none.
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "m" }];
		const store = makeStore();
		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888", recallScope: "project" });

		// With a real project id in the route ctx, the filter uses it (NOT "current").
		await routes.recall({ host: { store }, projectId: "proj-7" } as never, { body: { query: "q" } } as never);
		const o1 = calls.recall[0].opts as { tags?: Record<string, string>; tagsMatch?: string };
		assert.deepEqual(o1.tags, { project: "proj-7" });
		assert.equal(o1.tagsMatch, "any");

		// No project id in ctx ⇒ no project filter (no fabricated placeholder tag).
		await routes.recall({ host: { store } } as never, { body: { query: "q2" } } as never);
		const o2 = calls.recall[1].opts as { tags?: unknown };
		assert.equal(o2.tags, undefined);
	} finally {
		__setClientFactory(null);
	}
});

test("routes reflect: project scope sends a project tag filter; all scope sends none", async () => {
	// P5 contract: hindsight_reflect's `scope` must map to a TAG FILTER on the shared
	// bank (NOT reflect over the whole bank for a project-scoped call).
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888" });

		// scope:project + a real project id ⇒ filter on { project: <id> }.
		await routes.reflect(
			{ host: { store }, projectId: "proj-9" } as never,
			{ body: { prompt: "what did we decide", scope: "project" } } as never,
		);
		assert.deepEqual(calls.reflect[0].opts?.tags, { project: "proj-9" });
		assert.equal(calls.reflect[0].opts?.tagsMatch, "any");

		// scope:all ⇒ no project filter (reflect over the bank).
		await routes.reflect(
			{ host: { store }, projectId: "proj-9" } as never,
			{ body: { prompt: "anything", scope: "all" } } as never,
		);
		assert.equal(calls.reflect[1].opts, undefined);

		// scope:project but NO project id in ctx ⇒ no fabricated placeholder tag.
		await routes.reflect(
			{ host: { store } } as never,
			{ body: { prompt: "global", scope: "project" } } as never,
		);
		assert.equal(calls.reflect[2].opts, undefined);
	} finally {
		__setClientFactory(null);
	}
});

test("routes reflect: applies bank directives when explicitly enabled, otherwise keeps per-request Bobbit instruction", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888" });

		await routes.reflect({ host: { store }, projectId: "proj-9" } as never, { body: { prompt: "what do we know" } } as never);
		assert.match(calls.reflect[0].prompt, /^Bobbit coding-agent memory reflection instructions:/);
		assert.equal(calls.createDirective.length, 0);

		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888", directivesEnabled: true, directiveApplyMode: "disabled" });
		await routes.reflect({ host: { store }, projectId: "proj-9" } as never, { body: { prompt: "still fallback" } } as never);
		assert.match(calls.reflect[1].prompt, /^Bobbit coding-agent memory reflection instructions:/);
		assert.equal(calls.createDirective.length, 0, "directivesEnabled alone does not write bank directives");

		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888", directivesEnabled: true, directiveApplyMode: "bank-wide-explicit-opt-in" });
		await routes.reflect({ host: { store }, projectId: "proj-9" } as never, { body: { prompt: "use bank directives" } } as never);
		assert.equal(calls.reflect[2].prompt, "use bank directives");
		assert.equal(calls.listDirectives.length, 1);
		assert.equal(calls.createDirective.length, 1);
		assert.equal(calls.createDirective[0].directive.name, "bobbit-coding-agent-recall");

		await routes.reflect({ host: { store }, projectId: "proj-9" } as never, { body: { prompt: "idempotent" } } as never);
		assert.equal(calls.reflect[3].prompt, "idempotent");
		assert.equal(calls.listDirectives.length, 1, "directive signature cache avoids repeated list/apply");
		assert.equal(calls.createDirective.length, 1);
	} finally {
		__setClientFactory(null);
	}
});

test("routes retain: trusted manual context tags are enforced over user-supplied tags", async () => {
	// Manual retain tags come from the trusted route ctx, not agent-supplied args.
	// User `tags` stay additive, but spoofed canonical keys must NOT win.
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888", recallScope: "project" });

		const res = (await routes.retain(
			{ host: { store }, projectId: "proj-3", goalId: "goal-7", sessionId: "sess-9", roleName: "coder" } as never,
			{
				body: {
					content: "remember this",
					tags: { kind: "spoofed", project: "evil-project", goal: "evil-goal", session: "evil-session", agent: "evil-agent", topic: "auth" },
					scope: "project",
				},
			} as never,
		)) as { ok: boolean };
		assert.equal(res.ok, true);
		const tags = calls.retain[0].opts.tags as Record<string, string>;
		assert.deepEqual(tags, {
			kind: "manual",
			project: "proj-3",
			goal: "goal-7",
			session: "sess-9",
			agent: "coder",
			topic: "auth",
		});
	} finally {
		__setClientFactory(null);
	}
});

// ── Managed deployment modes (P3 — ctx.runtime injection) ──────────────────
//
// In a managed mode the provider NEVER dials `externalUrl`; it uses the host-
// injected `ctx.runtime = { baseUrl, headers, status }` pointing at the locally
// running managed Hindsight API. The provider never starts Docker — an absent or
// non-running runtime simply keeps it dormant (recall → no blocks, retain → queued).

const MANAGED = {
	mode: "managed",
	bank: "bobbit",
	namespace: "default",
	recallScope: "all" as const,
	tagsMatch: "any" as const,
	autoRecall: true,
	autoRetain: true,
	retainEveryNTurns: 1,
	retainMaxDelayMs: 1_800_000,
	retainOverlapTurns: 0,
	recallBudget: 1200,
	timeoutMs: 4000,
};

function captureClientBaseUrl() {
	const { client, calls, state } = makeClient();
	let seenBaseUrl: string | undefined;
	let seenCfg: { baseUrl: string; apiKey?: string; timeoutMs?: number } | undefined;
	__setClientFactory((cfg: { baseUrl: string; apiKey?: string; timeoutMs?: number }) => {
		seenBaseUrl = cfg.baseUrl;
		seenCfg = cfg;
		return client;
	});
	return { client, calls, state, baseUrl: () => seenBaseUrl, cfg: () => seenCfg };
}

test("managed mode: a RUNNING runtime makes the provider dial ctx.runtime.baseUrl (not externalUrl)", async () => {
	const cap = captureClientBaseUrl();
	try {
		cap.state.memories = [{ text: "managed-mem" }];
		const store = makeStore();
		const c = {
			// externalUrl is set but MUST be ignored in a managed mode.
			config: { ...MANAGED, externalUrl: "http://should-not-be-used:9999" },
			host: { store },
			runtime: { baseUrl: "http://127.0.0.1:48080", headers: { Authorization: "Bearer tok" }, status: "running" },
			projectId: "proj-1",
			prompt: "recall please",
		};
		const out = await provider.beforePrompt(c);
		assert.equal(out.blocks.length, 1, "a running managed runtime serves recall blocks");
		assert.equal(cap.baseUrl(), "http://127.0.0.1:48080", "client dials the managed runtime base URL");
		assert.equal(cap.calls.recall.length, 1);
	} finally {
		__setClientFactory(null);
	}
});

test("managed mode: managed-external-postgres also activates via ctx.runtime.baseUrl", async () => {
	const cap = captureClientBaseUrl();
	try {
		cap.state.memories = [{ text: "x" }];
		const store = makeStore();
		const c = {
			config: { ...MANAGED, mode: "managed-external-postgres" },
			host: { store },
			runtime: { baseUrl: "http://127.0.0.1:38080", status: "running" },
			prompt: "q",
		};
		const out = await provider.beforePrompt(c);
		assert.equal(out.blocks.length, 1);
		assert.equal(cap.baseUrl(), "http://127.0.0.1:38080");
	} finally {
		__setClientFactory(null);
	}
});

test("managed mode is dormant + non-fatal when the runtime is ABSENT (no ctx.runtime)", async () => {
	let factoryCalls = 0;
	__setClientFactory(() => { factoryCalls++; return makeClient().client; });
	try {
		const store = makeStore();
		const base = { config: { ...MANAGED }, host: { store }, sessionId: "s", prompt: "hello", response: "hi" };
		// recall hooks → no blocks; retain hooks → no throw; no client constructed.
		assert.deepEqual(await provider.beforePrompt(base), { blocks: [] });
		assert.deepEqual(await provider.afterTurn(base), { blocks: [] });
		assert.deepEqual(await provider.sessionSetup(base), { blocks: [] });
		assert.equal(factoryCalls, 0, "no client constructed without a running managed runtime");
		assert.equal(store.map.size, 0, "no store writes — nothing even queued while dormant");
	} finally {
		__setClientFactory(null);
	}
});

test("managed mode is dormant when the runtime is STOPPED/unhealthy (status gate)", async () => {
	let factoryCalls = 0;
	__setClientFactory(() => { factoryCalls++; return makeClient().client; });
	try {
		for (const status of ["stopped", "unhealthy", "starting", "docker-unavailable"]) {
			const store = makeStore();
			const c = {
				config: { ...MANAGED },
				host: { store },
				runtime: { baseUrl: "http://127.0.0.1:48080", status },
				prompt: "q",
			};
			assert.deepEqual(await provider.beforePrompt(c), { blocks: [] }, `status=${status} must stay dormant`);
		}
		assert.equal(factoryCalls, 0, "a non-running managed runtime never constructs a client");
	} finally {
		__setClientFactory(null);
	}
});

test("managed mode: afterTurn QUEUES the retain when the running runtime's retain fails (non-fatal)", async () => {
	const cap = captureClientBaseUrl();
	try {
		cap.state.failRetain = true;
		const store = makeStore();
		const c = {
			config: { ...MANAGED },
			host: { store },
			runtime: { baseUrl: "http://127.0.0.1:48080", status: "running" },
			sessionId: "s",
			prompt: "turn-x",
		};
		const out = await provider.afterTurn(c);
		assert.deepEqual(out.blocks, [], "afterTurn never throws on a managed retain failure");
		const q = (await store.get(QUEUE_KEY)) as { content: string }[];
		assert.equal(q.length, 1, "failed managed retain is durably queued");
		assert.equal(q[0].content, "User: turn-x");
	} finally {
		__setClientFactory(null);
	}
});

test("managed mode: a RUNNING runtime with an empty status (unspecified) is tolerated as reachable", async () => {
	const cap = captureClientBaseUrl();
	try {
		cap.state.memories = [{ text: "m" }];
		const c = {
			config: { ...MANAGED },
			host: { store: makeStore() },
			runtime: { baseUrl: "http://127.0.0.1:48080" }, // status omitted
			prompt: "q",
		};
		const out = await provider.beforePrompt(c);
		assert.equal(out.blocks.length, 1, "an unspecified status is treated as reachable");
		assert.equal(cap.baseUrl(), "http://127.0.0.1:48080");
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

test("routes config GET redacts externalDatabaseUrl to a boolean like apiKey", async () => {
	__setClientFactory(() => makeClient().client);
	try {
		const store = makeStore();
		// managed-external-postgres with a configured external DB connection URL (a secret).
		await store.put(CONFIG_KEY, { mode: "managed-external-postgres", externalDatabaseUrl: "postgres://u:p@host:5432/db", apiKey: "k" });
		const cfg = (await routes.config({ host: { store } } as never, { method: "GET" } as never)) as { config: Record<string, unknown> };
		assert.equal("externalDatabaseUrl" in cfg.config, false, "raw external DB URL secret is never echoed");
		assert.equal(cfg.config.externalDatabaseUrlSet, true, "externalDatabaseUrl collapses to a boolean");
		assert.equal("apiKey" in cfg.config, false);
		assert.equal(cfg.config.apiKeySet, true);

		// Absent secret → the *Set boolean is false (and still no raw value).
		const empty = makeStore();
		await empty.put(CONFIG_KEY, { mode: "managed" });
		const cfg2 = (await routes.config({ host: { store: empty } } as never, { method: "GET" } as never)) as { config: Record<string, unknown> };
		assert.equal(cfg2.config.externalDatabaseUrlSet, false);
		assert.equal("externalDatabaseUrl" in cfg2.config, false);
	} finally {
		__setClientFactory(null);
	}
});

// ── Managed-mode ROUTES: runtime context gating (implementation finding) ───────
//
// The routes used to build `clientConfig(cfg)` with NO runtime context, so a
// managed mode (which dials a host-injected runtime base URL, never `externalUrl`)
// produced an EMPTY base URL and could never reach a running managed runtime.
// The routes now gate every client call on `isActive(cfg, ctx.runtime)`: they use
// the host-injected `ctx.runtime` when one is present, and otherwise report a
// deterministic configured-but-not-healthy / dormant state WITHOUT dialing an
// empty base URL. External mode is unchanged (a URL is its own reachability gate).

test("routes status: managed mode WITHOUT a runtime ⇒ configured:true, healthy:false, no client constructed", async () => {
	let factoryCalls = 0;
	__setClientFactory(() => { factoryCalls++; return makeClient().client; });
	try {
		const store = makeStore();
		await store.put(CONFIG_KEY, { mode: "managed" });
		// No ctx.runtime ⇒ no reachable managed runtime from the route context.
		const st = (await routes.status({ host: { store } } as never)) as {
			configured: boolean; healthy: boolean; mode: string; queueDepth: number;
		};
		assert.equal(st.configured, true, "a selected managed mode is configured");
		assert.equal(st.healthy, false, "no running runtime ⇒ not healthy (panel renders 'Starting')");
		assert.equal(st.mode, "managed");
		assert.equal(st.queueDepth, 0);
		assert.equal(factoryCalls, 0, "no empty-base client call is made");
	} finally {
		__setClientFactory(null);
	}
});

test("routes status: managed mode WITH a running runtime probes the injected runtime base URL", async () => {
	const cap = captureClientBaseUrl();
	try {
		cap.state.healthy = true;
		const store = makeStore();
		// externalUrl is set but MUST be ignored in a managed mode.
		await store.put(CONFIG_KEY, { mode: "managed", externalUrl: "http://should-not-be-used:9999" });
		const st = (await routes.status({
			host: { store },
			runtime: { baseUrl: "http://127.0.0.1:48080", headers: { Authorization: "Bearer tok" }, status: "running" },
		} as never)) as { configured: boolean; healthy: boolean };
		assert.equal(st.configured, true);
		assert.equal(st.healthy, true, "a running managed runtime reports healthy");
		assert.equal(cap.baseUrl(), "http://127.0.0.1:48080", "health probe dials the managed runtime base URL, not externalUrl");
	} finally {
		__setClientFactory(null);
	}
});

test("routes recall: managed mode WITHOUT a runtime ⇒ configured:true, empty, no empty-base client call", async () => {
	let factoryCalls = 0;
	__setClientFactory(() => { factoryCalls++; return makeClient().client; });
	try {
		const store = makeStore();
		await store.put(CONFIG_KEY, { mode: "managed" });
		const res = (await routes.recall({ host: { store } } as never, { body: { query: "x" } } as never)) as {
			configured: boolean; memories: unknown[];
		};
		assert.deepEqual(res, { configured: true, memories: [] }, "configured-but-dormant managed recall is empty");
		assert.equal(factoryCalls, 0, "no client is constructed without a running managed runtime");
	} finally {
		__setClientFactory(null);
	}
});

test("routes recall: managed mode WITH a running runtime dials the injected runtime base URL", async () => {
	const cap = captureClientBaseUrl();
	try {
		cap.state.memories = [{ text: "managed-route-mem", id: "m1" }];
		const store = makeStore();
		await store.put(CONFIG_KEY, { mode: "managed", externalUrl: "http://should-not-be-used:9999", bank: "bobbit" });
		const res = (await routes.recall(
			{ host: { store }, runtime: { baseUrl: "http://127.0.0.1:38080", status: "running" } } as never,
			{ body: { query: "q" } } as never,
		)) as { configured: boolean; memories: { text: string }[] };
		assert.equal(res.configured, true);
		assert.equal(res.memories.length, 1);
		assert.equal(res.memories[0].text, "managed-route-mem");
		assert.equal(cap.baseUrl(), "http://127.0.0.1:38080", "recall dials the managed runtime base URL");
		assert.equal(cap.calls.recall[0].bank, "bobbit");
	} finally {
		__setClientFactory(null);
	}
});

// ── Memory-quality: defaults, scope/tags, cadence, missions, per-project overlay ─

test("config defaults: project scope + tags_match any + cadence 5 + observation-biased recall", () => {
	assert.equal(CONFIG_DEFAULTS.recallScope, "project", "default recall is project (project + global)");
	assert.equal(CONFIG_DEFAULTS.tagsMatch, "any", "any includes untagged/global memory");
	assert.equal(CONFIG_DEFAULTS.retainEveryNTurns, 5, "cost-conscious auto-retain batch size");
	assert.equal(CONFIG_DEFAULTS.retainMaxDelayMs, 1_800_000, "30m hook-observed max-delay flush");
	assert.equal(CONFIG_DEFAULTS.retainOverlapTurns, 2, "bounded overlap carry-forward");
	assert.deepEqual(CONFIG_DEFAULTS.recallTypes, ["observation", "world", "experience"]);
	assert.ok(CONFIG_DEFAULTS.retainMission.length > 0);
	assert.ok(CONFIG_DEFAULTS.observationsMission.length > 0);
	assert.ok(CONFIG_DEFAULTS.reflectMission.length > 0);
});

test("recallTagFilter: tagsMatch + extraTags variants (extra tags NARROW, never broaden)", () => {
	// any_strict (hard-isolation) opt-in for project scope.
	assert.deepEqual(recallTagFilter("project", "p", "any_strict"), { tags: { project: "p" }, tagsMatch: "any_strict" });
	// Extra tags NARROW a project recall: require project AND every extra tag and
	// EXCLUDE untagged/global + other projects (all_strict) — never the old `any`-merge
	// that broadened recall to untagged/global AND other-project goal:g memories.
	assert.deepEqual(recallTagFilter("project", "p", "any", { goal: "g" }), { tags: { project: "p", goal: "g" }, tagsMatch: "all_strict" });
	// Even with `any_strict` config, extra tags still narrow via all_strict.
	assert.deepEqual(recallTagFilter("project", "p", "any_strict", { goal: "g" }), { tags: { project: "p", goal: "g" }, tagsMatch: "all_strict" });
	// tags.project can NEVER override the route-derived project tag (it is dropped).
	assert.deepEqual(recallTagFilter("project", "p", "any", { project: "other", goal: "g" }), { tags: { project: "p", goal: "g" }, tagsMatch: "all_strict" });
	// An extra map that is ONLY `project` is fully stripped ⇒ plain project scope (no
	// spurious narrowing, and still cannot override the real project).
	assert.deepEqual(recallTagFilter("project", "p", "any", { project: "other" }), { tags: { project: "p" }, tagsMatch: "any" });
	// scope all + extra tags ⇒ additive filter (no fabricated project tag), tags_match any.
	assert.deepEqual(recallTagFilter("all", "p", "any", { project: "other" }), { tags: { project: "other" }, tagsMatch: "any" });
	// scope all without extra tags ⇒ no filter (whole bank).
	assert.equal(recallTagFilter("all", "p", "any"), undefined);
});

test("validateConfigOverrides: tagsMatch, retainEveryNTurns, recallTypes, missions", () => {
	const ok = validateConfigOverrides({ tagsMatch: "any_strict", retainEveryNTurns: 3, recallTypes: ["observation"], retainMission: "x" });
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.value, { tagsMatch: "any_strict", retainEveryNTurns: 3, recallTypes: ["observation"], retainMission: "x" });
	assert.equal(validateConfigOverrides({ tagsMatch: "nope" }).ok, false);
	assert.equal(validateConfigOverrides({ retainEveryNTurns: 0 }).ok, false);
	assert.equal(validateConfigOverrides({ recallTypes: [] }).ok, false);
	assert.equal(validateConfigOverrides({ recallTypes: ["bogus"] }).ok, false);
});

test("validateConfigOverrides: retainMaxDelayMs + retainOverlapTurns (batching cost levers)", () => {
	const ok = validateConfigOverrides({ retainMaxDelayMs: 60000, retainOverlapTurns: 3 });
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.value, { retainMaxDelayMs: 60000, retainOverlapTurns: 3 });
	// 0 is valid for both (max-delay disabled / no overlap).
	assert.deepEqual(validateConfigOverrides({ retainMaxDelayMs: 0, retainOverlapTurns: 0 }).value, { retainMaxDelayMs: 0, retainOverlapTurns: 0 });
	// Negatives + non-numbers rejected.
	assert.equal(validateConfigOverrides({ retainMaxDelayMs: -1 }).ok, false);
	assert.equal(validateConfigOverrides({ retainOverlapTurns: -2 }).ok, false);
	assert.equal(validateConfigOverrides({ retainOverlapTurns: "x" }).ok, false);
});

test("validateProjectOverride: safe keys only; cleared keys dropped; unsafe keys ignored", () => {
	const ok = validateProjectOverride({ recallScope: "all", bank: "team-bank", tagsMatch: "any_strict", recallBudget: 800, recallTypes: ["observation"] });
	assert.deepEqual(ok.value, { recallScope: "all", bank: "team-bank", tagsMatch: "any_strict", recallBudget: 800, recallTypes: ["observation"] });
	// Empty/null clears (dropped from the result).
	assert.deepEqual(validateProjectOverride({ recallScope: "", bank: null }).value, {});
	// Unsafe deployment/secret keys are ignored (never appear in the overlay).
	assert.deepEqual(validateProjectOverride({ mode: "managed", externalUrl: "http://x", apiKey: "k", recallScope: "project" }).value, { recallScope: "project" });
	assert.equal(validateProjectOverride({ recallScope: "bogus" }).ok, false);
});

test("loadEffectiveConfig precedence: project override > global > defaults", async () => {
	const store = makeStore();
	// No global, no overlay → defaults.
	let cfg = await loadEffectiveConfig(store);
	assert.equal(cfg.recallScope, "project");
	assert.equal(cfg.bank, "bobbit");
	// Global overrides defaults.
	await store.put(CONFIG_KEY, { externalUrl: "http://h", recallScope: "all", bank: "global-bank" });
	cfg = await loadEffectiveConfig(store, "proj-1");
	assert.equal(cfg.recallScope, "all");
	assert.equal(cfg.bank, "global-bank");
	// Project overlay wins over global (safe keys only).
	await store.put(projectConfigKey("proj-1"), { recallScope: "project", bank: "proj-bank" });
	cfg = await loadEffectiveConfig(store, "proj-1");
	assert.equal(cfg.recallScope, "project");
	assert.equal(cfg.bank, "proj-bank");
	// A different project does NOT see proj-1's overlay.
	const other = await loadEffectiveConfig(store, "proj-2");
	assert.equal(other.recallScope, "all");
	assert.equal(other.bank, "global-bank");
});

test("provider recall applies the per-project overlay (overlay recallScope wins) + observation bias", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "m" }];
		const store = makeStore();
		// Global base scope is `all`; the project overlay flips it to `project`.
		await store.put(projectConfigKey("proj-7"), { recallScope: "project" });
		await provider.beforePrompt({ config: { ...ACTIVE, recallScope: "all" }, host: { store }, projectId: "proj-7", prompt: "q" });
		const o = calls.recall[0].opts as { tags?: Record<string, string>; tagsMatch?: string; types?: string[] };
		assert.deepEqual(o.tags, { project: "proj-7" }, "overlay forced project scope ⇒ project tag");
		assert.equal(o.tagsMatch, "any", "project + global by default");
		assert.deepEqual(o.types, ["observation", "world", "experience"], "recall is observation-biased by default");
	} finally {
		__setClientFactory(null);
	}
});

test("recall: tagsMatch any_strict (hard-isolation) flows through to the client", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "m" }];
		const store = makeStore();
		await provider.beforePrompt({ config: { ...ACTIVE, recallScope: "project", tagsMatch: "any_strict" }, host: { store }, projectId: "p", prompt: "q" });
		const o = calls.recall[0].opts as { tags?: Record<string, string>; tagsMatch?: string };
		assert.deepEqual(o.tags, { project: "p" });
		assert.equal(o.tagsMatch, "any_strict", "any_strict excludes global (project-only)");
	} finally {
		__setClientFactory(null);
	}
});

test("auto-retain batching: default N buffers 4 turns then flushes ALL 5 in one aggregate", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		const cfg = { ...ACTIVE, retainEveryNTurns: 5 };
		for (let i = 1; i <= 4; i++) {
			await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: `turn ${i}` });
		}
		assert.equal(calls.retain.length, 0, "first four turns are buffered (no LLM extraction yet)");
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "turn 5" });
		assert.equal(calls.retain.length, 1, "the fifth turn flushes ONE aggregate retain");
		// ALL FIVE buffered turns appear in the single aggregate — batched, never sampled.
		for (let i = 1; i <= 5; i++) {
			assert.match(calls.retain[0].content, new RegExp(`User: turn ${i}\\b`), `turn ${i} is in the aggregate`);
		}
		assert.equal(calls.retain[0].opts.tags?.kind, "turn");
		// The pending buffer's primary turns are cleared after the flush (count advances).
		const buf = (await store.get("retain-pending:s")) as { turns: unknown[] };
		assert.equal(buf.turns.length, 0, "primary pending turns cleared after flush");
	} finally {
		__setClientFactory(null);
	}
});

test("auto-retain batching: N=10 buffers nine turns then flushes all ten in one aggregate", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		const cfg = { ...ACTIVE, retainEveryNTurns: 10 };
		for (let i = 1; i <= 9; i++) {
			await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: `turn ${i}` });
		}
		assert.equal(calls.retain.length, 0, "nine turns buffered, nothing flushed yet");
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "turn 10" });
		assert.equal(calls.retain.length, 1, "tenth turn flushes one aggregate");
		for (let i = 1; i <= 10; i++) {
			assert.match(calls.retain[0].content, new RegExp(`User: turn ${i}\\b`), `turn ${i} is in the N=10 aggregate`);
		}
	} finally {
		__setClientFactory(null);
	}
});

test("auto-retain batching: no buffered turn is silently dropped across consecutive batches", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		// overlapTurns:0 ⇒ each turn appears EXACTLY once across the two aggregates.
		const cfg = { ...ACTIVE, retainEveryNTurns: 3, retainOverlapTurns: 0 };
		for (let i = 1; i <= 6; i++) {
			await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: `turn ${i}` });
		}
		assert.equal(calls.retain.length, 2, "two full batches ⇒ two aggregate retains");
		const all = `${calls.retain[0].content}\n${calls.retain[1].content}`;
		for (let i = 1; i <= 6; i++) {
			assert.match(all, new RegExp(`User: turn ${i}\\b`), `turn ${i} appears in some aggregate (never dropped)`);
		}
		// First aggregate is turns 1-3, second is 4-6 (no overlap ⇒ clean partition).
		assert.match(calls.retain[0].content, /User: turn 1[\s\S]*User: turn 3/);
		assert.match(calls.retain[1].content, /User: turn 4[\s\S]*User: turn 6/);
	} finally {
		__setClientFactory(null);
	}
});

test("auto-retain batching: retainOverlapTurns carries the last summaries into the next aggregate", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		const cfg = { ...ACTIVE, retainEveryNTurns: 3, retainOverlapTurns: 2 };
		// First batch: turns 1-3 ⇒ flush; overlap carries turns 2 & 3 forward.
		for (let i = 1; i <= 3; i++) {
			await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: `turn ${i}` });
		}
		assert.equal(calls.retain.length, 1);
		// Second batch: turns 4-6 ⇒ flush; aggregate INCLUDES overlap turns 2 & 3.
		for (let i = 4; i <= 6; i++) {
			await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: `turn ${i}` });
		}
		assert.equal(calls.retain.length, 2);
		const second = calls.retain[1].content;
		assert.match(second, /Earlier context \(overlap\)/, "overlap context header present");
		assert.match(second, /User: turn 2\b/, "overlap turn 2 carried forward");
		assert.match(second, /User: turn 3\b/, "overlap turn 3 carried forward");
		assert.match(second, /User: turn 4\b/);
		assert.match(second, /User: turn 6\b/);
		// Overlap is BOUNDED — only the last 2 of the prior batch, not turn 1.
		assert.doesNotMatch(second, /User: turn 1\b/, "overlap is bounded (turn 1 not carried)");
	} finally {
		__setClientFactory(null);
	}
});

test("auto-retain batching: a later hook flushes a buffer older than retainMaxDelayMs", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		// Big batch size so count never triggers; tiny max delay so age does.
		const cfg = { ...ACTIVE, retainEveryNTurns: 100, retainMaxDelayMs: 50 };
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "stale turn" });
		assert.equal(calls.retain.length, 0, "single turn below the batch size is buffered, not flushed");
		// Backdate the pending turn so it is older than retainMaxDelayMs.
		const buf = (await store.get("retain-pending:s")) as { turns: { summary: string; ts: number }[]; overlap: string[] };
		buf.turns[0].ts = Date.now() - 10_000;
		await store.put("retain-pending:s", buf);
		// A LATER hook observes the stale buffer and flushes it (no provider timers).
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "later turn" });
		assert.equal(calls.retain.length, 1, "stale buffer flushed by the later hook");
		assert.match(calls.retain[0].content, /User: stale turn/);
		assert.match(calls.retain[0].content, /User: later turn/);
	} finally {
		__setClientFactory(null);
	}
});

test("auto-retain batching: beforeCompact synchronously flushes pending buffered turns first", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		// High batch size ⇒ the two turns stay buffered until compaction flushes them.
		const cfg = { ...ACTIVE, retainEveryNTurns: 50 };
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "buffered 1" });
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "buffered 2" });
		assert.equal(calls.retain.length, 0, "buffered, not yet flushed");
		await provider.beforeCompact({ config: { ...cfg }, host: { store }, sessionId: "s", summary: "lost span" });
		// Two retains: the flushed aggregate (sync) THEN the compact span (sync).
		assert.equal(calls.retain.length, 2);
		assert.match(calls.retain[0].content, /User: buffered 1[\s\S]*User: buffered 2/, "aggregate flushed first");
		assert.equal(calls.retain[0].opts.sync, true, "pending flush on compaction is synchronous");
		assert.equal(calls.retain[0].opts.tags?.kind, "turn");
		assert.equal(calls.retain[1].content, "lost span");
		assert.equal(calls.retain[1].opts.tags?.kind, "compaction");
		// Buffer cleared after the synchronous flush.
		const buf = (await store.get("retain-pending:s")) as { turns: unknown[] };
		assert.equal(buf.turns.length, 0);
	} finally {
		__setClientFactory(null);
	}
});

test("auto-retain batching: sessionShutdown flushes the pending buffer (best-effort)", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		await store.put(CONFIG_KEY, { externalUrl: "http://localhost:8888" });
		const cfg = { ...ACTIVE, retainEveryNTurns: 50 };
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "tail turn" });
		assert.equal(calls.retain.length, 0, "buffered below the batch size");
		await provider.sessionShutdown({ config: { ...cfg }, host: { store }, sessionId: "s" });
		assert.equal(calls.retain.length, 1, "shutdown flushes the remaining buffered turns");
		assert.match(calls.retain[0].content, /User: tail turn/);
		const buf = (await store.get("retain-pending:s")) as { turns: unknown[] };
		assert.equal(buf.turns.length, 0, "buffer drained on shutdown");
	} finally {
		__setClientFactory(null);
	}
});

test("auto-retain batching: a failed flush is durably QUEUED, never dropped, and the buffer advances", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		state.failRetain = true;
		const cfg = { ...ACTIVE, retainEveryNTurns: 2, retainOverlapTurns: 0 };
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "t1" });
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "t2" });
		// Flush attempted (and failed) ⇒ the aggregate is preserved on the retry queue.
		const q = (await store.get(QUEUE_KEY)) as { content: string }[];
		assert.equal(q.length, 1, "failed aggregate flush is durably queued");
		assert.match(q[0].content, /User: t1[\s\S]*User: t2/);
		// Buffer advanced so the count keeps moving (no unbounded growth on failure).
		const buf = (await store.get("retain-pending:s")) as { turns: unknown[] };
		assert.equal(buf.turns.length, 0, "primary pending cleared even on a failed flush");
	} finally {
		__setClientFactory(null);
	}
});

test("auto-retain batching: retainEveryNTurns=1 preserves per-turn retain", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		for (let i = 1; i <= 3; i++) {
			await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "s", prompt: `t${i}` });
		}
		assert.equal(calls.retain.length, 3, "every turn retains when N=1");
	} finally {
		__setClientFactory(null);
	}
});

test("beforeCompact retains regardless of cadence (always captures the lost span)", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		// A high cadence would skip a turn retain, but compaction is cadence-exempt.
		const cfg = { ...ACTIVE, retainEveryNTurns: 100 };
		await provider.beforeCompact({ config: { ...cfg }, host: { store }, sessionId: "s", summary: "span" });
		assert.equal(calls.retain.length, 1);
		assert.equal(calls.retain[0].opts.sync, true);
		assert.equal(calls.retain[0].opts.tags?.kind, "compaction");
	} finally {
		__setClientFactory(null);
	}
});

test("bank mission: PATCHed once per signature, re-applied only on change", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		const cfg = { ...ACTIVE, retainMission: "M1" };
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "a" });
		await provider.afterTurn({ config: { ...cfg }, host: { store }, sessionId: "s", prompt: "b" });
		assert.equal(calls.updateBankConfig.length, 1, "PATCH only once for the same mission signature");
		assert.equal(calls.updateBankConfig[0].updates.retain_mission, "M1");
		assert.ok(calls.updateBankConfig[0].updates.observations_mission, "all missions are sent");
		// A mission change re-applies (signature differs).
		await provider.afterTurn({ config: { ...cfg, retainMission: "M2" }, host: { store }, sessionId: "s", prompt: "c" });
		assert.equal(calls.updateBankConfig.length, 2, "signature change ⇒ re-PATCH");
		assert.equal(calls.updateBankConfig[1].updates.retain_mission, "M2");
	} finally {
		__setClientFactory(null);
	}
});

test("bank mission PATCH failure is non-fatal — retain still proceeds", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.failUpdateBankConfig = true;
		const store = makeStore();
		await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "s", prompt: "x" });
		assert.equal(calls.updateBankConfig.length, 1, "mission PATCH was attempted");
		assert.equal(calls.retain.length, 1, "retain proceeds despite a mission PATCH failure");
	} finally {
		__setClientFactory(null);
	}
});

test("routes config: projectOverride write/read with precedence (requires a project ctx)", async () => {
	__setClientFactory(() => makeClient().client);
	try {
		const store = makeStore();
		await store.put(CONFIG_KEY, { externalUrl: "http://h", recallScope: "all", bank: "global-bank" });
		// No project ctx ⇒ a projectOverride write is rejected.
		const noProj = (await routes.config(
			{ host: { store } } as never,
			{ method: "POST", body: { projectOverride: { recallScope: "project" } } } as never,
		)) as { ok: boolean; error?: string };
		assert.equal(noProj.ok, false);
		assert.equal(noProj.error, "NO_PROJECT");

		// With a project ctx the overlay persists, GET reflects effective + meta.
		const set = (await routes.config(
			{ host: { store }, projectId: "proj-1" } as never,
			{ method: "POST", body: { projectOverride: { recallScope: "project", bank: "proj-bank" } } } as never,
		)) as { ok: boolean; config: Record<string, unknown>; projectOverride: unknown; globalConfig: Record<string, unknown> };
		assert.equal(set.ok, true);
		assert.equal(set.config.recallScope, "project");
		assert.equal(set.config.bank, "proj-bank");
		assert.deepEqual(set.projectOverride, { recallScope: "project", bank: "proj-bank" });
		assert.equal(set.globalConfig.recallScope, "all", "globalConfig meta shows the un-overlaid global");

		// GET round-trips the overlay.
		const get = (await routes.config({ host: { store }, projectId: "proj-1" } as never, { method: "GET" } as never)) as { config: Record<string, unknown> };
		assert.equal(get.config.bank, "proj-bank");
		// A different project sees only the global.
		const other = (await routes.config({ host: { store }, projectId: "proj-2" } as never, { method: "GET" } as never)) as { config: Record<string, unknown> };
		assert.equal(other.config.bank, "global-bank");
	} finally {
		__setClientFactory(null);
	}
});

test("routes recall/reflect: optional tags NARROW a project recall (all_strict, no broadening)", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "m" }];
		const store = makeStore();
		await store.put(CONFIG_KEY, { externalUrl: "http://h", recallScope: "project" });
		// project scope + { goal } NARROWS: project AND goal, all_strict (no untagged/
		// global, no other-project goal:g leakage).
		await routes.recall({ host: { store }, projectId: "p1" } as never, { body: { query: "q", tags: { goal: "g9" } } } as never);
		const ro = calls.recall[0].opts as { tags?: Record<string, string>; tagsMatch?: string };
		assert.deepEqual(ro.tags, { project: "p1", goal: "g9" });
		assert.equal(ro.tagsMatch, "all_strict");

		// A caller-supplied tags.project can NOT override the route-derived project.
		await routes.recall({ host: { store }, projectId: "p1" } as never, { body: { query: "q", tags: { project: "evil", goal: "g9" } } } as never);
		const ro2 = calls.recall[1].opts as { tags?: Record<string, string>; tagsMatch?: string };
		assert.deepEqual(ro2.tags, { project: "p1", goal: "g9" });
		assert.equal(ro2.tagsMatch, "all_strict");

		await routes.reflect({ host: { store }, projectId: "p1" } as never, { body: { prompt: "x", scope: "project", tags: { topic: "auth" } } } as never);
		assert.deepEqual(calls.reflect[0].opts?.tags, { project: "p1", topic: "auth" });
		assert.equal(calls.reflect[0].opts?.tagsMatch, "all_strict");
	} finally {
		__setClientFactory(null);
	}
});

// ── Hindsight v2 provider mechanics ─────────────────────────────────────────

test("sessionSetup injects per-project mental model and makes zero raw recall calls", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "raw" }];
		state.mentalModel = { content: "Project decisions and open threads", last_refreshed_at: new Date().toISOString() };
		const store = makeStore();
		const out = await provider.sessionSetup({ config: { ...ACTIVE, recallScope: "project" }, host: { store }, projectId: "proj-1", prompt: "setup" });
		assert.equal(out.blocks.length, 1);
		assert.equal(out.blocks[0].title, "Project memory model");
		assert.equal(out.blocks[0].content, "Project decisions and open threads");
		assert.equal(calls.recall.length, 0, "raw recall is skipped when model is injected");
		assert.equal(calls.ensureMentalModel.length, 1);
		const spec = calls.ensureMentalModel[0].spec;
		assert.deepEqual(spec.tags, ["project:proj-1", "bobbit", "kind:mental-model"]);
		assert.deepEqual(spec.trigger, {
			fact_types: ["observation", "world", "experience"],
			exclude_mental_models: true,
			include: null,
			tags: ["project:proj-1"],
			tags_match: "all_strict",
		});
		assert.equal(calls.getMentalModel[0].id, "bobbit-proj-1");
	} finally {
		__setClientFactory(null);
	}
});

test("sessionSetup falls back to raw recall when mental model is empty or disabled", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "fallback" }];
		state.mentalModel = null;
		const store = makeStore();
		const out = await provider.sessionSetup({ config: { ...ACTIVE, recallScope: "project" }, host: { store }, projectId: "proj-1", prompt: "setup" });
		assert.equal(out.blocks[0].content, "- fallback");
		assert.equal(calls.recall.length, 1, "empty async mental model falls back to raw recall");

		await provider.sessionSetup({ config: { ...ACTIVE, recallScope: "project", mentalModelEnabled: false }, host: { store }, projectId: "proj-2", prompt: "setup2" });
		assert.equal(calls.ensureMentalModel.length, 1, "disabled mental model does not call mental-model API");
		assert.equal(calls.recall.length, 2);
	} finally {
		__setClientFactory(null);
	}
});

test("mental model refresh is cadence-bounded", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.mentalModel = { content: "state", is_stale: true };
		const store = makeStore();
		const c = { config: { ...ACTIVE, mentalModelRefreshEveryMs: 60_000 }, host: { store }, projectId: "proj-r", prompt: "setup" };
		await provider.sessionSetup(c);
		await provider.sessionSetup(c);
		assert.equal(calls.refreshMentalModel.length, 1, "second setup is inside cadence window");
	} finally {
		__setClientFactory(null);
	}
});

test("recall opts carry queryTimestamp when enabled and never enable include.chunks", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.memories = [{ text: "m" }];
		await provider.beforePrompt({ config: { ...ACTIVE }, host: { store: makeStore() }, prompt: "q" });
		const opts = calls.recall[0].opts as Record<string, unknown>;
		assert.equal(typeof opts.queryTimestamp, "string", "recallQueryTimestampEnabled defaults true");
		assert.equal("include" in opts, false, "chunks stay default-disabled");
		calls.recall.length = 0;
		await provider.beforePrompt({ config: { ...ACTIVE, recallQueryTimestampEnabled: false }, host: { store: makeStore() }, prompt: "q2" });
		assert.equal("queryTimestamp" in (calls.recall[0].opts as Record<string, unknown>), false);
	} finally {
		__setClientFactory(null);
	}
});

test("auto-retain forwards project observation_scopes and derived entities", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		await provider.afterTurn({
			config: { ...ACTIVE },
			host: { store: makeStore() },
			sessionId: "s",
			projectId: "proj-1",
			prompt: "u",
			response: "a",
			changedFiles: ["src/a.ts"],
			components: ["provider"],
		});
		const opts = calls.retain[0].opts;
		assert.deepEqual(opts.observationScopes, [["project:proj-1"]]);
		assert.deepEqual(opts.entities, [
			{ text: "src/a.ts", type: "file" },
			{ text: "provider", type: "component" },
		]);
	} finally {
		__setClientFactory(null);
	}
});

test("retry queue preserves observation scopes and entities on replay", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		state.failRetain = true;
		await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "s", projectId: "p", prompt: "u", changedFiles: ["x.ts"] });
		state.failRetain = false;
		calls.retain.length = 0;
		await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "s2", prompt: "drain" });
		const replay = calls.retain.find((r) => /User: u/.test(r.content));
		assert.ok(replay);
		assert.deepEqual(replay!.opts.observationScopes, [["project:p"]]);
		assert.deepEqual(replay!.opts.entities, [{ text: "x.ts", type: "file" }]);
	} finally {
		__setClientFactory(null);
	}
});

test("directives are bank-wide safe: not applied by default, applied idempotently only when enabled", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		await provider.afterTurn({ config: { ...ACTIVE }, host: { store }, sessionId: "s", prompt: "a" });
		assert.equal(calls.createDirective.length, 0);
		await provider.afterTurn({ config: { ...ACTIVE, directivesEnabled: true }, host: { store }, sessionId: "s", prompt: "b" });
		assert.equal(calls.createDirective.length, 0, "directivesEnabled alone keeps bank-wide writes disabled");
		const enabled = { ...ACTIVE, directivesEnabled: true, directiveApplyMode: "bank-wide-explicit-opt-in" as const };
		await provider.afterTurn({ config: enabled, host: { store }, sessionId: "s", prompt: "c" });
		await provider.afterTurn({ config: enabled, host: { store }, sessionId: "s", prompt: "d" });
		assert.equal(calls.listDirectives.length, 1);
		assert.equal(calls.createDirective.length, 1);
		assert.equal(calls.createDirective[0].directive.name, "bobbit-coding-agent-recall");
		assert.equal(calls.updateDirective.length, 0);
	} finally {
		__setClientFactory(null);
	}
});

test("health-gated shutdown drain defers on unhealthy probe and bounded drain honors max", async () => {
	const { client, calls, state } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		await store.put(QUEUE_KEY, [
			{ content: "one", tags: { kind: "turn" }, ts: 1, bank: "bobbit", namespace: "default" },
			{ content: "two", tags: { kind: "turn" }, ts: 2, bank: "bobbit", namespace: "default" },
			{ content: "three", tags: { kind: "turn" }, ts: 3, bank: "bobbit", namespace: "default" },
		]);
		state.healthy = false;
		await provider.sessionShutdown({ config: { ...ACTIVE, retainQueueShutdownMax: 2 }, host: { store }, sessionId: "s" });
		assert.equal(calls.retain.length, 0, "unhealthy probe defers queue drain");
		assert.equal(((await store.get(QUEUE_KEY)) as unknown[]).length, 3);

		state.healthy = true;
		await provider.sessionShutdown({ config: { ...ACTIVE, retainQueueShutdownMax: 2, retainQueueLlmHealthGate: true }, host: { store }, sessionId: "s" });
		assert.deepEqual(calls.llmHealth, ["bobbit"], "uses llmHealth(bank) when LLM health gate is enabled");
		assert.equal(calls.retain.length, 2, "bounded drain replays only max entries");
		assert.equal(((await store.get(QUEUE_KEY)) as unknown[]).length, 1);
	} finally {
		__setClientFactory(null);
	}
});

test("shutdown queue drain is bounded to 10 by default", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		await store.put(QUEUE_KEY, Array.from({ length: 12 }, (_, i) => ({ content: `entry-${i}`, tags: { kind: "turn" }, ts: i, bank: "bobbit", namespace: "default" })));
		await provider.sessionShutdown({ config: { ...ACTIVE }, host: { store }, sessionId: "s" });
		assert.equal(calls.retain.length, 10);
		assert.equal(((await store.get(QUEUE_KEY)) as unknown[]).length, 2);
	} finally {
		__setClientFactory(null);
	}
});

test("goalCompleted retains one async replace outcome digest and duplicate calls are idempotent", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		const c = {
			config: { ...ACTIVE },
			host: { store },
			projectId: "proj-1",
			goalId: "goal-1",
			headSha: "abc123",
			pullRequest: { number: 42, state: "OPEN", url: "https://github.com/SuuBro/bobbit/pull/42", title: "Ship provider mechanics" },
			title: "Ship provider mechanics",
			touchedFiles: ["market-packs/hindsight/src/provider.ts"],
			decisions: ["Use stable outcome document id"],
			tasks: [
				{ title: "Implement provider mechanics", type: "implementation", state: "complete", resultSummary: "Changed market-packs/hindsight/src/provider.ts" },
			],
			gates: [
				{ gateId: "implementation", name: "Implementation", status: "passed", signalCount: 2, latestCommitSha: "abc123" },
			],
		};
		await provider.goalCompleted(c as never);
		await provider.goalCompleted(c as never);
		assert.equal(calls.retain.length, 1);
		const r = calls.retain[0];
		assert.match(r.content, /Goal completed: goal-1/);
		assert.equal(r.opts.documentId, "outcome:goal-1");
		assert.equal(r.opts.updateMode, "replace");
		assert.deepEqual(r.opts.observationScopes, [["project:proj-1"]]);
		assert.deepEqual(r.opts.entities, [{ text: "market-packs/hindsight/src/provider.ts", type: "file" }]);
		assert.match(r.content, /Pull request: #42 OPEN https:\/\/github\.com\/SuuBro\/bobbit\/pull\/42/);
		assert.match(r.content, /Tasks:\n- \[complete\] Implement provider mechanics \(implementation\) — Changed market-packs\/hindsight\/src\/provider\.ts/);
		assert.match(r.content, /Gates:\n- Implementation: passed, signals=2, commit=abc123/);
		assert.equal(r.opts.tags?.kind, "outcome");
		assert.equal(r.opts.tags?.pr, "42");
	} finally {
		__setClientFactory(null);
	}
});

test("goalCompleted queues outcome digest on retain failure without throwing", async () => {
	const { client, state } = makeClient();
	__setClientFactory(() => client);
	try {
		state.failRetain = true;
		const store = makeStore();
		await provider.goalCompleted({ config: { ...ACTIVE }, host: { store }, projectId: "p", goalId: "g", headSha: "h", changedFiles: ["f.ts"] } as never);
		const q = (await store.get(QUEUE_KEY)) as Array<Record<string, unknown>>;
		assert.equal(q.length, 1);
		assert.equal(q[0].documentId, "outcome:g");
		assert.equal(q[0].updateMode, "replace");
		assert.deepEqual(q[0].observationScopes, [["project:p"]]);
		assert.deepEqual(q[0].entities, [{ text: "f.ts", type: "file" }]);
	} finally {
		__setClientFactory(null);
	}
});

test("goalCompleted retries the retain when a prior marker is stuck at non-terminal state \"started\" (mid-flight crash recovery)", async () => {
	const { client, calls } = makeClient();
	__setClientFactory(() => client);
	try {
		const store = makeStore();
		// Simulate a prior process crashing between writing the "started" marker and
		// completing the retain: the marker exists but never advanced to a terminal state.
		await store.put("goal-completed:goal-1:abc123", { ts: Date.now(), state: "started" });
		await provider.goalCompleted({ config: { ...ACTIVE }, host: { store }, projectId: "p", goalId: "goal-1", headSha: "abc123", changedFiles: ["f.ts"] } as never);
		assert.equal(calls.retain.length, 1);
	} finally {
		__setClientFactory(null);
	}
});

test("goalCompleted stays idempotent when a prior marker is at a terminal state (\"retained\" or \"queued\")", async () => {
	for (const state of ["retained", "queued"]) {
		const { client, calls } = makeClient();
		__setClientFactory(() => client);
		try {
			const store = makeStore();
			await store.put("goal-completed:goal-1:abc123", { ts: Date.now(), state });
			await provider.goalCompleted({ config: { ...ACTIVE }, host: { store }, projectId: "p", goalId: "goal-1", headSha: "abc123", changedFiles: ["f.ts"] } as never);
			assert.equal(calls.retain.length, 0, `expected no retain when prior marker state is "${state}"`);
		} finally {
			__setClientFactory(null);
		}
	}
});
