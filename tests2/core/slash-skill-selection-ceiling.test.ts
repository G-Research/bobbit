import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSkillExpansions } from "../../src/server/skills/resolve-skill-expansions.js";
import {
	discoverSlashSkills,
	getSlashSkill,
	invalidateSlashSkillsCache,
} from "../../src/server/skills/slash-skills.js";

const roots: string[] = [];

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-skill-selection-"));
	roots.push(root);
	return root;
}

function writeSkill(cwd: string, name: string, body: string): void {
	const dir = path.join(cwd, ".claude", "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

afterEach(() => invalidateSlashSkillsCache());
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("session-local slash skill selection ceiling", () => {
	it("filters only the composed discovery result without poisoning the global cache", () => {
		const cwd = tempRoot();
		writeSkill(cwd, "ceiling-selected", "---\nname: ceiling-selected\ndescription: Selected\n---\nSelected body");
		writeSkill(cwd, "ceiling-blocked", "---\nname: ceiling-blocked\ndescription: Blocked\n---\nBlocked body");

		const allBefore = discoverSlashSkills(cwd).map((skill) => skill.name);
		expect(allBefore).toEqual(expect.arrayContaining(["ceiling-selected", "ceiling-blocked"]));

		const selected = discoverSlashSkills(cwd, undefined, undefined, ["ceiling-selected"]);
		expect(selected.map((skill) => skill.name)).toEqual(["ceiling-selected"]);

		const allAfter = discoverSlashSkills(cwd).map((skill) => skill.name);
		expect(allAfter).toEqual(expect.arrayContaining(["ceiling-selected", "ceiling-blocked"]));
	});

	it("fails closed for unknown names and keeps unselected expansions unavailable", () => {
		const cwd = tempRoot();
		writeSkill(cwd, "ceiling-selected", "---\nname: ceiling-selected\ndescription: Selected\n---\nSelected body");
		writeSkill(cwd, "ceiling-blocked", "---\nname: ceiling-blocked\ndescription: Blocked\n---\nBlocked body");

		expect(getSlashSkill(cwd, "ceiling-selected", undefined, undefined, ["missing"])).toBeUndefined();

		const selected = resolveSkillExpansions(
			"/ceiling-selected arg",
			cwd,
			undefined,
			undefined,
			undefined,
			["ceiling-selected"],
		);
		expect(selected.expansions).toHaveLength(1);
		expect(selected.modelText).toContain("Selected body");

		const blocked = resolveSkillExpansions(
			"/ceiling-blocked arg",
			cwd,
			undefined,
			undefined,
			undefined,
			["ceiling-selected"],
		);
		expect(blocked.expansions).toEqual([]);
		expect(blocked.unknown).toEqual(["ceiling-blocked"]);
	});
});
