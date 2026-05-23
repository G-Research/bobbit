/**
 * Unit test for the image-model-picker `imageModelRank()` function in
 * `src/ui/dialogs/ImageModelSelector.ts`.
 *
 * The function is module-private (not exported) — re-implementing it in this
 * test gave false confidence (reviewer noted the prior version was a literal
 * copy of the production code). Instead we extract the function's source text
 * verbatim, eval it once, and exercise *that exact code* against the live
 * registry returned by `getAvailableImageModels()`. If the production
 * implementation changes, this test picks the change up automatically; the
 * test never carries its own copy of the algorithm.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(__dirname, "..", "src/ui/dialogs/ImageModelSelector.ts");

const { getAvailableImageModels } = await import("../src/server/agent/image-generation.js");
const { PreferencesStore } = await import("../src/server/agent/preferences-store.js");

/**
 * Extract the verbatim source of `imageModelRank` from the production file
 * and evaluate it. We deliberately avoid copy-pasting the body so the test
 * always exercises the production algorithm.
 */
function loadProductionRank(): (model: any, registry: readonly any[]) => number {
	const src = fs.readFileSync(SOURCE, "utf-8");
	// Match the function declaration and its body. The production function is
	// a top-level `function imageModelRank(model, registry: …): number { … }`.
	const match = src.match(/function imageModelRank\([^)]*\):\s*number\s*\{([\s\S]*?)\n\}/);
	assert.ok(match, "could not locate imageModelRank() in ImageModelSelector.ts — production source layout changed?");
	const body = match[1];
	// Strip TypeScript types from the function we will eval — Node has no
	// stripper. The body is small and uses no advanced TS features beyond a
	// single readonly array type, so a direct construction works.
	// eslint-disable-next-line no-new-func
	const fn = new Function("model", "registry", body) as (model: any, registry: readonly any[]) => number;
	return fn;
}

function withRegistry<T>(fn: (reg: ReturnType<typeof getAvailableImageModels>) => T): T {
	const dir = mkdtempSync(path.join(tmpdir(), "bobbit-imr-"));
	try {
		const prefs = new PreferencesStore(dir);
		return fn(getAvailableImageModels(prefs));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("imageModelRank (production source) parity with registry order", () => {
	const rank = loadProductionRank();

	it("first registry entry has the highest rank, last has the lowest positive rank", () => {
		withRegistry((registry) => {
			assert.ok(registry.length > 1, "registry must have multiple entries");
			const first = registry[0];
			const last = registry[registry.length - 1];
			assert.equal(rank(first, registry), registry.length);
			assert.equal(rank(last, registry), 1);
			assert.ok(rank(first, registry) > rank(last, registry));
		});
	});

	it("every registry entry has a positive rank (no orphans)", () => {
		withRegistry((registry) => {
			for (const m of registry) {
				assert.ok(rank(m, registry) > 0, `rank for ${m.provider}/${m.id} should be > 0`);
			}
		});
	});

	it("models not in the registry rank below all known models", () => {
		withRegistry((registry) => {
			const unknown = { provider: "unknown", id: "phantom-0" };
			assert.equal(rank(unknown, registry), -1);
			for (const m of registry) {
				assert.ok(rank(m, registry) > rank(unknown, registry));
			}
		});
	});

	it("ranks are strictly decreasing along registry order", () => {
		withRegistry((registry) => {
			let prev = Number.POSITIVE_INFINITY;
			for (const m of registry) {
				const r = rank(m, registry);
				assert.ok(r < prev, `expected strictly decreasing ranks; ${m.provider}/${m.id} broke order`);
				prev = r;
			}
		});
	});
});
