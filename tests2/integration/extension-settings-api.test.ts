import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	base,
	connectWs,
	createSession,
	defaultProject,
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

async function readJson(response: Response): Promise<any> {
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

function target(body: any): any {
	const result = body.targets?.find((candidate: any) =>
		candidate.ref?.packId === PACK_ID && candidate.ref?.kind === "provider" && candidate.ref?.id === PROVIDER_ID,
	);
	expect(result, "Hindsight fixture provider must be visible in the settings catalogue").toBeTruthy();
	return result;
}

function runtimeProviderIds(gateway: any, projectId: string): string[] {
	const registry = gateway.sessionManager.lifecycleHub?.registry;
	expect(registry, "gateway lifecycle hub exposes the live project resolver").toBeTruthy();
	return registry.listProviders(projectId)
		.filter((provider: any) => provider.packRoot?.endsWith(PACK_ID))
		.map((provider: any) => provider.id);
}

function writeFixturePack(headquartersDir: string): void {
	packDir = path.join(headquartersDir, "config", "market-packs", PACK_ID);
	fs.mkdirSync(path.join(packDir, "providers"), { recursive: true });
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
		"  providers: [memory]",
		"  hooks: []",
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
		"activation:",
		"  requiresConfig: [externalUrl]",
	].join("\n") + "\n", "utf8");
	fs.writeFileSync(path.join(packDir, "lib", "provider.mjs"), "export default {};\n", "utf8");
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
		expect(await readJson(saved)).toMatchObject({ revision: initial.revision + 1, target: { configuration: { state: "ready" } } });

		const stale = await patchTarget(project.id, initial.revision, { externalUrl: "https://stale.example.test" });
		expect(stale.status).toBe(409);
		expect(await readJson(stale)).toMatchObject({ code: "EXTENSION_SETTINGS_REVISION_CONFLICT" });
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
		await getPackStore().put(PACK_ID, providerConfigStoreKey(PROVIDER_ID), { externalUrl: legacyUrl });
		const beforeRecord = target(await settings(projectB.id));
		expect(beforeRecord.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ value: legacyUrl, source: "legacy" });

		const aInitial = await settings(projectA.id);
		const aSaved = await patchTarget(projectA.id, aInitial.revision, {
			externalUrl: "https://project-a-hindsight.example.test",
			apiKey: SECRET_A,
		});
		expect(aSaved.status).toBe(200);
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
});
