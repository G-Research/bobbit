// Reproducing test (TDD red) for the "Fix skill autocomplete gap" goal (9e081770),
// Facet 2 — nested Claude-plugin skill layout.
//
// `scanSkillDir` (src/server/skills/slash-skills.ts) only scans one level deep:
//   <dir>/<name>/SKILL.md
// Claude Code plugin skills nest one level deeper — <plugin>/skills/<name>/SKILL.md —
// so a custom scan directory pointed at either
//   (a) a plugins-parent root  (<dir>/<plugin>/skills/<name>/SKILL.md), or
//   (b) a plugin root          (<dir>/skills/<name>/SKILL.md)
// resolves ZERO skills today.
//
// These assertions FAIL on HEAD (nested skill not discovered) and PASS once
// scanSkillDir understands the bounded `skills/` convention for both roots while
// preserving the existing one-level behaviour for normal `.claude/skills` dirs.
//
// Distinctive failure token: SKILL_AUTOCOMPLETE_GAP.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scanSkillDir } from "../../src/server/skills/slash-skills.ts";
import { installScopedMemFs } from "./helpers/scoped-memfs.js";

const ROOT = path.resolve("/memfs/scan-skill-nested");
const PLUGINS_PARENT = path.join(ROOT, "plugins-parent");
const PLUGIN_ROOT = path.join(ROOT, "my-plugin-root");
const NORMAL_DIR = path.join(ROOT, "normal");
let restoreFs: () => void;

function writeSkill(dir: string, name: string, description: string): void {
	const skillDir = path.join(dir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`, "", "Body text."].join("\n"),
		"utf-8",
	);
}

beforeAll(() => {
	const scoped = installScopedMemFs(["existsSync", "mkdirSync", "readFileSync", "readdirSync", "writeFileSync"]);
	restoreFs = scoped.restore;
	writeSkill(path.join(PLUGINS_PARENT, "my-plugin", "skills"), "foo", "A nested plugin skill");
	writeSkill(path.join(PLUGIN_ROOT, "skills"), "foo", "A plugin-root skill");
	writeSkill(NORMAL_DIR, "bar", "A normal one-level skill");
});

afterAll(() => restoreFs());

describe("scanSkillDir — nested Claude-plugin skill layout", () => {
	it("discovers <plugins-parent>/<plugin>/skills/<name>/SKILL.md (source custom)", () => {
		// Plugins-parent root: immediate children are plugin dirs, each with a skills/ subdir.
		const skills = scanSkillDir(PLUGINS_PARENT, "custom");
		const names = skills.map((s) => s.name);
		expect(names, "SKILL_AUTOCOMPLETE_GAP: plugins-parent nested scan should discover foo").toContain("foo");
		const foo = skills.find((s) => s.name === "foo");
		expect(foo?.source, "SKILL_AUTOCOMPLETE_GAP: nested plugin skill must keep source=custom").toBe("custom");
	});

	it("discovers <plugin-root>/skills/<name>/SKILL.md (source custom)", () => {
		// Plugin root: the scan dir's immediate child is skills/.
		const skills = scanSkillDir(PLUGIN_ROOT, "custom");
		const names = skills.map((s) => s.name);
		expect(names, "SKILL_AUTOCOMPLETE_GAP: plugin-root nested scan should discover foo").toContain("foo");
		const foo = skills.find((s) => s.name === "foo");
		expect(foo?.source, "SKILL_AUTOCOMPLETE_GAP: plugin-root skill must keep source=custom").toBe("custom");
	});

	it("preserves existing one-level behaviour for normal <dir>/<name>/SKILL.md", () => {
		// Regression guard: normal .claude/skills-style dir must keep resolving,
		// and the new nested branches must NOT swallow or duplicate it.
		const skills = scanSkillDir(NORMAL_DIR, "custom");
		const names = skills.map((s) => s.name);
		expect(names, "one-level normal-layout skill must still resolve").toContain("bar");
		expect(names.filter((n) => n === "bar").length, "normal skill must not be duplicated").toBe(1);
		const bar = skills.find((s) => s.name === "bar");
		expect(bar?.source).toBe("custom");
	});
});
