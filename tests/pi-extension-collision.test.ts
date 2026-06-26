import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ToolManager, type PiExtensionExternalTool, type ScopedToolContext } from "../src/server/agent/tool-manager.ts";

function makeDirs(): { root: string; configDir: string; builtinDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-collision-"));
	const configDir = path.join(root, "config");
	const builtinDir = path.join(root, "builtin-tools");
	fs.mkdirSync(path.join(configDir, "tools"), { recursive: true });
	fs.mkdirSync(path.join(builtinDir, "core"), { recursive: true });
	fs.writeFileSync(path.join(builtinDir, "core", "shared.yaml"), [
		"name: shared_tool",
		"description: Builtin shared tool",
		"group: Core",
		"provider:",
		"  type: builtin",
		"  tool: read",
		"",
	].join("\n"));
	return { root, configDir, builtinDir };
}

function piTool(name: string, packName: string, packId: string, listName: string): PiExtensionExternalTool {
	return {
		name,
		description: `${packName} ${name}`,
		packName,
		packId,
		listName,
		scope: "project",
		sourcePath: `/packs/${packId}/pi-extensions/${listName}/extension.ts`,
	};
}

const ctx: ScopedToolContext = { scopeKey: "project:demo", projectId: "demo" };

describe("scoped pi-extension tool collisions", () => {
	it("collapses duplicate pi runtime names into one visible row with provider provenance", () => {
		const { root, configDir, builtinDir } = makeDirs();
		try {
			const tm = new ToolManager(configDir, builtinDir);
			tm.setScopedPiExtensionTools(ctx, [
				piTool("collide", "Pack One", "pack-one", "one"),
				piTool("collide", "Pack Two", "pack-two", "two"),
			]);

			const rows = tm.getAvailableTools(ctx).filter((tool) => tool.name === "collide");
			assert.equal(rows.length, 1);
			assert.equal(rows[0].origin, "marketplace-pi-extension");
			assert.equal(rows[0].providerType, "pi-extension");
			assert.deepEqual(rows[0].providers?.map((provider) => provider.packName), ["Pack One", "Pack Two"]);
			assert.deepEqual(rows[0].providers?.map((provider) => provider.providerKey), [
				"pi-ext:project:demo:pack-one:one:collide",
				"pi-ext:project:demo:pack-two:two:collide",
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the winning built-in row when a pi tool collides but attaches pi provenance", () => {
		const { root, configDir, builtinDir } = makeDirs();
		try {
			const tm = new ToolManager(configDir, builtinDir);
			tm.setScopedPiExtensionTools(ctx, [piTool("shared_tool", "Pi Pack", "pi-pack", "shared")]);

			const row = tm.getToolByName("shared_tool", ctx);
			assert.ok(row);
			assert.equal(row!.description, "Builtin shared tool");
			assert.equal(row!.origin, undefined);
			assert.equal(row!.providers?.length, 1);
			assert.equal(row!.providers?.[0]?.packName, "Pi Pack");

			const provider = tm.getToolProviders(ctx).get("shared_tool");
			assert.equal(provider?.type, "builtin", "colliding built-in provider must remain activatable");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
