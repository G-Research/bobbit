import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "vitest";
import { loadHooks } from "../../src/server/agent/pack-contributions.js";
import { validateManifest } from "../../src/server/agent/pack-manifest.js";
import { validateDecisionHookOutput } from "../../src/server/agent/decision-hook-contract.js";
import { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.js";

const root = path.resolve("market-packs/_fixtures/staff-proposal-advisor");
const manifest = validateManifest({
	schema: 2, name: "staff-proposal-advisor", version: "1.0.0", description: "fixture",
	contents: { roles: [], tools: [], skills: [], hooks: ["staff-improvement"] },
})!;

describe("staff proposal fixture", () => {
	it("is default-uninstalled, due only at turn three, and emits a consented ordinary goal seed", async () => {
		const registry = new PackContributionRegistry(() => [{
			id: "fixture", kind: "market", scope: "project", path: root, readOnly: true,
			manifest, layout: "defaults-tree",
		}] as any);
		assert.deepEqual(registry.listScheduledDecisionHooks("project", 1), []);
		const [hook] = registry.listScheduledDecisionHooks("project", 3);
		assert.equal(hook.id, "staff-improvement");
		assert.deepEqual(registry.listScheduledAdvisorHooks("project"), []);
		assert.equal(loadHooks(root, manifest)[0].schedule?.kind, "decision");

		const fixture = await import(pathToFileURL(path.join(root, "lib/staff-improvement.mjs")).href);
		const noPattern = await fixture.decide({});
		assert.equal(noPattern, undefined);
		const output = validateDecisionHookOutput(await fixture.decide({
			staffImprovementSignals: { windowTurns: 3, patterns: [{ kind: "repeated-user-correction", count: 2 }] },
		}), { now: Date.now() });
		assert.equal(output?.kind, "request");
		if (!output || output.kind !== "request") throw new Error("fixture must return a request");
		assert.equal(output.request.requestedClass, "consent-required");
		assert.equal(output.request.effect.kind, "proposal");
		if (output.request.effect.kind !== "proposal") throw new Error("fixture must declare a proposal effect");
		assert.equal(output.request.effect.proposals.create?.proposalType, "goal");
		assert.deepEqual(output.request.effect.noEffectValues, ["decline", "other"]);
	});
});
