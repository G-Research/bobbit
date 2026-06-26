import { test, expect } from "./in-process-harness.js";
import {
	agentEndPredicate,
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	nonGitCwd,
	registerProject,
} from "./e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = path.resolve(__dirname, "..", "fixtures", "market-sources");
const DEMO_SOURCE = path.join(FIXTURES, "pi-extension-demo-src");
const FAILURE_SOURCE = path.join(FIXTURES, "pi-extension-failure-src");
const SCOPE_SOURCE = path.join(FIXTURES, "pi-extension-scope-src");

const DEMO_PACK = "pi-extension-demo";
const FAILURE_PACK = "pi-extension-failure";
const PROJECT_A_PACK = "pi-extension-project-a";
const PROJECT_B_PACK = "pi-extension-project-b";
const DEMO_TOOL = "pi_demo_echo";

type Scope = "server" | "project";

interface InstalledPack {
	sourceId: string;
	packName: string;
	scope: Scope;
	projectId?: string;
}

const installed: InstalledPack[] = [];
const sessions: string[] = [];
const projectsToRemove: string[] = [];
const sourceIds = new Set<string>();

function refOf(row: any): string {
	return typeof row === "string" ? row : String(row?.ref ?? row?.listName ?? "");
}

async function addSource(sourceDir: string): Promise<string> {
	const add = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: sourceDir }),
	});
	const text = await add.text();
	if (add.status === 409) {
		const sourcesResp = await apiFetch("/api/marketplace/sources");
		expect(sourcesResp.status).toBe(200);
		const source = ((await sourcesResp.json()).sources ?? []).find((item: any) => item.url === sourceDir);
		expect(source, text).toBeTruthy();
		sourceIds.add(source.id);
		return source.id;
	}
	expect(add.status, text).toBe(201);
	const sourceId = (JSON.parse(text) as { source: { id: string } }).source.id;
	sourceIds.add(sourceId);
	return sourceId;
}

async function installPack(sourceDir: string, dirName: string, scope: Scope, projectId?: string): Promise<void> {
	const sourceId = await addSource(sourceDir);
	const install = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName, scope, ...(projectId ? { projectId } : {}) }),
	});
	const text = await install.text();
	expect(install.status, text).toBe(201);
	installed.push({ sourceId, packName: dirName, scope, projectId });
}

async function setPiExtensionsDisabled(packName: string, piExtensions: string[], scope: Scope = "server", projectId?: string): Promise<any> {
	const resp = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope, packName, ...(projectId ? { projectId } : {}), disabled: { piExtensions } }),
	});
	const body = await resp.json();
	expect(resp.status, JSON.stringify(body)).toBe(200);
	return body;
}

async function activation(packName: string, scope: Scope = "server", projectId?: string): Promise<any> {
	const qs = new URLSearchParams({ scope, packName });
	if (projectId) qs.set("projectId", projectId);
	const resp = await apiFetch(`/api/marketplace/pack-activation?${qs.toString()}`);
	const body = await resp.json();
	expect(resp.status, JSON.stringify(body)).toBe(200);
	return body;
}

async function toolByName(name: string, projectId?: string): Promise<any | undefined> {
	const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	const resp = await apiFetch(`/api/tools${qs}`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	return (body.tools ?? []).find((tool: any) => tool.name === name);
}

async function waitForTool(name: string, projectId?: string): Promise<any> {
	let found: any;
	await expect.poll(async () => {
		found = await toolByName(name, projectId);
		return Boolean(found);
	}, { timeout: 15_000, message: `${name} should appear in /api/tools` }).toBe(true);
	return found;
}

function extensionArgs(gateway: any, sessionId: string): string[] {
	const args: string[] = gateway.sessionManager.getSession(sessionId)?.rpcClient?.options?.args ?? [];
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--extension" && typeof args[i + 1] === "string") out.push(args[++i]);
	}
	return out;
}

function hasExtensionArg(gateway: any, sessionId: string, tail: string): boolean {
	const normalizedTail = tail.replace(/\\/g, "/");
	return extensionArgs(gateway, sessionId).some((arg) => arg.replace(/\\/g, "/").endsWith(normalizedTail));
}

async function createRole(roleName: string, policy: "ask" | "never"): Promise<void> {
	const resp = await apiFetch("/api/roles", {
		method: "POST",
		body: JSON.stringify({
			name: roleName,
			label: `Pi extension ${policy} role`,
			promptTemplate: "E2E pi extension policy role.",
			toolPolicies: { [DEMO_TOOL]: policy },
		}),
	});
	const text = await resp.text();
	expect(resp.status, text).toBe(201);
}

async function createRoleSession(roleId: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), roleId }),
	});
	const body = await resp.json();
	expect(resp.status, JSON.stringify(body)).toBe(201);
	sessions.push(body.id);
	return body.id;
}

async function runPiTool(sessionId: string, input: Record<string, unknown>): Promise<any> {
	const conn = await connectWs(sessionId);
	try {
		const cursor = conn.messageCount();
		conn.send({ type: "prompt", text: `PI_EXTENSION_TOOL:${DEMO_TOOL}::${JSON.stringify(input)}` });
		const result = await conn.waitForFrom(
			cursor,
			(m) => m.type === "event" && m.data?.type === "message_end" && m.data?.message?.role === "toolResult" && m.data?.message?.toolName === DEMO_TOOL,
			20_000,
		);
		await conn.waitForFrom(cursor, agentEndPredicate(), 20_000).catch(() => {});
		return result.data.message;
	} finally {
		conn.close();
	}
}

test.describe.configure({ mode: "serial" });

test.describe("marketplace pi extensions", () => {
	test.afterEach(async () => {
		for (const id of sessions.splice(0)) await deleteSession(id).catch(() => {});
		await apiFetch(`/api/roles/pi-extension-never-role`, { method: "DELETE" }).catch(() => {});
		await apiFetch(`/api/roles/pi-extension-ask-role`, { method: "DELETE" }).catch(() => {});
		for (const pack of installed.splice(0).reverse()) {
			await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: pack.scope, packName: pack.packName, ...(pack.projectId ? { projectId: pack.projectId } : {}) }),
			}).catch(() => {});
		}
		for (const sourceId of [...sourceIds]) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
			sourceIds.delete(sourceId);
		}
		for (const dir of projectsToRemove.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	test("install + default enable passes extension args, exposes provenance, and the fixture tool can be used", async ({ gateway }) => {
		await installPack(DEMO_SOURCE, DEMO_PACK, "server");
		await setPiExtensionsDisabled(DEMO_PACK, []);

		const tool = await waitForTool(DEMO_TOOL);
		expect(tool).toMatchObject({
			name: DEMO_TOOL,
			origin: "marketplace-pi-extension",
			originPackName: DEMO_PACK,
			providerType: "pi-extension",
		});

		await expect.poll(async () => {
			const body = await activation(DEMO_PACK);
			const row = body.catalogue.piExtensions.find((item: any) => refOf(item) === "demo");
			return row && typeof row === "object" && row.tools?.some((t: any) => t.name === DEMO_TOOL) && row.diagnostic?.status;
		}, { timeout: 15_000, message: "activation catalogue should include discovered pi-extension metadata" }).toBe("ok");

		const sessionId = await createSession({ cwd: nonGitCwd() });
		sessions.push(sessionId);
		expect(hasExtensionArg(gateway, sessionId, "/pi-extensions/demo/extension.ts")).toBe(true);

		const result = await runPiTool(sessionId, { message: "hello", suffix: "!" });
		expect(result.isError).toBe(false);
		expect(result.content?.[0]?.text).toContain('"echoed":"hello!"');
	});

	test("disabling a pi extension persists and omits it from later session startup", async ({ gateway }) => {
		await installPack(DEMO_SOURCE, DEMO_PACK, "server");
		await setPiExtensionsDisabled(DEMO_PACK, []);

		const enabledSession = await createSession({ cwd: nonGitCwd() });
		sessions.push(enabledSession);
		expect(hasExtensionArg(gateway, enabledSession, "/pi-extensions/demo/extension.ts")).toBe(true);

		const disabled = await setPiExtensionsDisabled(DEMO_PACK, ["demo"]);
		expect(disabled.disabled.piExtensions).toEqual(["demo"]);
		const reread = await activation(DEMO_PACK);
		expect(reread.disabled.piExtensions).toEqual(["demo"]);
		const row = reread.catalogue.piExtensions.find((item: any) => refOf(item) === "demo");
		expect(row, "disabled extension remains visible in activation catalogue").toBeTruthy();
		expect(row.diagnostic.status).toBe("disabled");

		const disabledSession = await createSession({ cwd: nonGitCwd() });
		sessions.push(disabledSession);
		expect(hasExtensionArg(gateway, disabledSession, "/pi-extensions/demo/extension.ts")).toBe(false);
	});

	test("discovery failure remains visible as an extension-level marketplace row", async () => {
		await installPack(FAILURE_SOURCE, FAILURE_PACK, "server");
		await setPiExtensionsDisabled(FAILURE_PACK, []);

		await expect.poll(async () => {
			const body = await activation(FAILURE_PACK);
			const row = body.catalogue.piExtensions.find((item: any) => refOf(item) === "broken");
			return row && typeof row === "object" ? row.diagnostic?.status : undefined;
		}, { timeout: 15_000, message: "broken extension diagnostic should surface" }).toBe("discovery-failed");

		const body = await activation(FAILURE_PACK);
		const row = body.catalogue.piExtensions.find((item: any) => refOf(item) === "broken");
		expect(row).toMatchObject({ ref: "broken", diagnostic: { status: "discovery-failed" } });
		expect(row.diagnostic.message).toMatch(/definitely-not-installed|missing|resolve|import/i);
		expect(await toolByName("pi_broken_never_visible")).toBeUndefined();
	});

	test("explicit never and ask policies for discovered pi-extension tools are enforced by the guard", async ({ gateway }) => {
		await installPack(DEMO_SOURCE, DEMO_PACK, "server");
		await setPiExtensionsDisabled(DEMO_PACK, []);
		await waitForTool(DEMO_TOOL);

		await createRole("pi-extension-never-role", "never");
		const neverSession = await createRoleSession("pi-extension-never-role");
		expect(hasExtensionArg(gateway, neverSession, "/pi-extensions/demo/extension.ts")).toBe(true);
		const blocked = await runPiTool(neverSession, { message: "blocked" });
		expect(blocked.isError).toBe(true);
		expect(blocked.content?.[0]?.text).toMatch(/not permitted|blocked/i);

		await createRole("pi-extension-ask-role", "ask");
		const askSession = await createRoleSession("pi-extension-ask-role");
		const conn = await connectWs(askSession);
		try {
			const cursor = conn.messageCount();
			conn.send({ type: "prompt", text: `PI_EXTENSION_TOOL:${DEMO_TOOL}::{"message":"granted"}` });
			const perm = await conn.waitForFrom(cursor, (m) => m.type === "tool_permission_needed" && m.toolName === DEMO_TOOL, 20_000);
			expect(perm.group).toMatch(/pi extension/i);
			conn.send({ type: "grant_tool_permission", toolName: DEMO_TOOL, scope: "tool", mode: "session-only" });
			const result = await conn.waitForFrom(
				cursor,
				(m) => m.type === "event" && m.data?.type === "message_end" && m.data?.message?.role === "toolResult" && m.data?.message?.toolName === DEMO_TOOL,
				20_000,
			);
			expect(result.data.message.isError).toBe(false);
			expect(result.data.message.content?.[0]?.text).toContain('"echoed":"granted"');
		} finally {
			conn.close();
		}
	});

	test("project-scoped pi-extension tools and session args do not leak across projects", async ({ gateway }) => {
		const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-ext-a-"));
		const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-ext-b-"));
		projectsToRemove.push(rootA, rootB);
		const projectA = await registerProject({ name: `pi-ext-a-${Date.now()}`, rootPath: rootA });
		const projectB = await registerProject({ name: `pi-ext-b-${Date.now()}`, rootPath: rootB });

		await installPack(SCOPE_SOURCE, PROJECT_A_PACK, "project", projectA.id);
		await installPack(SCOPE_SOURCE, PROJECT_B_PACK, "project", projectB.id);
		await setPiExtensionsDisabled(PROJECT_A_PACK, [], "project", projectA.id);
		await setPiExtensionsDisabled(PROJECT_B_PACK, [], "project", projectB.id);

		const aOnly = await waitForTool("pi_scope_a_only", projectA.id);
		const aShared = await waitForTool("pi_scope_shared", projectA.id);
		expect(aOnly.originPackName).toBe(PROJECT_A_PACK);
		expect(aShared.providers ?? [{ packName: aShared.originPackName }]).toEqual(
			expect.arrayContaining([expect.objectContaining({ packName: PROJECT_A_PACK })]),
		);
		expect(await toolByName("pi_scope_b_only", projectA.id)).toBeUndefined();

		const bOnly = await waitForTool("pi_scope_b_only", projectB.id);
		const bShared = await waitForTool("pi_scope_shared", projectB.id);
		expect(bOnly.originPackName).toBe(PROJECT_B_PACK);
		expect(bShared.providers ?? [{ packName: bShared.originPackName }]).toEqual(
			expect.arrayContaining([expect.objectContaining({ packName: PROJECT_B_PACK })]),
		);
		expect(await toolByName("pi_scope_a_only", projectB.id)).toBeUndefined();
		expect(await toolByName("pi_scope_a_only")).toBeUndefined();
		expect(await toolByName("pi_scope_b_only")).toBeUndefined();

		const sessionA = await createSession({ cwd: rootA, projectId: projectA.id });
		const sessionB = await createSession({ cwd: rootB, projectId: projectB.id });
		sessions.push(sessionA, sessionB);
		expect(hasExtensionArg(gateway, sessionA, "/pi-extensions/project-a/extension.ts")).toBe(true);
		expect(hasExtensionArg(gateway, sessionA, "/pi-extensions/project-b/extension.ts")).toBe(false);
		expect(hasExtensionArg(gateway, sessionB, "/pi-extensions/project-b/extension.ts")).toBe(true);
		expect(hasExtensionArg(gateway, sessionB, "/pi-extensions/project-a/extension.ts")).toBe(false);
	});
});
