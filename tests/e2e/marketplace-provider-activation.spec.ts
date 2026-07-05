/**
 * API E2E — schema-v2 provider activation round-trip.
 *
 * Pure REST coverage for the additive pack-activation shape: provider refs and
 * the new schema-v2 catalogue arrays persist through GET/PUT without any
 * provider runtime dispatch.
 *
 * Also pins finding EXT-03 (contents.hooks/contents.workflows had no loader and
 * were phantom activation toggles): a pack MAY still declare `contents.hooks`
 * and `contents.workflows` (non-fatal, the manifest still loads with a warning),
 * but NEITHER key is ever surfaced in the pack-activation catalogue or
 * accepted/echoed as a disabled-refs kind — see
 * src/server/agent/pack-manifest.ts / docs/marketplace.md.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import fs from "node:fs";
import path from "node:path";

function writeMeta(packDir: string, packName: string): void {
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: e2e",
		"sourceRef: local",
		"commit: test",
		`packName: ${packName}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n", "utf-8");
}

function writePack(root: string, packName: string): string {
	const packDir = path.join(root, ".bobbit", "config", "market-packs", packName);
	fs.mkdirSync(path.join(packDir, "providers"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 2",
		`name: ${packName}`,
		"description: Provider activation e2e",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		"  providers: [memory]",
		"  hooks: [turn-hook]",
		"  mcp: [local-mcp]",
		"  pi-extensions: [pi-card]",
		"  runtimes: [node]",
		"  workflows: [review-flow]",
	].join("\n") + "\n", "utf-8");
	writeMeta(packDir, packName);
	fs.writeFileSync(path.join(packDir, "providers", "memory.yaml"), "id: memory\nmodule: ../lib/provider.js\nhooks: [beforePrompt]\n", "utf-8");
	fs.writeFileSync(path.join(packDir, "lib", "provider.js"), "export default {};\n", "utf-8");
	return packDir;
}

function piExtensionRefs(rows: any[]): string[] {
	return rows.map((row) => typeof row === "string" ? row : String(row?.ref ?? row?.listName ?? "")).filter(Boolean);
}

function writeSchema1Pack(root: string, packName: string): string {
	const packDir = path.join(root, ".bobbit", "config", "market-packs", packName);
	fs.mkdirSync(path.join(packDir, "providers"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		`name: ${packName}`,
		"description: Schema 1 activation e2e",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		"  providers: [memory]",
		"  hooks: [turn-hook]",
		"  pi-extensions: [pi-card]",
		"  runtimes: [node]",
		"  workflows: [review-flow]",
	].join("\n") + "\n", "utf-8");
	writeMeta(packDir, packName);
	fs.writeFileSync(path.join(packDir, "providers", "memory.yaml"), "id: memory\nmodule: ../lib/provider.js\nhooks: [beforePrompt]\n", "utf-8");
	fs.writeFileSync(path.join(packDir, "lib", "provider.js"), "export default {};\n", "utf-8");
	return packDir;
}

test.describe("marketplace pack activation — providers", () => {
	test("schema-1 catalogue omits schema-v2 arrays", async ({ gateway }) => {
		const packName = `provider-activation-v1-${Date.now()}`;
		const packDir = writeSchema1Pack(gateway.bobbitDir, packName);
		try {
			const get = await apiFetch(`/api/marketplace/pack-activation?scope=server&packName=${encodeURIComponent(packName)}`);
			expect(get.status).toBe(200);
			const getBody = await get.json();
			expect(Object.keys(getBody.catalogue).sort()).toEqual(["descriptions", "entrypoints", "roles", "skills", "tools"]);
			for (const key of ["providers", "hooks", "mcp", "piExtensions", "runtimes", "workflows"]) {
				expect(key in getBody.catalogue, `${key} must be absent for schema-1 packs`).toBe(false);
			}
		} finally {
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});

	test("PUT/GET round-trips disabled.providers and exposes schema-v2 catalogue arrays", async ({ gateway }) => {
		const packName = `provider-activation-${Date.now()}`;
		const packDir = writePack(gateway.bobbitDir, packName);
		try {
			const put = await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({
					scope: "server",
					packName,
					disabled: {
						providers: ["memory", "not-declared"],
						mcp: ["local-mcp"],
						piExtensions: ["pi-card"],
						runtimes: ["node"],
						// hooks/workflows are sent anyway (finding EXT-03) to prove a PUT body
						// carrying them is silently ignored, never persisted/echoed.
						hooks: ["turn-hook"],
						workflows: ["review-flow"],
					},
				}),
			});
			expect(put.status).toBe(200);
			const putBody = await put.json();
			expect(putBody.catalogue.providers).toEqual(["memory"]);
			expect(putBody.catalogue.mcp).toEqual(["local-mcp"]);
			expect(piExtensionRefs(putBody.catalogue.piExtensions)).toEqual(["pi-card"]);
			expect(putBody.catalogue.runtimes).toEqual(["node"]);
			expect(putBody.disabled.providers).toEqual(["memory"]);
			// EXT-03: neither key is activation-toggleable — never echoed, even though
			// the pack declares them and the PUT body tried to set them.
			expect("hooks" in putBody.catalogue).toBe(false);
			expect("workflows" in putBody.catalogue).toBe(false);
			expect("hooks" in putBody.disabled).toBe(false);
			expect("workflows" in putBody.disabled).toBe(false);

			const get = await apiFetch(`/api/marketplace/pack-activation?scope=server&packName=${encodeURIComponent(packName)}`);
			expect(get.status).toBe(200);
			const getBody = await get.json();
			expect(getBody.disabled.providers).toEqual(["memory"]);
			expect(getBody.catalogue).toMatchObject({
				providers: ["memory"],
				mcp: ["local-mcp"],
				runtimes: ["node"],
			});
			expect(piExtensionRefs(getBody.catalogue.piExtensions)).toEqual(["pi-card"]);
			expect("hooks" in getBody.catalogue).toBe(false);
			expect("workflows" in getBody.catalogue).toBe(false);
		} finally {
			await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({ scope: "server", packName, disabled: {} }),
			}).catch(() => {});
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});
});
