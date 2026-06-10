/**
 * Unit — pack-schema-v1 §7: RUNTIME tool resolution is activation-filtered.
 *
 * Activation (disabling market-pack tools via `pack_activation`) already filters
 * the ConfigCascade list so `/api/tools` hides a disabled tool. This pins that
 * the SAME filtering reaches the runtime `ToolManager` resolution path that backs
 * every other tool endpoint, so there is NO split-brain:
 *
 *   - renderer GET (`/api/tools/:tool/renderer`)  → `resolveToolLocation`
 *   - action POST (`/api/tools/:tool/actions/:a`) → `resolveToolLocation`
 *   - surface-token mint (`/api/ext/surface-token`) → `resolvePackIdentityForTool`
 *       → `resolveToolLocation`
 *   - prompt docs / `getToolByName` / `getAllToolNames` → `loadToolDefinitions`
 *
 * All of those consult `loadToolDefinitions`, where a market layer now drops its
 * `disabledTools` names. So a disabled high-priority pack tool stops resolving
 * (its action can't dispatch, its surface token can't mint, its renderer 404s)
 * and a lower-priority same-name pack tool reappears as the winner — exactly as
 * the cascade listing behaves.
 *
 * The disabled-tool list is the SAME shape `pack_activation` stores
 * (`DisabledRefs.tools`); server.ts feeds it into each `MarketToolRoot` from the
 * SAME store the cascade reads, so this fixture mirrors that wiring.
 *
 * file:// fixtures only.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolManager, __resetToolScanCache, type MarketToolRoot } from "../src/server/agent/tool-manager.ts";
import { resolvePackIdentityForTool } from "../src/server/extension-host/pack-identity.ts";

let tmp: string;
let configDir: string;
let builtinDir: string;
let packALow: string;   // tools/ dir of low-priority pack
let packBHigh: string;  // tools/ dir of high-priority pack

function w(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

/** Write a pack tool YAML declaring a renderer + an actions module (so renderer/
 *  action resolution has something to resolve when the tool is enabled). */
function packTool(toolsDir: string, group: string, name: string, desc: string): void {
	w(path.join(toolsDir, group, `${name}.yaml`),
		`name: ${name}\ngroup: ${group}\ndescription: "${desc}"\nrenderer: ${name}Renderer.js\nactions:\n  module: actions.mjs\n  names: [retry]\n`);
	w(path.join(toolsDir, group, `${name}Renderer.js`), "export default {};\n");
	w(path.join(toolsDir, group, "actions.mjs"), "export const actions = { retry: () => 1 };\n");
}

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "market-tool-activation-"));
	configDir = path.join(tmp, "user-config");
	builtinDir = path.join(tmp, "builtins");
	fs.mkdirSync(path.join(configDir, "tools"), { recursive: true });
	fs.mkdirSync(builtinDir, { recursive: true });

	// Both packs live under a `market-packs/<name>` path so `rendererKind` treats
	// their `.js` renderer as "pack" (mirrors a real install).
	packALow = path.join(tmp, ".bobbit", "config", "market-packs", "packA", "tools");
	packBHigh = path.join(tmp, ".bobbit", "config", "market-packs", "packB", "tools");

	// Low pack ships a same-named `shared_tool` that should reappear when the high
	// pack's copy is disabled.
	packTool(packALow, "Demo", "shared_tool", "from packA");

	// High pack ships: a same-named `shared_tool` (winner while enabled), a unique
	// `solo_tool` (vanishes entirely when disabled), and an `enabled_tool` control.
	packTool(packBHigh, "Demo", "shared_tool", "from packB");
	packTool(packBHigh, "Demo", "solo_tool", "high-only tool");
	packTool(packBHigh, "Demo", "enabled_tool", "stays enabled");
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Build a ToolManager whose high pack has the given disabled tool names — the
 *  EXACT `MarketToolRoot.disabledTools` server.ts derives from `pack_activation`. */
function tmWithDisabled(disabledHigh: string[]): InstanceType<typeof ToolManager> {
	__resetToolScanCache();
	const tm = new ToolManager(configDir, builtinDir);
	const roots: MarketToolRoot[] = [
		{ dir: packALow },
		{ dir: packBHigh, disabledTools: disabledHigh },
	];
	tm.setMarketToolRootsProvider(() => roots);
	return tm;
}

describe("runtime tool resolution honors pack_activation (no split-brain)", () => {
	it("control: with NOTHING disabled the high pack wins and all tools resolve", () => {
		const tm = tmWithDisabled([]);
		// High pack wins the same-named tool.
		assert.equal(tm.getToolByName("shared_tool")!.description, "from packB");
		assert.equal(path.resolve(tm.resolveToolLocation("shared_tool")!.baseDir), path.resolve(packBHigh));
		// Unique high-pack tool resolves with its renderer + action.
		const solo = tm.resolveToolLocation("solo_tool");
		assert.ok(solo, "solo_tool resolves when enabled");
		assert.equal(solo!.rendererKind, "pack");
		assert.equal(solo!.actionsModule, "actions.mjs");
		assert.ok(tm.getAllToolNames().includes("solo_tool"));
		// Surface-token mint precondition holds (isPack).
		assert.equal(resolvePackIdentityForTool(tm, "solo_tool").isPack, true);
	});

	it("(c) renderer GET 404s for a disabled pack tool (no pack renderer resolves)", () => {
		const tm = tmWithDisabled(["solo_tool", "shared_tool"]);
		// The renderer endpoint 404s when resolveToolLocation yields no pack renderer.
		const loc = tm.resolveToolLocation("solo_tool");
		assert.equal(loc, undefined, "disabled unique tool must not resolve at all");
	});

	it("(a) action endpoint cannot resolve/execute a disabled pack tool even if allowedTools contains it", () => {
		const tm = tmWithDisabled(["solo_tool", "shared_tool"]);
		// The action dispatcher resolves the module via resolveToolLocation; a
		// disabled unique tool resolves to nothing ⇒ no actionsModule ⇒ 404
		// "no actions", regardless of the session's allowedTools.
		assert.equal(tm.resolveToolLocation("solo_tool"), undefined);
		assert.equal(tm.getToolByName("solo_tool"), undefined);
		assert.ok(!tm.getAllToolNames().includes("solo_tool"));
		// And it's absent from the prompt docs (the prompt-doc path is filtered too).
		assert.ok(!tm.getToolDocsForPrompt().includes("solo_tool"));
	});

	it("(b) surface-token mint is rejected for a disabled pack tool", () => {
		const tm = tmWithDisabled(["solo_tool", "shared_tool"]);
		// resolvePackIdentityForTool → resolveToolLocation returns undefined, so
		// isPack is false and the mint endpoint answers 403.
		const ident = resolvePackIdentityForTool(tm, "solo_tool");
		assert.equal(ident.isPack, false);
		assert.equal(ident.packId, "");
	});

	it("(d) a lower-priority same-name pack tool reappears as the winner when the high one is disabled", () => {
		const tm = tmWithDisabled(["shared_tool"]);
		const byName = tm.getToolByName("shared_tool");
		assert.ok(byName, "the low pack's shared_tool must reappear");
		assert.equal(byName!.description, "from packA");
		const loc = tm.resolveToolLocation("shared_tool");
		assert.ok(loc, "shadow resolves");
		assert.equal(path.resolve(loc!.baseDir), path.resolve(packALow),
			"the resolved winner is now the LOW pack, not the disabled high one");
		// The reappeared shadow still mints a surface token (its own packId).
		assert.equal(resolvePackIdentityForTool(tm, "shared_tool").isPack, true);
	});

	it("(e) an ENABLED tool is unaffected by disabling its pack siblings", () => {
		const tm = tmWithDisabled(["solo_tool", "shared_tool"]);
		const loc = tm.resolveToolLocation("enabled_tool");
		assert.ok(loc, "enabled_tool still resolves");
		assert.equal(loc!.rendererKind, "pack");
		assert.equal(loc!.actionsModule, "actions.mjs");
		assert.equal(path.resolve(loc!.baseDir), path.resolve(packBHigh));
		assert.ok(tm.getAllToolNames().includes("enabled_tool"));
		assert.ok(tm.getToolDocsForPrompt().includes("enabled_tool"));
		assert.equal(resolvePackIdentityForTool(tm, "enabled_tool").isPack, true);
	});

	it("builtins are never activation-filtered (no disabledTools on the builtin layer)", () => {
		// A builtin tool sharing a name with a disabled list entry is untouched: the
		// disabled set only applies to the market layer that declares it.
		w(path.join(builtinDir, "Core", "solo_tool.yaml"),
			"name: solo_tool\ngroup: Core\ndescription: builtin solo\n");
		const tm = tmWithDisabled(["solo_tool"]);
		// High pack's solo_tool is dropped, so the builtin shadow becomes the winner.
		const byName = tm.getToolByName("solo_tool");
		assert.ok(byName, "builtin solo_tool reappears when the pack one is disabled");
		assert.equal(byName!.description, "builtin solo");
		// Clean up so other cases see no builtin solo_tool.
		fs.rmSync(path.join(builtinDir, "Core"), { recursive: true, force: true });
		__resetToolScanCache();
	});
});
