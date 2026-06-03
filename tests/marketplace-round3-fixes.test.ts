/**
 * Unit tests for the round-3 server-side marketplace review fixes:
 *  1. Shared project-scope skills registration is reconciled against on-disk
 *     reality — uninstalling one skill pack must not break sibling skill packs.
 *  2. reconcile is the authoritative final step of every install/update/
 *     uninstall/rollback, so a rolled-back skill-bearing update keeps the
 *     skills registration.
 *  3. Git add-source awaits the initial sync so packs are immediately visible.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { makeHarness, pack, localSource, tmpDir, SOURCE_A } from "./helpers/marketplace-harness.ts";
import { parseCustomDirectories } from "../src/server/agent/config-directories.ts";

const { MarketplaceService } = await import("../src/server/marketplace/service.ts");
const { reconcileSkillDirRegistration } = await import("../src/server/marketplace/entity-handlers.ts");

function makeService() {
	const stateDir = tmpDir("bobbit-market-state-");
	const systemConfigDir = tmpDir("bobbit-market-syscfg-");
	const systemSkillsDir = tmpDir("bobbit-market-sysskills-");
	const service = new MarketplaceService({
		stateDir,
		systemConfigDir,
		systemSkillsDir,
		resolveProject: () => null,
	});
	return { service, stateDir, systemConfigDir, systemSkillsDir };
}

/** The "skills"-typed config_directories entry for `dir`, or undefined. */
function skillReg(store: Parameters<typeof parseCustomDirectories>[0], dir: string) {
	return parseCustomDirectories(store).find((d) => path.resolve(d.path) === path.resolve(dir));
}

// ── Fix 1: shared skills registration survives single-pack uninstall ─────────

describe("marketplace fix: shared project skills registration is reconciled", () => {
	it("uninstalling one skill pack keeps a sibling skill pack resolvable AND registered", () => {
		const h = makeHarness();
		const skillsDir = path.join(h.projectConfigDir, "skills");

		// Two packs each contribute a skill under the SAME shared skills dir.
		h.service.install({ scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"), entities: null, conflict: "fail" });
		h.service.install({ scope: "project", projectId: "p1", source: localSource(), pack: pack("notes-pack"), entities: null, conflict: "fail" });

		assert.ok(fs.existsSync(path.join(skillsDir, "deep-research", "SKILL.md")));
		assert.ok(fs.existsSync(path.join(skillsDir, "note-taker", "SKILL.md")));
		assert.ok(skillReg(h.projectConfigStore, skillsDir)?.types.includes("skills"));

		// Uninstall ONE pack — the sibling skill must still resolve AND stay registered.
		h.service.uninstall({ scope: "project", projectId: "p1", sourceId: "src-a", packId: "notes-pack" });
		assert.ok(!fs.existsSync(path.join(skillsDir, "note-taker")), "uninstalled skill removed");
		assert.ok(fs.existsSync(path.join(skillsDir, "deep-research", "SKILL.md")), "sibling skill survives");
		assert.ok(skillReg(h.projectConfigStore, skillsDir)?.types.includes("skills"), "registration remains while a skill survives");

		// Uninstall the last skill pack → registration dropped + empty dir removed.
		h.service.uninstall({ scope: "project", projectId: "p1", sourceId: "src-a", packId: "research-pack" });
		assert.equal(skillReg(h.projectConfigStore, skillsDir), undefined, "registration dropped when no skills remain");
		assert.ok(!fs.existsSync(skillsDir), "empty shared skills dir removed");
	});

	it("reconcileSkillDirRegistration is idempotent and matches on-disk reality", () => {
		const h = makeHarness();
		const skillsDir = path.join(h.projectConfigDir, "skills");
		const ctx = {
			scope: "project" as const,
			projectId: "p1",
			configDir: h.projectConfigDir,
			skillInstallDir: skillsDir,
			projectConfigStore: h.projectConfigStore,
		};

		// No skills on disk → reconcile is a no-op (no registration).
		reconcileSkillDirRegistration(ctx);
		assert.equal(skillReg(h.projectConfigStore, skillsDir), undefined);

		// Add a skill on disk, then reconcile (twice) → registration present, stable.
		fs.mkdirSync(path.join(skillsDir, "manual-skill"), { recursive: true });
		fs.writeFileSync(path.join(skillsDir, "manual-skill", "SKILL.md"), "---\nname: manual-skill\n---\n");
		reconcileSkillDirRegistration(ctx);
		reconcileSkillDirRegistration(ctx);
		const after = parseCustomDirectories(h.projectConfigStore).filter((d) => path.resolve(d.path) === path.resolve(skillsDir));
		assert.equal(after.length, 1, "registration is added once, not duplicated");
		assert.ok(after[0].types.includes("skills"));

		// Remove the skill on disk, reconcile → registration dropped + dir removed.
		fs.rmSync(path.join(skillsDir, "manual-skill"), { recursive: true, force: true });
		reconcileSkillDirRegistration(ctx);
		assert.equal(skillReg(h.projectConfigStore, skillsDir), undefined);
		assert.ok(!fs.existsSync(skillsDir));
	});

	it("reconcile preserves a non-skills type registered on the same path", () => {
		const h = makeHarness();
		const skillsDir = path.join(h.projectConfigDir, "skills");
		// Pre-register the same path with both skills + tools.
		h.projectConfigStore.set("config_directories", JSON.stringify([{ path: path.resolve(skillsDir), types: ["skills", "tools"] }]));

		const ctx = {
			scope: "project" as const, projectId: "p1", configDir: h.projectConfigDir,
			skillInstallDir: skillsDir, projectConfigStore: h.projectConfigStore,
		};
		// No skills on disk → only the "skills" type is dropped; "tools" survives.
		reconcileSkillDirRegistration(ctx);
		const entry = skillReg(h.projectConfigStore, skillsDir);
		assert.ok(entry, "entry retained because another type remains");
		assert.deepEqual(entry!.types, ["tools"]);
	});
});

// ── Fix 2: rolled-back skill-bearing update keeps the registration ───────────

describe("marketplace fix: rollback keeps the skills registration", () => {
	it("a rolled-back whole-pack update restores the skill AND keeps it registered", () => {
		const h = makeHarness();
		const skillsDir = path.join(h.projectConfigDir, "skills");

		// Install role + skill (whole-pack of a pack that, at the time, omits the tool).
		const initial = pack("research-pack");
		initial.entities = initial.entities.filter((e) => e.type !== "tool");
		h.service.install({ scope: "project", projectId: "p1", source: localSource(), pack: initial, entities: null, conflict: "fail" });
		assert.ok(skillReg(h.projectConfigStore, skillsDir)?.types.includes("skills"));

		// Force the tool copy to fail mid-update: plant a FILE where the tools group dir must go.
		fs.writeFileSync(path.join(h.projectConfigDir, "tools"), "not a dir");

		// Whole-pack update now declares the tool too → skill refresh + tool copy fails.
		assert.throws(() => h.service.update({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
		}));

		// Skill restored AND still registered — the rollback's intermediate uninstall
		// must not leave the shared registration dropped.
		assert.ok(fs.existsSync(path.join(skillsDir, "deep-research", "SKILL.md")), "skill restored after rollback");
		assert.ok(skillReg(h.projectConfigStore, skillsDir)?.types.includes("skills"), "registration survives a rolled-back update");

		// Provenance unchanged: still role + skill.
		const rec = h.projectProvenance().find("src-a", "research-pack")!;
		assert.deepEqual(rec.entities.map((e) => e.type).sort(), ["role", "skill"]);
	});
});

// ── Fix 3: git add-source awaits the initial sync ───────────────────────────

describe("marketplace fix: git source sync populates the cache before packs are read", () => {
	it("an awaited sync of a file://-backed git source makes its packs immediately visible", async () => {
		// Build a real git repo containing a pack.
		const repo = tmpDir("bobbit-market-gitrepo-");
		fs.cpSync(path.join(SOURCE_A, "research-pack"), path.join(repo, "research-pack"), { recursive: true });
		const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
		const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: gitEnv, stdio: "ignore" });
		run("init", "-q");
		run("add", "-A");
		run("commit", "-q", "-m", "packs");

		const { service } = makeService();
		const src = service.addSource({ kind: "git", url: pathToFileURL(repo).href });

		// Mirrors what the add-source route AWAITs: after sync, packs are visible.
		const synced = await service.syncSource(src.id);
		assert.equal(synced.lastSyncError, null, "sync should succeed");
		assert.ok(synced.lastSyncedAt, "lastSyncedAt populated");
		assert.ok(synced.lastSyncCommit, "lastSyncCommit populated");

		const packs = service.listPacks("system", null);
		assert.ok(packs.some((p) => p.packId === "research-pack"), "pack visible immediately after awaited sync");
	});
});
