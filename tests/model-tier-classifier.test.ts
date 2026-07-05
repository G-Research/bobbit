// CLF-W4: pinning tests for the model-tier classifier's rule table
// (`classifyModelTier`) and its `DecisionClassifier` wrapper. The rule table
// mirrors docs/internals.md's "Recommended model tiers (VER-02)" table
// verbatim — this file's role lists must be edited alongside that doc
// section, and vice versa (see model-tier-classifier.ts's header).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	classifyModelTier,
	modelTierClassifier,
	MODEL_TIER_CLASSIFIER_ID,
	MODEL_TIER_POINT,
	MODEL_TIER_KIND,
	FRONTIER_TIER_ROLES,
	MID_TIER_ROLES,
	CHEAP_TIER_ROLES,
} from "../src/server/agent/model-tier-classifier.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const internalsDoc = fs.readFileSync(path.join(__dirname, "../docs/internals.md"), "utf-8");

describe("classifyModelTier (VER-02 deterministic rule table)", () => {
	for (const role of CHEAP_TIER_ROLES) {
		it(`selects "cheap" for role "${role}"`, () => {
			assert.deepEqual(classifyModelTier({ roleName: role }), {
				kind: "select",
				choice: "cheap",
				confidence: 1,
				rationale: `matched deterministic rule 'cheap-tier-role': role "${role}" is in docs/internals.md's VER-02 Cheap tier`,
			});
		});
	}

	for (const role of MID_TIER_ROLES) {
		it(`selects "mid" for role "${role}"`, () => {
			const decision = classifyModelTier({ roleName: role });
			assert.equal(decision.kind, "select");
			assert.equal((decision as { choice: string }).choice, "mid");
		});
	}

	for (const role of FRONTIER_TIER_ROLES) {
		it(`selects "frontier" for role "${role}"`, () => {
			const decision = classifyModelTier({ roleName: role });
			assert.equal(decision.kind, "select");
			assert.equal((decision as { choice: string }).choice, "frontier");
		});
	}

	it("is case-insensitive on role name", () => {
		assert.equal(classifyModelTier({ roleName: "DOCS-WRITER" }).kind, "select");
		assert.equal(classifyModelTier({ roleName: "Team-Lead" }).kind, "select");
	});

	it("abstains for an untiered builtin role (assistant/general/ux-designer) — no ambiguity guessing", () => {
		assert.deepEqual(classifyModelTier({ roleName: "assistant" }), { kind: "abstain" });
		assert.deepEqual(classifyModelTier({ roleName: "general" }), { kind: "abstain" });
		assert.deepEqual(classifyModelTier({ roleName: "ux-designer" }), { kind: "abstain" });
	});

	it("abstains for an unknown/custom role", () => {
		assert.deepEqual(classifyModelTier({ roleName: "my-custom-pack-role" }), { kind: "abstain" });
	});

	it("abstains when no roleName is given", () => {
		assert.deepEqual(classifyModelTier({}), { kind: "abstain" });
	});

	it("never proposes a literal <provider>/<modelId> — only the three symbolic tier labels", () => {
		const allRoles = [...CHEAP_TIER_ROLES, ...MID_TIER_ROLES, ...FRONTIER_TIER_ROLES];
		for (const role of allRoles) {
			const decision = classifyModelTier({ roleName: role });
			if (decision.kind === "select") {
				assert.ok(["cheap", "mid", "frontier"].includes(decision.choice as string));
			}
		}
	});
});

describe("model-tier rule table stays in sync with docs/internals.md's VER-02 table", () => {
	it("every CHEAP_TIER_ROLES entry appears in the doc's Cheap tier row", () => {
		const cheapRow = internalsDoc.match(/\| Cheap \|([^|]+)\|/);
		assert.ok(cheapRow, "expected a 'Cheap' tier row in docs/internals.md's VER-02 table");
		for (const role of CHEAP_TIER_ROLES) assert.ok(cheapRow![1].includes(role), `expected "${role}" in the doc's Cheap row`);
	});

	it("every MID_TIER_ROLES entry appears in the doc's Mid tier row", () => {
		const midRow = internalsDoc.match(/\| Mid \|([^|]+)\|/);
		assert.ok(midRow, "expected a 'Mid' tier row in docs/internals.md's VER-02 table");
		for (const role of MID_TIER_ROLES) assert.ok(midRow![1].includes(role), `expected "${role}" in the doc's Mid row`);
	});

	it("every FRONTIER_TIER_ROLES entry appears in the doc's Frontier tier row", () => {
		const frontierRow = internalsDoc.match(/\| Frontier[^|]*\|([^|]+)\|/);
		assert.ok(frontierRow, "expected a 'Frontier' tier row in docs/internals.md's VER-02 table");
		for (const role of FRONTIER_TIER_ROLES) assert.ok(frontierRow![1].includes(role), `expected "${role}" in the doc's Frontier row`);
	});
});

describe("modelTierClassifier (DecisionClassifier wrapper)", () => {
	const ctx = { sessionId: "sess-1", cwd: "/tmp" };

	it("has the expected built-in classifier id", () => {
		assert.equal(modelTierClassifier.id, MODEL_TIER_CLASSIFIER_ID);
	});

	it("registers at (session-spawn, model-tier)", () => {
		assert.equal(MODEL_TIER_POINT, "session-spawn");
		assert.equal(MODEL_TIER_KIND, "model-tier");
	});

	it("reads arg.roleName and selects the right tier", async () => {
		const decision = await modelTierClassifier.evaluate(ctx, { roleName: "docs-writer" });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "cheap");
	});

	it("abstains for a malformed arg (wrong type) rather than throwing", async () => {
		const decision = await modelTierClassifier.evaluate(ctx, { roleName: 42 });
		assert.deepEqual(decision, { kind: "abstain" });
	});

	it("abstains for a null/undefined arg rather than throwing", async () => {
		assert.deepEqual(await modelTierClassifier.evaluate(ctx, undefined), { kind: "abstain" });
		assert.deepEqual(await modelTierClassifier.evaluate(ctx, null), { kind: "abstain" });
	});
});
