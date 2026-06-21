/**
 * Unit — Hindsight agent tool `execute()` text formatting (finding #4).
 *
 * The shipped recall route/client return memories in the shape
 * `{ id, text, score, ... }` (see market-packs/hindsight/src/hindsight-client.ts
 * RecallMemory). The `hindsight_recall` tool's `execute()` wrapper must render
 * each memory's human-readable `text`, NOT a JSON blob. This pins that the
 * formatting prefers `text`, falls back to a legacy `content` field, and only
 * uses JSON as a last resort.
 *
 * The route HTTP round-trip is covered by tests/e2e/hindsight-agent-tools.spec.ts;
 * this unit test drives only the thin `execute()` formatting wrapper with the two
 * gateway calls (surface-token mint + route dispatch) stubbed via a fake fetch.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import registerHindsightTools from "../market-packs/hindsight/tools/hindsight/extension.ts";
import { routes, __setClientFactory } from "../market-packs/hindsight/src/routes.ts";
import { CONFIG_KEY } from "../market-packs/hindsight/src/shared.ts";

type ExecuteFn = (toolUseId: string, params: unknown, signal?: AbortSignal) => Promise<any>;

function captureTools(): { api: any; get: (name: string) => ExecuteFn } {
	const tools = new Map<string, ExecuteFn>();
	const api = {
		registerTool(config: any) {
			if (config?.name && typeof config.execute === "function") {
				tools.set(config.name, config.execute.bind(config));
			}
		},
	};
	return {
		api,
		get: (name: string) => {
			const fn = tools.get(name);
			if (!fn) throw new Error(`tool ${name} was not registered`);
			return fn;
		},
	};
}

function textOf(result: any): string {
	const item = result?.content?.[0];
	return typeof item?.text === "string" ? item.text : "";
}

/** Stub the gateway: surface-token mint → {token}, route dispatch → routeResult. */
interface FetchRecord { url: string; body?: any }

function stubFetch(routeResult: unknown, records?: FetchRecord[]): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const u = String(url);
		let parsedBody: any;
		if (typeof init?.body === "string") {
			try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
		}
		records?.push({ url: u, body: parsedBody });
		const body = u.includes("/api/ext/surface-token") ? { token: "surface-token" } : routeResult;
		return {
			status: 200,
			ok: true,
			text: async () => JSON.stringify(body),
		} as unknown as Response;
	}) as typeof fetch;
	return () => { globalThis.fetch = original; };
}

function routeDispatch(records: FetchRecord[]): any {
	return records.find((r) => r.url.includes("/api/ext/route/"))?.body;
}

describe("hindsight_recall execute — memory text formatting (finding #4)", () => {
	let recall: ExecuteFn;
	const prevEnv: Record<string, string | undefined> = {};

	before(() => {
		for (const k of ["BOBBIT_SESSION_ID", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL", "BOBBIT_DIR"]) {
			prevEnv[k] = process.env[k];
		}
		// Force env-fallback creds (no on-disk gateway files in the test sandbox).
		delete process.env.BOBBIT_DIR;
		process.env.BOBBIT_SESSION_ID = "sess-test";
		process.env.BOBBIT_TOKEN = "test-token";
		process.env.BOBBIT_GATEWAY_URL = "http://127.0.0.1:0";
		const { api, get } = captureTools();
		registerHindsightTools(api as any);
		recall = get("hindsight_recall");
	});

	after(() => {
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k]; else process.env[k] = v;
		}
	});

	let restoreFetch: () => void = () => {};
	beforeEach(() => { restoreFetch(); restoreFetch = () => {}; });

	it("renders each memory's `text`, not a JSON blob", async () => {
		restoreFetch = stubFetch({
			configured: true,
			memories: [
				{ id: "m1", text: "Risky rollouts always go behind a feature flag.", score: 0.91 },
				{ id: "m2", text: "Billing migrated to the new queue.", score: 0.8 },
			],
		});
		const result = await recall("tool-use-id", { query: "rollout policy" });
		const text = textOf(result);
		assert.notEqual(result?.isError, true);
		assert.match(text, /1\. Risky rollouts always go behind a feature flag\./);
		assert.match(text, /2\. Billing migrated to the new queue\./);
		// The structured result is still exposed under details; the displayed text
		// must NOT be a JSON blob of the memory object.
		assert.ok(!text.includes("\"text\""), "displayed text must not be a JSON dump");
		assert.ok(!text.includes("score"), "displayed text must not leak the score field");
		assert.equal(result.details.count, 2);
	});

	it("falls back to `content` when `text` is absent", async () => {
		restoreFetch = stubFetch({
			configured: true,
			memories: [{ id: "m1", content: "Legacy content field." }],
		});
		const result = await recall("tool-use-id", { query: "q" });
		assert.match(textOf(result), /1\. Legacy content field\./);
	});

	it("falls back to JSON only when neither text nor content is present", async () => {
		restoreFetch = stubFetch({
			configured: true,
			memories: [{ id: "m1", foo: "bar" }],
		});
		const result = await recall("tool-use-id", { query: "q" });
		assert.match(textOf(result), /"foo":"bar"/);
	});

	it("reports a dormant (unconfigured) Hindsight without error", async () => {
		restoreFetch = stubFetch({ configured: false, memories: [] });
		const result = await recall("tool-use-id", { query: "q" });
		assert.notEqual(result?.isError, true);
		assert.match(textOf(result), /not configured/i);
		assert.equal(result.details.configured, false);
	});
});

describe("Hindsight v2 route/tool execute wrappers", () => {
	let reflect: ExecuteFn;
	let retain_outcome: ExecuteFn;
	let invalidate: ExecuteFn;
	const prevEnv: Record<string, string | undefined> = {};

	before(() => {
		for (const k of ["BOBBIT_SESSION_ID", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL", "BOBBIT_DIR"]) {
			prevEnv[k] = process.env[k];
		}
		delete process.env.BOBBIT_DIR;
		process.env.BOBBIT_SESSION_ID = "sess-test";
		process.env.BOBBIT_TOKEN = "test-token";
		process.env.BOBBIT_GATEWAY_URL = "http://127.0.0.1:0";
		const { api, get } = captureTools();
		registerHindsightTools(api as any);
		reflect = get("hindsight_reflect");
		retain_outcome = get("hindsight_retain_outcome");
		invalidate = get("hindsight_invalidate");
	});

	after(() => {
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k]; else process.env[k] = v;
		}
	});

	let restoreFetch: () => void = () => {};
	beforeEach(() => { restoreFetch(); restoreFetch = () => {}; });

	it("hindsight_reflect forwards structured options and displays structuredOutput", async () => {
		const records: FetchRecord[] = [];
		restoreFetch = stubFetch({ configured: true, text: "Structured result", structuredOutput: { component: "billing", status: "done" } }, records);
		const schema = { type: "object", properties: { component: { type: "string" }, status: { type: "string" } } };
		const result = await reflect("tool-use-id", {
			prompt: "summarize billing",
			responseSchema: schema,
			factTypes: ["observation"],
			excludeMentalModels: true,
		});
		assert.notEqual(result?.isError, true);
		assert.match(textOf(result), /```json/);
		assert.match(textOf(result), /"component": "billing"/);
		assert.deepEqual(result.details.structuredOutput, { component: "billing", status: "done" });
		const dispatch = routeDispatch(records);
		assert.equal(dispatch?.init?.body?.prompt, "summarize billing");
		assert.deepEqual(dispatch?.init?.body?.responseSchema, schema);
		assert.deepEqual(dispatch?.init?.body?.factTypes, ["observation"]);
		assert.equal(dispatch?.init?.body?.excludeMentalModels, true);
	});

	it("hindsight_retain_outcome dispatches the dedicated stable outcome route", async () => {
		const records: FetchRecord[] = [];
		restoreFetch = stubFetch({ ok: true, configured: true, documentId: "outcome:g1" }, records);
		const result = await retain_outcome("tool-use-id", {
			content: "Completed billing queue migration.",
			goalId: "g1",
			pr: 42,
			files: ["src/billing.ts"],
			components: ["billing"],
			tags: { release: "v2" },
			timestamp: "2026-06-21T00:00:00.000Z",
		});
		assert.notEqual(result?.isError, true);
		assert.match(textOf(result), /Outcome retained \(outcome:g1\)\./);
		const dispatch = routeDispatch(records);
		assert.match(records.find((r) => r.url.includes("/api/ext/route/"))?.url ?? "", /retain_outcome$/);
		assert.equal(dispatch?.init?.body?.content, "Completed billing queue migration.");
		assert.equal(dispatch?.init?.body?.goalId, "g1");
		assert.equal(dispatch?.init?.body?.pr, 42);
		assert.deepEqual(dispatch?.init?.body?.files, ["src/billing.ts"]);
	});

	it("hindsight_invalidate validates input and dispatches id + reason", async () => {
		const invalid = await invalidate("tool-use-id", { id: "m1" });
		assert.equal(invalid?.isError, true);
		assert.match(textOf(invalid), /reason is required/);

		const records: FetchRecord[] = [];
		restoreFetch = stubFetch({ ok: true, configured: true, id: "m1" }, records);
		const result = await invalidate("tool-use-id", { id: "m1", reason: "Superseded by new architecture decision." });
		assert.notEqual(result?.isError, true);
		assert.match(textOf(result), /Memory invalidated \(m1\)\./);
		const dispatch = routeDispatch(records);
		assert.equal(dispatch?.init?.body?.id, "m1");
		assert.equal(dispatch?.init?.body?.reason, "Superseded by new architecture decision.");
	});
});

function makeRouteStore() {
	const map = new Map<string, unknown>();
	return {
		get: async (k: string) => (map.has(k) ? structuredClone(map.get(k)) : null),
		put: async (k: string, v: unknown) => { map.set(k, structuredClone(v)); },
		list: async (prefix = "") => [...map.keys()].filter((k) => k.startsWith(prefix)),
	};
}

async function activeRouteCtx(projectId = "proj-1") {
	const store = makeRouteStore();
	await store.put(CONFIG_KEY, {
		mode: "external",
		externalUrl: "http://localhost:8888",
		bank: "bobbit",
		namespace: "default",
		recallScope: "project",
		tagsMatch: "any",
		recallBudget: 1200,
		recallTypes: ["observation", "world", "experience"],
		timeoutMs: 1500,
	});
	return { host: { store }, projectId };
}

describe("Hindsight v2 routes", () => {
	beforeEach(() => __setClientFactory(null));
	after(() => __setClientFactory(null));

	it("recall passes queryTimestamp and keeps chunks off by default", async () => {
		const calls: any[] = [];
		__setClientFactory(() => ({
			health: async () => ({ ok: true }),
			ensureBank: async () => {},
			recall: async (bank: string, query: string, opts: unknown) => { calls.push({ bank, query, opts }); return { memories: [] }; },
			retain: async () => {},
			reflect: async () => ({ text: "" }),
			listBanks: async () => ({ banks: [] }),
			updateBankConfig: async () => {},
		}));
		const ctx = await activeRouteCtx();
		await routes.recall(ctx, { body: { query: "recent decisions", queryTimestamp: "2026-06-21T00:00:00.000Z" } });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].opts.queryTimestamp, "2026-06-21T00:00:00.000Z");
		assert.deepEqual(calls[0].opts.types, ["observation", "world", "experience"]);
		assert.equal("include" in calls[0].opts, false);
	});

	it("reflect forwards schema options and adds the safe per-request Bobbit instruction", async () => {
		const calls: any[] = [];
		__setClientFactory(() => ({
			health: async () => ({ ok: true }),
			ensureBank: async () => {},
			recall: async () => ({ memories: [] }),
			retain: async () => {},
			reflect: async (bank: string, prompt: string, opts: unknown) => {
				calls.push({ bank, prompt, opts });
				return { text: "ok", structuredOutput: { answer: "yes" } };
			},
			listBanks: async () => ({ banks: [] }),
			updateBankConfig: async () => {},
		}));
		const schema = { type: "object", properties: { answer: { type: "string" } } };
		const ctx = await activeRouteCtx();
		const res = await routes.reflect(ctx, { body: { prompt: "what happened?", responseSchema: schema, factTypes: ["observation"], excludeMentalModels: true } });
		assert.equal(res.configured, true);
		assert.deepEqual(res.structuredOutput, { answer: "yes" });
		assert.match(calls[0].prompt, /Bobbit coding-agent memory reflection instructions/);
		assert.match(calls[0].prompt, /what happened\?/);
		assert.deepEqual(calls[0].opts.responseSchema, schema);
		assert.deepEqual(calls[0].opts.factTypes, ["observation"]);
		assert.equal(calls[0].opts.excludeMentalModels, true);
	});

	it("retain_outcome builds stable document id, canonical tags, entities, and observation scopes", async () => {
		const calls: any[] = [];
		__setClientFactory(() => ({
			health: async () => ({ ok: true }),
			ensureBank: async () => {},
			recall: async () => ({ memories: [] }),
			retain: async (bank: string, content: string, opts: unknown) => { calls.push({ bank, content, opts }); },
			reflect: async () => ({ text: "" }),
			listBanks: async () => ({ banks: [] }),
			updateBankConfig: async () => {},
		}));
		const ctx = await activeRouteCtx("proj-7");
		const res = await routes.retain_outcome(ctx, { body: { content: "Shipped billing queue.", goalId: "g7", pr: 88, files: ["src/billing.ts"], components: ["billing"], tags: { kind: "spoof", topic: "billing" }, timestamp: "2026-06-21T00:00:00.000Z" } });
		assert.equal(res.ok, true);
		assert.equal(res.documentId, "outcome:g7");
		assert.equal(calls[0].opts.documentId, "outcome:g7");
		assert.equal(calls[0].opts.updateMode, "replace");
		assert.equal(calls[0].opts.timestamp, "2026-06-21T00:00:00.000Z");
		assert.deepEqual(calls[0].opts.observationScopes, [["project:proj-7"]]);
		assert.deepEqual(calls[0].opts.entities, [{ text: "src/billing.ts", type: "file" }, { text: "billing", type: "component" }]);
		assert.equal(calls[0].opts.tags.kind, "outcome");
		assert.equal(calls[0].opts.tags.project, "proj-7");
		assert.equal(calls[0].opts.tags.goal, "g7");
		assert.equal(calls[0].opts.tags.pr, "88");
		assert.equal(calls[0].opts.tags.bobbit, "true");
		assert.equal(calls[0].opts.tags.topic, "billing");
	});

	it("invalidate route calls reversible curation client method", async () => {
		const calls: any[] = [];
		__setClientFactory(() => ({
			health: async () => ({ ok: true }),
			ensureBank: async () => {},
			recall: async () => ({ memories: [] }),
			retain: async () => {},
			reflect: async () => ({ text: "" }),
			listBanks: async () => ({ banks: [] }),
			updateBankConfig: async () => {},
			invalidateMemory: async (bank: string, id: string, reason: string) => { calls.push({ bank, id, reason }); },
		}));
		const ctx = await activeRouteCtx();
		const res = await routes.invalidate(ctx, { body: { id: "m1", reason: "Wrong architecture." } });
		assert.equal(res.ok, true);
		assert.deepEqual(calls, [{ bank: "bobbit", id: "m1", reason: "Wrong architecture." }]);
	});
});
