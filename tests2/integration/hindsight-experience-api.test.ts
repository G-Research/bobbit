import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test as base, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, registerProject } from "./_e2e/e2e-setup.js";
import { mintSurfaceToken } from "../../src/server/extension-host/surface-binding.ts";
import { enableTsWorkerResolver } from "../core/helpers/enable-ts-worker.ts";
import { startHindsightStub } from "../../tests/e2e/hindsight-stub.mjs";
import { ServiceRuntimeStore } from "../../src/server/service-runtime/service-runtime-store.ts";
import { getPackStore } from "../../src/server/extension-host/pack-store.ts";
import { queueKey } from "../../market-packs/hindsight/src/shared.ts";

// The in-process gateway stages Hindsight as the shipped built-in pack. Keep
// the test-only resolver available for source-mode route workers in older test
// bundles, but do not copy-install or shadow the built-in pack.
enableTsWorkerResolver();

const test = base;
const PACK_ID = "hindsight";
const PROVIDER_ID = "memory";
const SECRET = "HINDSIGHT_INTEGRATION_SECRET_MUST_NOT_ESCAPE";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACK_SOURCE = path.resolve(__dirname, "..", "..", "market-packs", PACK_ID);
const IMPLEMENTED = fs.existsSync(path.join(PACK_SOURCE, "src", "memory-routes.ts"))
	&& fs.existsSync(path.join(PACK_SOURCE, "src", "tools.ts"))
	&& fs.existsSync(path.resolve(__dirname, "..", "..", "src", "server", "agent", "hindsight-runtime-bridge.ts"));
const describe = IMPLEMENTED ? test.describe : test.describe.skip;

let operatorCookie = "";
const projectRoots: string[] = [];
const sessions: string[] = [];

function settingsPath(projectId: string): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-settings`;
}

function providerPath(projectId: string): string {
	return `${settingsPath(projectId)}/${PACK_ID}/provider/${PROVIDER_ID}`;
}

function grantsPath(projectId: string): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-grants`;
}

function operatorHeaders(): Record<string, string> {
	return { Cookie: operatorCookie };
}

async function json(response: Response): Promise<any> {
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

async function mintOperatorCookie(): Promise<string> {
	const response = await apiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const cookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
	const cookie = cookies.map(value => value.split(";")[0]).find(value => value.startsWith("bobbit_session="));
	expect(cookie, "the test must use the same verified operator proof required by EP-7 and EP-6").toBeTruthy();
	return cookie!;
}

async function createProject(gateway: any, label: string): Promise<{ id: string; rootPath: string }> {
	const rootPath = path.join(gateway.bobbitDir, "hindsight-experience-api", `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(rootPath, { recursive: true });
	projectRoots.push(rootPath);
	return registerProject({ name: `hindsight-experience-${label}-${Date.now()}`, rootPath, seedWorkflows: false });
}

async function route(
	sessionId: string,
	name: string,
	body: Record<string, unknown> = {},
	headers: Record<string, string> = {},
	tool?: string,
): Promise<Response> {
	return apiFetch(`/api/ext/route/${encodeURIComponent(name)}`, {
		method: "POST",
		headers: { "X-Bobbit-Session-Id": sessionId, ...headers },
		body: JSON.stringify({
			sessionId,
			surfaceToken: mintSurfaceToken(tool
			? { sessionId, packId: PACK_ID, contributionId: `hindsight/${tool}`, tool }
			: { sessionId, packId: PACK_ID, contributionId: "panel:hindsight.memory" }),
			init: { method: "POST", body },
		}),
	});
}

async function grant(projectId: string, capability: string): Promise<void> {
	const response = await apiFetch(grantsPath(projectId), {
		method: "PUT", headers: operatorHeaders(),
		body: JSON.stringify({ packId: PACK_ID, principal: "pack", capability }),
	});
	expect(response.status, `grant ${capability}: ${await response.clone().text()}`).toBe(200);
}

async function revoke(projectId: string, capability: string): Promise<void> {
	const response = await apiFetch(`${grantsPath(projectId)}/${PACK_ID}/principals/pack/${encodeURIComponent(capability)}`, {
		method: "DELETE", headers: operatorHeaders(),
	});
	expect(response.status, `revoke ${capability}: ${await response.clone().text()}`).toBe(200);
}

function denied(response: Response, body: any, capability: string): void {
	expect(response.status).toBe(403);
	expect(body).toMatchObject({ code: expect.stringMatching(/EXTENSION_CAPABILITY_(?:REQUIRED|DENIED)/) });
	expect(JSON.stringify(body)).toContain(capability);
}

function runtimeStore(gateway: any, projectId: string): ServiceRuntimeStore {
	const context = gateway.projectContextManager.getOrCreate(projectId);
	const serverIdentity = `hindsight-${createHash("sha256").update(path.join(gateway.bobbitDir, "state")).digest("hex").slice(0, 24)}`;
	return new ServiceRuntimeStore({ stateDir: context.stateDir, serverIdentity });
}

async function seedCleanupRuntime(gateway: any, projectId: string, mode: "local" | "compose"): Promise<ServiceRuntimeStore> {
	const store = runtimeStore(gateway, projectId);
	const identity = store.identity(PACK_ID, "hindsight");
	await store.replace(identity, {
		version: 1,
		serverIdentity: `hindsight-${createHash("sha256").update(path.join(gateway.bobbitDir, "state")).digest("hex").slice(0, 24)}`,
		desired: "running",
		selectedMode: mode,
		settingsRevision: "marketplace-cleanup-test",
		runnerIdentity: mode === "local"
			? { kind: "local", id: "absent-local-child" }
			: { kind: "compose", id: "api", composeProject: "forged-project" },
		endpoint: "http://127.0.0.1:45555",
		restartAttempts: [],
		updatedAt: new Date().toISOString(),
	});
	return store;
}

async function installProjectHindsightFixture(gateway: any, project: { id: string; rootPath: string }): Promise<{ sourceId: string; sourceRoot: string }> {
	const sourceRoot = path.join(gateway.bobbitDir, "hindsight-marketplace-cleanup", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(sourceRoot, { recursive: true });
	fs.cpSync(PACK_SOURCE, path.join(sourceRoot, PACK_ID), { recursive: true });
	const sourceResponse = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: sourceRoot }),
	});
	expect(sourceResponse.status, `add local Hindsight marketplace fixture: ${await sourceResponse.clone().text()}`).toBe(201);
	const sourceId = (await json(sourceResponse)).source.id as string;
	const installed = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_ID, scope: "project", projectId: project.id }),
	});
	expect(installed.status, `install local Hindsight marketplace fixture: ${await installed.clone().text()}`).toBe(201);
	return { sourceId, sourceRoot };
}

async function cleanupProjectHindsightFixture(projectId: string, fixture: { sourceId: string; sourceRoot: string }): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "project", packName: PACK_ID, projectId }),
	}).catch(() => {});
	await apiFetch(`/api/marketplace/sources/${encodeURIComponent(fixture.sourceId)}`, { method: "DELETE" }).catch(() => {});
	fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
}

describe.serial("Hindsight experience API", () => {
	test.beforeAll(async () => {
		// Hindsight is a normal enabled built-in. Clearing any prior server override
		// exercises its shipped activation path without creating a shadow install.
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		});
		expect(activation.status, `Hindsight built-in activation reset failed: ${await activation.clone().text()}`).toBe(200);
		operatorCookie = await mintOperatorCookie();
	});

	test.afterAll(async () => {
		for (const sessionId of sessions.splice(0)) await deleteSession(sessionId);
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		}).catch(() => {});
		for (const root of projectRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	for (const mutation of [
		{
			name: "update",
			successStatus: 200,
			request: (projectId: string) => apiFetch("/api/marketplace/update", {
				method: "POST", body: JSON.stringify({ scope: "project", packName: PACK_ID, projectId }),
			}),
		},
		{
			name: "uninstall",
			successStatus: 204,
			request: (projectId: string) => apiFetch("/api/marketplace/installed", {
				method: "DELETE", body: JSON.stringify({ scope: "project", packName: PACK_ID, projectId }),
			}),
		},
		{
			name: "deactivate",
			successStatus: 200,
			request: (projectId: string) => apiFetch("/api/marketplace/pack-activation", {
				method: "PUT", body: JSON.stringify({ scope: "project", packName: PACK_ID, projectId, disabled: { runtimes: ["hindsight"] } }),
			}),
		},
	] as const) {
		test(`stops the owned runtime before Hindsight ${mutation.name}, retaining a retryable contribution on cleanup failure`, async ({ gateway }) => {
			const project = await createProject(gateway, `marketplace-${mutation.name}`);
			const fixture = await installProjectHindsightFixture(gateway, project);
			try {
				await grant(project.id, "service.manage");
				const store = await seedCleanupRuntime(gateway, project.id, "compose");
				const failed = await mutation.request(project.id);
				expect(failed.status, `${mutation.name} must fail while owned cleanup fails`).not.toBe(mutation.successStatus);

				const stale = await store.load(store.identity(PACK_ID, "hindsight"));
				expect(stale).toMatchObject({
					desired: "stopped",
					runnerIdentity: { kind: "compose", id: "api", composeProject: "forged-project" },
				});
				expect(stale?.endpoint).toBeUndefined();
				const unchanged = await apiFetch(`/api/marketplace/pack-activation?scope=project&projectId=${encodeURIComponent(project.id)}&packName=${PACK_ID}`);
				expect(unchanged.status, `${mutation.name} failure retains the old contribution`).toBe(200);
				const unchangedBody = await json(unchanged);
				expect(unchangedBody.disabled?.runtimes ?? []).not.toContain("hindsight");

				await seedCleanupRuntime(gateway, project.id, "local");
				const succeeded = await mutation.request(project.id);
				expect(succeeded.status, `${mutation.name} retry after cleanup: ${await succeeded.clone().text()}`).toBe(mutation.successStatus);
				const cleaned = await store.load(store.identity(PACK_ID, "hindsight"));
				expect(cleaned?.desired).toBe("stopped");
				expect(cleaned?.endpoint).toBeUndefined();
				expect(cleaned?.runnerIdentity).toBeUndefined();

				const after = await apiFetch(`/api/marketplace/pack-activation?scope=project&projectId=${encodeURIComponent(project.id)}&packName=${PACK_ID}`);
				if (mutation.name === "uninstall") {
					expect(after.status).toBe(404);
				} else {
					expect(after.status).toBe(200);
					const afterBody = await json(after);
					expect(afterBody.disabled?.runtimes ?? []).toEqual(mutation.name === "deactivate" ? ["hindsight"] : []);
				}
			} finally {
				await cleanupProjectHindsightFixture(project.id, fixture);
			}
		});
	}

	test("uses EP-7 compare-and-swap and write-only redaction for Hindsight configuration", async ({ gateway }) => {
		const project = await createProject(gateway, "settings");
		const initialResponse = await apiFetch(settingsPath(project.id));
		expect(initialResponse.status).toBe(200);
		const initial = await json(initialResponse);
		const target = initial.targets.find((item: any) => item.ref?.packId === PACK_ID && item.ref?.kind === "provider" && item.ref?.id === PROVIDER_ID);
		expect(target).toBeTruthy();

		const saved = await apiFetch(providerPath(project.id), {
			method: "PATCH", headers: operatorHeaders(),
			body: JSON.stringify({
				expectedRevision: initial.revision,
				values: { runtimeMode: "external", externalUrl: "http://127.0.0.1:65531", apiKey: SECRET },
			}),
		});
		const savedText = await saved.text();
		expect(saved.status).toBe(200);
		expect(savedText).not.toContain(SECRET);
		const savedBody = JSON.parse(savedText);
		expect(savedBody).toMatchObject({ revision: initial.revision + 1 });
		expect(savedBody.target.fields.find((field: any) => field.key === "apiKey")).toMatchObject({ type: "secret", secretSet: true });

		const stale = await apiFetch(providerPath(project.id), {
			method: "PATCH", headers: operatorHeaders(),
			body: JSON.stringify({ expectedRevision: initial.revision, values: { externalUrl: "http://127.0.0.1:65530" } }),
		});
		expect(stale.status).toBe(409);
		expect(await json(stale)).toMatchObject({ code: "EXTENSION_SETTINGS_REVISION_CONFLICT" });

		const reloaded = await apiFetch(settingsPath(project.id));
		expect(reloaded.status).toBe(200);
		expect(await reloaded.text()).not.toContain(SECRET);
	});

	test("repairs inactive Hindsight settings through the catalogue without runtime side effects", async ({ gateway }) => {
		const project = await createProject(gateway, "inactive-settings-repair");
		const context = gateway.projectContextManager.getOrCreate(project.id);
		const initial = await json(await apiFetch(settingsPath(project.id)));

		for (const [packId, providerId] of [["not-installed", PROVIDER_ID], [PACK_ID, "not-installed"]] as const) {
			const denied = await apiFetch(`${settingsPath(project.id)}/${packId}/provider/${providerId}`, {
				method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: initial.revision, enabled: true }),
			});
			expect(denied.status).toBe(404);
			expect(await json(denied)).toMatchObject({ code: "EXTENSION_SETTINGS_TARGET_NOT_FOUND" });
		}

		const disabled = await apiFetch(providerPath(project.id), {
			method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: initial.revision, enabled: false }),
		});
		expect(disabled.status).toBe(200);
		const disabledBody = await json(disabled);
		expect(disabledBody.target).toMatchObject({ enabled: { effective: false, projectOverride: false } });
		expect(fs.existsSync(path.join(context.stateDir, "service-runtimes"))).toBe(false);
		expect(fs.existsSync(path.join(context.stateDir, "hindsight-queue"))).toBe(false);
		expect(getPackStore().readSync(PACK_ID, queueKey(project.id))).toMatchObject({ state: "absent" });

		// The active registry now drops this provider. Re-enabling still uses only
		// the server-resolved installed schema and EP-7 CAS; it cannot start a
		// runtime, contact a service, or create private provider state.
		const repaired = await apiFetch(providerPath(project.id), {
			method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: disabledBody.revision, enabled: true }),
		});
		expect(repaired.status).toBe(200);
		const repairedBody = await json(repaired);
		expect(repairedBody).toMatchObject({ revision: disabledBody.revision + 1, target: { enabled: { effective: true, projectOverride: true } } });
		expect(fs.existsSync(path.join(context.stateDir, "service-runtimes"))).toBe(false);
		expect(fs.existsSync(path.join(context.stateDir, "hindsight-queue"))).toBe(false);
		expect(getPackStore().readSync(PACK_ID, queueKey(project.id))).toMatchObject({ state: "absent" });
	});

	test("fails closed with redacted typed errors when Hindsight settings pairing cannot be read", async ({ gateway }) => {
		const project = await createProject(gateway, "settings-pairing-repair");
		const initial = await json(await apiFetch(settingsPath(project.id)));
		const disabled = await apiFetch(providerPath(project.id), {
			method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: initial.revision, enabled: false }),
		});
		expect(disabled.status).toBe(200);
		const revision = (await json(disabled)).revision;
		const context = gateway.projectContextManager.getOrCreate(project.id);
		const secretsPath = path.join(context.stateDir, "extension-settings-secrets.json");

		fs.writeFileSync(secretsPath, JSON.stringify({ schema: 1, commitId: "mismatched-commit", values: {} }) + "\n");
		await gateway.projectContextManager.remove(project.id);
		const mismatched = await apiFetch(providerPath(project.id), {
			method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: revision, enabled: true }),
		});
		expect(mismatched.status).toBe(503);
		const mismatchBody = await json(mismatched);
		expect(mismatchBody).toEqual({
			error: "Extension settings are unavailable. Retry after repairing project state.",
			code: "EXTENSION_SETTINGS_SECRET_COMMIT_MISMATCH",
		});
		expect(JSON.stringify(mismatchBody)).not.toContain("mismatched-commit");

		fs.writeFileSync(secretsPath, "not valid JSON\n");
		await gateway.projectContextManager.remove(project.id);
		const unreadable = await apiFetch(providerPath(project.id), {
			method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: revision, enabled: true }),
		});
		expect(unreadable.status).toBe(503);
		const unreadableBody = await json(unreadable);
		expect(unreadableBody).toEqual({
			error: "Extension settings are unavailable. Retry after repairing project state.",
			code: "EXTENSION_SETTINGS_SECRET_READ_FAILED",
		});
		expect(JSON.stringify(unreadableBody)).not.toContain("not valid JSON");
		const reopened = gateway.projectContextManager.getOrCreate(project.id);
		expect(fs.existsSync(path.join(reopened.stateDir, "service-runtimes"))).toBe(false);
		expect(fs.existsSync(path.join(reopened.stateDir, "hindsight-queue"))).toBe(false);
	});

	test("keeps local managed-volume settings dormant but rejects explicit start before runtime mutation", async ({ gateway }) => {
		const project = await createProject(gateway, "managed-volume-start");
		const sessionId = await createSession({ projectId: project.id, cwd: project.rootPath });
		sessions.push(sessionId);
		const initial = await json(await apiFetch(settingsPath(project.id)));
		const saved = await apiFetch(providerPath(project.id), {
			method: "PATCH", headers: operatorHeaders(),
			body: JSON.stringify({
				expectedRevision: initial.revision,
				values: {
					runtimeMode: "local", databaseMode: "managed-volume",
					localLlmProvider: "openai-compatible", localLlmModelId: "qwen3-coder",
					localLlmBaseUrl: "http://127.0.0.1:11434/v1", localLlmApiKey: SECRET,
				},
			}),
		});
		const savedText = await saved.text();
		expect(saved.status).toBe(200);
		expect(savedText).not.toContain(SECRET);

		await grant(project.id, "service.manage");
		const start = await route(sessionId, "runtime-control", { action: "start", consent: true }, operatorHeaders());
		const startBody = await json(start);
		expect(start.status).toBe(422);
		expect(startBody).toMatchObject({ code: "HINDSIGHT_EXTERNAL_DATABASE_SETTING_REQUIRED" });
		expect(String(startBody.error)).toMatch(/external PostgreSQL database/i);
		expect(JSON.stringify(startBody)).not.toContain(SECRET);
		const context = gateway.projectContextManager.getOrCreate(project.id);
		expect(fs.existsSync(path.join(context.stateDir, "service-runtimes"))).toBe(false);

		const status = await route(sessionId, "runtime-status");
		expect(status.status).toBe(200);
		expect((await json(status)).runtime).toMatchObject({ state: "stopped", desired: "stopped" });
	});

	test("retains the server-derived completed outcome idempotently and rejects incomplete goals", async ({ gateway }) => {
		const project = await createProject(gateway, "outcome-route");
		const goal = await createGoal({ projectId: project.id, title: "Route-owned completed outcome", cwd: project.rootPath, worktree: false, team: false });
		const sessionId = await createSession({ projectId: project.id, goalId: goal.id, cwd: project.rootPath });
		const stub = await startHindsightStub({ port: 0 }) as Awaited<ReturnType<typeof startHindsightStub>>;
		try {
			const initial = await json(await apiFetch(settingsPath(project.id)));
			const configured = await apiFetch(providerPath(project.id), {
				method: "PATCH", headers: operatorHeaders(),
				body: JSON.stringify({ expectedRevision: initial.revision, values: { runtimeMode: "external", externalUrl: stub.url } }),
			});
			expect(configured.status).toBe(200);
			await grant(project.id, "memory.write");

			const incomplete = await route(sessionId, "retain-outcome", { content: "forged incomplete outcome", goalId: "forged-goal" });
			expect(incomplete.status).toBe(200);
			expect(await json(incomplete)).toEqual({ ok: false, configured: true, code: "OUTCOME_UNAVAILABLE" });

			const context = gateway.projectContextManager.getContextForGoal(goal.id);
			await context.goalManager.updateGoal(goal.id, { state: "complete" });
			const beforeRouteCalls = stub.calls.filter((call: any) => call.method === "POST" && /\/memories$/.test(call.path)).length;
			const first = await route(sessionId, "retain-outcome", { content: "forged first body", completionRevision: "forged" });
			const second = await route(sessionId, "retain-outcome", { content: "forged second body" });
			expect(first.status).toBe(200);
			expect(second.status).toBe(200);
			const firstBody = await json(first);
			const secondBody = await json(second);
			expect(secondBody).toEqual(firstBody);
			const routeCalls = stub.calls.filter((call: any) => call.method === "POST" && /\/memories$/.test(call.path)).slice(beforeRouteCalls);
			expect(routeCalls).toHaveLength(2);
			expect(routeCalls.map((call: any) => call.body.items[0].id)).toEqual([firstBody.outcomeId, firstBody.outcomeId]);
			expect(routeCalls.map((call: any) => call.body.items[0].tags)).toEqual([
				["goal:" + goal.id, "kind:outcome", "project:" + project.id],
				["goal:" + goal.id, "kind:outcome", "project:" + project.id],
			]);
			expect(JSON.stringify(routeCalls)).not.toContain("forged first body");
			expect(JSON.stringify(routeCalls)).not.toContain("forged second body");
		} finally {
			await stub.close();
			await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goal.id).catch(() => {});
		}
	});

	test("enforces live EP-6 grants around typed routes while leaving status and logs read-only", async ({ gateway }) => {
		const project = await createProject(gateway, "grants");
		const sessionId = await createSession({ projectId: project.id, cwd: project.rootPath });
		sessions.push(sessionId);
		const initial = await json(await apiFetch(settingsPath(project.id)));
		const configured = await apiFetch(providerPath(project.id), {
			method: "PATCH", headers: operatorHeaders(),
			body: JSON.stringify({ expectedRevision: initial.revision, values: { runtimeMode: "docker" } }),
		});
		expect(configured.status).toBe(200);

		const status = await route(sessionId, "runtime-status");
		expect(status.status).toBe(200);
		const statusBody = await json(status);
		expect(statusBody.runtime).toMatchObject({
			identity: { packId: PACK_ID, runtimeId: "hindsight" },
			state: expect.stringMatching(/^(stopped|starting|ready|degraded|blocked|unavailable)$/),
			desired: expect.stringMatching(/^(running|stopped)$/),
		});
		expect(JSON.stringify(statusBody)).not.toContain(SECRET);

		const logs = await route(sessionId, "runtime-logs", { tail: 10 });
		expect(logs.status).toBe(200);
		const logsBody = await json(logs);
		expect(logsBody.lines).toEqual(expect.any(Array));
		expect(logsBody.lines.length).toBeLessThanOrEqual(10);
		expect(JSON.stringify(logsBody)).not.toContain(SECRET);

		const readDenied = await route(sessionId, "recall", { query: "must require a live read grant" });
		denied(readDenied, await json(readDenied), "memory.read");
		await grant(project.id, "memory.read");
		const readAllowed = await route(sessionId, "recall", { query: "configured but unavailable is bounded" });
		expect(readAllowed.status, `granted recall: ${await readAllowed.clone().text()}`).toBe(200);
		const readBody = await json(readAllowed);
		// Saving a managed EP-7 mode is inert. It is configured, but until an
		// explicitly granted start succeeds the route returns its bounded typed
		// no-service result rather than probing, starting, or falling back.
		expect(readBody).toEqual({ configured: true, code: "SERVICE_UNHEALTHY" });
		expect(JSON.stringify(readBody)).not.toContain(SECRET);
		await revoke(project.id, "memory.read");
		const readRevoked = await route(sessionId, "recall", { query: "revoked before dispatch" });
		denied(readRevoked, await json(readRevoked), "memory.read");

		const controlDenied = await route(sessionId, "runtime-control", { action: "stop" });
		denied(controlDenied, await json(controlDenied), "service.manage");
		await grant(project.id, "service.manage");

		// A bearer plus a valid tool-bound surface token is sufficient to invoke
		// ordinary pack routes, but never to mutate runtime or migration state.
		const bearerToolBound = await route(sessionId, "runtime-control", { action: "stop", consent: true }, {}, "hindsight_recall");
		expect(bearerToolBound.status).toBe(403);
		expect(await json(bearerToolBound)).toMatchObject({ code: "PROMPT_EXTENSION_OPERATOR_REQUIRED" });

		const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(project.id);
		gateway.sessionManager.sandboxTokenStore.addSession(project.id, sessionId);
		const sandboxDenied = await route(sessionId, "runtime-control", { action: "stop", consent: true }, { Authorization: `Bearer ${sandboxToken}` });
		expect(sandboxDenied.status).toBe(403);
		expect(await json(sandboxDenied)).toMatchObject({ code: "PROMPT_EXTENSION_OPERATOR_REQUIRED" });
		const migrationDenied = await route(sessionId, "migration-execute", {}, {});
		expect(migrationDenied.status).toBe(403);
		expect(await json(migrationDenied)).toMatchObject({ code: "PROMPT_EXTENSION_OPERATOR_REQUIRED" });
		const context = gateway.projectContextManager.getOrCreate(project.id);
		expect(fs.existsSync(path.join(context.stateDir, "service-runtimes"))).toBe(false);

		// The panel's existing signed cookie is the separate operator proof; body
		// consent only confirms the requested control operation's shape.
		const controlled = await route(sessionId, "runtime-control", { action: "stop", consent: true }, operatorHeaders());
		expect(controlled.status).toBe(200);
		expect((await json(controlled)).runtime).toMatchObject({ state: expect.any(String) });
		await revoke(project.id, "service.manage");
		const controlRevoked = await route(sessionId, "runtime-control", { action: "stop" });
		denied(controlRevoked, await json(controlRevoked), "service.manage");
	});
});
