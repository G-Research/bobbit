/**
 * Unit — the pack-addressed panel-serving endpoint source invariants
 * (pack-schema-v1 §6.3). After the schema rationalisation panels are pack-scoped
 * (panels/<file>.yaml), addressed by { packId, panelId }, and served by
 * `GET /api/ext/packs/:packId/panels/:panelId` — NOT the old tool-keyed
 * `/api/tools/:tool/panel/:panelId` (which is removed).
 *
 * The endpoint lives inside server.ts's large handler; this pins its security
 * shape at the source level (no full gateway spin-up):
 *   - it is BEARER-ONLY (no allowedTools / action-guard call), like the renderer;
 *   - it resolves the panel via the pack-contribution registry by { packId, panelId };
 *   - it re-validates the resolved path stays within the PACK ROOT
 *     (`isPackPathWithinRoot`, §2.2);
 *   - the OLD `/api/tools/:tool/panel/:panelId` route no longer exists.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const serverSrc = fs.readFileSync(path.resolve("src/server/server.ts"), "utf-8");

function extPanelBlock(): string {
	const start = serverSrc.indexOf("const extPanelMatch = url.pathname.match");
	assert.ok(start > 0, "pack-addressed panel endpoint must exist in server.ts");
	const end = serverSrc.indexOf("GET /api/ext/contributions", start);
	assert.ok(end > start, "the contributions endpoint must follow the panel endpoint");
	return serverSrc.slice(start, end);
}

function codeOnly(block: string): string {
	return block.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
}

describe("GET /api/ext/packs/:packId/panels/:panelId (pack-schema-v1 §6.3)", () => {
	it("the OLD tool-keyed panel route is removed", () => {
		assert.equal(serverSrc.includes("\\/api\\/tools\\/([^/]+)\\/panel\\/"), false, "old /api/tools/:tool/panel/:panelId must be gone");
	});

	it("matches the pack-addressed route and is GET", () => {
		const block = extPanelBlock();
		assert.ok(block.includes("\\/api\\/ext\\/packs\\/([^/]+)\\/panels\\/([^/]+)"), "must capture :packId + :panelId");
		assert.match(block, /req\.method === "GET"/);
	});

	it("is bearer-only — NO allowedTools / action-guard / scoped-guard call", () => {
		const block = codeOnly(extPanelBlock());
		assert.equal(/allowedTools/.test(block), false);
		assert.equal(/authorizeActionRequest/.test(block), false);
		assert.equal(/authorizeScopedRequest/.test(block), false);
	});

	it("resolves the panel via the pack-contribution registry and re-validates pack-root containment", () => {
		const block = extPanelBlock();
		assert.match(block, /packContributionRegistry\.getPanel\(/);
		assert.match(block, /isPackPathWithinRoot\(panel\.packRoot, fileAbs\)/);
		assert.match(block, /"Content-Type": "text\/javascript"/);
	});
});
