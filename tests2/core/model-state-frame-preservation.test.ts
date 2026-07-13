/**
 * Pinning tests for `buildResolvedModelStateModel` in `src/server/ws/handler.ts`
 * — the builder every live/rehydrated `state.model` frame routes through.
 *
 * Regression target: the builder used to overwrite live `state.model` fields
 * (contextWindow, maxTokens, reasoning, thinkingLevelMap) with
 * `resolveModelStateMeta` output for EVERY provider. That is correct for known
 * catalog/cache-backed models (Fable), but for custom/aigw/unknown providers
 * the resolver only produces INFERRED defaults, which clobbered more-accurate
 * live metadata already present on the agent state — regressing thinking/context
 * UI for non-catalog models.
 *
 * Contract pinned here:
 *   1. Custom/unknown provider (resolver source === "inferred"): live
 *      contextWindow / maxTokens / reasoning / thinkingLevelMap are PRESERVED.
 *   2. Known Fable model (authoritative cache/catalog): authoritative catalog
 *      metadata WINS, including thinkingLevelMap.max, even over stale live base
 *      values.
 *
 * node:test / vitest run `it`s in a file sequentially, so the shared
 * module-level model cache is deterministic; each test manages its own cache
 * state (getAvailableModels to populate; invalidateModelCache to clear).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import { createMemFs } from "../harness/mem-fs.js";

const memfs = createMemFs();
const stateDir = path.resolve("/memfs/model-state-frame-preservation");

const { PreferencesStore } = await import("../../src/server/agent/preferences-store.ts");
const { getAvailableModels, invalidateModelCache } = await import("../../src/server/agent/model-registry.ts");
const { buildResolvedModelStateModel } = await import("../../src/server/ws/handler.ts");

const prefs = new PreferencesStore(stateDir, memfs);

describe("buildResolvedModelStateModel — live metadata preservation", () => {
	it("custom/unknown provider preserves live contextWindow/maxTokens/reasoning/thinkingLevelMap (resolver is inferred-only)", () => {
		invalidateModelCache();
		// Live frame carries accurate metadata for a non-catalog model — e.g. a
		// custom/aigw-registered model that Bobbit's registry does not know.
		const liveMap = { off: null, low: "low", high: "high", max: "max" };
		const base = {
			provider: "custom",
			id: "my-private-model-42",
			contextWindow: 512_000,
			maxTokens: 64_000,
			reasoning: true,
			thinkingLevelMap: liveMap,
		};

		const model = buildResolvedModelStateModel("custom", "my-private-model-42", base);

		assert.equal(model.provider, "custom");
		assert.equal(model.id, "my-private-model-42");
		// Inferred defaults must NOT clobber the accurate live values.
		assert.equal(model.contextWindow, 512_000, "live contextWindow must survive");
		assert.equal(model.maxTokens, 64_000, "live maxTokens must survive");
		assert.equal(model.reasoning, true, "live reasoning must survive");
		assert.deepEqual(model.thinkingLevelMap, liveMap, "live thinkingLevelMap must survive");
	});

	it("custom/unknown provider without live fields falls back to inferred defaults", () => {
		invalidateModelCache();
		const model = buildResolvedModelStateModel("custom", "totally-unknown-model-xyz-123", {
			provider: "custom",
			id: "totally-unknown-model-xyz-123",
		});
		// No accurate live values → inferred fallback fills the gaps.
		assert.equal(typeof model.contextWindow, "number");
		assert.equal(model.contextWindow, 128_000, "inferMeta DEFAULT_META context window");
		assert.equal(model.reasoning, false, "inferMeta DEFAULT_META reasoning");
		assert.equal(model.thinkingLevelMap, undefined, "no live map + no catalog map → dropped");
	});

	it("known Fable model gets authoritative catalog metadata (incl. thinkingLevelMap.max), overriding stale live base", async () => {
		invalidateModelCache();
		// Populate the registry cache so the resolver serves authoritative metadata.
		const models = await getAvailableModels(prefs);
		assert.ok(
			models.find(m => m.provider === "anthropic" && m.id === "claude-fable-5"),
			"expected anthropic/claude-fable-5 in the assembled model list",
		);

		// Stale/incorrect live base (the exact bug the authoritative path fixes).
		const staleBase = {
			provider: "anthropic",
			id: "claude-fable-5",
			contextWindow: 200_000,
			maxTokens: 8_192,
			reasoning: false,
			thinkingLevelMap: { off: null },
		};

		const model = buildResolvedModelStateModel("anthropic", "claude-fable-5", staleBase);

		assert.equal(model.contextWindow, 1_000_000, "authoritative Fable context window wins");
		assert.equal(model.maxTokens, 128_000, "authoritative Fable maxTokens wins");
		assert.equal(model.reasoning, true, "authoritative Fable reasoning wins");
		assert.deepEqual(
			model.thinkingLevelMap,
			{ off: null, xhigh: "xhigh", max: "max" },
			"authoritative Fable thinkingLevelMap (incl. max) wins over stale live map",
		);
	});
});
