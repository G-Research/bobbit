// v2-native — checkout grant provenance regression. Listed in tests-map.json `v2Native`.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../../src/server/agent/project-registry.js";
import type { ExtensionGrant } from "../../src/server/agent/project-config-store.js";

const cleanup: string[] = [];

afterEach(() => {
	for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): { registry: ProjectRegistry; projectId: string; stateDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-grant-provenance-"));
	cleanup.push(root);
	const projectRoot = path.join(root, "checkout");
	const stateDir = path.join(root, "gateway-state");
	fs.mkdirSync(projectRoot, { recursive: true });
	const registry = new ProjectRegistry(stateDir);
	const project = registry.register("checkout", projectRoot);
	return { registry, projectId: project.id, stateDir };
}

function grant(at = "2026-01-01T00:00:00.000Z"): ExtensionGrant {
	return {
		packId: "malicious-pack",
		hookId: "import.decide",
		capability: "decide",
		grantedAt: at,
		grantedBy: "admin",
	};
}

describe("extension grant provenance", () => {
	it("fails closed for checkout grants until an exact durable operator binding exists", () => {
		const { registry, projectId } = fixture();
		const imported = grant();

		expect(registry.authorizedExtensionGrants(projectId, [imported])).toEqual([]);

		registry.bindExtensionGrant(projectId, imported);
		expect(registry.authorizedExtensionGrants(projectId, [imported])).toEqual([imported]);

		// A checkout can edit project.yaml but cannot update the gateway registry.
		const stale = grant("2026-01-02T00:00:00.000Z");
		expect(registry.authorizedExtensionGrants(projectId, [stale])).toEqual([]);

		// Revocation names authority, not attacker-controlled metadata: restoring
		// the old config row cannot launder the old binding back into effect.
		registry.revokeExtensionGrantBinding(projectId, stale);
		expect(registry.authorizedExtensionGrants(projectId, [imported])).toEqual([]);
	});

	it("persists an exact binding per registered project without lending it to another project", () => {
		const { registry, projectId, stateDir } = fixture();
		const imported = grant();
		registry.bindExtensionGrant(projectId, imported);

		const reloaded = new ProjectRegistry(stateDir);
		expect(reloaded.authorizedExtensionGrants(projectId, [imported])).toEqual([imported]);

		const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-grant-provenance-other-"));
		cleanup.push(secondRoot);
		const second = reloaded.register("other", secondRoot);
		expect(reloaded.authorizedExtensionGrants(second.id, [imported])).toEqual([]);
	});
});
