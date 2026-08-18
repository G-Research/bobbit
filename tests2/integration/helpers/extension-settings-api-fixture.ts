import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../_e2e/in-process-harness.js";
import {
	apiFetch,
	base,
	connectWs,
	createSession,
	registerProject,
	type WsConnection,
} from "../_e2e/e2e-setup.js";
import { getPackStore } from "../../../src/server/extension-host/pack-store.js";
import { providerConfigStoreKey } from "../../../src/server/agent/pack-contributions.js";

export { apiFetch, base, connectWs, createSession, expect, test, type WsConnection };

function createExtensionSettingsFixture() {
	const PACK_ID = `hindsight-settings-fixture-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const PROVIDER_ID = "memory";
	const RECONCILIATION_HOOK_ID = "schema.reconciliation";
	const SECRET_A = "HINDSIGHT_API_KEY_MUST_NEVER_ESCAPE_A";
	const SECRET_B = "HINDSIGHT_API_KEY_MUST_NEVER_ESCAPE_B";

	let packDir = "";
	let operatorCookie = "";
	const projectRoots: string[] = [];

	function settingsPath(projectId: string): string {
		return `/api/projects/${encodeURIComponent(projectId)}/extension-settings`;
	}

	function targetPath(projectId: string): string {
		return `${settingsPath(projectId)}/${encodeURIComponent(PACK_ID)}/provider/${PROVIDER_ID}`;
	}

	function reconciliationHookPath(projectId: string): string {
		return `${settingsPath(projectId)}/${encodeURIComponent(PACK_ID)}/hook/${encodeURIComponent(RECONCILIATION_HOOK_ID)}`;
	}

	function grantsPath(projectId: string): string {
		return `/api/projects/${encodeURIComponent(projectId)}/extension-grants`;
	}

	function operatorHeaders(): Record<string, string> {
		return { Cookie: operatorCookie };
	}

	async function readJson(response: Response): Promise<any> {
		const text = await response.text();
		return text ? JSON.parse(text) : {};
	}

	function targetByRef(body: any, kind: "provider" | "hook", id: string): any {
		const result = body.targets?.find((candidate: any) =>
			candidate.ref?.packId === PACK_ID && candidate.ref?.kind === kind && candidate.ref?.id === id,
		);
		expect(result, `Hindsight fixture ${kind} ${id} must be visible in the settings catalogue`).toBeTruthy();
		return result;
	}

	function target(body: any): any {
		return targetByRef(body, "provider", PROVIDER_ID);
	}

	function runtimeProviders(gateway: any, projectId: string): any[] {
		const registry = gateway.sessionManager.lifecycleHub?.registry;
		expect(registry, "gateway lifecycle hub exposes the live project resolver").toBeTruthy();
		return registry.listProviders(projectId)
			.filter((provider: any) => provider.packRoot?.endsWith(PACK_ID));
	}

	function runtimeProviderIds(gateway: any, projectId: string): string[] {
		return runtimeProviders(gateway, projectId).map((provider: any) => provider.id);
	}

	function runtimeHookIds(gateway: any, projectId: string): string[] {
		const registry = gateway.sessionManager.lifecycleHub?.registry;
		expect(registry, "gateway lifecycle hub exposes the live project resolver").toBeTruthy();
		return registry.listHooks(projectId)
			.filter((hook: any) => hook.packRoot?.endsWith(PACK_ID))
			.map((hook: any) => hook.id);
	}

	/** Direct legacy-store writes bypass the production route's resolver invalidation. */
	async function putLegacyProviderConfig(gateway: any, values: Record<string, unknown>): Promise<void> {
		await getPackStore().put(PACK_ID, providerConfigStoreKey(PROVIDER_ID), values);
		gateway.sessionManager.lifecycleHub?.registry.invalidate();
	}

	function writeFixturePack(headquartersDir: string): void {
		packDir = path.join(headquartersDir, "config", "market-packs", PACK_ID);
		fs.mkdirSync(path.join(packDir, "providers"), { recursive: true });
		fs.mkdirSync(path.join(packDir, "hooks"), { recursive: true });
		fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });
		fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
			"sourceUrl: test",
			"sourceRef: local",
			"commit: fixture",
			`packName: ${PACK_ID}`,
			"version: 1.0.0",
			"installedAt: '2026-01-01T00:00:00.000Z'",
			"updatedAt: '2026-01-01T00:00:00.000Z'",
			"scope: server",
		].join("\n") + "\n", "utf8");
		fs.writeFileSync(path.join(packDir, "pack.yaml"), [
			"schema: 2",
			`name: ${PACK_ID}`,
			"description: Hindsight extension-settings integration fixture",
			"version: 1.0.0",
			"contents:",
			"  roles: []",
			"  tools: []",
			"  skills: []",
			"  entrypoints: []",
			"  providers: [memory, activation-only, no-config, opaque-config]",
			"  hooks: [activation-only, no-config, opaque-config, reconciliation]",
			"  mcp: []",
			"  pi-extensions: []",
			"  runtimes: []",
			"  workflows: []",
		].join("\n") + "\n", "utf8");
		fs.writeFileSync(path.join(packDir, "providers", "memory.yaml"), [
			"id: memory",
			"kind: memory",
			"module: ../lib/provider.mjs",
			"hooks: [beforePrompt]",
			"config:",
			"  externalUrl: { type: string, optional: true }",
			"  apiKey: { type: secret, optional: true }",
			"  recallScope: { type: enum, values: [project, all], default: all }",
			"  languages: { type: multi-enum, values: [typescript, javascript, python], default: [typescript] }",
			"  optionalLanguages: { type: multi-enum, values: [typescript, javascript, python], optional: true }",
			"  autoRecall: { type: boolean, default: true }",
			"  recallBudget: { type: number, min: 1, max: 4096, default: 1200 }",
			"  requiredName: { type: string }",
			"activation:",
			"  requiresConfig: [externalUrl]",
		].join("\n") + "\n", "utf8");
		fs.writeFileSync(path.join(packDir, "providers", "activation-only.yaml"), [
			"id: activation-only",
			"kind: generic",
			"module: ../lib/provider.mjs",
			"hooks: [beforePrompt]",
			"activation:",
			"  requiresConfig: [externalUrl]",
		].join("\n") + "\n", "utf8");
		fs.writeFileSync(path.join(packDir, "hooks", "activation-only.yaml"), [
			"id: activation-only",
			"module: ../lib/hook.mjs",
			"events: [beforePrompt]",
			"mode: observe",
			"capabilities: []",
			"activation:",
			"  requiresConfig: [externalUrl]",
		].join("\n") + "\n", "utf8");
		writeReconciliationHookV1();
		for (const kind of ["providers", "hooks"] as const) {
			const module = kind === "providers" ? "../lib/provider.mjs" : "../lib/hook.mjs";
			const base = kind === "providers"
				? ["kind: generic", `module: ${module}`, "hooks: [beforePrompt]"]
				: [`module: ${module}`, "events: [beforePrompt]", "mode: observe", "capabilities: []"];
			fs.writeFileSync(path.join(packDir, kind, "no-config.yaml"), ["id: no-config", ...base].join("\n") + "\n", "utf8");
			fs.writeFileSync(path.join(packDir, kind, "opaque-config.yaml"), ["id: opaque-config", ...base, "config:", "  endpoint: https://legacy.example.test", "  retry: 3"].join("\n") + "\n", "utf8");
		}
		fs.writeFileSync(path.join(packDir, "lib", "provider.mjs"), "export default {};\n", "utf8");
		fs.writeFileSync(path.join(packDir, "lib", "hook.mjs"), "export default {};\n", "utf8");
	}

	function writeReconciliationHookV1(): void {
		fs.writeFileSync(path.join(packDir, "hooks", "reconciliation.yaml"), [
			`id: ${RECONCILIATION_HOOK_ID}`,
			"module: ../lib/hook.mjs",
			"events: [sessionSetup, beforePrompt]",
			"mode: decide",
			"capabilities: [mutate]",
			"selectors: [skills, mcp]",
			"config:",
			"  endpoint: { type: string, optional: true }",
			"  legacyEnum: { type: enum, values: [legacy, strict], default: legacy }",
			"  legacyText: { type: string, optional: true }",
			"  legacyNumber: { type: number, min: 1, max: 10, default: 4 }",
			"  removedValue: { type: string, optional: true }",
			"  apiKey: { type: secret, optional: true }",
			"activation:",
			"  requiresConfig: [endpoint]",
		].join("\n") + "\n", "utf8");
	}

	function writeReconciliationHookV2(): void {
		fs.writeFileSync(path.join(packDir, "hooks", "reconciliation.yaml"), [
			`id: ${RECONCILIATION_HOOK_ID}`,
			"module: ../lib/hook.mjs",
			"events: [sessionSetup, beforePrompt]",
			"mode: decide",
			"capabilities: [mutate]",
			"selectors: [skills, mcp]",
			"config:",
			"  endpoint: { type: string, optional: true }",
			"  legacyEnum: { type: enum, values: [strict], default: strict }",
			"  legacyText: { type: boolean, optional: true }",
			"  legacyNumber: { type: number, min: 5, max: 8, default: 6 }",
			"  optionalAdded: { type: string, optional: true }",
			"  defaultAdded: { type: string, default: evolved-default }",
			"  apiKey: { type: secret, optional: true }",
			"activation:",
			"  requiresConfig: [endpoint]",
		].join("\n") + "\n", "utf8");
	}

	async function createProject(gateway: any, suffix: string): Promise<{ id: string; rootPath: string }> {
		const rootPath = path.join(gateway.bobbitDir, "extension-settings-projects", `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(rootPath, { recursive: true });
		projectRoots.push(rootPath);
		return registerProject({ name: `extension-settings-${suffix}-${Date.now()}`, rootPath, seedWorkflows: false });
	}

	async function mintOperatorCookie(): Promise<string> {
		const probe = await apiFetch("/api/goals", {
			headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
		});
		const cookies = (probe.headers as any).getSetCookie?.() as string[] | undefined
			?? (probe.headers.get("set-cookie") ? [probe.headers.get("set-cookie") as string] : []);
		const cookie = cookies.map(value => value.split(";")[0]).find(value => value.startsWith("bobbit_session="));
		expect(cookie, "browser-signaled gateway requests mint the verified operator cookie").toBeTruthy();
		return cookie!;
	}

	async function settings(projectId: string): Promise<any> {
		const response = await apiFetch(settingsPath(projectId));
		expect(response.status).toBe(200);
		return readJson(response);
	}

	async function patchTarget(projectId: string, expectedRevision: number, values: Record<string, unknown>, enabled?: boolean): Promise<Response> {
		return apiFetch(targetPath(projectId), {
			method: "PATCH",
			headers: operatorHeaders(),
			body: JSON.stringify({ expectedRevision, values, ...(enabled === undefined ? {} : { enabled }) }),
		});
	}

	async function install(gateway: any): Promise<void> {
		writeFixturePack(gateway.bobbitDir);
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		});
		expect(activation.status, `fixture pack activation refresh failed: ${await activation.clone().text()}`).toBe(200);
		operatorCookie = await mintOperatorCookie();
	}

	async function dispose(): Promise<void> {
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		}).catch(() => {});
		await getPackStore().delete(PACK_ID, providerConfigStoreKey(PROVIDER_ID)).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
		for (const root of projectRoots) fs.rmSync(root, { recursive: true, force: true });
	}

	return {
		PACK_ID,
		PROVIDER_ID,
		RECONCILIATION_HOOK_ID,
		SECRET_A,
		SECRET_B,
		settingsPath,
		targetPath,
		reconciliationHookPath,
		grantsPath,
		operatorHeaders,
		readJson,
		targetByRef,
		target,
		runtimeProviders,
		runtimeProviderIds,
		runtimeHookIds,
		putLegacyProviderConfig,
		writeReconciliationHookV2,
		createProject,
		settings,
		patchTarget,
		install,
		dispose,
	};
}

type ExtensionSettingsFixture = ReturnType<typeof createExtensionSettingsFixture>;

/**
 * Isolated fixture per file: a unique temporary pack avoids cross-fork state,
 * while the shared setup keeps the split API suites behaviorally identical.
 */
export function describeExtensionSettingsApi(
	name: string,
	define: (fixture: ExtensionSettingsFixture) => void,
): void {
	const fixture = createExtensionSettingsFixture();
	test.describe(name, () => {
		test.beforeAll(async ({ gateway }) => fixture.install(gateway));
		test.afterAll(async () => fixture.dispose());
		define(fixture);
	});
}
