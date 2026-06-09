/**
 * Unit — Slice B4 panel contribution parsing + serving endpoint invariants
 * (design extension-host-phase2.md §6.2/§6.4).
 *
 * Covers:
 *   1. `parsePanels` — typed parse of the `panels:` contribution; path-traversal
 *      ('../evil.js') / absolute / Windows-drive / missing entries dropped with a
 *      warn (NEVER rejects the tool); invalid ids dropped; duplicate ids deduped;
 *      `title` optional.
 *   2. `resolveToolLocation` surfaces the typed `panels[]` (with the on-disk
 *      `entry`) for the winning provider, so the panel GET endpoint can resolve a
 *      panelId → module; an entry the parser dropped never reaches the endpoint.
 *   3. The GET /api/tools/:tool/panel/:panelId endpoint is BEARER-ONLY — its
 *      handler body carries NO allowedTools / action-guard call (exactly like the
 *      renderer endpoint) and re-validates the path with `path.relative`. Asserted
 *      at the source level (the endpoint lives inside server.ts's 13k-line
 *      handler; this pins the security shape without spinning a full gateway).
 *
 * file:// + temp-dir fixtures only.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { parsePanels } = await import("../src/server/agent/tool-contributions.ts");
const { ToolManager, __resetToolScanCache } = await import("../src/server/agent/tool-manager.ts");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pack-panels-endpoint-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

function w(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

describe("parsePanels (Slice B4 — typed, tolerant, path-traversal validated)", () => {
	it("keeps a valid { id, title, entry } and a title-less entry", () => {
		const out = parsePanels(
			[
				{ id: "artifacts.viewer", title: "Artifacts", entry: "viewer.js" },
				{ id: "bare", entry: "sub/dir/bare.js" },
			],
			"f.yaml",
		);
		assert.deepEqual(out, [
			{ id: "artifacts.viewer", title: "Artifacts", entry: "viewer.js" },
			{ id: "bare", entry: "sub/dir/bare.js" },
		]);
	});

	it("drops entries whose `entry` escapes the group dir (traversal / absolute / drive)", () => {
		const out = parsePanels(
			[
				{ id: "trav", entry: "../evil.js" },
				{ id: "abs", entry: "/etc/evil.js" },
				{ id: "drive", entry: "C:\\evil.js" },
				{ id: "winrel", entry: "..\\evil.js" },
				{ id: "ok", entry: "ok.js" },
			],
			"f.yaml",
		);
		assert.deepEqual(out.map((p) => p.id), ["ok"]);
	});

	it("drops entries with a missing/invalid entry or invalid id; dedupes duplicate ids; never throws on junk", () => {
		assert.deepEqual(parsePanels([{ id: "noentry" }], "f.yaml"), []);
		assert.deepEqual(parsePanels([{ id: "1 bad id", entry: "x.js" }], "f.yaml"), []);
		assert.deepEqual(parsePanels([{ entry: "x.js" }], "f.yaml"), []);
		assert.deepEqual(parsePanels("not-an-array", "f.yaml"), []);
		assert.deepEqual(parsePanels([42, null, { id: "dup", entry: "a.js" }, { id: "dup", entry: "b.js" }], "f.yaml").map((p) => p.entry), ["a.js"]);
	});
});

describe("resolveToolLocation surfaces typed panels for the winning provider (Fix B4)", () => {
	const pf = fs.mkdtempSync(path.join(TMP, "panel-resolve-"));
	const pack = path.join(pf, ".bobbit", "config", "market-packs", "demo", "tools");
	const cfg = path.join(pf, "config");
	fs.mkdirSync(path.join(cfg, "tools"), { recursive: true });

	// Tool with a safe panel entry + an unsafe one (dropped by parsePanels).
	w(path.join(pack, "demo", "panel_tool.yaml"),
		`name: panel_tool\ndescription: panels\ngroup: demo\npanels:\n  - id: viewer\n    title: Viewer\n    entry: Viewer.js\n  - id: evil\n    entry: ../evil.js\n`);
	w(path.join(pack, "demo", "Viewer.js"), "export default function(){ return { render(){} }; }\n");

	function tm(): InstanceType<typeof ToolManager> {
		__resetToolScanCache();
		const m = new ToolManager(cfg, path.join(pf, "builtin", "tools"));
		m.setMarketToolRootsProvider(() => [pack]);
		return m;
	}

	it("exposes the safe panel entry and drops the traversal one", () => {
		const loc = tm().resolveToolLocation("panel_tool");
		assert.ok(loc, "tool must resolve");
		const ids = (loc!.panels ?? []).map((p) => p.id);
		assert.deepEqual(ids, ["viewer"]);
		const viewer = loc!.panels!.find((p) => p.id === "viewer")!;
		assert.equal(viewer.entry, "Viewer.js");
		assert.equal(viewer.title, "Viewer");
		// The traversal entry must never reach the GET endpoint.
		assert.equal((loc!.panels ?? []).some((p) => p.id === "evil"), false);
	});

	it("surfaces panels on the wire ToolInfo (id + title only — no server-side entry)", () => {
		const info = tm().getToolByName("panel_tool");
		assert.ok(info, "tool info present");
		assert.deepEqual(info!.panels, [{ id: "viewer", title: "Viewer" }]);
	});
});

describe("GET /api/tools/:tool/panel/:panelId is bearer-only + path-traversal validated (source invariant)", () => {
	const serverSrc = fs.readFileSync(path.resolve("src/server/server.ts"), "utf-8");

	/** Extract the panel-endpoint handler block: from its route-match comment to
	 *  the start of the action endpoint (the block ends right before it). */
	function panelEndpointBlock(): string {
		const start = serverSrc.indexOf("const panelMatch = url.pathname.match");
		assert.ok(start > 0, "panel endpoint must exist in server.ts");
		const end = serverSrc.indexOf("const actionMatch = url.pathname.match", start);
		assert.ok(end > start, "action endpoint must follow the panel endpoint");
		return serverSrc.slice(start, end);
	}

	/** The endpoint block with `//` line-comments stripped — so guard-ABSENCE
	 *  assertions check executable code, not the explanatory comments (which
	 *  legitimately mention `allowedTools` to document WHY there is no check). */
	function panelEndpointCode(): string {
		return panelEndpointBlock()
			.split("\n")
			.map((line) => line.replace(/\/\/.*$/, ""))
			.join("\n");
	}

	it("the panel endpoint precedes the action endpoint and matches the documented route", () => {
		const block = panelEndpointBlock();
		// The route literal `\/panel\/` (panelId segment) appears in the match regex.
		assert.ok(block.includes("\\/panel\\/([^/]+)"), "panel route must capture :panelId");
		assert.match(block, /req\.method === "GET"/);
	});

	it("carries NO allowedTools / action-guard call — bearer-only like the renderer endpoint", () => {
		const block = panelEndpointCode();
		assert.equal(/allowedTools/.test(block), false, "panel endpoint must NOT gate on allowedTools");
		assert.equal(/authorizeActionRequest/.test(block), false, "panel endpoint must NOT run the action guard");
		assert.equal(/authorizeScopedRequest/.test(block), false, "panel endpoint must NOT run the scoped guard");
		assert.equal(/verifyToolUse/.test(block), false, "panel endpoint must NOT verify a tool-use ownership");
	});

	it("re-validates the resolved file path stays within the tool's group dir (anti-traversal)", () => {
		const block = panelEndpointBlock();
		assert.match(block, /resolveActionToolManager/);
		assert.match(block, /resolveToolLocation/);
		assert.match(block, /path\.relative\(groupAbs, fileAbs\)/);
		assert.match(block, /rel\.startsWith\("\.\."\)/);
		// Serves JS with no-cache, exactly like the renderer endpoint.
		assert.match(block, /"Content-Type": "text\/javascript"/);
	});
});
