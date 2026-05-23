/**
 * Unit test for the 25 MB cap in `imageFromUrl()` inside
 * `src/server/agent/image-generation.ts`.
 *
 * `imageFromUrl` is module-private. We exercise it end-to-end via
 * `generateImage()` with a DALL-E (non-`gpt-image`) model whose response body
 * surfaces a `url` row, which forces the code path that calls
 * `imageFromUrl`.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateImage } from "../src/server/agent/image-generation.js";
import { PreferencesStore } from "../src/server/agent/preferences-store.js";

let tmp: string;
let prefs: PreferencesStore;
let origFetch: typeof fetch;
let previousAgentDir: string | undefined;

const MB = 1024 * 1024;

before(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-imgcap-"));
	previousAgentDir = process.env.BOBBIT_AGENT_DIR;
	process.env.BOBBIT_AGENT_DIR = tmp;
	mkdirSync(tmp, { recursive: true });
	// No OAuth credential — we set the OpenAI key via prefs below so the
	// non-GPT-Image path is used.
	prefs = new PreferencesStore(tmp);
	prefs.set("providerEnabled.openai", true);
	prefs.set("providerKey.openai", "test-key");
	origFetch = globalThis.fetch;
});

after(() => {
	globalThis.fetch = origFetch;
	if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
	rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	globalThis.fetch = origFetch;
});

/**
 * Mock the two-stage fetch flow:
 *   1. POST .../images/generations → returns a single `{ url: "..." }` row.
 *   2. GET <imageUrl> → returns the response we want imageFromUrl to consume.
 */
function mockTwoStage(imageResponseBuilder: () => Response): void {
	let stage = 0;
	globalThis.fetch = (async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : (input as any).url;
		if (stage === 0) {
			stage = 1;
			// Sanity: we are in the OpenAI Images endpoint.
			assert.match(String(url), /\/images\/generations/);
			return new Response(JSON.stringify({
				data: [{ url: "https://oaidalleapiprodscus.blob.core.windows.net/large.png", revised_prompt: "x" }],
			}), { status: 200 });
		}
		// Stage 1: the imageFromUrl GET call.
		assert.equal(String(url), "https://oaidalleapiprodscus.blob.core.windows.net/large.png");
		void init;
		return imageResponseBuilder();
	}) as any;
}

async function callGenerate(): Promise<Error | undefined> {
	try {
		await generateImage(prefs, { prompt: "test", model: "openai/dall-e-3" });
		return undefined;
	} catch (err) {
		return err as Error;
	}
}

describe("imageFromUrl 25 MB cap", () => {
	it("rejects up-front when Content-Length advertises >25 MB", async () => {
		mockTwoStage(() => new Response("ignored", {
			status: 200,
			headers: {
				"content-type": "image/png",
				"content-length": String(26 * MB),
			},
		}));
		const err = await callGenerate();
		assert.ok(err, "expected throw");
		assert.match(err!.message, /remote image exceeds 25 MB cap/);
	});

	it("rejects when streaming reader pushes chunks summing to >25 MB", async () => {
		// Build a real ReadableStream of two ~13 MB chunks (total ~26 MB).
		mockTwoStage(() => {
			const chunk = new Uint8Array(13 * MB);
			let pushed = 0;
			const stream = new ReadableStream({
				pull(ctrl) {
					if (pushed >= 2) {
						ctrl.close();
						return;
					}
					pushed++;
					ctrl.enqueue(chunk);
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		});
		const err = await callGenerate();
		assert.ok(err, "expected throw");
		assert.match(err!.message, /remote image exceeds 25 MB cap/);
	});

	it("rejects when arrayBuffer fallback yields >25 MB and no body is exposed", async () => {
		// Construct a response whose `body` getter is patched to null so the
		// arrayBuffer-fallback branch in imageFromUrl runs.
		mockTwoStage(() => {
			const big = new Uint8Array(26 * MB);
			const r = new Response(big, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
			Object.defineProperty(r, "body", { value: null, configurable: true });
			return r;
		});
		const err = await callGenerate();
		assert.ok(err, "expected throw");
		assert.match(err!.message, /remote image exceeds 25 MB cap/);
	});

	it("succeeds when total bytes are well under the 25 MB cap (24 MB)", async () => {
		// 24 MB total, in 6 × 4 MB chunks.
		mockTwoStage(() => {
			const chunk = new Uint8Array(4 * MB);
			let pushed = 0;
			const stream = new ReadableStream({
				pull(ctrl) {
					if (pushed >= 6) { ctrl.close(); return; }
					pushed++;
					ctrl.enqueue(chunk);
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		});
		const err = await callGenerate();
		assert.equal(err, undefined, `unexpected throw: ${err?.message}`);
	});
});

// Stub `writeFileSync` is unused — we rely on tmp dir teardown above.
void writeFileSync;
