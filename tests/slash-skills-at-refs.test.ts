/**
 * Regression: SKILL.md bodies are NOT auto-inlined via `resolveMarkdownRefs`.
 * `@path/foo.md` markers must reach the agent verbatim so it can decide to
 * read them on demand (Claude Code Level-3 progressive disclosure).
 *
 * Also asserts the description-fallback (first non-blank line) is unchanged.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cwd: string;

before(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slash-skills-at-refs-test-"));
	const skillRoot = path.join(cwd, ".claude", "skills", "withref");
	fs.mkdirSync(skillRoot, { recursive: true });
	fs.mkdirSync(path.join(skillRoot, "references"), { recursive: true });
	fs.writeFileSync(
		path.join(skillRoot, "references", "REFERENCE.md"),
		"INLINED-FROM-REFERENCE-MD",
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillRoot, "SKILL.md"),
		"---\nname: withref\ndescription: Has a @-ref\n---\nMain body. See @references/REFERENCE.md for details.\n",
		"utf-8",
	);

	// Skill without explicit description — exercises the first-non-blank-line fallback.
	const fbRoot = path.join(cwd, ".claude", "skills", "no-desc");
	fs.mkdirSync(fbRoot, { recursive: true });
	fs.writeFileSync(
		path.join(fbRoot, "SKILL.md"),
		"---\nname: no-desc\n---\n\nFirst meaningful line wins\nSecond line",
		"utf-8",
	);
});

after(() => {
	try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
});

const { discoverSlashSkills, getSlashSkill } =
	await import("../src/server/skills/slash-skills.ts");

describe("slash-skills @path refs preserved verbatim", () => {
	it("@references/REFERENCE.md is NOT inlined into the skill body", () => {
		const skill = getSlashSkill(cwd, "withref");
		assert.ok(skill, "skill should be discovered");
		assert.ok(skill!.content.includes("@references/REFERENCE.md"),
			"`@references/REFERENCE.md` literal must appear in the body");
		assert.ok(!skill!.content.includes("INLINED-FROM-REFERENCE-MD"),
			"file contents must NOT be inlined at scan time");
	});

	it("description fallback (first non-blank line) still works", () => {
		const skill = getSlashSkill(cwd, "no-desc");
		assert.ok(skill);
		assert.equal(skill!.description, "First meaningful line wins");
	});

	it("autocomplete-style listing still surfaces the skill", () => {
		const all = discoverSlashSkills(cwd);
		const names = all.map(s => s.name);
		assert.ok(names.includes("withref"), `expected withref in: ${names.join(", ")}`);
		assert.ok(names.includes("no-desc"));
	});
});
