import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PackEntry } from "../../src/server/agent/pack-types.js";
import { createAdoptedExtension, type AdoptionScope, type AdoptedExtension } from "../../src/server/agent/adopted-extensions.js";
import { SessionManager } from "../../src/server/agent/session-manager.js";
import { adoptedSkillEntries } from "../../src/server/skills/adopted-skill-entries.js";
import { resolveSkillExpansions } from "../../src/server/skills/resolve-skill-expansions.js";
import {
	discoverSlashSkills,
	discoverSlashSkillsResolved,
	invalidateSlashSkillsCache,
	scanSkillDirResolved,
} from "../../src/server/skills/slash-skills.js";

const roots: string[] = [];

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-adopted-skills-"));
	roots.push(root);
	return root;
}

function writeSkill(root: string, dir: string, body: string): void {
	const skillDir = path.join(root, dir);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), body, "utf8");
}

function adoptedEntry(directory: string, id: string): PackEntry {
	const scanned = scanSkillDirResolved(directory, "custom");
	return {
		id: `adopt:server:${id}`,
		kind: "adopted",
		scope: "server",
		adoptionId: id,
		path: directory,
		readOnly: true,
		onlyTypes: ["skills"],
		layout: "skills-flat",
		preloaded: {
			skills: scanned.skills.map((skill) => {
				const name = `adopt-${id}--${skill.name}`;
				return { name, item: { ...skill, name } };
			}),
		},
	};
}

beforeEach(() => invalidateSlashSkillsCache());
afterAll(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("adopted Claude-style skills", () => {
	it("keeps valid siblings while reporting controlled scanner rejections", () => {
		const source = tempRoot();
		writeSkill(source, "read", ["---", "name: read", "allowed-tools: [bash]", "---", "Read only"].join("\n"));
		writeSkill(source, "broken", ["---", "name: [not-a-string", "---", "Broken"].join("\n"));
		writeSkill(source, "z-duplicate", ["---", "name: read", "---", "Duplicate"].join("\n"));
		fs.mkdirSync(path.join(source, "missing"), { recursive: true });

		const result = scanSkillDirResolved(source, "custom");
		expect(result.skills.map((skill) => skill.name)).toEqual(["read"]);
		expect(result.skills[0]?.allowedTools).toEqual(["bash"]);
		expect(result.diagnostics).toEqual(expect.arrayContaining([
			{ path: path.join(source, "broken", "SKILL.md"), reason: "malformed_frontmatter" },
			{ path: path.join(source, "z-duplicate", "SKILL.md"), reason: "duplicate_name" },
			{ path: path.join(source, "missing", "SKILL.md"), reason: "missing_skill_file" },
		]));
	});

	it("resolves namespaced adopted entries through SkillLoader and preserves provenance", () => {
		const root = tempRoot();
		const cwd = path.join(root, "project");
		const source = path.join(root, "stock-skills");
		fs.mkdirSync(cwd, { recursive: true });
		writeSkill(source, "read", ["---", "name: read", "description: Read a stock asset", "allowed-tools: bash", "---", "Source body"].join("\n"));
		const entry = adoptedEntry(source, "stock-docs");
		const context = {
			serverBase: path.join(root, "server"),
			globalUserBase: path.join(root, "global"),
			projectBase: cwd,
			adoptedEntries: (scope: "server" | "global-user" | "project"): PackEntry[] => scope === "server" ? [entry] : [],
		};

		const skills = discoverSlashSkills(cwd, undefined, context);
		const adopted = skills.find((skill) => skill.name === "adopt-stock-docs--read");
		expect(adopted).toMatchObject({
			source: "custom",
			originKind: "adopted",
			adoptionId: "stock-docs",
			allowedTools: ["bash"],
			content: "Source body",
			filePath: path.join(source, "read", "SKILL.md"),
		});

		const resolved = discoverSlashSkillsResolved(cwd, undefined, context);
		const resolvedAdopted = resolved.find((skill) => skill.name === "adopt-stock-docs--read");
		expect(resolvedAdopted?.origin).toMatchObject({ kind: "adopted", adoptionId: "stock-docs" });
	});

	it("keeps legacy project skills above the adopted resolver band on collisions", () => {
		const root = tempRoot();
		const cwd = path.join(root, "project");
		const source = path.join(root, "stock-skills");
		writeSkill(source, "read", ["---", "name: read", "---", "Adopted body"].join("\n"));
		fs.mkdirSync(path.join(cwd, ".claude", "commands"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".claude", "commands", "manual.md"), [
			"---", "name: adopt-stock-docs--read", "---", "Manual body",
		].join("\n"), "utf8");
		const entry = adoptedEntry(source, "stock-docs");
		const context = {
			serverBase: path.join(root, "server"),
			globalUserBase: path.join(root, "global"),
			projectBase: cwd,
			adoptedEntries: (scope: "server" | "global-user" | "project"): PackEntry[] => scope === "server" ? [entry] : [],
		};

		const resolved = discoverSlashSkillsResolved(cwd, undefined, context);
		const winner = resolved.find((skill) => skill.name === "adopt-stock-docs--read");
		expect(winner?.item.content).toBe("Manual body");
		expect(winner?.origin.kind).toBe("legacy-implicit");
		expect(winner?.shadows.map((shadow) => shadow.kind)).toContain("adopted");
	});

	it("expands and catalogs project adoptions only for their owning project", () => {
		const root = tempRoot();
		const cwd = path.join(root, "project");
		const source = path.join(root, "stock-skills");
		writeSkill(source, "summarize", ["---", "name: summarize", "description: Summarize", "allowed-tools: read", "---", "ADOPTED $ARGUMENTS"].join("\n"));
		const adoption = createAdoptedExtension({ kind: "skills", scope: "project", projectId: "project-a", source: { directory: source } });
		const ledger = (records: Partial<Record<AdoptionScope, Record<string, AdoptedExtension>>>) => ({
			get: () => undefined,
			getPackActivation: () => ({}),
			getAdoptedExtensions: (scope: AdoptionScope) => records[scope] ?? {},
		});
		const serverStore = ledger({});
		const projectAStore = ledger({ project: { [adoption.id]: adoption } });
		const projectBStore = ledger({});
		const context = (projectId: string, projectStore: typeof projectAStore) => ({
			serverBase: root, globalUserBase: root, projectBase: cwd,
			serverConfigStore: serverStore as any,
			projectConfigStore: projectStore as any,
			adoptedEntries: (scope: AdoptionScope) => adoptedSkillEntries(scope, { serverConfigStore: serverStore, projectConfigStore: projectStore, projectId }),
		});
		const name = `adopt-${adoption.id}--summarize`;
		const expanded = resolveSkillExpansions(`/${name} this`, cwd, projectAStore, undefined, context("project-a", projectAStore));
		expect(expanded.modelText).toContain("ADOPTED this");
		invalidateSlashSkillsCache();
		expect(resolveSkillExpansions(`/${name}`, cwd, projectAStore, undefined, context("project-b", projectAStore)).unknown).toEqual([name]);

		const manager: any = new SessionManager({ projectConfigStore: serverStore as any });
		manager.projectContextManager = { getOrCreate: (id: string) => id === "project-a" ? { projectConfigStore: projectAStore } : { projectConfigStore: projectBStore } };
		invalidateSlashSkillsCache();
		expect(manager.computeSkillsCatalog(["activate_skill"], cwd, projectAStore, "project-a").map((skill: { name: string }) => skill.name)).toContain(name);
		invalidateSlashSkillsCache();
		expect(manager.computeSkillsCatalog(["activate_skill"], cwd, projectBStore, "project-b").map((skill: { name: string }) => skill.name)).not.toContain(name);
	});
});
