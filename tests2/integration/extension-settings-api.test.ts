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

test.describe("extension settings API", () => {
	test.beforeAll(async ({ gateway }) => {
		writeFixturePack(gateway.bobbitDir);
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		});
		expect(activation.status, `fixture pack activation refresh failed: ${await activation.clone().text()}`).toBe(200);
		operatorCookie = await mintOperatorCookie();
	});

	test.afterAll(async () => {
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		}).catch(() => {});
		await getPackStore().delete(PACK_ID, providerConfigStoreKey(PROVIDER_ID)).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
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
		expect(target(initial).fields.find((field: any) => field.key === "languages"))
			.toMatchObject({ type: "multi-enum", value: ["typescript"], default: ["typescript"], source: "default" });
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

	test("canonicalizes multi-enum arrays, rejects invalid sets, and restores project values after reload", async ({ gateway }) => {
		const project = await createProject(gateway, "multi-enum");
		const initial = await settings(project.id);

		for (const languages of ["typescript", ["unknown"], ["typescript", "typescript"], []] as const) {
			const response = await patchTarget(project.id, initial.revision, { languages });
			expect(response.status).toBe(422);
			expect(await readJson(response)).toMatchObject({ code: "EXTENSION_SETTINGS_INVALID_FIELD_VALUE" });
		}

		const saved = await patchTarget(project.id, initial.revision, {
			externalUrl: "https://multi-enum-hindsight.example.test",
			languages: ["typescript", "javascript"],
			optionalLanguages: [],
			apiKey: SECRET_A,
		});
		expect(saved.status).toBe(200);
		const savedText = await saved.text();
		expect(savedText).not.toContain(SECRET_A);
		const savedTarget = JSON.parse(savedText).target;
		expect(savedTarget.fields.find((field: any) => field.key === "languages"))
			.toMatchObject({ value: ["javascript", "typescript"], source: "project" });
		expect(savedTarget.fields.find((field: any) => field.key === "optionalLanguages"))
			.toMatchObject({ value: [], source: "project" });
		expect(runtimeProviders(gateway, project.id).find((provider: any) => provider.id === PROVIDER_ID)?.config)
			.toMatchObject({ languages: ["javascript", "typescript"], optionalLanguages: [] });

		await gateway.projectContextManager.remove(project.id);
		const reloaded = target(await settings(project.id));
		expect(reloaded.fields.find((field: any) => field.key === "languages"))
			.toMatchObject({ value: ["javascript", "typescript"], source: "project" });
		expect(reloaded.fields.find((field: any) => field.key === "optionalLanguages"))
			.toMatchObject({ value: [], source: "project" });
		expect(JSON.stringify(reloaded)).not.toContain(SECRET_A);
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

	test("keeps grants untouched, preserves legacy Hindsight mode only at runtime before a project record, and isolates configured projects", async ({ gateway }) => {
		const projectA = await createProject(gateway, "isolation-a");
		const projectB = await createProject(gateway, "isolation-b");
		const grantsBefore = await readJson(await apiFetch(`/api/projects/${encodeURIComponent(projectA.id)}/extension-grants`));

		const legacyUrl = "https://legacy-hindsight.example.test";
		await putLegacyProviderConfig(gateway, { externalUrl: legacyUrl, languages: ["python"], mode: "managed" });
		const beforeRecord = target(await settings(projectB.id));
		expect(beforeRecord.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ value: legacyUrl, source: "legacy" });
		expect(beforeRecord.fields.find((field: any) => field.key === "languages"))
			.toMatchObject({ value: ["typescript"], source: "default" });
		expect(beforeRecord.fields.find((field: any) => field.key === "mode")).toBeUndefined();
		expect(JSON.stringify(beforeRecord)).not.toContain("managed");
		expect(runtimeProviders(gateway, projectB.id).find((provider: any) => provider.id === PROVIDER_ID)?.config)
			.toMatchObject({ externalUrl: legacyUrl, mode: "managed" });

		const invalidLegacyProject = await createProject(gateway, "legacy-invalid");
		await putLegacyProviderConfig(gateway, { externalUrl: legacyUrl, recallScope: "invalid", mode: "managed" });
		expect(target(await settings(invalidLegacyProject.id)).configuration).toMatchObject({ state: "invalid-values" });
		expect(runtimeProviderIds(gateway, invalidLegacyProject.id)).not.toContain(PROVIDER_ID);
		await putLegacyProviderConfig(gateway, { externalUrl: legacyUrl, mode: "managed" });

		const aInitial = await settings(projectA.id);
		const aSaved = await patchTarget(projectA.id, aInitial.revision, {
			externalUrl: "https://project-a-hindsight.example.test",
			apiKey: SECRET_A,
		});
		expect(aSaved.status).toBe(200);
		const projectAConfig = runtimeProviders(gateway, projectA.id).find((provider: any) => provider.id === PROVIDER_ID)?.config;
		expect(projectAConfig).toMatchObject({ externalUrl: "https://project-a-hindsight.example.test" });
		expect(projectAConfig).not.toHaveProperty("mode");
		const bInitial = await settings(projectB.id);
		const bSaved = await patchTarget(projectB.id, bInitial.revision, {
			externalUrl: "https://project-b-hindsight.example.test",
			apiKey: SECRET_B,
		});
		expect(bSaved.status).toBe(200);

		const a = target(await settings(projectA.id));
		const b = target(await settings(projectB.id));
		expect(a.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ value: "https://project-a-hindsight.example.test", source: "project" });
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
		expect(runtimeProviderIds(gateway, projectA.id)).toContain(PROVIDER_ID);
		expect(runtimeProviderIds(gateway, projectB.id)).not.toContain(PROVIDER_ID);

		await gateway.projectContextManager.remove(projectB.id);
		const afterReload = target(await settings(projectB.id));
		expect(afterReload).toMatchObject({ enabled: { effective: false, projectOverride: false } });
		expect(afterReload.fields.find((field: any) => field.key === "apiKey")).toMatchObject({ secretSet: true });
		expect(JSON.stringify(afterReload)).not.toContain(SECRET_B);
		expect(JSON.stringify(afterReload)).not.toContain(SECRET_A);
		expect(await readJson(await apiFetch(`/api/projects/${encodeURIComponent(projectA.id)}/extension-grants`))).toEqual(grantsBefore);
	});

	test("fails closed after hook schema evolution while preserving redaction, compatible additions, and mutate-only authority", async ({ gateway }) => {
		const project = await createProject(gateway, "hook-schema-evolution");
		const initial = await settings(project.id);
		const secretCanary = `EVOLVED_HOOK_SECRET_MUST_NEVER_ESCAPE_${Date.now()}`;
		const saved = await apiFetch(reconciliationHookPath(project.id), {
			method: "PATCH",
			headers: operatorHeaders(),
			body: JSON.stringify({
				expectedRevision: initial.revision,
				values: {
					endpoint: "https://schema-evolution.example.test",
					legacyEnum: "legacy",
					legacyText: "stored-before-boolean",
					legacyNumber: 3,
					removedValue: "must-not-return-after-removal",
					apiKey: secretCanary,
				},
			}),
		});
		expect(saved.status).toBe(200);
		const savedBody = await readJson(saved);
		expect(JSON.stringify(savedBody)).not.toContain(secretCanary);
		expect(savedBody.target.fields.find((field: any) => field.key === "apiKey"))
			.toEqual(expect.objectContaining({ type: "secret", secretSet: true }));
		expect(runtimeHookIds(gateway, project.id)).toContain(RECONCILIATION_HOOK_ID);

		const mutationGrant = await apiFetch(grantsPath(project.id), {
			method: "PUT",
			headers: operatorHeaders(),
			body: JSON.stringify({ packId: PACK_ID, hookId: RECONCILIATION_HOOK_ID, capability: "mutate" }),
		});
		expect(mutationGrant.status).toBe(200);
		const mutateOnly = targetByRef(await settings(project.id), "hook", RECONCILIATION_HOOK_ID);
		expect(mutateOnly.hookGrant).toMatchObject({
			requestedCapabilities: ["decide", "mutate"],
			grants: ["mutate"],
			runnable: false,
			status: "grant-required",
			runtimeAuthorized: true,
		});

		writeReconciliationHookV2();
		const refresh = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		});
		expect(refresh.status, `schema evolution must invalidate the pack resolver: ${await refresh.clone().text()}`).toBe(200);

		const evolvedResponse = await settings(project.id);
		const evolved = targetByRef(evolvedResponse, "hook", RECONCILIATION_HOOK_ID);
		expect(evolved).toMatchObject({
			enabled: { effective: true },
			configuration: { state: "invalid-values", missing: [] },
		});
		for (const key of ["legacyEnum", "legacyText", "legacyNumber"]) {
			expect(evolved.fields.find((field: any) => field.key === key)).not.toHaveProperty("value");
		}
		expect(evolved.fields.find((field: any) => field.key === "removedValue")).toBeUndefined();
		expect(evolved.fields.find((field: any) => field.key === "optionalAdded")).not.toHaveProperty("value");
		expect(evolved.fields.find((field: any) => field.key === "defaultAdded"))
			.toMatchObject({ value: "evolved-default", default: "evolved-default", source: "default" });
		expect(evolved.fields.find((field: any) => field.key === "apiKey")).toEqual(expect.objectContaining({ type: "secret", secretSet: true }));
		expect(JSON.stringify(evolvedResponse)).not.toContain(secretCanary);
		const diagnostics: string[] = [];
		const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { diagnostics.push(args.map(String).join(" ")); });
		try {
			expect(runtimeHookIds(gateway, project.id)).not.toContain(RECONCILIATION_HOOK_ID);
		} finally {
			warn.mockRestore();
		}
		expect(JSON.stringify(diagnostics)).not.toContain(secretCanary);

		const repaired = await apiFetch(reconciliationHookPath(project.id), {
			method: "PATCH",
			headers: operatorHeaders(),
			body: JSON.stringify({ expectedRevision: evolvedResponse.revision, values: { legacyEnum: "strict", legacyText: true, legacyNumber: 6 } }),
		});
		expect(repaired.status).toBe(200);
		const repairedTarget = (await readJson(repaired)).target;
		expect(repairedTarget.configuration).toMatchObject({ state: "ready", missing: [] });
		expect(repairedTarget.fields.find((field: any) => field.key === "defaultAdded"))
			.toMatchObject({ value: "evolved-default", source: "default" });
		expect(runtimeHookIds(gateway, project.id)).toContain(RECONCILIATION_HOOK_ID);
	});
});
