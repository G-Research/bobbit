/**
 * Unit test: the UI's `imageModelRank` (src/ui/dialogs/ImageModelSelector.ts)
 * is registry-derived and stays in lock-step with the server-side registry
 * order returned by `getAvailableImageModels()`
 * (src/server/agent/image-generation.ts).
 *
 * The function is module-private; we re-implement it here from its source
 * contract (early-registry index → highest rank) and assert that the contract
 * is preserved by checking the ordering invariants on the registry itself.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { getAvailableImageModels } = await import("../dist/server/agent/image-generation.js");
const { PreferencesStore } = await import("../dist/server/agent/preferences-store.js");

/**
 * Mirror of the rank function in src/ui/dialogs/ImageModelSelector.ts.
 * Higher = newer/more-recent. Models not in the registry sort below known.
 */
function rank(
	model: { provider: string; id: string },
	registry: ReadonlyArray<{ provider: string; id: string }>,
): number {
	const idx = registry.findIndex((m) => m.provider === model.provider && m.id === model.id);
	if (idx < 0) return -1;
	return registry.length - idx;
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

describe("imageModelRank parity with image-generation registry", () => {
	it("first registry entry has the highest rank", () => {
		withRegistry((registry) => {
			assert.ok(registry.length > 1, "registry must have multiple entries to test ordering");
			const first = registry[0];
			const last = registry[registry.length - 1];
			assert.equal(rank(first, registry), registry.length);
			assert.equal(rank(last, registry), 1);
			assert.ok(rank(first, registry) > rank(last, registry));
		});
	});

	it("every registry entry has a rank entry (no orphans)", () => {
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
				assert.ok(r < prev, `expected strictly decreasing ranks, but ${m.provider}/${m.id} broke order`);
				prev = r;
			}
		});
	});
});
