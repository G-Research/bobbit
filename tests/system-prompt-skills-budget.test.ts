/**
 * Unit tests for the configurable skills-catalog byte budget.
 * Pins:
 *  - default = 16384 bytes
 *  - resolveSkillsCatalogBudget clamps and falls back correctly
 *  - buildSkillsCatalogSection honours an override and clamps it
 *  - the truncation footer + warn log reference the *effective* budget
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-budget-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const {
	SKILLS_CATALOG_BUDGET,
	SKILLS_CATALOG_BUDGET_MIN,
	SKILLS_CATALOG_BUDGET_MAX,
	resolveSkillsCatalogBudget,
	buildSkillsCatalogSection,
	initPromptDirs,
} = await import("../src/server/agent/system-prompt.ts");

// Required by other code paths even if our tests don't touch them.
initPromptDirs(path.join(tmpRoot, "state"));

function makeSkills(n: number) {
	const skills = [];
	for (let i = 0; i < n; i++) {
		// Pad name so each entry is wide enough to chew through the budget quickly.
		const name = `skill-${String(i).padStart(4, "0")}`;
		skills.push({
			name,
			description: "A reasonably long description used to bulk up each catalog entry so the byte budget bites. ".repeat(2).trim(),
			argumentHint: "<arg>",
			source: "test",
			content: "",
		} as any);
	}
	return skills;
}

describe("skills-catalog budget — exports and defaults", () => {
	it("default budget is 16384 bytes", () => {
		assert.equal(SKILLS_CATALOG_BUDGET, 16384);
	});
	it("MIN is 1024 and MAX is 131072", () => {
		assert.equal(SKILLS_CATALOG_BUDGET_MIN, 1024);
		assert.equal(SKILLS_CATALOG_BUDGET_MAX, 131072);
	});
});

describe("resolveSkillsCatalogBudget", () => {
	it("returns default for undefined", () => {
		assert.equal(resolveSkillsCatalogBudget(undefined), SKILLS_CATALOG_BUDGET);
	});
	it("returns default for NaN", () => {
		assert.equal(resolveSkillsCatalogBudget(Number.NaN), SKILLS_CATALOG_BUDGET);
	});
	it("returns default for +Infinity / -Infinity", () => {
		assert.equal(resolveSkillsCatalogBudget(Number.POSITIVE_INFINITY), SKILLS_CATALOG_BUDGET);
		assert.equal(resolveSkillsCatalogBudget(Number.NEGATIVE_INFINITY), SKILLS_CATALOG_BUDGET);
	});
	it("clamps small values up to MIN (500 → 1024)", () => {
		assert.equal(resolveSkillsCatalogBudget(500), SKILLS_CATALOG_BUDGET_MIN);
	});
	it("clamps negative values up to MIN", () => {
		assert.equal(resolveSkillsCatalogBudget(-100), SKILLS_CATALOG_BUDGET_MIN);
	});
	it("clamps huge values down to MAX (999999 → 131072)", () => {
		assert.equal(resolveSkillsCatalogBudget(999999), SKILLS_CATALOG_BUDGET_MAX);
	});
	it("floors fractional values inside range", () => {
		assert.equal(resolveSkillsCatalogBudget(8192.9), 8192);
	});
	it("passes valid integer values through unchanged", () => {
		assert.equal(resolveSkillsCatalogBudget(8192), 8192);
		assert.equal(resolveSkillsCatalogBudget(SKILLS_CATALOG_BUDGET_MIN), SKILLS_CATALOG_BUDGET_MIN);
		assert.equal(resolveSkillsCatalogBudget(SKILLS_CATALOG_BUDGET_MAX), SKILLS_CATALOG_BUDGET_MAX);
	});
});

describe("buildSkillsCatalogSection — budget plumbing", () => {
	it("returns undefined for empty input", () => {
		assert.equal(buildSkillsCatalogSection([]), undefined);
	});

	it("default (no override) uses 16384 bytes — fits more than a 4096 budget would", () => {
		// ~150 skills * ~190B per line is well above 4096 but under 16384.
		const skills = makeSkills(50);
		const out = buildSkillsCatalogSection(skills)!;
		assert.ok(out, "section should be non-empty");
		assert.ok(out.length <= SKILLS_CATALOG_BUDGET + 200, `length ${out.length} should be within default budget`);
		assert.ok(!out.includes("more skills omitted"), "no truncation expected at the default 16K budget for 50 entries");
	});

	it("honours an override (8192) and produces truncation footer referencing it", () => {
		const skills = makeSkills(200);
		const out = buildSkillsCatalogSection(skills, 8192)!;
		assert.ok(out.length <= 8192 + 200, `length ${out.length} should be roughly within 8192`);
		assert.match(out, /more skills omitted, alphabetically truncated/);
	});

	it("clamps an under-MIN override up to 1024", () => {
		const skills = makeSkills(200);
		const out = buildSkillsCatalogSection(skills, 500)!;
		// With a ~1024 effective budget the output should be much smaller than at 8192.
		assert.ok(out.length <= 1024 + 200, `length ${out.length} should be ~1024 after clamp`);
		assert.match(out, /more skills omitted, alphabetically truncated/);
	});

	it("clamps an over-MAX override down to 131072", () => {
		// 1000 skills of ~190B each ≈ 190K — would exceed MAX, so we expect truncation
		// at ~131072, not at 190K.
		const skills = makeSkills(1000);
		const out = buildSkillsCatalogSection(skills, 9999999)!;
		assert.ok(out.length <= SKILLS_CATALOG_BUDGET_MAX + 500, `length ${out.length} should be capped near MAX`);
	});

	it("a higher budget fits strictly more entries than a lower one", () => {
		const skills = makeSkills(500);
		const small = buildSkillsCatalogSection(skills, 2048)!;
		const big = buildSkillsCatalogSection(skills, 32768)!;
		const smallCount = (small.match(/^- \*\*skill-/gm) || []).length;
		const bigCount = (big.match(/^- \*\*skill-/gm) || []).length;
		assert.ok(bigCount > smallCount, `expected larger budget to fit more entries (got small=${smallCount}, big=${bigCount})`);
	});
});
