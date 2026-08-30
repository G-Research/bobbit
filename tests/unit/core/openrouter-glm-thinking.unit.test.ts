import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	clampThinkingLevelForModel,
	resolveThinkingClampModel,
} from "../../../src/server/agent/thinking-level-clamp.ts";

describe("exact thinking metadata clamp", () => {
	it("uses exact Pi metadata for a direct built-in", () => {
		const pi = getBuiltinModel("openrouter" as any, "z-ai/glm-5.2" as any) as any;
		assert.ok(pi);

		const resolved = resolveThinkingClampModel("openrouter", "z-ai/glm-5.2");
		assert.ok(resolved);
		assert.equal(resolved.metadataSource, "exact-registry");
		assert.equal(resolved.reasoning, pi.reasoning);
		assert.deepEqual(resolved.thinkingLevelMap, pi.thinkingLevelMap);
		assert.equal(clampThinkingLevelForModel("high", "openrouter", "z-ai/glm-5.2"), "high");
	});

	it("uses exact target-realm composed metadata, including explicit tiers", () => {
		const metadataLookup = () => ({
			reasoning: true,
			thinkingLevelMap: { off: "none", xhigh: "extra", max: "maximum" } as const,
		});
		const resolved = resolveThinkingClampModel("aigw", "vendor/future-reasoner", { metadataLookup });
		assert.ok(resolved);
		assert.equal(resolved.metadataSource, "exact-registry");
		assert.deepEqual(resolved.thinkingLevelMap, { off: "none", xhigh: "extra", max: "maximum" });
		assert.equal(clampThinkingLevelForModel("xhigh", "aigw", "vendor/future-reasoner", { metadataLookup }), "xhigh");
		assert.equal(clampThinkingLevelForModel("max", "aigw", "vendor/future-reasoner", { metadataLookup }), "max");
	});

	it("does not infer extended levels from family-shaped ids", () => {
		const metadataLookup = () => ({ reasoning: true });
		for (const [provider, id] of [
			["aigw", "openai/gpt-5.6-luna"],
			["aigw", "claude-opus-4-8"],
			["custom", "gpt-5.2-codex"],
		] as const) {
			assert.equal(clampThinkingLevelForModel("xhigh", provider, id, { metadataLookup }), "high");
			assert.equal(clampThinkingLevelForModel("max", provider, id, { metadataLookup }), "high");
		}
	});

	it("returns unavailable instead of fabricating family metadata", () => {
		const metadataLookup = () => undefined;
		assert.equal(resolveThinkingClampModel("aigw", "openai/gpt-5.6-luna", { metadataLookup }), undefined);
		assert.equal(clampThinkingLevelForModel("max", "aigw", "openai/gpt-5.6-luna", { metadataLookup }), undefined);
	});

	it("rejects legacy inferred resolver results at the exact boundary", () => {
		const metadataLookup = () => ({
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" as const },
			source: "inferred",
		});
		assert.equal(resolveThinkingClampModel("custom", "gpt-5.2", { metadataLookup }), undefined);
	});
});
