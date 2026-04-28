/**
 * Unit test: `imageModelRank` (in src/ui/components/ImageModelSelector.ts —
 * note: per Agent B B17 the canonical source moves to
 * src/ui/dialogs/ImageModelSelector.ts) ordering matches the registry order
 * returned by getAvailableImageModels().
 *
 * Phase 1: scaffold. Phase 2 will derive the expected order from the
 * server-side registry and compare with the UI rank table.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// TODO Phase 2 imports once Agent A/B land:
// const { getAvailableImageModels } = await import("../dist/server/agent/image-generation.js");
// const { imageModelRank } = await import("../dist/ui/dialogs/ImageModelSelector.js");

describe("imageModelRank parity with registry order", () => {
	it.skip("rank order equals getAvailableImageModels() order", () => {
		// TODO Phase 2: derive expected order from the registry and compare.
		assert.ok(true);
	});

	it.skip("every registry entry has a rank entry (no orphans)", () => {
		// TODO Phase 2.
		assert.ok(true);
	});
});
