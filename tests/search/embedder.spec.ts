/**
 * Unit tests for `src/server/search/embedder.ts`.
 *
 * Verifies the `Embedder` contract using the deterministic fake embedder
 * (no model download). A separate smoke test exercises the real
 * `NomicEmbedder` end-to-end; it is gated behind `RUN_REAL_EMBEDDER=1`
 * and is skipped in CI.
 *
 * Design reference: docs/design/semantic-search.md §3, §6, §11.
 */
import { test, expect } from "@playwright/test";
import {
	createFakeEmbedder,
	NomicEmbedder,
	NOMIC_DIM,
	NOMIC_EMBEDDER_ID,
} from "../../src/server/search/embedder.ts";
import type { Embedder } from "../../src/server/search/types.ts";

test.describe("createFakeEmbedder", () => {
	test("advertises 768-dim and a stable id", () => {
		const e = createFakeEmbedder();
		expect(e.dim).toBe(768);
		expect(typeof e.id).toBe("string");
		expect(e.id.length).toBeGreaterThan(0);
	});

	test("ready() is a no-op and idempotent under concurrent callers", async () => {
		const e = createFakeEmbedder();
		await Promise.all([e.ready(), e.ready(), e.ready(), e.ready()]);
		// If we got here without throwing, contract is satisfied.
		expect(true).toBe(true);
	});

	test("embed returns one Float32Array per input with correct dim", async () => {
		const e = createFakeEmbedder();
		const out = await e.embed(["alpha", "beta", "gamma"], "document");
		expect(out).toHaveLength(3);
		for (const v of out) {
			expect(v).toBeInstanceOf(Float32Array);
			expect(v.length).toBe(768);
		}
	});

	test("embed on empty batch returns empty array", async () => {
		const e = createFakeEmbedder();
		const out = await e.embed([], "document");
		expect(out).toHaveLength(0);
	});

	test("output is L2-normalized", async () => {
		const e = createFakeEmbedder();
		const [v] = await e.embed(["some text"], "document");
		let s = 0;
		for (let i = 0; i < v.length; i++) s += v[i] * v[i];
		expect(Math.sqrt(s)).toBeGreaterThan(0.99);
		expect(Math.sqrt(s)).toBeLessThan(1.01);
	});

	test("same text + same kind → identical vector (deterministic)", async () => {
		const a = createFakeEmbedder();
		const b = createFakeEmbedder();
		const [va] = await a.embed(["hello world"], "document");
		const [vb] = await b.embed(["hello world"], "document");
		expect(Array.from(va)).toEqual(Array.from(vb));
	});

	test("different `kind` produces different outputs for same text", async () => {
		const e = createFakeEmbedder();
		const [vd] = await e.embed(["same text"], "document");
		const [vq] = await e.embed(["same text"], "query");
		let diff = 0;
		for (let i = 0; i < vd.length; i++) diff += Math.abs(vd[i] - vq[i]);
		expect(diff).toBeGreaterThan(0.01);
	});

	test("batched call routes each input through the pipeline", async () => {
		const e = createFakeEmbedder();
		const inputs = ["one", "two", "three", "four"];
		const out = await e.embed(inputs, "document");
		// Batch preserves order.
		const single = await Promise.all(inputs.map((t) => e.embed([t], "document")));
		for (let i = 0; i < inputs.length; i++) {
			expect(Array.from(out[i])).toEqual(Array.from(single[i][0]));
		}
		// Records the call for test assertions.
		expect(e.calls.length).toBeGreaterThanOrEqual(1);
		expect(e.calls[0].texts).toEqual(inputs);
		expect(e.calls[0].kind).toBe("document");
	});

	test("countTokens is cheap and deterministic", () => {
		const e = createFakeEmbedder();
		const text = "the quick brown fox jumps over the lazy dog";
		const t0 = process.hrtime.bigint();
		const n = e.countTokens(text);
		const t1 = process.hrtime.bigint();
		// Should be microseconds; assert a very loose bound so this isn't
		// flaky under CI load — the goal is "not embedding".
		const elapsedMs = Number(t1 - t0) / 1e6;
		expect(elapsedMs).toBeLessThan(50);
		// Deterministic: two calls return the same count.
		expect(e.countTokens(text)).toBe(n);
		expect(n).toBeGreaterThan(0);
	});

	test("countTokens empty string", () => {
		const e = createFakeEmbedder();
		expect(e.countTokens("")).toBe(0);
	});

	test("satisfies Embedder interface structurally", () => {
		const e: Embedder = createFakeEmbedder();
		expect(typeof e.id).toBe("string");
		expect(typeof e.dim).toBe("number");
		expect(typeof e.embed).toBe("function");
		expect(typeof e.countTokens).toBe("function");
		expect(typeof e.ready).toBe("function");
	});
});

test.describe("NomicEmbedder constants", () => {
	test("exposes stable id and dim", () => {
		const e = new NomicEmbedder();
		expect(e.id).toBe(NOMIC_EMBEDDER_ID);
		expect(e.dim).toBe(NOMIC_DIM);
		expect(e.id).toBe("nomic-embed-text-v1.5");
		expect(e.dim).toBe(768);
	});

	test("countTokens falls back to approx before ready()", () => {
		const e = new NomicEmbedder();
		// Pre-ready() the tokenizer isn't loaded; approx should kick in.
		expect(e.countTokens("abcd")).toBe(1); // 4 chars / 4 = 1
		expect(e.countTokens("abcdefgh")).toBe(2);
		expect(e.countTokens("")).toBe(0);
	});
});

// ── Real model smoke (opt-in) ────────────────────────────────────────

const runReal = process.env.RUN_REAL_EMBEDDER === "1";
test.describe("NomicEmbedder real model (smoke, opt-in)", () => {
	test.skip(!runReal, "set RUN_REAL_EMBEDDER=1 to run; downloads ~140MB");

	test("embeds a query end-to-end", async () => {
		test.setTimeout(10 * 60_000); // first download may be slow
		const e = new NomicEmbedder();
		await e.ready();
		const [v] = await e.embed(["hello world"], "query");
		expect(v).toBeInstanceOf(Float32Array);
		expect(v.length).toBe(NOMIC_DIM);
		// Normalized to ~unit length.
		let s = 0;
		for (let i = 0; i < v.length; i++) s += v[i] * v[i];
		expect(Math.sqrt(s)).toBeGreaterThan(0.99);
		expect(Math.sqrt(s)).toBeLessThan(1.01);
		// Real tokenizer should now return > approx for realistic text.
		expect(e.countTokens("the quick brown fox")).toBeGreaterThan(0);
	});
});
