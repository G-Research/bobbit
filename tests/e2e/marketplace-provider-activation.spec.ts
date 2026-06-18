/**
 * API E2E — schema-v2 provider activation round-trip.
 *
 * Pure REST coverage for the additive pack-activation shape: provider refs and
 * the new schema-v2 catalogue arrays persist through GET/PUT without any
 * provider runtime dispatch.
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
						hooks: ["turn-hook"],
						mcp: ["local-mcp"],
						piExtensions: ["pi-card"],
						runtimes: ["node"],
						workflows: ["review-flow"],
					},
				}),
			});
			expect(put.status).toBe(200);
			const putBody = await put.json();
			expect(putBody.catalogue.providers).toEqual(["memory"]);
			expect(putBody.catalogue.hooks).toEqual(["turn-hook"]);
			expect(putBody.catalogue.mcp).toEqual(["local-mcp"]);
			expect(putBody.catalogue.piExtensions).toEqual(["pi-card"]);
			expect(putBody.catalogue.runtimes).toEqual(["node"]);
			expect(putBody.catalogue.workflows).toEqual(["review-flow"]);
			expect(putBody.disabled.providers).toEqual(["memory"]);

			const get = await apiFetch(`/api/marketplace/pack-activation?scope=server&packName=${encodeURIComponent(packName)}`);
			expect(get.status).toBe(200);
			const getBody = await get.json();
			expect(getBody.disabled.providers).toEqual(["memory"]);
			expect(getBody.catalogue).toMatchObject({
				providers: ["memory"],
				hooks: ["turn-hook"],
				mcp: ["local-mcp"],
				piExtensions: ["pi-card"],
				runtimes: ["node"],
				workflows: ["review-flow"],
			});
		} finally {
			await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({ scope: "server", packName, disabled: {} }),
			}).catch(() => {});
			fs.rmSync(packDir, { recursive: true, force: true });
		}
	});
});
