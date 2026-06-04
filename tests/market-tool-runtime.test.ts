/**
 * Unit — market-pack tools at runtime (finding #1).
 *
 * A tool shipped by an installed market pack must be visible to the runtime
 * tool machinery (ToolManager), not just to the cascade listing:
 *   (a) returned by getToolByName / included in getAvailableTools / getAllToolNames,
 *   (b) carried in getToolProviders with the market pack's tools/ dir as baseDir
 *       (so its extension.ts loads in a session),
 *   (c) documented by getToolDocsForPrompt,
 *   (d) resolved with correct precedence: builtin < market(low→high) < user overlay.
 *
 * With NO market roots provider the result is byte-identical to the legacy
 * two-layer (builtin → user overlay) cascade — pinned below.
 *
 * file:// fixtures only.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ToolManager, __resetToolScanCache } = await import("../src/server/agent/tool-manager.ts");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "market-tool-runtime-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

function w(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

/** Write a tool YAML under `<root>/<group>/<name>.yaml`. */
function tool(root: string, group: string, name: string, opts: { desc?: string; provider?: string } = {}): void {
	const provider = opts.provider ?? "";
	w(path.join(root, group, `${name}.yaml`),
		`name: ${name}\ndescription: ${opts.desc ?? name}\ngroup: ${group}\n${provider}`);
}

// ── Fixture layers ───────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(TMP, "layers-"));

// Builtin layer (lowest).
const builtinToolsDir = path.join(dir, "builtin", "tools");
tool(builtinToolsDir, "g_builtin", "only_builtin", { provider: "provider:\n  type: builtin\n  tool: read\n" });
tool(builtinToolsDir, "g_shared", "shared", { desc: "from builtin" });

// Market pack A (low market).
const marketA = path.join(dir, "market-a", "tools");
tool(marketA, "g_shared", "shared", { desc: "from market-a" });
tool(marketA, "kitgroup", "kit_tool", { desc: "kit market tool", provider: "provider:\n  type: bobbit-extension\n  extension: extension.ts\n" });
w(path.join(marketA, "kitgroup", "extension.ts"), "export const x = 1;\n");

// Market pack B (high market).
const marketB = path.join(dir, "market-b", "tools");
tool(marketB, "g_shared", "shared", { desc: "from market-b" });

// User overlay config dir WITH a g_shared override (highest).
const userConfig = path.join(dir, "user-config");
tool(path.join(userConfig, "tools"), "g_shared", "shared", { desc: "from user" });

// User overlay config dir WITHOUT a g_shared override (to test market>builtin).
const bareConfig = path.join(dir, "bare-config");
fs.mkdirSync(path.join(bareConfig, "tools"), { recursive: true });

describe("market-pack tools at runtime (finding #1)", () => {
	it("with NO market provider: market tools are invisible (byte-identical legacy)", () => {
		__resetToolScanCache();
		const tm = new ToolManager(userConfig, builtinToolsDir);
		assert.equal(tm.getToolByName("kit_tool"), undefined);
		assert.equal(tm.getToolProviders().has("kit_tool"), false);
		assert.ok(!tm.getAllToolNames().includes("kit_tool"));
		// shared resolves to the user overlay (builtin < user), unchanged.
		assert.equal(tm.getToolByName("shared")!.description, "from user");
	});

	it("with a market provider: market tool is listed, provider-backed, documented", () => {
		__resetToolScanCache();
		const tm = new ToolManager(userConfig, builtinToolsDir);
		tm.setMarketToolRootsProvider(() => [marketA, marketB]);

		// (a) by name + in the available list + name list.
		const byName = tm.getToolByName("kit_tool");
		assert.ok(byName, "getToolByName must return the market tool");
		assert.equal(byName!.description, "kit market tool");
		assert.ok(tm.getAvailableTools().some((t) => t.name === "kit_tool"));
		assert.ok(tm.getAllToolNames().includes("kit_tool"));

		// (b) provider carries the market pack's tools/ dir as baseDir so the
		//     extension.ts resolves to <market-a>/kitgroup/extension.ts.
		const prov = tm.getToolProviders().get("kit_tool");
		assert.ok(prov, "getToolProviders must include the market tool");
		assert.equal(prov!.type, "bobbit-extension");
		assert.equal(prov!.extension, "extension.ts");
		assert.equal(prov!.groupDir, "kitgroup");
		assert.equal(path.resolve(prov!.baseDir), path.resolve(marketA));
		assert.ok(fs.existsSync(path.join(prov!.baseDir, prov!.groupDir, prov!.extension!)));

		// (c) documented in the prompt.
		assert.ok(tm.getToolDocsForPrompt().includes("kit_tool"));
	});

	it("precedence: user overlay > market > builtin (highest market wins among markets)", () => {
		__resetToolScanCache();
		// User overlay defines g_shared ⇒ user wins over everything.
		const withUser = new ToolManager(userConfig, builtinToolsDir);
		withUser.setMarketToolRootsProvider(() => [marketA, marketB]);
		assert.equal(withUser.getToolByName("shared")!.description, "from user");

		// No user override ⇒ market-b (highest market layer) wins over market-a + builtin.
		__resetToolScanCache();
		const noUser = new ToolManager(bareConfig, builtinToolsDir);
		noUser.setMarketToolRootsProvider(() => [marketA, marketB]);
		assert.equal(noUser.getToolByName("shared")!.description, "from market-b");

		// Only market-a ⇒ market-a wins over builtin.
		__resetToolScanCache();
		const onlyA = new ToolManager(bareConfig, builtinToolsDir);
		onlyA.setMarketToolRootsProvider(() => [marketA]);
		assert.equal(onlyA.getToolByName("shared")!.description, "from market-a");

		// No markets ⇒ builtin (lowest) is the only source of g_shared.
		__resetToolScanCache();
		const none = new ToolManager(bareConfig, builtinToolsDir);
		assert.equal(none.getToolByName("shared")!.description, "from builtin");
	});

	it("a throwing market provider degrades to no market roots (never crashes)", () => {
		__resetToolScanCache();
		const tm = new ToolManager(bareConfig, builtinToolsDir);
		tm.setMarketToolRootsProvider(() => { throw new Error("boom"); });
		assert.equal(tm.getToolByName("kit_tool"), undefined);
		assert.equal(tm.getToolByName("shared")!.description, "from builtin");
	});
});
