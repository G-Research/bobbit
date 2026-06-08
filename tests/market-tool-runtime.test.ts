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

// ── finding #1: a market pack touching a SHARED builtin group must NOT drop
//    the rest of that group, and runtime must EQUAL the resolver's by-name set.
const { PackResolver, ToolLoader } = await import("../src/server/agent/pack-resolver.ts");
import type { PackEntry } from "../src/server/agent/pack-types.ts";

describe("market pack overlaying a shared builtin group (finding #1)", () => {
	// Builtin `shell` group with a provider-backed `bash` (must survive).
	const f = fs.mkdtempSync(path.join(TMP, "shared-group-"));
	const builtin = path.join(f, "builtin", "tools");
	tool(builtin, "shell", "bash", { desc: "builtin bash", provider: "provider:\n  type: builtin\n  tool: read\n" });
	tool(builtin, "shell", "ls", { desc: "builtin ls" });

	// Market pack ships ONE extra tool into the SAME `shell` group.
	const mkt = path.join(f, "market", "tools");
	tool(mkt, "shell", "extra", { desc: "market extra", provider: "provider:\n  type: bobbit-extension\n  extension: extension.ts\n" });
	w(path.join(mkt, "shell", "extension.ts"), "export const y = 2;\n");

	// Bare user config (no overrides).
	const cfg = path.join(f, "config");
	fs.mkdirSync(path.join(cfg, "tools"), { recursive: true });

	/** Resolve the same layers through the unified PackResolver (the /api/tools path). */
	function resolverNames(marketRoots: string[]): Set<string> {
		const entries: PackEntry[] = [
			{ id: "builtin", kind: "builtin", scope: "builtin", path: path.dirname(builtin), readOnly: true, layout: "defaults-tree" },
			...marketRoots.map((r, i): PackEntry => ({
				id: `market:${i}`, kind: "market", scope: "project", path: path.dirname(r), readOnly: true, layout: "defaults-tree",
			})),
			{ id: "user:project", kind: "user", scope: "project", path: cfg, readOnly: false, layout: "defaults-tree" },
		];
		return new Set(new PackResolver(entries, [new ToolLoader()]).resolve("tools").map((r) => r.name));
	}

	it("builtin bash + its provider survive; market extra resolves; no group drop", () => {
		__resetToolScanCache();
		const tm = new ToolManager(cfg, builtin);
		tm.setMarketToolRootsProvider(() => [mkt]);

		const bash = tm.getToolByName("bash");
		assert.ok(bash, "builtin bash must NOT be dropped by the market pack");
		assert.ok(tm.getToolProviders().has("bash"), "builtin bash provider must remain loaded");
		assert.equal(tm.getToolByName("ls")!.description, "builtin ls");

		const extra = tm.getToolByName("extra");
		assert.ok(extra, "market extra must resolve");
		assert.equal(tm.getToolProviders().get("extra")!.type, "bobbit-extension");
	});

	it("runtime tool set EQUALS the resolver/by-name set (no divergence)", () => {
		__resetToolScanCache();
		const tm = new ToolManager(cfg, builtin);
		tm.setMarketToolRootsProvider(() => [mkt]);
		const runtime = new Set(tm.getAllToolNames());
		assert.deepEqual([...runtime].sort(), [...resolverNames([mkt])].sort());
		assert.deepEqual([...runtime].sort(), ["bash", "extra", "ls"]);
	});

	it("market pack defining a BRAND-NEW group adds it and equals the resolver", () => {
		__resetToolScanCache();
		const newGrp = path.join(f, "market-new", "tools");
		tool(newGrp, "fresh", "fresh_tool", { desc: "brand new" });
		const tm = new ToolManager(cfg, builtin);
		tm.setMarketToolRootsProvider(() => [newGrp]);
		assert.ok(tm.getToolByName("fresh_tool"), "brand-new group tool resolves");
		assert.ok(tm.getToolByName("bash"), "builtin bash still present");
		assert.deepEqual(new Set(tm.getAllToolNames()), resolverNames([newGrp]));
	});
});

// ── Fix 2: rendererKind + resolveToolLocation must source the renderer from the
//    PARSED/validated contribution, NOT the raw YAML `renderer:` field. An unsafe
//    renderer path (e.g. `../evil.js`) is dropped by parseContributions, so it must
//    NOT be advertised as rendererKind:"pack" (which would make the client register
//    a pack renderer that only fails later at the GET endpoint). It must degrade to
//    rendererKind:"builtin" with no pack renderer path.
describe("renderer-path validation flows into rendererKind + resolveToolLocation (Fix 2)", () => {
	// A market-pack root whose path contains a real `market-packs` segment, so the
	// rendererKind helper treats a `.js` renderer as "pack".
	const pf = fs.mkdtempSync(path.join(TMP, "renderer-validation-"));
	const pack = path.join(pf, ".bobbit", "config", "market-packs", "demo", "tools");
	const cfg = path.join(pf, "config");
	fs.mkdirSync(path.join(cfg, "tools"), { recursive: true });

	// Safe renderer → must stay rendererKind:"pack" + resolveToolLocation returns it.
	w(path.join(pack, "demo", "safe_tool.yaml"),
		`name: safe_tool\ndescription: safe\ngroup: demo\nrenderer: SafeRenderer.js\n`);
	w(path.join(pack, "demo", "SafeRenderer.js"), "export default {};\n");
	// Unsafe renderer (path traversal) → parseContributions drops it; must degrade.
	w(path.join(pack, "demo", "evil_tool.yaml"),
		`name: evil_tool\ndescription: evil\ngroup: demo\nrenderer: ../evil.js\n`);

	function tm(): InstanceType<typeof ToolManager> {
		__resetToolScanCache();
		const m = new ToolManager(cfg, path.join(pf, "builtin", "tools"));
		m.setMarketToolRootsProvider(() => [pack]);
		return m;
	}

	it("a safe .js renderer still resolves as a pack renderer", () => {
		const m = tm();
		assert.equal(m.getToolByName("safe_tool")!.rendererKind, "pack");
		const loc = m.resolveToolLocation("safe_tool");
		assert.equal(loc!.rendererKind, "pack");
		assert.equal(loc!.rendererFile, "SafeRenderer.js");
	});

	it("an unsafe `../evil.js` renderer is NOT advertised as pack and resolveToolLocation returns no pack renderer", () => {
		const m = tm();
		// Dropped renderer ⇒ rendererKind must NOT be "pack".
		const byName = m.getToolByName("evil_tool")!;
		assert.notEqual(byName.rendererKind, "pack");
		assert.equal(byName.rendererKind, "builtin");
		// resolveToolLocation must NOT hand the renderer GET endpoint a pack path.
		const loc = m.resolveToolLocation("evil_tool");
		assert.notEqual(loc!.rendererKind, "pack");
		assert.equal(loc!.rendererFile, undefined);
	});
});
