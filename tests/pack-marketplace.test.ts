/**
 * Wave 1 — Pack-Based Marketplace resolver foundation unit tests.
 *
 * Covers (design §12.2):
 *   #1 pack discovery + pack.yaml / .pack-meta.yaml parsing
 *   #2 PackResolver core (shadow ordering, shadows[], onlyTypes)
 *   #3 per-type loaders incl. the 3 skill layouts
 *   #4 three-scope resolution incl. within-scope user-pack > market + pack_order
 *   #5 legacy → unified-list A/B equivalence (roles + skills)
 *   #6 disabled_config_directories enforcement (deliberate, §6.3)
 *
 * All fixtures are real file trees under a tmp dir (file:// fixtures).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const manifestMod = await import("../src/server/agent/pack-manifest.ts");
const { parseManifest, validateManifest, readManifest, writeManifest, writeMeta, readMeta, isValidPackName } = manifestMod;
const { PackResolver, RoleLoader, ToolLoader, SkillLoader } = await import("../src/server/agent/pack-resolver.ts");
const { buildPackList } = await import("../src/server/agent/pack-list.ts");
const { ConfigCascade } = await import("../src/server/agent/config-cascade.ts");
const { BuiltinConfigProvider } = await import("../src/server/agent/builtin-config.ts");
const { discoverSlashSkills, scanSkillDir, scanCommandsDir } = await import("../src/server/skills/slash-skills.ts");

type AnyEntry = any;

let TMP: string;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pack-mvp-")); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

function w(file: string, content: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}
function roleYaml(name: string, marker = "p") {
	// `marker` rides in promptTemplate (not format-validated, unlike model).
	return `name: ${name}\nlabel: ${name}\naccessory: none\ncreatedAt: 0\nupdatedAt: 0\npromptTemplate: ${marker}\n`;
}
function skillMd(name: string, body = "BODY") {
	return `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}\n`;
}

// ── #1 manifest parsing ──────────────────────────────────────────

describe("#1 pack discovery & manifest parsing", () => {
	it("parses a valid pack.yaml", () => {
		const problems: string[] = [];
		const m = parseManifest(
			"name: research-pack\ndescription: deep research\nversion: 1.2.0\ncontents:\n  roles: [researcher]\n  tools: [research]\n  skills: [lit-review]\n",
			problems,
		);
		assert.ok(m, problems.join("; "));
		assert.equal(m!.name, "research-pack");
		assert.deepEqual(m!.contents.roles, ["researcher"]);
		assert.deepEqual(m!.contents.tools, ["research"]);
	});

	it("rejects bad pack names and unsafe names", () => {
		assert.equal(isValidPackName("ok-pack-1"), true);
		assert.equal(isValidPackName("Bad_Name"), false);
		assert.equal(isValidPackName("../escape"), false);
		assert.equal(isValidPackName(".hidden"), false);
		assert.equal(validateManifest({ name: "Bad", description: "d", version: "1", contents: { roles: [], tools: [], skills: [] } }), null);
	});

	it("rejects contents.mcp (MVP boundary)", () => {
		const problems: string[] = [];
		const m = validateManifest(
			{ name: "p", description: "d", version: "1", contents: { roles: [], tools: [], skills: [], mcp: ["x"] } },
			problems,
		);
		assert.equal(m, null);
		assert.ok(problems.join(";").includes("contents.mcp"));
	});

	it("requires contents with all three array keys", () => {
		assert.equal(validateManifest({ name: "p", description: "d", version: "1" }), null);
		assert.equal(validateManifest({ name: "p", description: "d", version: "1", contents: { roles: [], tools: [] } }), null);
	});

	it("ignores unknown top-level keys (forward-compat)", () => {
		const m = validateManifest({ name: "p", description: "d", version: "1", futureKey: 42, contents: { roles: [], tools: [], skills: [] } });
		assert.ok(m);
		assert.equal((m as any).futureKey, undefined);
	});

	it("readManifest: dir without pack.yaml ⇒ null; with ⇒ manifest", () => {
		const noPack = path.join(TMP, "nopack");
		fs.mkdirSync(noPack, { recursive: true });
		assert.equal(readManifest(noPack), null);
		const withPack = path.join(TMP, "withpack");
		fs.mkdirSync(withPack, { recursive: true });
		writeManifest(withPack, { name: "p1", description: "d", version: "1", contents: { roles: [], tools: [], skills: [] } });
		assert.equal(readManifest(withPack)!.name, "p1");
	});

	it(".pack-meta.yaml round-trips", () => {
		const dir = path.join(TMP, "meta-rt");
		fs.mkdirSync(dir, { recursive: true });
		const meta = { sourceUrl: "u", sourceRef: "main", commit: "abc", packName: "p", version: "1.0.0", installedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", scope: "project" as const };
		writeMeta(dir, meta);
		assert.deepEqual(readMeta(dir), meta);
	});
});

// ── #2 PackResolver core ─────────────────────────────────────────

describe("#2 PackResolver core", () => {
	const mkEntry = (id: string, scope: string, roles: Array<{ name: string; v: number }>, onlyTypes?: string[]): AnyEntry => ({
		id, kind: scope === "builtin" ? "builtin" : "user", scope, path: "", readOnly: false, layout: "defaults-tree",
		...(onlyTypes ? { onlyTypes } : {}),
		preloaded: { roles: roles.map(r => ({ name: r.name, item: r })) },
	});

	it("later entry shadows earlier same-name; shadows[] accumulates oldest→newest", () => {
		const entries = [
			mkEntry("a", "builtin", [{ name: "x", v: 1 }]),
			mkEntry("b", "server", [{ name: "x", v: 2 }, { name: "y", v: 1 }]),
			mkEntry("c", "project", [{ name: "x", v: 3 }]),
		];
		const resolved = new PackResolver(entries, [new RoleLoader()]).resolve<{ name: string; v: number }>("roles");
		const x = resolved.find(r => r.item.name === "x")!;
		assert.equal(x.item.v, 3);
		assert.equal(x.origin.id, "c");
		assert.deepEqual(x.shadows.map((s: AnyEntry) => s.id), ["a", "b"]);
		const y = resolved.find(r => r.item.name === "y")!;
		assert.equal(y.shadows.length, 0);
	});

	it("onlyTypes filters the entry out of non-listed types", () => {
		const entries = [
			mkEntry("a", "builtin", [{ name: "x", v: 1 }]),
			mkEntry("skillsonly", "project", [{ name: "x", v: 99 }], ["skills"]),
		];
		const resolved = new PackResolver(entries, [new RoleLoader()]).resolve<{ name: string; v: number }>("roles");
		assert.equal(resolved.find(r => r.item.name === "x")!.item.v, 1, "skills-only entry must not contribute roles");
	});
});

// ── #3 per-type loaders ──────────────────────────────────────────

describe("#3 per-type loaders", () => {
	let root: string;
	before(() => {
		root = path.join(TMP, "loaders");
		w(path.join(root, "roles", "coder.yaml"), roleYaml("coder"));
		w(path.join(root, "tools", "research", "web.yaml"), "name: web\ndescription: d\n");
		w(path.join(root, "tools", "flat.yaml"), "name: flat\ndescription: d\ngroup: Misc\n");
		w(path.join(root, "skills", "lit-review", "SKILL.md"), skillMd("lit-review"));
	});

	it("RoleLoader reads defaults-tree roles/", () => {
		const out = new RoleLoader().load({ path: root, layout: "defaults-tree" } as AnyEntry);
		assert.deepEqual(out.map((e: AnyEntry) => e.name), ["coder"]);
	});

	it("ToolLoader reads grouped + flat tools/ (group from dir name)", () => {
		const out = new ToolLoader().load({ path: root, layout: "defaults-tree" } as AnyEntry);
		const byName = new Map(out.map((e: AnyEntry) => [e.name, e.item]));
		assert.equal((byName.get("web") as AnyEntry).group, "research");
		assert.equal((byName.get("flat") as AnyEntry).group, "Misc");
	});

	it("SkillLoader handles all three layouts", () => {
		const dt = new SkillLoader().load({ path: root, layout: "defaults-tree", skillSource: "built-in" } as AnyEntry);
		assert.deepEqual(dt.map((e: AnyEntry) => e.name), ["lit-review"]);

		const flatRoot = path.join(TMP, "skills-flat");
		w(path.join(flatRoot, "alpha", "SKILL.md"), skillMd("alpha"));
		const sf = new SkillLoader().load({ path: flatRoot, layout: "skills-flat", skillSource: "custom" } as AnyEntry);
		assert.deepEqual(sf.map((e: AnyEntry) => e.name), ["alpha"]);
		assert.equal(sf[0].item.source, "custom");

		const cmdRoot = path.join(TMP, "commands");
		w(path.join(cmdRoot, "deploy.md"), skillMd("deploy"));
		const cf = new SkillLoader().load({ path: cmdRoot, layout: "commands-flat" } as AnyEntry);
		assert.deepEqual(cf.map((e: AnyEntry) => e.name), ["deploy"]);
		assert.equal(cf[0].item.source, "legacy");
	});
});

// ── #4 three-scope resolution + within-scope user-pack > market ───

describe("#4 three-scope resolution", () => {
	let builtinsDir: string, serverBase: string, globalUserBase: string, projectBase: string;
	function marketPack(base: string, scope: string, packName: string, role: string, model: string) {
		const dir = path.join(base, ".bobbit", "config", "market-packs", packName);
		w(path.join(dir, "roles", role + ".yaml"), roleYaml(role, model));
		writeManifest(dir, { name: packName, description: "d", version: "1", contents: { roles: [role], tools: [], skills: [] } });
		writeMeta(dir, { sourceUrl: "u", sourceRef: "m", commit: "", packName, version: "1", installedAt: "t", updatedAt: "t", scope: scope as any });
	}
	before(() => {
		const r = path.join(TMP, "scopes");
		builtinsDir = path.join(r, "builtin");
		serverBase = path.join(r, "server");
		globalUserBase = path.join(r, "gu");
		projectBase = path.join(r, "proj");
		w(path.join(builtinsDir, "roles", "coder.yaml"), roleYaml("coder", "m-builtin"));
		w(path.join(serverBase, ".bobbit", "config", "roles", "coder.yaml"), roleYaml("coder", "m-server"));
		w(path.join(globalUserBase, ".bobbit", "config", "roles", "coder.yaml"), roleYaml("coder", "m-gu"));
	});

	function resolveRoles(opts: any) {
		const list = buildPackList(opts);
		return new PackResolver(list, [new RoleLoader()]).resolve<any>("roles");
	}

	it("project > global-user > server > builtin; within project user-pack > market", () => {
		// project user-pack defines coder; project market pack also defines coder.
		w(path.join(projectBase, ".bobbit", "config", "roles", "coder.yaml"), roleYaml("coder", "m-project-user"));
		marketPack(projectBase, "project", "mkt", "coder", "m-project-market");
		const resolved = resolveRoles({ builtinsDir, serverBase, globalUserBase, projectBase, cwd: projectBase });
		const coder = resolved.find((e: AnyEntry) => e.item.name === "coder")!;
		assert.equal(coder.item.promptTemplate, "m-project-user", "project user-pack must beat its own market pack");
		assert.equal(coder.origin.scope, "project");
		assert.equal(coder.origin.kind, "user");

		// global-user beats server: remove project layers by using a fresh projectBase with no coder.
		const emptyProj = path.join(TMP, "empty-proj");
		fs.mkdirSync(emptyProj, { recursive: true });
		const r2 = resolveRoles({ builtinsDir, serverBase, globalUserBase, projectBase: emptyProj, cwd: emptyProj });
		assert.equal(r2.find((e: AnyEntry) => e.item.name === "coder")!.item.promptTemplate, "m-gu");
	});

	it("market-vs-market within a scope ordered by pack_order (highest last)", () => {
		const base = path.join(TMP, "mkt-order");
		marketPack(base, "project", "a", "shared", "from-a");
		marketPack(base, "project", "b", "shared", "from-b");
		const store = { get: (k: string) => (k === "pack_order" ? JSON.stringify({ project: ["b", "a"] }) : undefined) };
		const resolved = resolveRoles({ builtinsDir, serverBase: base, globalUserBase: base, projectBase: base, cwd: base, projectConfigStore: store });
		// order ["b","a"] ⇒ a is last ⇒ a wins
		assert.equal(resolved.find((e: AnyEntry) => e.item.name === "shared")!.item.promptTemplate, "from-a");

		const store2 = { get: (k: string) => (k === "pack_order" ? JSON.stringify({ project: ["a", "b"] }) : undefined) };
		const resolved2 = resolveRoles({ builtinsDir, serverBase: base, globalUserBase: base, projectBase: base, cwd: base, projectConfigStore: store2 });
		assert.equal(resolved2.find((e: AnyEntry) => e.item.name === "shared")!.item.promptTemplate, "from-b");
	});
});

// ── #5 legacy → unified A/B equivalence ──────────────────────────

describe("#5 legacy → unified A/B equivalence", () => {
	it("roles: cascade adapter == independent legacy 3-layer merge", () => {
		const builtinsDir = path.join(TMP, "ab-builtin");
		w(path.join(builtinsDir, "roles", "coder.yaml"), roleYaml("coder", "m-b"));
		w(path.join(builtinsDir, "roles", "tester.yaml"), roleYaml("tester", "m-b"));
		const builtins = new BuiltinConfigProvider(builtinsDir);
		const serverRoles = [{ name: "coder", label: "c", promptTemplate: "p", accessory: "none", model: "m-s", createdAt: 0, updatedAt: 0 }];
		const projectRoles = [{ name: "coder", label: "c", promptTemplate: "p", accessory: "none", model: "m-p", createdAt: 0, updatedAt: 0 }];
		const serverStores = { getRoles: () => serverRoles, getTools: () => [], getToolGroupPolicies: () => ({}) };
		const pcm = { getOrCreate: (id: string) => (id === "p1" ? { roleStore: { getAllLocal: () => projectRoles } } : undefined) } as any;
		const cascade = new ConfigCascade(builtins, serverStores, pcm);

		// independent legacy merge
		function legacy(projectId?: string) {
			const merged = new Map<string, any>();
			for (const item of builtins.getRoles()) merged.set(item.name, { item, origin: "builtin" });
			for (const item of serverRoles) { const e = merged.get(item.name); merged.set(item.name, { item, origin: "server", overrides: e?.origin }); }
			if (projectId === "p1") for (const item of projectRoles) { const e = merged.get(item.name); merged.set(item.name, { item, origin: "project", overrides: e?.origin }); }
			return [...merged.values()].map(v => v.overrides ? v : { item: v.item, origin: v.origin });
		}
		assert.deepEqual(cascade.resolveRoles(), legacy());
		assert.deepEqual(cascade.resolveRoles("p1"), legacy("p1"));
	});

	it("skills: discoverSlashSkills order == legacy merge order", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ab-skills-"));
		// same-named skill in a low and a high legacy dir; high (project .claude/skills) must win.
		w(path.join(cwd, ".bobbit", "skills", "dup", "SKILL.md"), skillMd("dup", "FROM-BOBBIT-PROJECT"));
		w(path.join(cwd, ".claude", "skills", "dup", "SKILL.md"), skillMd("dup", "FROM-CLAUDE-PROJECT"));
		w(path.join(cwd, ".claude", "skills", "only", "SKILL.md"), skillMd("only"));

		const got = discoverSlashSkills(cwd);
		const dup = got.find(s => s.name === "dup")!;
		assert.ok(dup.content.includes("FROM-CLAUDE-PROJECT"), ".claude/skills (project, highest) must win over .bobbit/skills");
		assert.ok(got.some(s => s.name === "only"));

		// legacy reference merge (the §6.2 order, lowest→highest)
		const byName = new Map<string, any>();
		for (const s of scanCommandsDir(path.join(cwd, ".claude", "commands"))) byName.set(s.name, s);
		for (const s of scanSkillDir(path.join(os.homedir(), ".bobbit", "skills"), "personal")) byName.set(s.name, s);
		for (const s of scanSkillDir(path.join(os.homedir(), ".claude", "skills"), "personal")) byName.set(s.name, s);
		for (const s of scanSkillDir(path.join(cwd, ".bobbit", "skills"), "project")) byName.set(s.name, s);
		for (const s of scanSkillDir(path.join(cwd, ".claude", "skills"), "project")) byName.set(s.name, s);
		const legacyDup = byName.get("dup")!;
		assert.equal(dup.content, legacyDup.content);
		assert.equal(dup.source, legacyDup.source);
		fs.rmSync(cwd, { recursive: true, force: true });
	});
});

// ── #6 disabled_config_directories enforcement (deliberate, §6.3) ─

describe("#6 disabled_config_directories enforcement", () => {
	it("present-AND-disabled skill dir is omitted; present-but-not-disabled still resolves", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "disabled-"));
		w(path.join(cwd, ".claude", "skills", "zz-disable-me", "SKILL.md"), skillMd("zz-disable-me"));

		// not disabled ⇒ resolves
		const before = discoverSlashSkills(cwd, { get: () => undefined });
		assert.ok(before.some(s => s.name === "zz-disable-me"), "should resolve when not disabled");

		// disabled ⇒ omitted
		const disabledPath = path.resolve(path.join(cwd, ".claude", "skills"));
		const store = { get: (k: string) => (k === "disabled_config_directories" ? JSON.stringify([disabledPath]) : undefined) };
		const after = discoverSlashSkills(cwd, store);
		assert.ok(!after.some(s => s.name === "zz-disable-me"), "disabled dir must be omitted from resolution");
		fs.rmSync(cwd, { recursive: true, force: true });
	});
});
