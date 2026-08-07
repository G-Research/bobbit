import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test as base, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, deleteSession, registerProject } from "./_e2e/e2e-setup.js";
import { mintSurfaceToken } from "../../src/server/extension-host/surface-binding.ts";
import { enableTsWorkerResolver } from "../core/helpers/enable-ts-worker.ts";

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

async function route(sessionId: string, name: string, body: Record<string, unknown> = {}): Promise<Response> {
	return apiFetch(`/api/ext/route/${encodeURIComponent(name)}`, {
		method: "POST",
		headers: { "X-Bobbit-Session-Id": sessionId },
		body: JSON.stringify({
			sessionId,
			surfaceToken: mintSurfaceToken({ sessionId, packId: PACK_ID, contributionId: "panel:hindsight.memory" }),
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
		const controlled = await route(sessionId, "runtime-control", { action: "stop", consent: true });
		expect(controlled.status).toBe(200);
		expect((await json(controlled)).runtime).toMatchObject({ state: expect.any(String) });
		await revoke(project.id, "service.manage");
		const controlRevoked = await route(sessionId, "runtime-control", { action: "stop" });
		denied(controlRevoked, await json(controlRevoked), "service.manage");
	});
});
