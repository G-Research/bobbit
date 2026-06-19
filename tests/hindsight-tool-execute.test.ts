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
function stubFetch(routeResult: unknown): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL) => {
		const u = String(url);
		const body = u.includes("/api/ext/surface-token") ? { token: "surface-token" } : routeResult;
		return {
			status: 200,
			ok: true,
			text: async () => JSON.stringify(body),
		} as unknown as Response;
	}) as typeof fetch;
	return () => { globalThis.fetch = original; };
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
