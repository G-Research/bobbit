/**
 * Unit tests for resolveSkillExpansions — see design §3 / §4.
 *
 * Strategy: build a tmp project tree containing real SKILL.md files and
 * point the resolver at it via a synthetic projectConfigStore.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cwdDir: string;

function writeSkill(name: string, body: string) {
	const dir = path.join(cwdDir, ".claude", "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf-8");
}

before(() => {
	cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-resolve-test-"));
	writeSkill("mockup",
		"---\nname: mockup\ndescription: Build a mockup\nargument-hint: <element>\n---\nMOCKUP-BODY $ARGUMENTS"
	);
	writeSkill("git-conventions",
		"---\nname: git-conventions\ndescription: Project git rules\n---\nGIT-RULES"
	);
	writeSkill("foo",
		"---\nname: foo\ndescription: Foo skill\n---\nFOO-BODY"
	);
});

after(() => {
	try { fs.rmSync(cwdDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const { resolveSkillExpansions } = await import("../src/server/skills/resolve-skill-expansions.ts");
const { buildSlashSkillPrompt, getSlashSkill } = await import("../src/server/skills/slash-skills.ts");

function expandedFor(name: string, args = ""): string {
	const skill = getSlashSkill(cwdDir, name);
	if (!skill) throw new Error(`fixture skill not found: ${name}`);
	return buildSlashSkillPrompt(skill, args);
}

describe("resolveSkillExpansions", () => {
	it("prefix-only / no args → entire text replaced; range covers full input", () => {
		const r = resolveSkillExpansions("/mockup", cwdDir);
		assert.equal(r.originalText, "/mockup");
		assert.equal(r.modelText, expandedFor("mockup", ""));
		assert.equal(r.expansions.length, 1);
		assert.equal(r.expansions[0].name, "mockup");
		assert.equal(r.expansions[0].args, "");
		assert.deepEqual(r.expansions[0].range, [0, "/mockup".length]);
		assert.equal(r.unknown.length, 0);
	});

	it("prefix-only / with args → buildSlashSkillPrompt with args; UTF-16 range covers full input", () => {
		const text = "/mockup hero card";
		const r = resolveSkillExpansions(text, cwdDir);
		assert.equal(r.modelText, expandedFor("mockup", "hero card"));
		assert.equal(r.expansions[0].args, "hero card");
		assert.deepEqual(r.expansions[0].range, [0, text.length]);
	});

	it("inline single → replaces only the /name token", () => {
		const text = "see /git-conventions for rules";
		const r = resolveSkillExpansions(text, cwdDir);
		const expanded = expandedFor("git-conventions", "");
		assert.equal(r.modelText, "see " + expanded + " for rules");
		assert.equal(r.expansions.length, 1);
		assert.deepEqual(r.expansions[0].range, [4, 4 + "/git-conventions".length]);
		assert.equal(r.expansions[0].args, "");
	});

	it("prefix-only with multi-line args → entire text replaced; legacy semantics preserved", () => {
		// `/foo\nsee /bar` matches the prefix-only regex (^\/([\w-]+)(?:\s+(.*))?$):
		// `\s+` consumes the newline, `.*` (non-DOTALL) matches the rest of the line,
		// `$` matches end-of-input. So legacy collapses the whole text into one
		// expansion of /foo with args = `see /git-conventions`. We must preserve
		// that byte-for-byte.
		const text = "/foo\nsee /git-conventions";
		const r = resolveSkillExpansions(text, cwdDir);
		assert.equal(r.expansions.length, 1);
		assert.equal(r.expansions[0].name, "foo");
		assert.equal(r.expansions[0].args, "see /git-conventions");
		assert.deepEqual(r.expansions[0].range, [0, text.length]);
		assert.equal(r.modelText, expandedFor("foo", "see /git-conventions"));
	});

	it("single-line inline scan: /foo at start (no args, trailing tail) → prefix-only matches whole text", () => {
		// Edge: text starts with `/foo` and has more chars on same line. Legacy
		// regex matches prefix-only with empty args (because `(?:\s+(.*))?` is optional)?
		// No — if there's no whitespace after `/foo`, the regex requires `$` right
		// after the name, so this falls through to inline scan.
		const text = "/foobar"; // unknown skill name (foobar != foo)
		const r = resolveSkillExpansions(text, cwdDir);
		assert.equal(r.expansions.length, 0);
		assert.deepEqual(r.unknown, ["foobar"]);
	});

	it("no skills present → text unchanged, no expansions", () => {
		const text = "just a normal message";
		const r = resolveSkillExpansions(text, cwdDir);
		assert.equal(r.modelText, text);
		assert.equal(r.expansions.length, 0);
		assert.equal(r.unknown.length, 0);
	});

	it("unknown skill / prefix-only → text unchanged, name recorded in unknown", () => {
		const r = resolveSkillExpansions("/does-not-exist with args", cwdDir);
		assert.equal(r.modelText, "/does-not-exist with args");
		assert.equal(r.expansions.length, 0);
		assert.deepEqual(r.unknown, ["does-not-exist"]);
	});

	it("unknown skill / inline → token left as-is, no expansion recorded", () => {
		const r = resolveSkillExpansions("see /does-not-exist token", cwdDir);
		assert.equal(r.modelText, "see /does-not-exist token");
		assert.equal(r.expansions.length, 0);
		assert.deepEqual(r.unknown, ["does-not-exist"]);
	});

	it("multiple inline → ranges are left-to-right, splices preserve later indices", () => {
		const text = "before /foo middle /git-conventions tail";
		const r = resolveSkillExpansions(text, cwdDir);
		assert.equal(r.expansions.length, 2);
		assert.equal(r.expansions[0].name, "foo");
		assert.equal(r.expansions[1].name, "git-conventions");
		const r0 = r.expansions[0].range;
		const r1 = r.expansions[1].range;
		assert.ok(r0[0] < r0[1]);
		assert.ok(r0[1] <= r1[0]);
		// Spot-check: ranges point at the original /name tokens in the original text
		assert.equal(text.slice(r0[0], r0[1]), "/foo");
		assert.equal(text.slice(r1[0], r1[1]), "/git-conventions");
		// Splicing right-to-left should match modelText
		const expandedFoo = expandedFor("foo", "");
		const expandedGit = expandedFor("git-conventions", "");
		const expectedModelText =
			text.slice(0, r0[0]) + expandedFoo + text.slice(r0[1], r1[0]) + expandedGit + text.slice(r1[1]);
		assert.equal(r.modelText, expectedModelText);
	});

	it("byte-equal regression: matches the pre-refactor handler block output", () => {
		// This is the regression contract: the resolver must produce the same
		// modelText the inline regex block in ws/handler.ts produced for the
		// same inputs. We re-implement the legacy algorithm here as a fixture.
		function legacy(text: string): string {
			let promptText = text;
			const slashPattern = /(^|[\s])\/([\w-]+)/g;
			const replacements: Array<{ start: number; end: number; expanded: string }> = [];
			let m: RegExpExecArray | null;
			while ((m = slashPattern.exec(promptText)) !== null) {
				const skillName = m[2];
				const skill = getSlashSkill(cwdDir, skillName);
				if (!skill) continue;
				const prefixLen = m[1].length;
				const tokenStart = m.index + prefixLen;
				const tokenEnd = tokenStart + 1 + skillName.length;
				if (tokenStart === 0 && promptText.match(/^\/([\w-]+)(?:\s+(.*))?$/)) {
					const skillArgs = promptText.slice(tokenEnd).trim();
					promptText = buildSlashSkillPrompt(skill, skillArgs);
					replacements.length = 0;
					break;
				}
				replacements.push({ start: tokenStart, end: tokenEnd, expanded: buildSlashSkillPrompt(skill, "") });
			}
			for (let i = replacements.length - 1; i >= 0; i--) {
				const r = replacements[i];
				promptText = promptText.slice(0, r.start) + r.expanded + promptText.slice(r.end);
			}
			return promptText;
		}

		const cases = [
			"/mockup",
			"/mockup hero card",
			"see /git-conventions for rules",
			"/foo\nsee /git-conventions",
			"just a normal message",
			"see /does-not-exist token",
			"before /foo middle /git-conventions tail",
		];
		for (const c of cases) {
			const got = resolveSkillExpansions(c, cwdDir).modelText;
			const want = legacy(c);
			assert.equal(got, want, `byte-equal regression failed for input: ${JSON.stringify(c)}`);
		}
	});
});
