/**
 * pack-schema-v1 §7 — pack-activation filtering for slash-skill discovery.
 *
 * Discovery has its OWN pipeline (`discoverSlashSkillsResolved` →
 * `PackResolver`) separate from the roles/tools config-cascade. This test pins
 * that the SAME `pack_activation` disabled-skill lookup threaded via
 * `SkillMarketContext.packActivation` is honored there:
 *   - a disabled market-pack skill is dropped BEFORE the precedence merge, so it
 *     is absent from the resolved list;
 *   - because the drop happens pre-merge, a lower-priority same-named market-pack
 *     skill REAPPEARS as the winner;
 *   - an enabled skill (same pack) is unaffected.
 *
 * Fixtures are real on-disk market packs under `<base>/.bobbit/config/market-packs`,
 * ordered via a synthetic server `pack_order` store.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let baseDir: string;
let emptyHome: string;
let projectCwd: string;

function writePackSkill(packRoot: string, skillName: string, body: string): void {
	const dir = path.join(packRoot, "skills", skillName);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf-8");
}

function writePack(packName: string, skills: Record<string, string>): string {
	const packRoot = path.join(baseDir, ".bobbit", "config", "market-packs", packName);
	fs.mkdirSync(packRoot, { recursive: true });
	const skillNames = Object.keys(skills);
	fs.writeFileSync(
		path.join(packRoot, "pack.yaml"),
		[
			`name: ${packName}`,
			`description: "Fixture pack ${packName}"`,
			"version: 1.0.0",
			"contents:",
			"  roles: []",
			"  tools: []",
			`  skills: [${skillNames.join(", ")}]`,
			"  entrypoints: []",
		].join("\n"),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(packRoot, ".pack-meta.yaml"),
		[
			`packName: ${packName}`,
			"version: 1.0.0",
			"scope: server",
			"sourceUrl: \"\"",
			"sourceRef: \"\"",
			"commit: \"\"",
			"installedAt: \"\"",
			"updatedAt: \"\"",
		].join("\n"),
		"utf-8",
	);
	for (const [name, body] of Object.entries(skills)) writePackSkill(packRoot, name, body);
	return packRoot;
}

/** Minimal ProjectConfigReader returning a fixed `pack_order` for the server scope. */
function packOrderStore(serverOrder: string[]): { get(key: string): string | undefined } {
	return {
		get(key: string): string | undefined {
			if (key === "pack_order") return JSON.stringify({ server: serverOrder });
			return undefined;
		},
	};
}

before(() => {
	baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "slash-skills-activation-"));
	emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "slash-skills-activation-home-"));
	// A SEPARATE empty discovery root so the project scope (which falls back to
	// `cwd` when projectBase is unset) does NOT re-scan baseDir's market-packs
	// with an empty project pack_order and reverse precedence.
	projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "slash-skills-activation-cwd-"));
	// packLow (lowest priority) + packHigh (highest). Both define `dup`; packHigh
	// additionally defines `solo` (only in the high pack) and `keep` (the enabled
	// control). pack_order = [packLow, packHigh] ⇒ packHigh wins ties.
	writePack("pack-low", {
		dup: "---\nname: dup\ndescription: dup from LOW\n---\nLOW-DUP",
	});
	writePack("pack-high", {
		dup: "---\nname: dup\ndescription: dup from HIGH\n---\nHIGH-DUP",
		solo: "---\nname: solo\ndescription: only in HIGH\n---\nHIGH-SOLO",
		keep: "---\nname: keep\ndescription: enabled control\n---\nHIGH-KEEP",
	});
});

after(() => {
	for (const d of [baseDir, emptyHome, projectCwd]) {
		try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});

const { discoverSlashSkillsResolved, invalidateSlashSkillsCache } = await import("../src/server/skills/slash-skills.ts");
type DisabledLookup = (scope: "server" | "global-user" | "project", packName: string) => { skills?: string[] };

function resolveWith(disabled: DisabledLookup | undefined): Map<string, { content: string; packName: string | null }> {
	invalidateSlashSkillsCache();
	const resolved = discoverSlashSkillsResolved(projectCwd, undefined, {
		serverBase: baseDir,
		globalUserBase: emptyHome,
		serverConfigStore: packOrderStore(["pack-low", "pack-high"]) as never,
		packActivation: disabled,
	});
	const out = new Map<string, { content: string; packName: string | null }>();
	for (const r of resolved) {
		out.set(r.name, {
			content: r.item.content,
			packName: r.origin.kind === "market" ? (r.origin.manifest?.name ?? null) : null,
		});
	}
	return out;
}

describe("slash-skill discovery honors pack_activation (pack-schema-v1 §7)", () => {
	it("with no activation filter, the highest-priority market-pack skill wins", () => {
		const skills = resolveWith(undefined);
		assert.equal(skills.get("dup")?.content, "HIGH-DUP", "packHigh should win the dup tie");
		assert.equal(skills.get("dup")?.packName, "pack-high");
		assert.equal(skills.get("solo")?.content, "HIGH-SOLO");
		assert.equal(skills.get("keep")?.content, "HIGH-KEEP");
	});

	it("a disabled market-pack skill is absent AND a lower-priority shadow reappears", () => {
		// Disable `dup` + `solo` in pack-high.
		const disabled: DisabledLookup = (scope, packName) =>
			scope === "server" && packName === "pack-high" ? { skills: ["dup", "solo"] } : {};
		const skills = resolveWith(disabled);
		// `solo` only existed in pack-high → fully absent.
		assert.equal(skills.has("solo"), false, "disabled solo must be absent (no shadow)");
		// `dup` from pack-high is dropped pre-merge → pack-low's `dup` reappears.
		assert.equal(skills.get("dup")?.content, "LOW-DUP", "lower-priority shadow must reappear");
		assert.equal(skills.get("dup")?.packName, "pack-low");
		// `keep` is enabled → unaffected.
		assert.equal(skills.get("keep")?.content, "HIGH-KEEP", "enabled skill must be unaffected");
	});

	it("disabling a skill in the WRONG pack/scope does not filter it", () => {
		// Disable `dup` but for pack-low / project scope — pack-high's `dup` is untouched.
		const disabled: DisabledLookup = (scope, packName) =>
			packName === "pack-low" ? { skills: ["dup"] } : {};
		const skills = resolveWith(disabled);
		// pack-high's dup wins (it is not disabled); pack-low's would-be shadow is the
		// one disabled, which is inert since it lost the tie anyway.
		assert.equal(skills.get("dup")?.content, "HIGH-DUP");
		assert.equal(skills.get("solo")?.content, "HIGH-SOLO");
		assert.equal(skills.get("keep")?.content, "HIGH-KEEP");
	});
});
