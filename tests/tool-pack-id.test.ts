/**
 * pack-schema-v1 — `/api/tools` exposes each market-pack tool's STRUCTURAL packId.
 *
 * The client resolves a tool renderer's OWN-pack panel via
 * `/api/ext/packs/:packId/panels/:panelId` (panel ids are pack-local now), so it
 * needs the SAME structural packId the panel endpoint + `/api/ext/contributions`
 * key by. The `/api/tools` LIST + detail endpoints derive that packId via
 * `resolvePackIdentityForTool(toolManager, name)` — the EXACT call exercised here.
 *
 * This pins the cross-module equality the wire contract depends on:
 *   resolvePackIdentityForTool(winning tool location).packId   (/api/tools)
 *     === packIdFromRoot(packRoot)                               (/api/ext/contributions, panel endpoint)
 *     === the PackContributionRegistry's packId for that pack
 *     === the `market-packs/<name>` dir segment
 * and that a builtin (non-pack) tool yields an empty packId (absent on the wire).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolManager } from "../src/server/agent/tool-manager.ts";
import { resolvePackIdentityForTool } from "../src/server/extension-host/pack-identity.ts";
import { packIdFromRoot } from "../src/server/agent/pack-contributions.ts";
import { PackContributionRegistry } from "../src/server/extension-host/pack-contribution-registry.ts";
import type { PackEntry, PackManifest } from "../src/server/agent/pack-types.ts";

let tmp: string;
let configDir: string;
let builtinDir: string;
let packRoot: string;
let packToolsDir: string;

const PACK_NAME = "artifacts";
const TOOL = "artifact_demo";

function w(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tool-pack-id-"));
	// Empty user-config + builtin dirs so only our market pack contributes.
	configDir = path.join(tmp, "user-config");
	builtinDir = path.join(tmp, "builtins");
	fs.mkdirSync(path.join(configDir, "tools"), { recursive: true });
	fs.mkdirSync(builtinDir, { recursive: true });
	// A real installed market pack: tools/<group>/<tool>.yaml (renderer pointing at
	// a shared lib/ module) + a pack-scoped panel.
	packRoot = path.join(tmp, "server", ".bobbit", "config", "market-packs", PACK_NAME);
	packToolsDir = path.join(packRoot, "tools");
	w(path.join(packRoot, "pack.yaml"),
		`name: ${PACK_NAME}\ndescription: "Search tool + artifact viewer."\nversion: 1.0.0\ncontents:\n  roles: []\n  tools: [Demo]\n  skills: []\n  entrypoints: []\n`);
	w(path.join(packToolsDir, "Demo", `${TOOL}.yaml`),
		`name: ${TOOL}\ngroup: Demo\ndescription: "Demo artifact tool."\nrenderer: ../../lib/SharedRenderer.js\n`);
	w(path.join(packRoot, "panels", "artifacts-viewer.yaml"),
		"id: artifacts.viewer\ntitle: Artifact\nentry: ../lib/ArtifactViewerPanel.js\n");
	w(path.join(packRoot, "lib", "SharedRenderer.js"), "export default {};\n");
	w(path.join(packRoot, "lib", "ArtifactViewerPanel.js"), "export default {};\n");
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

function manifest(name: string): PackManifest {
	return { name, description: "d", version: "1", contents: { roles: [], tools: [], skills: [], entrypoints: [] } };
}

describe("structural packId on the /api/tools resolution path", () => {
	it("a market-pack tool resolves to the SAME packId the panel endpoint + contributions use", () => {
		const tm = new ToolManager(configDir, builtinDir);
		// Mirror server.ts wiring: the project/server tool manager's market roots
		// are the installed packs' `tools/` dirs.
		tm.setMarketToolRootsProvider(() => [packToolsDir]);

		// The tool is visible and resolves to the pack's tools dir.
		const loc = tm.resolveToolLocation(TOOL);
		assert.ok(loc, "pack tool must resolve");
		assert.equal(path.resolve(loc!.baseDir), path.resolve(packToolsDir));

		// /api/tools derives packId via this exact call.
		const ident = resolvePackIdentityForTool(tm, TOOL);
		assert.equal(ident.isPack, true);
		assert.equal(ident.packId, PACK_NAME, "tool packId = market-packs/<name> segment");

		// /api/ext/contributions + the panel endpoint key by packIdFromRoot(packRoot).
		assert.equal(packIdFromRoot(packRoot), PACK_NAME);
		assert.equal(ident.packId, packIdFromRoot(packRoot), "/api/tools packId === contributions/panel packId");

		// And the live contribution registry agrees for the same pack.
		const entry: PackEntry = { id: `market:server:${PACK_NAME}`, kind: "market", scope: "server", path: packRoot, readOnly: true, manifest: manifest(PACK_NAME), layout: "defaults-tree" };
		const reg = new PackContributionRegistry(() => [entry]);
		const pack = reg.getPack(undefined, ident.packId);
		assert.ok(pack, "contribution registry must resolve the pack by the tool's packId");
		assert.equal(pack!.packId, ident.packId);
		assert.deepEqual(pack!.panels.map((p) => p.id), ["artifacts.viewer"],
			"the pack-local panel is fetchable at /api/ext/packs/${packId}/panels/${panelId}");
	});

	it("a builtin (non-pack) tool yields an empty packId (absent on the wire)", () => {
		// A tool defined in the user-config dir (not under market-packs/) is not a pack.
		w(path.join(configDir, "tools", "Local", "local_tool.yaml"),
			"name: local_tool\ngroup: Local\ndescription: d\n");
		const tm = new ToolManager(configDir, builtinDir);
		const ident = resolvePackIdentityForTool(tm, "local_tool");
		assert.equal(ident.isPack, false);
		assert.equal(ident.packId, "", "non-pack tool exposes no structural packId");
	});
});
