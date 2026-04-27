/**
 * Resolver-level integration: activation header is prepended to `expanded`
 * for both prefix-only and inline branches; byte-equal to what the REST
 * activate-skill handler produces (header + buildSlashSkillPrompt).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cwd: string;

before(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skill-act-hdr-resolver-"));
	const skillRoot = path.join(cwd, ".claude", "skills", "alpha");
	fs.mkdirSync(path.join(skillRoot, "references"), { recursive: true });
	fs.writeFileSync(path.join(skillRoot, "references", "R.md"), "ref body", "utf-8");
	fs.writeFileSync(
		path.join(skillRoot, "SKILL.md"),
		"---\nname: alpha\ndescription: Alpha\n---\nALPHA-BODY $ARGUMENTS",
		"utf-8",
	);
});

after(() => {
	try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
});

const { resolveSkillExpansions } = await import("../src/server/skills/resolve-skill-expansions.ts");
const { buildActivationHeader } = await import("../src/server/skills/skill-manifest.ts");
const { buildSlashSkillPrompt, getSlashSkill } = await import("../src/server/skills/slash-skills.ts");

describe("activation header in resolveSkillExpansions", () => {
	it("prefix-only expansion includes the activation header", () => {
		const r = resolveSkillExpansions("/alpha", cwd);
		assert.equal(r.expansions.length, 1);
		assert.match(r.expansions[0].expanded, /^<!-- skill-activation-header -->/);
		assert.match(r.expansions[0].expanded, /Available resources: references\/R\.md/);
		assert.ok(r.expansions[0].expanded.endsWith("ALPHA-BODY ") ||
			r.expansions[0].expanded.includes("ALPHA-BODY"),
			"body should follow header");
	});

	it("inline expansion includes the activation header", () => {
		const r = resolveSkillExpansions("see /alpha here", cwd);
		assert.equal(r.expansions.length, 1);
		assert.match(r.expansions[0].expanded, /^<!-- skill-activation-header -->/);
	});

	it("byte-equal: resolver expansion equals header + buildSlashSkillPrompt (REST handler path)", () => {
		const skill = getSlashSkill(cwd, "alpha");
		assert.ok(skill);
		const restExpanded = buildActivationHeader(skill!) + buildSlashSkillPrompt(skill!, "hero card");
		const resolverExpanded = resolveSkillExpansions("/alpha hero card", cwd).expansions[0].expanded;
		assert.equal(resolverExpanded, restExpanded);
	});

	it("pathRewrite returning null produces a degraded header in expansions", () => {
		const r = resolveSkillExpansions("/alpha", cwd, undefined, () => null);
		assert.equal(r.expansions.length, 1);
		assert.match(r.expansions[0].expanded, /Skill root: \(not visible inside sandbox/);
	});

	it("pathRewrite returning a string is reflected in the displayed root", () => {
		const r = resolveSkillExpansions("/alpha", cwd, undefined, () => "/workspace/.claude/skills/alpha");
		assert.match(r.expansions[0].expanded, /Skill root: \/workspace\/\.claude\/skills\/alpha/);
	});
});
