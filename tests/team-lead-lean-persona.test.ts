/**
 * Pinning tests for VER-03/F8 (W3.9, FINDINGS.md "Fat team-lead persona ~10k
 * resident tokens reloaded on every nudge/steer turn"): the opt-in
 * `BOBBIT_LEAN_TEAM_LEAD=1` diet of `defaults/roles/team-lead.yaml`.
 *
 * What this pins:
 *  1. Flag-off byte-identity — `parseRoleYaml`'s effective `promptTemplate`
 *     for team-lead is EXACTLY the `promptTemplate:` YAML field, unchanged,
 *     when `BOBBIT_LEAN_TEAM_LEAD` is unset/not `"1"`. The diet is fully
 *     inert by default.
 *  2. Flag-on selection — with the flag set, the effective template becomes
 *     `promptTemplateLean`, and it is meaningfully smaller (the whole point
 *     of the diet) while staying well under a fixed byte budget.
 *  3. Scoping — no other role is affected by the flag (only team-lead
 *     defines `promptTemplateLean`).
 *  4. Hard-invariant survival — every guardrail called out as "must not be
 *     silently lost" in the PR's disposition table is still asserted,
 *     substring-for-substring, in the LEAN prompt (not just the full one).
 *  5. Every `activate_skill(name="...")` pointer the lean prompt references
 *     resolves to a real, discoverable, model-invocable skill under
 *     `defaults/skills/` — a typo'd skill name here would silently strand
 *     the lead with a 404 mid-turn.
 *  6. The four new skill files parse correctly through the same
 *     `scanSkillDir` path the pack resolver's `SkillLoader` uses for
 *     `defaults-tree` packs (i.e. exactly how `defaults/skills/html` and
 *     `defaults/skills/mockup` are already loaded today), and none of them
 *     leak an unresolved `{{...}}` role-prompt placeholder — skill bodies
 *     get NO placeholder substitution (only `$ARGUMENTS`/`$1`), so any
 *     `{{GOAL_BRANCH}}`-style token left in a skill file would render
 *     literally to the model.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

const REPO = path.resolve(import.meta.dirname, "..");
const ROLE_FILE = path.join(REPO, "defaults", "roles", "team-lead.yaml");
const SKILLS_DIR = path.join(REPO, "defaults", "skills");

const { parseRoleYaml } = await import("../src/server/agent/builtin-config.ts");
const { scanSkillDir, buildSlashSkillPrompt } = await import("../src/server/skills/slash-skills.ts");

/** Byte budget for the lean variant — generous headroom above the current
 *  ~10.7KB measurement so incidental prose additions don't flake the test,
 *  while still catching a regression back toward the ~37KB full persona. */
const LEAN_BUDGET_BYTES = 16384;

function rawTeamLeadYaml(): string {
	return fs.readFileSync(ROLE_FILE, "utf-8");
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
	const prev = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}
}

describe("team-lead lean persona — BOBBIT_LEAN_TEAM_LEAD flag", () => {
	it("team-lead.yaml defines both promptTemplate and a smaller promptTemplateLean", () => {
		const doc = YAML.parse(rawTeamLeadYaml()) as { promptTemplate?: string; promptTemplateLean?: string };
		assert.equal(typeof doc.promptTemplate, "string");
		assert.equal(typeof doc.promptTemplateLean, "string");
		assert.ok(doc.promptTemplate!.length > 0);
		assert.ok(doc.promptTemplateLean!.length > 0);
		assert.ok(
			doc.promptTemplateLean!.length < doc.promptTemplate!.length,
			"promptTemplateLean must be smaller than promptTemplate — that is the point of the diet",
		);
	});

	it("flag unset ⇒ effective template is byte-identical to the raw promptTemplate field", () => {
		const doc = YAML.parse(rawTeamLeadYaml()) as { promptTemplate: string };
		const role = withEnv("BOBBIT_LEAN_TEAM_LEAD", undefined, () => parseRoleYaml(rawTeamLeadYaml()));
		assert.equal(role?.promptTemplate, doc.promptTemplate);
	});

	it('flag="0" (or any non-"1" value) ⇒ still the full template, not lean', () => {
		const doc = YAML.parse(rawTeamLeadYaml()) as { promptTemplate: string };
		const role = withEnv("BOBBIT_LEAN_TEAM_LEAD", "0", () => parseRoleYaml(rawTeamLeadYaml()));
		assert.equal(role?.promptTemplate, doc.promptTemplate);
	});

	it('flag="1" ⇒ effective template is promptTemplateLean, under the byte budget', () => {
		const doc = YAML.parse(rawTeamLeadYaml()) as { promptTemplateLean: string };
		const role = withEnv("BOBBIT_LEAN_TEAM_LEAD", "1", () => parseRoleYaml(rawTeamLeadYaml()));
		assert.equal(role?.promptTemplate, doc.promptTemplateLean);
		const bytes = Buffer.byteLength(role!.promptTemplate, "utf-8");
		assert.ok(bytes <= LEAN_BUDGET_BYTES, `lean promptTemplate is ${bytes}B, expected <= ${LEAN_BUDGET_BYTES}B`);
	});

	it("the flag does not affect a role with no promptTemplateLean (e.g. coder)", () => {
		const coderFile = path.join(REPO, "defaults", "roles", "coder.yaml");
		const raw = fs.readFileSync(coderFile, "utf-8");
		const doc = YAML.parse(raw) as { promptTemplate: string };
		const roleOff = withEnv("BOBBIT_LEAN_TEAM_LEAD", undefined, () => parseRoleYaml(raw));
		const roleOn = withEnv("BOBBIT_LEAN_TEAM_LEAD", "1", () => parseRoleYaml(raw));
		assert.equal(roleOff?.promptTemplate, doc.promptTemplate);
		assert.equal(roleOn?.promptTemplate, doc.promptTemplate);
	});
});

describe("team-lead lean persona — hard invariants survive the diet", () => {
	const leanPrompt = (YAML.parse(rawTeamLeadYaml()) as { promptTemplateLean: string }).promptTemplateLean;

	const mustContain: Array<[string, RegExp]> = [
		["only-the-lead-signals-gates", /Only you call `gate_signal`/],
		["never merge/push master", /Never (push to master|merge anything to master)/i],
		["never force-push", /force-push/i],
		["criteria-drop is never overridable", /drop a root acceptance criterion is always rejected/i],
		["never sleep/poll", /Never call `bash` with `sleep`/],
		["never spin-loop/poll", /Never spin-loop or poll for status/i],
		["mandatory PR", /pull request \(\*\*mandatory/i],
		["never merge the PR yourself", /never merge it yourself/i],
		["never curl/REST for team tools", /never curl or the REST API/i],
		["command-format gate merge-before-signal rule", /Merge every contributor's sub-branch into .* BEFORE calling `gate_signal`/],
		["0/0 / file-not-found failure mode", /0\/0 tests or file-not-found/i],
		["producers vs verifiers", /never spawn one of them to \*write\* a gate's artifact/i],
		["do not write production code", /do NOT write production code or tests yourself/i],
		["gate content must be substantive", /Gate content must be substantive/i],
	];

	for (const [label, re] of mustContain) {
		it(`lean prompt still states: ${label}`, () => {
			assert.match(leanPrompt, re);
		});
	}
});

describe("team-lead lean persona — activate_skill pointers resolve to real skills", () => {
	const leanPrompt = (YAML.parse(rawTeamLeadYaml()) as { promptTemplateLean: string }).promptTemplateLean;
	const referenced = [...leanPrompt.matchAll(/activate_skill\(name="([a-z0-9-]+)"\)/g)].map((m) => m[1]);
	const builtins = scanSkillDir(SKILLS_DIR, "built-in");
	const byName = new Map(builtins.map((s) => [s.name, s]));

	it("the lean prompt references at least one skill by name", () => {
		assert.ok(referenced.length >= 3, `expected several activate_skill pointers, found ${referenced.length}`);
	});

	for (const name of new Set(referenced)) {
		it(`activate_skill(name="${name}") resolves under defaults/skills/`, () => {
			const skill = byName.get(name);
			assert.ok(skill, `no defaults/skills/${name}/SKILL.md found`);
			assert.notEqual(skill!.disableModelInvocation, true, `${name} must remain model-invocable (activate_skill 403s on disable-model-invocation: true)`);
			assert.ok((skill!.description ?? "").trim().length > 0, `${name} needs a non-empty description for the Available Skills catalog`);
		});
	}
});

describe("team-lead-* skill files load through the skills machinery (scanSkillDir)", () => {
	const skills = scanSkillDir(SKILLS_DIR, "built-in");
	const byName = new Map(skills.map((s) => [s.name, s]));

	// Sanity: the diet didn't collaterally break the two pre-existing built-in skills.
	it("pre-existing built-in skills (html, mockup) still resolve", () => {
		assert.ok(byName.has("html"));
		assert.ok(byName.has("mockup"));
	});

	const expected = ["team-lead-tools", "team-lead-gates", "team-lead-orchestration", "team-lead-completion"];

	for (const name of expected) {
		it(`defaults/skills/${name}/SKILL.md parses with a non-empty body and description`, () => {
			const skill = byName.get(name);
			assert.ok(skill, `${name} not discovered by scanSkillDir`);
			assert.equal(skill!.name, name);
			assert.ok((skill!.description ?? "").trim().length > 0);
			assert.ok(skill!.content.trim().length > 200, "expected substantial moved-content, not a stub");
			assert.notEqual(skill!.disableModelInvocation, true);
		});

		it(`defaults/skills/${name}/SKILL.md has no unresolved role-prompt placeholders`, () => {
			const skill = byName.get(name)!;
			// Skill bodies only get $ARGUMENTS/$1 substitution (buildSlashSkillPrompt),
			// never {{AGENT_ID}}/{{GOAL_BRANCH}}/{{AVAILABLE_ROLES}} — a leftover
			// placeholder here would render literally to the model.
			assert.doesNotMatch(skill.content, /\{\{(AGENT_ID|GOAL_BRANCH|AVAILABLE_ROLES)\}\}/);
			const expanded = buildSlashSkillPrompt(skill, "");
			assert.equal(expanded, skill.content);
		});
	}

	it("expected skill count matches exactly (no accidental duplicate/typo'd directory)", () => {
		for (const name of expected) {
			assert.equal(skills.filter((s) => s.name === name).length, 1, `expected exactly one ${name} skill`);
		}
	});
});
