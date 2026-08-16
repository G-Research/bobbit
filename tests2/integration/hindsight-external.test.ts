import { test as base, expect } from "./_e2e/in-process-harness.js";
import { enableTsWorkerResolver } from "../core/helpers/enable-ts-worker.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	connectWs,
	agentEndPredicate,
	messageEndPredicate,
	waitForCondition,
	nonGitCwd,
} from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mintSurfaceToken } from "../../src/server/extension-host/surface-binding.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACK_NAME = "hindsight";
const PROVIDER_ID = "memory";
const PRODUCTION_LIFECYCLE_BUDGET = "budget: { maxTokens: 1200, timeoutMs: 1500 }";
const TEST_LIFECYCLE_BUDGET = "budget: { maxTokens: 1200, timeoutMs: 10000 }";
const PACK_SRC = path.resolve(__dirname, "..", "..", "market-packs", PACK_NAME);
const STUB_PATH = path.resolve(__dirname, "..", "..", "tests", "e2e", "hindsight-stub.mjs");
const EXTERNAL_TEST_SECRET = "HINDSIGHT_EXTERNAL_FIXTURE_SECRET_MUST_NOT_ESCAPE";
const DEPS_READY =
	fs.existsSync(path.join(PACK_SRC, "pack.yaml")) &&
	fs.existsSync(path.join(PACK_SRC, "lib", "provider.mjs")) &&
	fs.existsSync(STUB_PATH);

const test = base;
const describe = DEPS_READY ? test.describe : test.describe.skip;

interface RetainedItem { content: string; tags: string[]; async: boolean }
interface RecordedCall { method: string; path: string; bank?: string; body?: unknown }
interface HindsightStub {
	url: string;
	calls: RecordedCall[];
	seedMemories(bank: string, memories: { text: string; id?: string; tags?: string[] }[]): void;
	retained(bank?: string): RetainedItem[];
	close(): Promise<void>;
}

async function startStub(): Promise<HindsightStub> {
	const mod = await import(STUB_PATH as string);
	const start = mod.startHindsightStub ?? mod.default;
	return start({ port: 0 }) as Promise<HindsightStub>;
}

function installPack(headquartersDir: string): string {
	const packDir = path.join(headquartersDir, "config", "market-packs", PACK_NAME);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.cpSync(PACK_SRC, packDir, { recursive: true });

	// Starting a TypeScript module worker is fixture overhead, so retain the
	// existing integration-only lifecycle budget while preserving production yaml.
	const providerYaml = path.join(packDir, "providers", "memory.yaml");
	const yaml = fs.readFileSync(providerYaml, "utf-8");
	if (!yaml.includes(PRODUCTION_LIFECYCLE_BUDGET)) {
		throw new Error("Hindsight test fixture could not find the production lifecycle budget");
	}
	fs.writeFileSync(providerYaml, yaml.replace(PRODUCTION_LIFECYCLE_BUDGET, TEST_LIFECYCLE_BUDGET), "utf-8");
	fs.writeFileSync(
		path.join(packDir, ".pack-meta.yaml"),
		[
			"sourceUrl: e2e",
			"sourceRef: local",
			"commit: test",
			`packName: ${PACK_NAME}`,
			"version: 1.0.0",
			"installedAt: '2026-01-01T00:00:00.000Z'",
			"updatedAt: '2026-01-01T00:00:00.000Z'",
			"scope: server",
		].join("\n") + "\n",
		"utf-8",
	);
	return packDir;
}

function settingsPath(projectId: string): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-settings`;
}

/** EP-7 is the sole Hindsight configuration owner. This fixture must not seed
 * the retired pack-global record, which bypasses revisioning and redaction. */
async function configureProvider(projectId: string, externalUrl: string, operatorCookie: string): Promise<void> {
	const initial = await apiFetch(settingsPath(projectId));
	expect(initial.status).toBe(200);
	const { revision } = await initial.json() as { revision: number };
	const saved = await apiFetch(`${settingsPath(projectId)}/${PACK_NAME}/provider/${PROVIDER_ID}`, {
		method: "PATCH",
		headers: { Cookie: operatorCookie },
		body: JSON.stringify({
			expectedRevision: revision,
			values: { runtimeMode: "external", externalUrl, apiKey: EXTERNAL_TEST_SECRET },
		}),
	});
	const body = await saved.text();
	expect(saved.status, `canonical Hindsight settings save: ${body}`).toBe(200);
	expect(body).not.toContain(EXTERNAL_TEST_SECRET);
}

async function setProviderDisabled(providers: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { providers } }),
	});
	expect(response.status).toBe(200);
}

async function readServerPackOrder(): Promise<string[]> {
	const response = await apiFetch("/api/marketplace/pack-order?scope=server");
	expect(response.status).toBe(200);
	return (await response.json()).order as string[];
}

async function mintOperatorCookie(): Promise<string> {
	const response = await apiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const cookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
	const cookie = cookies.map(value => value.split(";")[0]).find(value => value.startsWith("bobbit_session="));
	expect(cookie, "Hindsight route fixtures require the same signed operator proof as live EP-6 grants").toBeTruthy();
	return cookie!;
}

async function grant(projectId: string, capability: "memory.read" | "memory.write", operatorCookie: string): Promise<void> {
	const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants`, {
		method: "PUT",
		headers: { Cookie: operatorCookie },
		body: JSON.stringify({ packId: PACK_NAME, principal: "pack", capability }),
	});
	expect(response.status, `live Hindsight ${capability} grant: ${await response.clone().text()}`).toBe(200);
}

async function revoke(projectId: string, capability: "memory.read" | "memory.write", operatorCookie: string): Promise<void> {
	const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants/${PACK_NAME}/principals/pack/${capability}`, {
		method: "DELETE",
		headers: { Cookie: operatorCookie },
	});
	expect(response.status, `live Hindsight ${capability} revoke: ${await response.clone().text()}`).toBe(200);
}

/** Notify the gateway after this fixture's direct on-disk install/uninstall. */
async function notifyPackFilesystemMutation(order: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-order", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", order }),
	});
	expect(response.status).toBe(200);
}

async function callBeforePrompt(sessionId: string, prompt: string): Promise<{ status: number; content: string }> {
	const response = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
		method: "POST",
		body: JSON.stringify({ prompt }),
	});
	const body = response.status === 200 ? await response.json() : {};
	return { status: response.status, content: typeof body.content === "string" ? body.content : "" };
}

async function callHindsightRoute(sessionId: string, route: "recall" | "retain", init: Record<string, unknown>): Promise<Response> {
	return apiFetch(`/api/ext/route/${route}`, {
		method: "POST",
		headers: { "X-Bobbit-Session-Id": sessionId },
		body: JSON.stringify({
			sessionId,
			surfaceToken: mintSurfaceToken({ sessionId, packId: PACK_NAME, contributionId: `route:${route}` }),
			init,
		}),
	});
}

async function driveTurn(sessionId: string, prompt: string): Promise<void> {
	const connection = await connectWs(sessionId);
	try {
		const userEnd = connection.waitFor(messageEndPredicate("user"));
		connection.send({ type: "prompt", text: prompt });
		await userEnd;
		await connection.waitFor(agentEndPredicate(), 15_000);
	} finally {
		connection.close();
	}
}

describe.configure({ mode: "serial" });

describe("hindsight installed-provider worker boundary", () => {
	const sessionIds: string[] = [];
	const cwds: string[] = [];
	let bobbitDir: string;
	let packDir: string;
	let projectId: string;
	let originalPackOrder: string[];
	let stub: HindsightStub;
	let operatorCookie: string;

	test.beforeAll(async ({ gateway }) => {
		enableTsWorkerResolver();
		bobbitDir = gateway.bobbitDir;
		projectId = gateway.defaultProjectId;
		operatorCookie = await mintOperatorCookie();
		originalPackOrder = await readServerPackOrder();
		packDir = installPack(bobbitDir);
		await notifyPackFilesystemMutation(originalPackOrder);
		stub = await startStub();
	});

	test.afterAll(async () => {
		await setProviderDisabled([PROVIDER_ID]).catch(() => {});
		for (const sessionId of sessionIds) await deleteSession(sessionId).catch(() => {});
		for (const cwd of cwds) fs.rmSync(cwd, { recursive: true, force: true });
		if (stub) await stub.close().catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
		if (originalPackOrder) await notifyPackFilesystemMutation(originalPackOrder).catch(() => {});
	});

	test("activates lifecycle hooks only while a live memory grant exists", async ({ gateway }) => {
		const hub = gateway.sessionManager.lifecycleHub;
		expect(hub, "gateway must own the lifecycle hub used for session bridge activation").toBeTruthy();
		await revoke(projectId, "memory.read", operatorCookie);
		await revoke(projectId, "memory.write", operatorCookie);
		expect(hub!.hasProvidersForHooks(projectId, ["beforePrompt"])).toBe(false);

		await grant(projectId, "memory.read", operatorCookie);
		expect(hub!.hasProvidersForHooks(projectId, ["beforePrompt"])).toBe(true);

		await revoke(projectId, "memory.read", operatorCookie);
		expect(hub!.hasProvidersForHooks(projectId, ["beforePrompt"])).toBe(false);
	});

	test("configured pack recalls and retains through ModuleHost and the host-store proxy", async () => {
		const callsBeforeConfig = stub.calls.length;
		await configureProvider(projectId, stub.url, operatorCookie);
		// EP-7 save is inert: configuration cannot probe the provider.
		expect(stub.calls).toHaveLength(callsBeforeConfig);
		await grant(projectId, "memory.read", operatorCookie);
		await grant(projectId, "memory.write", operatorCookie);
		await setProviderDisabled([]);
		stub.seedMemories("bobbit", [{
			text: "Use a feature flag for risky rollouts.",
			id: "m1",
			tags: [`project:${projectId}`],
		}]);

		const cwd = fs.mkdtempSync(path.join(nonGitCwd(), "hindsight-worker-smoke-"));
		cwds.push(cwd);
		// The persisted session project is the sole host-owned source used to build
		// HookCtx.scopeContext at the worker boundary.
		const sessionId = await createSession({ cwd, projectId });
		sessionIds.push(sessionId);

		const recallPrompt = "how should this roll out?";
		const recalled = await callBeforePrompt(sessionId, recallPrompt);
		expect(recalled.status).toBe(200);
		expect(recalled.content).toBe(
			`<context-block id="memory:0" source="Relevant memory" authority="memory" reason="Recall for: ${recallPrompt}">\n- Use a feature flag for risky rollouts.\n</context-block>`,
		);
		expect(stub.calls.find((call) => /\/memories\/recall$/.test(call.path) && call.bank === "bobbit")?.body).toMatchObject({
			query: recallPrompt,
			tags: [`project:${projectId}`],
			tags_match: "all_strict",
		});

		const prompt = "Remember the worker-backed retain path.";
		const expectedContent = "Assistant: OK";
		const retainedBefore = stub.retained("bobbit").length;
		await driveTurn(sessionId, prompt);
		await waitForCondition(
			() => stub.retained("bobbit").slice(retainedBefore).some((item) => item.content === expectedContent),
			{ timeoutMs: 10_000, message: "afterTurn retained exact content through the worker store.read proxy" },
		);
		expect(stub.retained("bobbit").slice(retainedBefore)).toEqual([{
			content: expectedContent,
			tags: [`agent:general`, `kind:turn`, `project:${projectId}`, `session:${sessionId}`],
			async: true,
		}]);
	});

	test("routes receive authoritative scope through the real worker boundary and fail closed when it is missing", async () => {
		const callsBeforeConfig = stub.calls.length;
		await configureProvider(projectId, stub.url, operatorCookie);
		// Saving a newer EP-7 revision cannot contact the configured endpoint.
		expect(stub.calls).toHaveLength(callsBeforeConfig);
		await setProviderDisabled([]);
		stub.seedMemories("bobbit", [{
			text: "Route scope is host derived.",
			id: "route-memory",
			tags: [`project:${projectId}`],
		}]);

		const cwd = fs.mkdtempSync(path.join(nonGitCwd(), "hindsight-route-scope-"));
		cwds.push(cwd);
		const scopedSession = await createSession({ cwd, projectId });
		sessionIds.push(scopedSession);
		const callsBeforeScopedRecall = stub.calls.length;
		const recalled = await callHindsightRoute(scopedSession, "recall", { method: "POST", body: { query: "route scope" } });
		expect(recalled.status).toBe(200);
		const recalledBody = await recalled.json() as { configured?: boolean; memories?: Array<{ text?: string }> };
		expect(recalledBody.configured).toBe(true);
		expect(recalledBody.memories).toEqual(expect.arrayContaining([
			expect.objectContaining({ text: "Route scope is host derived." }),
		]));
		expect(stub.calls.slice(callsBeforeScopedRecall).find(call => /\/memories\/recall$/.test(call.path) && call.bank === "bobbit")?.body).toMatchObject({
			query: "route scope",
			tags: [`project:${projectId}`],
			tags_match: "all_strict",
		});

		const retainedBefore = stub.retained("bobbit").length;
		const retained = await callHindsightRoute(scopedSession, "retain", { method: "POST", body: { content: "Host-scoped route retain." } });
		expect(retained.status).toBe(200);
		expect(await retained.json()).toMatchObject({ ok: true, configured: true });
		expect(stub.retained("bobbit").slice(retainedBefore)).toEqual([{
			content: "Host-scoped route retain.",
			tags: [`kind:manual`, `project:${projectId}`],
			async: true,
		}]);

		// Headquarters sessions deliberately have no rich project scope, while
		// retaining a valid visible session-store partition for the route boundary.
		const unscopedSession = await createSession({ cwd, projectId: "headquarters" });
		sessionIds.push(unscopedSession);
		// Configure and authorize this *separate* EP-7/EP-6 project so the result
		// proves missing host scope itself fails closed, rather than merely dormant
		// configuration doing so first.
		const callsBeforeHeadquartersConfig = stub.calls.length;
		await configureProvider("headquarters", stub.url, operatorCookie);
		expect(stub.calls).toHaveLength(callsBeforeHeadquartersConfig);
		await grant("headquarters", "memory.read", operatorCookie);
		const callsBeforeUnscopedRecall = stub.calls.length;
		const unscoped = await callHindsightRoute(unscopedSession, "recall", { method: "POST", body: { query: "must not reach remote" } });
		expect(unscoped.status).toBe(200);
		expect(await unscoped.json()).toMatchObject({ configured: true, memories: [] });
		expect(stub.calls).toHaveLength(callsBeforeUnscopedRecall);
	});
});
