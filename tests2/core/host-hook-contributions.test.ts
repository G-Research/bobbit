import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeHookContributions } from "../../src/server/extension-host/host-hook-contributions.ts";
import { loadHooks, type PackContributions } from "../../src/server/agent/pack-contributions.ts";
import type { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.ts";

function pack(packId: string, providers: any[] = [], hooks: any[] = []): PackContributions {
	return {
		packId,
		packName: packId,
		packRoot: `/packs/${packId}`,
		panels: [],
		entrypoints: [],
		providers,
		channels: [],
		hooks,
	};
}

function base(id: string, listName = id): any {
	return {
		id,
		listName,
		module: "../lib/hooks.mjs",
		sourceFile: `/packs/p/hooks/${listName}.yaml`,
		packRoot: "/packs/p",
		budget: { maxTokens: 1000, timeoutMs: 500 },
		capabilities: [],
	};
}

describe("explicit hook declarations", () => {
	it("parses explicit kinds against the canonical catalogues while retaining legacy rows as inert", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-hook-contrib-"));
		try {
			fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
			fs.mkdirSync(path.join(root, "lib"), { recursive: true });
			fs.writeFileSync(path.join(root, "lib", "hooks.mjs"), "export default {};\n");
			fs.writeFileSync(path.join(root, "hooks", "policy.yaml"), [
				"id: policy.tools", "module: ../lib/hooks.mjs", "kind: interceptor",
				"interceptors: [beforeToolCall, afterToolResult]", "failurePolicy: failClosed",
				"capabilities: [store]", "budget: { timeoutMs: 900 }",
			].join("\n"));
			fs.writeFileSync(path.join(root, "hooks", "audit.yaml"), [
				"id: audit.goals", "module: ../lib/hooks.mjs", "kind: notification",
				"notifications:", "  - { scope: project, name: goalUpdated }",
				"capabilities: []",
			].join("\n"));
			fs.writeFileSync(path.join(root, "hooks", "legacy.yaml"), [
				"id: old.metadata", "module: ../lib/hooks.mjs",
				"events: [beforePrompt]", "mode: observe", "capabilities: []",
			].join("\n"));
			const hooks = loadHooks(root, {
				name: "p", description: "", version: "1", schema: 2,
				contents: { roles: [], tools: [], skills: [], entrypoints: [], hooks: ["policy", "audit", "legacy"] },
			});
			expect(hooks).toMatchObject([
				{ id: "policy.tools", kind: "interceptor", interceptors: ["beforeToolCall", "afterToolResult"], failurePolicy: "failClosed" },
				{ id: "audit.goals", kind: "notification", notifications: [{ scope: "project", name: "goalUpdated" }] },
				{ id: "old.metadata", events: ["beforePrompt"], mode: "observe" },
			]);
			expect(hooks[2].kind).toBeUndefined();
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});

describe("normalizeHookContributions", () => {
	it("orders winning packs, providers, declarations, and declared names deterministically", () => {
		const provider = {
			...base("memory"),
			kind: "memory",
			hooks: ["beforePrompt", "afterTurn", "sessionSetup"],
		};
		const inert = { ...base("old"), events: ["beforePrompt"], mode: "observe" };
		const explicit = {
			...base("policy"),
			kind: "interceptor",
			interceptors: ["beforeToolCall", "afterToolResult"],
			failurePolicy: "failClosed",
		};
		const notification = {
			...base("observe"),
			kind: "notification",
			notifications: [{ scope: "project", name: "goalUpdated" }],
		};
		const packs = [pack("p", [provider], [inert, explicit, notification]), pack("q", [], [{
			...base("q-policy"),
			packRoot: "/packs/q",
			sourceFile: "/packs/q/hooks/q-policy.yaml",
			kind: "interceptor",
			interceptors: ["beforePrompt"],
		}])];
		const registry = {
			list: () => packs,
			listHooks: () => packs.flatMap((row) => row.hooks),
			listProviders: () => packs.flatMap((row) => row.providers),
			getActivationEpoch: () => 17,
		} as unknown as PackContributionRegistry;

		const rows = normalizeHookContributions(registry, "project-1");
		expect(rows.map((row) => row.kind === "notification"
			? `${row.packId}:notification:${row.selector.name}`
			: `${row.packId}:${row.kind}:${row.name}`)).toEqual([
			"p:legacy-provider:beforePrompt",
			"p:legacy-provider:sessionSetup",
			"p:interceptor:beforeToolCall",
			"p:interceptor:afterToolResult",
			"p:notification:goalUpdated",
			"q:interceptor:beforePrompt",
		]);
		expect(rows.every((row, index) => row.activationEpoch === 17 && row.order === index)).toBe(true);
		expect(rows.some((row) => row.contributionId === "old")).toBe(false);
	});

	it("returns an immutable row list without mutating declarations", () => {
		const declaration = {
			...base("policy"),
			kind: "interceptor",
			interceptors: ["beforePrompt"],
			config: { enabled: true },
		};
		const registry = {
			list: () => [pack("p", [], [declaration])],
			listHooks: () => [declaration],
			listProviders: () => [],
			getActivationEpoch: () => 2,
		} as unknown as PackContributionRegistry;
		const rows = normalizeHookContributions(registry, undefined);
		expect(Object.isFrozen(rows)).toBe(true);
		expect(rows[0]).toMatchObject({ packId: "p", contributionId: "policy", config: { enabled: true } });
		expect(declaration).not.toHaveProperty("packId");
	});
});
