import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./in-process-harness.js";
import {
	agentEndPredicate,
	apiFetch,
	connectWs,
	createSession,
	defaultProject,
	deleteSession,
} from "./e2e-setup.js";
import { openApp } from "./ui/ui-helpers.js";

const PACK = "pack-local-data";
const PI_TOOL = "pi_local_data_marker";
const SOURCE = fileURLToPath(new URL("../../market-packs/_fixtures", import.meta.url));

let sourceId: string | undefined;
const sessionIds: string[] = [];
let sandboxConfigured = false;

async function installAndEnable(projectId?: string): Promise<void> {
	const source = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE }),
	});
	const sourceText = await source.text();
	if (source.status === 409) {
		const existing = await apiFetch("/api/marketplace/sources");
		expect(existing.status).toBe(200);
		sourceId = ((await existing.json()).sources ?? []).find((item: any) => item.url === SOURCE)?.id;
		expect(sourceId, sourceText).toBeTruthy();
	} else {
		expect(source.status, sourceText).toBe(201);
		sourceId = JSON.parse(sourceText).source.id;
	}

	const install = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK, scope: projectId ? "project" : "server", ...(projectId ? { projectId } : {}) }),
	});
	const installText = await install.text();
	expect(install.status, installText).toBe(201);

	const enable = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({
			scope: projectId ? "project" : "server",
			packName: PACK,
			...(projectId ? { projectId } : {}),
			disabled: { enabled: true },
		}),
	});
	const enableText = await enable.text();
	expect(enable.status, enableText).toBe(200);
}

async function uninstall(projectId?: string): Promise<Response> {
	return apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: projectId ? "project" : "server", packName: PACK, ...(projectId ? { projectId } : {}) }),
	});
}

async function waitForPiTool(): Promise<void> {
	await expect.poll(async () => {
		const response = await apiFetch("/api/tools");
		expect(response.status).toBe(200);
		return ((await response.json()).tools ?? []).some((tool: any) => tool.name === PI_TOOL);
	}, { timeout: 15_000, message: `${PI_TOOL} should be discovered before session creation` }).toBe(true);
}

async function runPiTool(sessionId: string, input: Record<string, unknown>): Promise<any> {
	const connection = await connectWs(sessionId);
	try {
		const cursor = connection.messageCount();
		connection.send({ type: "prompt", text: `PI_EXTENSION_TOOL:${PI_TOOL}::${JSON.stringify(input)}` });
		const result = await connection.waitForFrom(
			cursor,
			message => message.type === "event"
				&& message.data?.type === "message_end"
				&& message.data?.message?.role === "toolResult"
				&& message.data?.message?.toolName === PI_TOOL,
			20_000,
		);
		await connection.waitForFrom(cursor, agentEndPredicate(), 20_000).catch(() => {});
		expect(result.data.message.isError, JSON.stringify(result.data.message.content)).toBe(false);
		return JSON.parse(result.data.message.content[0].text);
	} finally {
		connection.close();
	}
}

async function runOrdinaryWrite(sessionId: string, file: string): Promise<void> {
	const connection = await connectWs(sessionId);
	try {
		const cursor = connection.messageCount();
		connection.send({ type: "prompt", text: `please use the write tool at ${file}` });
		const result = await connection.waitForFrom(
			cursor,
			message => message.type === "event"
				&& message.data?.type === "message_end"
				&& message.data?.message?.role === "toolResult"
				&& message.data?.message?.toolName === "Write",
			20_000,
		);
		expect(result.data.message.isError).toBe(false);
		await connection.waitForFrom(cursor, agentEndPredicate(), 20_000).catch(() => {});
	} finally {
		connection.close();
	}
}

async function packIsContributed(projectId?: string): Promise<boolean> {
	const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	const response = await apiFetch(`/api/ext/contributions${suffix}`);
	expect(response.status).toBe(200);
	return ((await response.json()).packs ?? []).some((pack: any) => pack.packId === PACK);
}

async function selectSessionAndOpenPanel(page: any, sessionId: string): Promise<void> {
	await page.evaluate((id: string) => { window.location.hash = `#/session/${id}`; }, sessionId);
	await expect.poll(
		() => page.evaluate(() => (window as any).__bobbitState?.selectedSessionId ?? (window as any).bobbitState?.selectedSessionId),
		{ timeout: 15_000 },
	).toBe(sessionId);
	await page.evaluate(() => { window.location.hash = "#/ext/pack-local-data"; });
	await page.getByRole("button", { name: "Open Pack Local Data Fixture" }).click();
}

test.use({ serveUi: true });
test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
	for (const sessionId of sessionIds.splice(0)) await deleteSession(sessionId).catch(() => {});
	if (sandboxConfigured) {
		const project = await defaultProject().catch(() => undefined);
		if (project) await apiFetch(`/api/projects/${project.id}/config`, { method: "PUT", body: JSON.stringify({ sandbox: "none" }) }).catch(() => {});
		sandboxConfigured = false;
	}
	await uninstall().catch(() => {});
	if (sourceId) {
		await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
		sourceId = undefined;
	}
	const project = await defaultProject().catch(() => undefined);
	if (project) fs.rmSync(path.join(project.rootPath, ".pack-local-data-fixture"), { recursive: true, force: true });
});

test("browser, server route, Pi tool, and ordinary filesystem access share the canonical project directory and preserve it", async ({ page, gateway }) => {
	const project = await defaultProject();
	const componentCwd = path.join(project.rootPath, "components", "web");
	fs.mkdirSync(componentCwd, { recursive: true });
	await installAndEnable();
	expect(await packIsContributed()).toBe(true);
	await waitForPiTool();

	const sessionId = await createSession({ projectId: project.id, cwd: componentCwd });
	sessionIds.push(sessionId);
	const declaredDirectory = path.join(project.rootPath, ".pack-local-data-fixture");
	expect(fs.existsSync(declaredDirectory), "Pack Local Data activation must materialize the canonical project directory").toBe(true);
	const expectedDirectory = fs.realpathSync(declaredDirectory);
	const runtimeEnvironment = gateway.sessionManager.getSession(sessionId)?.rpcClient?.options?.env ?? {};
	expect(runtimeEnvironment.BOBBIT_PACK_LOCAL_DATA_JSON, "ordinary sessions must receive the pack-local-data runtime binding").toBeTruthy();
	expect(JSON.parse(runtimeEnvironment.BOBBIT_PACK_LOCAL_DATA_JSON)).toEqual({ [PACK]: expectedDirectory });

	await runOrdinaryWrite(sessionId, path.join(expectedDirectory, "ordinary-marker.txt"));
	expect(fs.readFileSync(path.join(expectedDirectory, "ordinary-marker.txt"), "utf8")).toBe("E2E_WRITE_TEST\n");

	const piResult = await runPiTool(sessionId, { operation: "write", name: "pi-marker.txt", content: "written-by-pi-host" });
	expect(piResult).toMatchObject({ directory: expectedDirectory, name: "pi-marker.txt", content: "written-by-pi-host" });
	expect(fs.readFileSync(path.join(expectedDirectory, "pi-marker.txt"), "utf8")).toBe("written-by-pi-host");

	await openApp(page);
	await selectSessionAndOpenPanel(page, sessionId);
	await expect(page.locator('[data-testid="pack-local-data-browser-directory"]')).toHaveText(expectedDirectory, { timeout: 20_000 });
	await expect(page.locator('[data-testid="pack-local-data-route-directory"]')).toHaveText(expectedDirectory);
	await expect(page.locator('[data-testid="pack-local-data-markers"]')).toContainText('"ordinary-marker.txt":"E2E_WRITE_TEST\\n"');
	await expect(page.locator('[data-testid="pack-local-data-markers"]')).toContainText('"pi-marker.txt":"written-by-pi-host"');
	await expect(page.locator('[data-testid="pack-local-data-markers"]')).toContainText('"host-marker.txt":"written-by-browser-route"');

	await page.reload();
	await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
	await selectSessionAndOpenPanel(page, sessionId);
	await expect(page.locator('[data-testid="pack-local-data-browser-directory"]')).toHaveText(expectedDirectory, { timeout: 20_000 });

	const removed = await uninstall();
	expect(removed.status).toBe(204);
	await expect.poll(() => packIsContributed(), { timeout: 15_000 }).toBe(false);
	expect(fs.readFileSync(path.join(expectedDirectory, "pi-marker.txt"), "utf8")).toBe("written-by-pi-host");
	expect(fs.readFileSync(path.join(expectedDirectory, "ordinary-marker.txt"), "utf8")).toBe("E2E_WRITE_TEST\n");
	expect(fs.readFileSync(path.join(expectedDirectory, "host-marker.txt"), "utf8")).toBe("written-by-browser-route");
});

test("sandbox mount is writable in both directions at the stable pack path", async ({ gateway }) => {
	const project = await defaultProject();
	await installAndEnable();
	await waitForPiTool();

	const docker = await import("node:child_process").then(({ spawnSync }) => ({
		info: spawnSync("docker", ["info"], { stdio: "ignore" }),
		image: spawnSync("docker", ["image", "inspect", "bobbit-agent"], { stdio: "ignore" }),
	}));
	test.skip(docker.info.status !== 0 || docker.image.status !== 0, "Docker and the bobbit-agent image are required for the writable bind-mount round trip");

	const setSandbox = await apiFetch(`/api/projects/${project.id}/config`, {
		method: "PUT",
		body: JSON.stringify({ sandbox: "docker" }),
	});
	const configText = await setSandbox.text();
	expect(setSandbox.status, configText).toBe(200);
	sandboxConfigured = true;

	const sessionId = await createSession({ projectId: project.id });
	sessionIds.push(sessionId);
	const declaredHostDirectory = path.join(project.rootPath, ".pack-local-data-fixture");
	expect(fs.existsSync(declaredHostDirectory), "sandbox activation must materialize the host directory before mounting it").toBe(true);
	const expectedHostDirectory = fs.realpathSync(declaredHostDirectory);
	const expectedContainerDirectory = "/bobbit/local-data/pack-local-data";
	const runtimeEnvironment = gateway.sessionManager.getSession(sessionId)?.rpcClient?.options?.env ?? {};
	expect(JSON.parse(runtimeEnvironment.BOBBIT_PACK_LOCAL_DATA_JSON)).toEqual({ [PACK]: expectedContainerDirectory });

	const containerWrite = await runPiTool(sessionId, { operation: "write", name: "container-marker.txt", content: "written-in-container" });
	expect(containerWrite.directory).toBe(expectedContainerDirectory);
	expect(fs.readFileSync(path.join(expectedHostDirectory, "container-marker.txt"), "utf8")).toBe("written-in-container");

	fs.writeFileSync(path.join(expectedHostDirectory, "host-marker.txt"), "written-on-host", "utf8");
	const containerRead = await runPiTool(sessionId, { operation: "read", name: "host-marker.txt" });
	expect(containerRead).toMatchObject({ directory: expectedContainerDirectory, content: "written-on-host" });

	const restoreConfig = await apiFetch(`/api/projects/${project.id}/config`, {
		method: "PUT",
		body: JSON.stringify({ sandbox: "none" }),
	});
	expect(restoreConfig.status).toBe(200);
	sandboxConfigured = false;
});
