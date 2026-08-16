import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	base,
	connectWs,
	createSession,
	registerProject,
	type WsConnection,
} from "./_e2e/e2e-setup.js";
import { getPackStore } from "../../src/server/extension-host/pack-store.js";
import { providerConfigStoreKey } from "../../src/server/agent/pack-contributions.js";

const PACK_ID = `hindsight-settings-fixture-${Date.now()}`;
const PROVIDER_ID = "memory";
const SECRET_A = "HINDSIGHT_API_KEY_MUST_NEVER_ESCAPE_A";
const SECRET_B = "HINDSIGHT_API_KEY_MUST_NEVER_ESCAPE_B";

let packDir = "";
let operatorCookie = "";
let initialServerPackOrder: string[] = [];
const projectRoots: string[] = [];

function settingsPath(projectId: string): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-settings`;
}

function targetPath(projectId: string): string {
	return `${settingsPath(projectId)}/${encodeURIComponent(PACK_ID)}/provider/${PROVIDER_ID}`;
}

function operatorHeaders(): Record<string, string> {
	return { Cookie: operatorCookie };
}

async function notifyPackFilesystemMutation(order: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-order", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", order }),
	});
	expect(response.status, `fixture filesystem refresh failed: ${await response.clone().text()}`).toBe(200);
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
		"  hooks: [activation-only, no-config, opaque-config]",
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

test.describe("extension settings API", () => {
	test.beforeAll(async ({ gateway }) => {
		const order = await apiFetch("/api/marketplace/pack-order?scope=server");
		expect(order.status).toBe(200);
		initialServerPackOrder = (await readJson(order)).order;
		writeFixturePack(gateway.bobbitDir);
		// Fixture directories are injected directly for speed, so notify the same
		// public Marketplace mutation a real install uses to refresh live resolvers.
		await notifyPackFilesystemMutation(initialServerPackOrder);
		operatorCookie = await mintOperatorCookie();
	});

	test.afterAll(async () => {
		await getPackStore().delete(PACK_ID, providerConfigStoreKey(PROVIDER_ID)).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
		await notifyPackFilesystemMutation(initialServerPackOrder).catch(() => {});
		for (const root of projectRoots) fs.rmSync(root, { recursive: true, force: true });
	});

	test("keeps provider and hook config gates without a declaration visible as repairable invalid schemas", async ({ gateway }) => {
		const project = await createProject(gateway, "activation-only");
		const initial = await settings(project.id);
		for (const kind of ["provider", "hook"] as const) {
			const invalid = initial.targets.find((candidate: any) =>
				candidate.ref?.packId === PACK_ID && candidate.ref?.kind === kind && candidate.ref?.id === "activation-only",
			);
			expect(invalid).toMatchObject({
				enabled: { effective: false },
				configuration: { state: "invalid-schema", missing: [] },
				fields: [],
			});
			const response = await apiFetch(`${settingsPath(project.id)}/${encodeURIComponent(PACK_ID)}/${kind}/activation-only`, {
				method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: initial.revision, enabled: true }),
			});
			expect(response.status).toBe(422);
			expect(await readJson(response)).toMatchObject({ code: "EXTENSION_SETTINGS_INVALID_SCHEMA" });
		}
		expect(runtimeProviderIds(gateway, project.id)).not.toContain("activation-only");
	});

	test("exposes no-config and opaque provider/hook targets for project-local enablement", async ({ gateway }) => {
		const project = await createProject(gateway, "configless-targets");
		let revision = (await settings(project.id)).revision;
		for (const [kind, id] of [["provider", "no-config"], ["provider", "opaque-config"], ["hook", "no-config"], ["hook", "opaque-config"]] as const) {
			const initial = targetByRef(await settings(project.id), kind, id);
			expect(initial).toMatchObject({ fields: [], configuration: { state: "ready", missing: [] }, enabled: { effective: true } });
			const response = await apiFetch(`${settingsPath(project.id)}/${encodeURIComponent(PACK_ID)}/${kind}/${id}`, {
				method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: revision, enabled: false }),
			});
			expect(response.status).toBe(200);
			const body = await readJson(response);
			expect(body.target).toMatchObject({ ref: { packId: PACK_ID, kind, id }, fields: [], enabled: { effective: false, projectOverride: false } });
			revision = body.revision;
		}
	});

	test("authenticates redacted reads and requires a verified operator for every mutation", async ({ gateway }) => {
		const project = await createProject(gateway, "auth");
		const anonymous = await fetch(`${base()}${settingsPath(project.id)}`);
		expect(anonymous.status).toBe(401);

		const initial = await settings(project.id);
		expect(initial).toMatchObject({ schema: 2, revision: 0 });
		expect(target(initial)).toMatchObject({
			enabled: { effective: true },
			configuration: { state: "requires-config", missing: ["externalUrl"] },
		});
		const defaulted = target(initial).fields.find((field: any) => field.key === "recallScope");
		expect(defaulted).toMatchObject({ value: "all", default: "all", source: "default" });
		expect(target(initial).fields.find((field: any) => field.key === "apiKey")).not.toHaveProperty("default");

		const bearerOnly = await apiFetch(targetPath(project.id), {
			method: "PATCH",
			body: JSON.stringify({ expectedRevision: initial.revision, enabled: false }),
		});
		expect(bearerOnly.status).toBe(403);
		expect(await readJson(bearerOnly)).toMatchObject({ code: "PROMPT_EXTENSION_OPERATOR_REQUIRED" });
	});

	test("validates exact server-resolved targets and revision CAS before publishing a redacted update", async ({ gateway }) => {
		const project = await createProject(gateway, "validation");
		const initial = await settings(project.id);

		for (const [pathSuffix, body, status, code] of [
			["/" + encodeURIComponent(PACK_ID), { enabled: true }, 400, "EXTENSION_SETTINGS_EXPECTED_REVISION_REQUIRED"],
			["/" + encodeURIComponent(PACK_ID), { expectedRevision: initial.revision, values: { externalUrl: "https://wrong-route.test" } }, 400, "EXTENSION_SETTINGS_INVALID_PACK_MUTATION"],
			["/missing/provider/memory", { expectedRevision: initial.revision, enabled: true }, 404, "EXTENSION_SETTINGS_TARGET_NOT_FOUND"],
			["/" + encodeURIComponent(PACK_ID) + "/provider/memory", { expectedRevision: initial.revision, values: { unknown: "nope" } }, 422, "EXTENSION_SETTINGS_UNKNOWN_FIELD"],
			["/" + encodeURIComponent(PACK_ID) + "/provider/memory", { expectedRevision: initial.revision, values: { recallScope: "invalid" } }, 422, "EXTENSION_SETTINGS_INVALID_FIELD_VALUE"],
			["/" + encodeURIComponent(PACK_ID) + "/provider/memory", { expectedRevision: initial.revision, values: { recallBudget: 0 } }, 422, "EXTENSION_SETTINGS_INVALID_FIELD_VALUE"],
		] as const) {
			const response = await apiFetch(`${settingsPath(project.id)}${pathSuffix}`, {
				method: "PATCH", headers: operatorHeaders(), body: JSON.stringify(body),
			});
			expect(response.status).toBe(status);
			expect((await readJson(response)).code).toBe(code);
		}

		const saved = await patchTarget(project.id, initial.revision, {
			externalUrl: "https://validated-hindsight.example.test",
			recallScope: "project",
			autoRecall: false,
			recallBudget: 512,
		});
		expect(saved.status).toBe(200);
		const savedBody = await readJson(saved);
		expect(savedBody).toMatchObject({ revision: initial.revision + 1, target: { configuration: { state: "ready" } } });
		expect(savedBody.target.fields.find((field: any) => field.key === "recallScope")).toMatchObject({ value: "project", default: "all", source: "project" });
		expect(savedBody.target.fields.find((field: any) => field.key === "apiKey")).not.toHaveProperty("default");

		const stale = await patchTarget(project.id, initial.revision, { externalUrl: "https://stale.example.test" });
		expect(stale.status).toBe(409);
		expect(await readJson(stale)).toMatchObject({ code: "EXTENSION_SETTINGS_REVISION_CONFLICT" });
	});

	test("clears defaulted overrides back to their declared source but rejects clearing required no-default fields", async ({ gateway }) => {
		const project = await createProject(gateway, "defaults");
		const initial = await settings(project.id);
		expect(target(initial).fields.find((field: any) => field.key === "recallScope")).toMatchObject({ value: "all", source: "default" });

		const configured = await patchTarget(project.id, initial.revision, {
			recallScope: "project",
			requiredName: "project-owned required value",
		});
		expect(configured.status).toBe(200);
		const configuredBody = await readJson(configured);
		expect(configuredBody.target.fields.find((field: any) => field.key === "recallScope")).toMatchObject({ value: "project", source: "project" });

		const clearedDefault = await patchTarget(project.id, configuredBody.revision, { recallScope: null });
		expect(clearedDefault.status).toBe(200);
		const clearedDefaultBody = await readJson(clearedDefault);
		expect(clearedDefaultBody.target.fields.find((field: any) => field.key === "recallScope")).toMatchObject({ value: "all", source: "default" });
		expect(clearedDefaultBody.target.fields.find((field: any) => field.key === "requiredName")).toMatchObject({ value: "project-owned required value", source: "project" });

		const rejectedRequired = await patchTarget(project.id, clearedDefaultBody.revision, { requiredName: null });
		expect(rejectedRequired.status).toBe(422);
		expect(await readJson(rejectedRequired)).toMatchObject({ code: "EXTENSION_SETTINGS_REQUIRED_FIELD" });
	});

	test("redacts Hindsight secrets while invalidating project caches via metadata-only WebSocket frames", async ({ gateway }) => {
		const project = await createProject(gateway, "redaction");
		const sessionId = await createSession({ projectId: project.id, cwd: project.rootPath });
		let connection: WsConnection | undefined;
		try {
			connection = await connectWs(sessionId);
			const initial = await settings(project.id);
			expect(runtimeProviderIds(gateway, project.id)).not.toContain(PROVIDER_ID);
			const cursor = connection.messageCount();
			const captured: string[] = [];
			const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
			for (const spy of spies) spy.mockImplementation((...args: unknown[]) => { captured.push(args.map(String).join(" ")); });
			let saved: Response;
			try {
				saved = await patchTarget(project.id, initial.revision, {
					externalUrl: "https://redaction-hindsight.example.test",
					apiKey: SECRET_A,
				});
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
			expect(saved!.status).toBe(200);
			const savedText = await saved!.text();
			expect(savedText).not.toContain(SECRET_A);
			const savedBody = JSON.parse(savedText);
			expect(savedBody.target.fields.find((field: any) => field.key === "apiKey")).toEqual(expect.objectContaining({ type: "secret", secretSet: true }));
			expect(JSON.stringify(captured)).not.toContain(SECRET_A);

			const invalidation = await connection.waitForFrom(cursor, message => message.type === "extension_settings_updated", 5_000);
			expect(invalidation).toMatchObject({ type: "extension_settings_updated", projectId: project.id, revision: initial.revision + 1 });
			expect(Object.keys(invalidation).sort()).toEqual(["projectId", "revision", "ts", "type"]);
			expect(JSON.stringify(invalidation)).not.toContain(SECRET_A);
			expect(runtimeProviderIds(gateway, project.id)).toContain(PROVIDER_ID);

			const reloaded = await settings(project.id);
			expect(JSON.stringify(reloaded)).not.toContain(SECRET_A);
			expect(target(reloaded).fields.find((field: any) => field.key === "apiKey")).toEqual(expect.objectContaining({ secretSet: true }));
		} finally {
			connection?.close();
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("keeps grants untouched, retains legacy values only before a project record, and isolates configured Hindsight projects", async ({ gateway }) => {
		const projectA = await createProject(gateway, "isolation-a");
		const projectB = await createProject(gateway, "isolation-b");
		const grantsBefore = await readJson(await apiFetch(`/api/projects/${encodeURIComponent(projectA.id)}/extension-grants`));

		const legacyUrl = "https://legacy-hindsight.example.test";
		const retiredSecret = "RETIRED_LLM_KEY_MUST_NEVER_ESCAPE";
		const undeclaredSecret = "UNDECLARED_KEY_MUST_NEVER_ESCAPE";
		await getPackStore().put(PACK_ID, providerConfigStoreKey(PROVIDER_ID), {
			externalUrl: legacyUrl,
			autoRecall: false,
			apiKey: SECRET_A,
			llmApiKey: retiredSecret,
			undeclaredCredential: undeclaredSecret,
		});
		// PackStore writes are deliberately out-of-band. Exercise the same cache
		// invalidation and lazy resolver rebuild that a Marketplace mutation uses.
		await notifyPackFilesystemMutation(initialServerPackOrder);
		const beforeRecord = target(await settings(projectA.id));
		expect(beforeRecord.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ value: legacyUrl, source: "legacy" });
		expect(beforeRecord.fields.find((field: any) => field.key === "apiKey")).toMatchObject({ secretSet: true });
		expect(JSON.stringify(beforeRecord)).not.toContain(SECRET_A);
		expect(JSON.stringify(beforeRecord)).not.toContain(retiredSecret);
		expect(JSON.stringify(beforeRecord)).not.toContain(undeclaredSecret);
		const legacyRuntime = runtimeProviders(gateway, projectA.id).find((provider: any) => provider.id === PROVIDER_ID);
		expect(legacyRuntime?.config).toMatchObject({ externalUrl: legacyUrl, autoRecall: false, apiKey: SECRET_A });
		expect(legacyRuntime?.config).not.toHaveProperty("llmApiKey");
		expect(legacyRuntime?.config).not.toHaveProperty("undeclaredCredential");

		// A partial first save transfers declared public and secret values to their
		// project/owner-only stores in the same paired generation.
		const aInitial = await settings(projectA.id);
		const aSaved = await patchTarget(projectA.id, aInitial.revision, { requiredName: "project-a" });
		expect(aSaved.status).toBe(200);
		const aSavedBody = await readJson(aSaved);
		expect(aSavedBody.target.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ value: legacyUrl, source: "project" });
		expect(aSavedBody.target.fields.find((field: any) => field.key === "autoRecall")).toMatchObject({ value: false, source: "project" });
		expect(aSavedBody.target.fields.find((field: any) => field.key === "apiKey")).toMatchObject({ secretSet: true });
		expect(JSON.stringify(aSavedBody)).not.toContain(SECRET_A);
		const projectYaml = fs.readFileSync(path.join(projectA.rootPath, ".bobbit", "config", "project.yaml"), "utf8");
		expect(projectYaml).not.toContain(SECRET_A);
		expect(projectYaml).not.toContain(retiredSecret);
		expect(projectYaml).not.toContain(undeclaredSecret);
		const ownedRuntime = runtimeProviders(gateway, projectA.id).find((provider: any) => provider.id === PROVIDER_ID);
		expect(ownedRuntime?.config).toMatchObject({ externalUrl: legacyUrl, apiKey: SECRET_A });
		expect(ownedRuntime?.config).not.toHaveProperty("llmApiKey");
		expect(ownedRuntime?.config).not.toHaveProperty("undeclaredCredential");

		// An explicit clear wins over the first-generation legacy transfer and the
		// target can never fall back to the retired PackStore record afterwards.
		const aClearedSecret = await patchTarget(projectA.id, aSavedBody.revision, { apiKey: null });
		expect(aClearedSecret.status).toBe(200);
		const aClearedSecretBody = await readJson(aClearedSecret);
		expect(aClearedSecretBody.target.fields.find((field: any) => field.key === "apiKey")).toMatchObject({ secretSet: false });
		const clearedRuntime = runtimeProviders(gateway, projectA.id).find((provider: any) => provider.id === PROVIDER_ID);
		expect(clearedRuntime?.config).not.toHaveProperty("apiKey");

		// A public clear likewise stays clear in the project row.
		const aCleared = await patchTarget(projectA.id, aClearedSecretBody.revision, { externalUrl: null });
		expect(aCleared.status).toBe(200);
		const aClearedBody = await readJson(aCleared);
		expect(aClearedBody.target).toMatchObject({ configuration: { state: "requires-config", missing: ["externalUrl"] } });
		expect(aClearedBody.target.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ source: "default" });
		expect(runtimeProviderIds(gateway, projectA.id)).not.toContain(PROVIDER_ID);

		const bInitial = await settings(projectB.id);
		const bSaved = await patchTarget(projectB.id, bInitial.revision, {
			externalUrl: "https://project-b-hindsight.example.test",
			apiKey: SECRET_B,
		});
		expect(bSaved.status).toBe(200);

		const a = target(await settings(projectA.id));
		const b = target(await settings(projectB.id));
		expect(a.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ source: "default" });
		expect(b.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ value: "https://project-b-hindsight.example.test", source: "project" });
		expect(JSON.stringify(a)).not.toContain(SECRET_A);
		expect(JSON.stringify(b)).not.toContain(SECRET_B);
		expect(JSON.stringify(a)).not.toContain("project-b-hindsight");
		expect(JSON.stringify(b)).not.toContain("project-a-hindsight");

		const disableB = await apiFetch(`${settingsPath(projectB.id)}/${encodeURIComponent(PACK_ID)}`, {
			method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: (await settings(projectB.id)).revision, enabled: false }),
		});
		expect(disableB.status).toBe(200);
		expect(target(await settings(projectB.id))).toMatchObject({ enabled: { effective: false, projectOverride: false }, configuration: { state: "disabled" } });
		expect(runtimeProviderIds(gateway, projectA.id)).not.toContain(PROVIDER_ID);
		expect(runtimeProviderIds(gateway, projectB.id)).not.toContain(PROVIDER_ID);

		await gateway.projectContextManager.remove(projectB.id);
		const afterReload = target(await settings(projectB.id));
		expect(afterReload).toMatchObject({ enabled: { effective: false, projectOverride: false } });
		expect(afterReload.fields.find((field: any) => field.key === "apiKey")).toMatchObject({ secretSet: true });
		expect(JSON.stringify(afterReload)).not.toContain(SECRET_B);
		expect(JSON.stringify(afterReload)).not.toContain(SECRET_A);
		expect(await readJson(await apiFetch(`/api/projects/${encodeURIComponent(projectA.id)}/extension-grants`))).toEqual(grantsBefore);
	});
});
