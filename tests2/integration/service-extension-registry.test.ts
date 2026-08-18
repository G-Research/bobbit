import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { PackEntry, PackManifest } from "../../src/server/agent/pack-types.ts";
import { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.ts";
import { ServiceExtensionRegistry } from "../../src/server/extension-host/service-extension-registry.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function install(
	scope: "server" | "project",
	name: string,
	id = "service",
	options: { config?: readonly string[]; activation?: readonly string[] } = {},
): PackEntry {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-extension-registry-"));
	roots.push(root);
	const packRoot = path.join(root, "market-packs", name);
	fs.mkdirSync(path.join(packRoot, "runtimes"), { recursive: true });
	fs.writeFileSync(path.join(packRoot, "runtimes", "managed.yaml"), [
		`id: ${id}`,
		"service:",
		"  runMode: local",
		"  readiness: { url: http://127.0.0.1:8080/health, timeoutMs: 100 }",
		"  stopGraceMs: 100",
		"  restart: never",
		...(options.config ?? ["config:", "  apiKey: { type: secret, optional: true }"]),
		...(options.activation ?? []),
	].join("\n"), "utf8");
	const manifest: PackManifest = {
		schema: 2, name, description: "fixture", version: "1",
		contents: { roles: [], tools: [], skills: [], entrypoints: [], providers: [], channels: [], hooks: [], mcp: [], piExtensions: [], runtimes: ["managed"], workflows: [], systemPrompts: [] },
	};
	return { id: `market:${scope}:${name}`, kind: "market", scope, path: packRoot, readOnly: true, manifest, layout: "defaults-tree" };
}

describe("service extension registry", () => {
	it("uses only the winning enabled pack declaration and never projects runtime secrets", () => {
		const low = install("server", "same-pack", "low-service");
		const high = install("project", "same-pack", "high-service");
		const registry = new PackContributionRegistry(
			() => [low, high], undefined, undefined, undefined, undefined, undefined, undefined,
			(projectId, packId, kind) => kind === "runtime" && projectId === "p" && packId === "same-pack"
				? { state: "present", enabled: true, values: { apiKey: "MUST_NEVER_APPEAR" } }
				: { state: "absent" },
		);
		const services = new ServiceExtensionRegistry(registry).list("p");
		assert.equal(services.length, 1);
		assert.equal(services[0]?.packId, "same-pack");
		assert.equal(services[0]?.spec.id, "high-service");
		assert.equal(JSON.stringify(services).includes("MUST_NEVER_APPEAR"), false);
	});

	it("fails closed for disabled and unreadable runtime settings", () => {
		const entry = install("server", "isolated-pack");
		const unavailable = new PackContributionRegistry(
			() => [entry], undefined, undefined, undefined, undefined, undefined, undefined,
			() => ({ state: "error", diagnostic: { code: "SETTINGS_READ_UNAVAILABLE", retryable: false } }),
		);
		assert.deepEqual(new ServiceExtensionRegistry(unavailable).list("p"), []);
		const disabled = new PackContributionRegistry(
			() => [entry], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
			() => ["managed"],
		);
		assert.deepEqual(new ServiceExtensionRegistry(disabled).list("p"), []);
	});

	it("requires a non-empty multi-enum runtime activation value while retaining scalar values", () => {
		const entry = install("server", "multi-enum-runtime", "multi-enum", {
			config: ["config:", "  languages: { type: enum, values: [typescript, javascript], optional: true }"],
			activation: ["activation:", "  requiresConfig: [languages]"],
		});
		const withValues = (languages: unknown) => new ServiceExtensionRegistry(new PackContributionRegistry(
			() => [entry], undefined, undefined, undefined, undefined, undefined, undefined,
			() => ({ state: "present", enabled: true, values: { languages } }),
		)).list("p");

		assert.deepEqual(withValues([]), []);
		assert.equal(withValues(["typescript"]).length, 1);
		assert.equal(withValues("typescript").length, 1);
	});
});
