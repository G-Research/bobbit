import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(path.join(process.cwd(), "src/server/agent/verification-harness.ts"), "utf8");

describe("verification harness Claude Code review-model filtering", () => {
	it("filters claude-code review prefs/role models before spawn-time initialModel", () => {
		assert.match(SRC, /export function resolvePiBackedReviewInitialModel[\s\S]*!isClaudeCodeReviewModel\(model\)/);
		assert.match(SRC, /const _preInitialModel = resolvePiBackedReviewInitialModel\(_preRoleModel, _preReviewPref\);/);
		assert.match(SRC, /const _preQaInitialModel = resolvePiBackedReviewInitialModel\(_preQaRoleModel, _preQaReviewPref\);/);
		assert.match(SRC, /const _preLegacyInitialModel = resolvePiBackedReviewInitialModel\(_preLegacyRoleModel, _preLegacyReviewPref\);/);
		assert.doesNotMatch(SRC, /const _preInitialModel = \(_preRoleModel[\s\S]{0,220}_preReviewPref/);
	});

	it("does not pass claude-code role models to set_model/applyModelString", () => {
		assert.match(SRC, /export function filterPiBackedReviewModelForSetModel[\s\S]*isClaudeCodeReviewModel\(modelStr\) \? undefined : modelStr/);
		for (const suffix of ["r", "q", "s"]) {
			assert.match(SRC, new RegExp(`const piRoleModel_${suffix} = filterPiBackedReviewModelForSetModel\\(roleModel_${suffix}\\);`));
			assert.doesNotMatch(SRC, new RegExp(`applyModelString\\([^,]+,\\s*roleModel_${suffix}`));
		}
	});

	it("filters default.reviewModel before applyReviewModelOverrides", () => {
		const filteredPrefCount = (SRC.match(/const reviewModelPref = filterPiBackedReviewModelForSetModel\(this\.preferencesStore\.get\("default\.reviewModel"\) as string \| undefined\);/g) ?? []).length;
		assert.equal(filteredPrefCount, 3, "reviewer, QA, and legacy sub-session paths must filter the review preference");
		assert.doesNotMatch(SRC, /const reviewModelPref = this\.preferencesStore\.get\("default\.reviewModel"\) as string \| undefined;/);
		assert.match(SRC, /k === "default\.reviewModel" \? reviewModelPref/);
	});
});
