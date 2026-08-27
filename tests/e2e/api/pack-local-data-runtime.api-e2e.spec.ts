import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../_helpers/in-process-harness.js";
import {
	agentEndPredicate,
	apiFetch,
	connectWs,
	createSession,
	defaultProject,
	deleteSession,
	waitForSessionStatus,
} from "../_helpers/e2e-setup.js";

const PACK = "pack-local-data";
const PI_TOOL = "pi_local_data_marker";
const SOURCE = fileURLToPath(new URL("../../../market-packs/_fixtures", import.meta.url));
const WINNER_PACK = "pi-local-data-same-id";
const LEGACY_PACK = "pi-legacy-same-id";

let sourceId: string | undefined;
const fixtureSourceIds = new Set<string>();
const fixtureSourceRoots: string[] = [];
const fixtureInstalls: Array<{ packName: string; scope: "server" | "project"; projectId?: string }> = [];
const sessionIds: string[] = [];
let sandboxConfigured = false;
let fixtureGitProjectRoot: string | undefined;

function initializeFixtureGitRepository(projectRoot: string): void {
	expect(fs.existsSync(path.join(projectRoot, ".git")), "the fixture must own the default project's Git lifecycle").toBe(false);
	fixtureGitProjectRoot = projectRoot;
	const marker = path.join(projectRoot, ".pack-local-data-git-fixture");
	fs.writeFileSync(marker, "Git-backed Pack Local Data sandbox fixture\n", "utf8");
	for (const args of [
		["init", "--quiet"],
		["add", path.basename(marker)],
		["-c", "user.name=Bobbit E2E", "-c", "user.email=bobbit-e2e@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initialize Pack Local Data sandbox fixture"],
	]) {
		const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	}
}

interface FixturePackOptions {
	packName: string;
	dirName: string;
	piExtension: string;
	toolName: string;
	marker: string;
	localDataDirectory?: string;
}

function createPiPackSource(parent: string, options: FixturePackOptions): string {
	const sourceRoot = fs.mkdtempSync(path.join(parent, "pi-winner-source-"));
	fixtureSourceRoots.push(sourceRoot);
	const extensionRoot = path.join(sourceRoot, options.dirName, "pi-extensions", options.piExtension);
	fs.mkdirSync(extensionRoot, { recursive: true });
	const localData = options.localDataDirectory
		? `localData:\n  scope: project\n  directory: ${options.localDataDirectory}\n  access: read-write\n  preserveOnUninstall: true\n`
		: "";
	fs.writeFileSync(path.join(sourceRoot, options.dirName, "pack.yaml"), `name: ${options.packName}
schema: 2
description: Same-ID Pi winner regression fixture.
version: 1.0.0
defaultDisabled: true
${localData}contents:
  roles: []
  tools: []
  skills: []
  entrypoints: []
  providers: []
  hooks: []
  mcp: []
  pi-extensions: [${options.piExtension}]
  runtimes: []
  workflows: []
`, "utf8");
	const bindingBody = options.localDataDirectory
		? `const raw = process.env.BOBBIT_PACK_LOCAL_DATA_JSON;
		if (!raw) throw new Error("missing Pack Local Data environment");
		const bindings = JSON.parse(raw);
		const directory = bindings[${JSON.stringify(options.packName)}];
		if (typeof directory !== "string" || !directory) throw new Error("missing same-ID Pack Local Data binding");
		return { marker: ${JSON.stringify(options.marker)}, directory, bindingKeys: Object.keys(bindings).sort() };`
		: `return { marker: ${JSON.stringify(options.marker)} };`;
	fs.writeFileSync(path.join(extensionRoot, "extension.ts"), `export default function activate(pi: any) {
	pi.tool({
		name: ${JSON.stringify(options.toolName)},
		description: "Reports which same-ID Pi extension was activated.",
		inputSchema: { type: "object", properties: {} },
	}, () => {
		${bindingBody}
	});
}
`, "utf8");
	return sourceRoot;
}

async function addFixtureSource(sourceRoot: string): Promise<string> {
	const response = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: sourceRoot }),
	});
	const text = await response.text();
	expect(response.status, text).toBe(201);
	const id = JSON.parse(text).source.id;
	fixtureSourceIds.add(id);
	return id;
}

async function installFixturePack(
	sourceRoot: string,
	dirName: string,
	packName: string,
	scope: "server" | "project",
	projectId?: string,
): Promise<void> {
	const fixtureSourceId = await addFixtureSource(sourceRoot);
	const install = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId: fixtureSourceId, dirName, scope, ...(projectId ? { projectId } : {}) }),
	});
	const installText = await install.text();
	expect(install.status, installText).toBe(201);
	fixtureInstalls.push({ packName, scope, projectId });
	const enable = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope, packName, ...(projectId ? { projectId } : {}), disabled: { enabled: true } }),
	});
	const enableText = await enable.text();
	expect(enable.status, enableText).toBe(200);
}

function extensionArgs(gateway: any, sessionId: string): string[] {
	const args: string[] = gateway.sessionManager.getSession(sessionId)?.rpcClient?.options?.args ?? [];
	const extensions: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--extension" && typeof args[index + 1] === "string") extensions.push(args[++index]);
	}
	return extensions.map(extension => extension.replace(/\\/g, "/"));
}

function runtimeEnvironment(gateway: any, sessionId: string): Record<string, string> {
	return gateway.sessionManager.getSession(sessionId)?.rpcClient?.options?.env ?? {};
}

async function installFixture(projectId?: string): Promise<void> {
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
}

async function setFixtureActivation(disabled: Record<string, unknown>, projectId?: string): Promise<any> {
	const response = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({
			scope: projectId ? "project" : "server",
			packName: PACK,
			...(projectId ? { projectId } : {}),
			disabled,
		}),
	});
	const text = await response.text();
	expect(response.status, text).toBe(200);
	return JSON.parse(text);
}

async function installAndEnable(projectId?: string): Promise<void> {
	await installFixture(projectId);
	await setFixtureActivation({ enabled: true }, projectId);
}

async function uninstall(projectId?: string): Promise<Response> {
	return apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: projectId ? "project" : "server", packName: PACK, ...(projectId ? { projectId } : {}) }),
	});
}

async function piToolIsListed(): Promise<boolean> {
	const response = await apiFetch("/api/tools");
	expect(response.status).toBe(200);
	return ((await response.json()).tools ?? []).some((tool: any) => tool.name === PI_TOOL);
}

async function waitForPiTool(): Promise<void> {
	await expect.poll(piToolIsListed, {
		timeout: 15_000,
		message: `${PI_TOOL} should be discovered before session creation`,
	}).toBe(true);
}

function hasFixturePiExtension(gateway: any, sessionId: string): boolean {
	return extensionArgs(gateway, sessionId).some(extension => extension.endsWith("/pack-local-data/pi-extensions/marker/extension.ts"));
}

async function runPiTool(sessionId: string, input: Record<string, unknown>, toolName = PI_TOOL): Promise<any> {
	const connection = await connectWs(sessionId);
	try {
		const cursor = connection.messageCount();
		connection.send({ type: "prompt", text: `PI_EXTENSION_TOOL:${toolName}::${JSON.stringify(input)}` });
		const result = await connection.waitForFrom(
			cursor,
			message => message.type === "event"
				&& message.data?.type === "message_end"
				&& message.data?.message?.role === "toolResult"
				&& message.data?.message?.toolName === toolName,
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

function runContainerMarker(
	containerId: string,
	bindingJson: string,
	input: { operation: "read" | "write"; name: string; content?: string },
): { directory: string; name: string; content: string } {
	const script = `
const fs = require("node:fs");
const path = require("node:path");
const [operation, name, content] = process.argv.slice(1);
const directory = JSON.parse(process.env.BOBBIT_PACK_LOCAL_DATA_JSON)[${JSON.stringify(PACK)}];
const file = path.join(directory, name);
const result = operation === "read"
  ? { directory, name, content: fs.readFileSync(file, "utf8") }
  : (fs.writeFileSync(file, content, "utf8"), { directory, name, content });
process.stdout.write(JSON.stringify(result));
`;
	const result = spawnSync("docker", [
		"exec",
		"-e", `BOBBIT_PACK_LOCAL_DATA_JSON=${bindingJson}`,
		containerId,
		"node", "-e", script,
		input.operation, input.name, input.content ?? "",
	], { encoding: "utf8" });
	expect(result.status, result.stderr || result.stdout).toBe(0);
	return JSON.parse(result.stdout);
}

async function packIsContributed(projectId?: string): Promise<boolean> {
	const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	const response = await apiFetch(`/api/ext/contributions${suffix}`);
	expect(response.status).toBe(200);
	return ((await response.json()).packs ?? []).some((pack: any) => pack.packId === PACK);
}

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
	for (const sessionId of sessionIds.splice(0)) await deleteSession(sessionId).catch(() => {});
	if (sandboxConfigured) {
		const project = await defaultProject().catch(() => undefined);
		if (project) await apiFetch(`/api/projects/${project.id}/config`, { method: "PUT", body: JSON.stringify({ sandbox: "none" }) }).catch(() => {});
		sandboxConfigured = false;
	}
	for (const fixture of fixtureInstalls.splice(0).reverse()) {
		await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: fixture.scope, packName: fixture.packName, ...(fixture.projectId ? { projectId: fixture.projectId } : {}) }),
		}).catch(() => {});
	}
	if (sourceId) await setFixtureActivation({}).catch(() => {});
	await uninstall().catch(() => {});
	if (sourceId) {
		await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
		sourceId = undefined;
	}
	for (const id of fixtureSourceIds) {
		await apiFetch(`/api/marketplace/sources/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
	}
	fixtureSourceIds.clear();
	for (const root of fixtureSourceRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	const project = await defaultProject().catch(() => undefined);
	if (project) {
		for (const directory of [".pack-local-data-fixture", ".pi-winner-project", ".pi-winner-server"]) {
			fs.rmSync(path.join(project.rootPath, directory), { recursive: true, force: true });
		}
	}
	if (fixtureGitProjectRoot) {
		fs.rmSync(path.join(fixtureGitProjectRoot, ".git"), { recursive: true, force: true });
		fs.rmSync(path.join(fixtureGitProjectRoot, ".pack-local-data-git-fixture"), { force: true });
		fixtureGitProjectRoot = undefined;
	}
});

test("default-disabled installed local data stays inert until enabled and preserves data after the override is cleared", async ({ gateway }) => {
	const project = await defaultProject();
	const declaredDirectory = path.join(project.rootPath, ".pack-local-data-fixture");
	fs.rmSync(declaredDirectory, { recursive: true, force: true });

	await installFixture();

	const installedResponse = await apiFetch(`/api/marketplace/installed?projectId=${encodeURIComponent(project.id)}`);
	expect(installedResponse.status).toBe(200);
	const installedRows = (await installedResponse.json()).installed ?? [];
	const rawInstalledRow = installedRows.find((row: any) => row.packName === PACK && row.scope === "server" && row.builtin !== true);
	expect(rawInstalledRow, "default-disabled installed packs must remain visible in the raw Marketplace listing").toBeTruthy();
	expect(rawInstalledRow.manifest.defaultDisabled).toBe(true);

	expect(await packIsContributed()).toBe(false);
	expect(await piToolIsListed()).toBe(false);
	const disabledSession = await createSession({ projectId: project.id });
	sessionIds.push(disabledSession);
	expect(runtimeEnvironment(gateway, disabledSession).BOBBIT_PACK_LOCAL_DATA_JSON).toBeUndefined();
	expect(hasFixturePiExtension(gateway, disabledSession)).toBe(false);
	expect(fs.existsSync(declaredDirectory), "default-OFF session activation must not materialize local data").toBe(false);

	const enabled = await setFixtureActivation({ enabled: true });
	expect(enabled.disabled.enabled).toBe(true);
	await expect.poll(() => packIsContributed(), { timeout: 15_000 }).toBe(true);
	await waitForPiTool();

	const enabledSession = await createSession({ projectId: project.id });
	sessionIds.push(enabledSession);
	const expectedDirectory = fs.realpathSync(declaredDirectory);
	expect(JSON.parse(runtimeEnvironment(gateway, enabledSession).BOBBIT_PACK_LOCAL_DATA_JSON)).toEqual({
		[PACK]: expectedDirectory,
	});
	expect(hasFixturePiExtension(gateway, enabledSession)).toBe(true);
	const markerPath = path.join(expectedDirectory, "default-disabled-marker.txt");
	const markerContent = "default-disabled lifecycle marker: π\n";
	const writeResult = await runPiTool(enabledSession, {
		operation: "write",
		name: path.basename(markerPath),
		content: markerContent,
	});
	expect(writeResult).toMatchObject({ directory: expectedDirectory, content: markerContent });
	const markerBytes = fs.readFileSync(markerPath);

	const cleared = await setFixtureActivation({});
	expect(cleared.disabled.enabled).toBeUndefined();
	await expect.poll(() => packIsContributed(), { timeout: 15_000 }).toBe(false);
	await expect.poll(piToolIsListed, { timeout: 15_000 }).toBe(false);

	const freshDisabledSession = await createSession({ projectId: project.id });
	sessionIds.push(freshDisabledSession);
	expect(runtimeEnvironment(gateway, freshDisabledSession).BOBBIT_PACK_LOCAL_DATA_JSON).toBeUndefined();
	expect(hasFixturePiExtension(gateway, freshDisabledSession)).toBe(false);
	expect(fs.readFileSync(markerPath)).toEqual(markerBytes);
});

test("ordinary and Pi runtime access share the canonical project directory and preserve it", async ({ gateway }) => {
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

	const removed = await uninstall();
	expect(removed.status).toBe(204);
	await expect.poll(() => packIsContributed(), { timeout: 15_000 }).toBe(false);
	expect(fs.readFileSync(path.join(expectedDirectory, "pi-marker.txt"), "utf8")).toBe("written-by-pi-host");
	expect(fs.readFileSync(path.join(expectedDirectory, "ordinary-marker.txt"), "utf8")).toBe("E2E_WRITE_TEST\n");
});

test("same-ID Pi activation follows the local-data winner and falls back after project uninstall", async ({ gateway }) => {
	const project = await defaultProject();
	const serverSource = createPiPackSource(gateway.bobbitDir, {
		packName: WINNER_PACK,
		dirName: "server-same-id",
		piExtension: "server-winner",
		toolName: "pi_same_id_server_marker",
		marker: "server",
		localDataDirectory: ".pi-winner-server",
	});
	const projectSource = createPiPackSource(gateway.bobbitDir, {
		packName: WINNER_PACK,
		dirName: "project-same-id",
		piExtension: "project-winner",
		toolName: "pi_same_id_project_marker",
		marker: "project",
		localDataDirectory: ".pi-winner-project",
	});
	await installFixturePack(serverSource, "server-same-id", WINNER_PACK, "server");
	await installFixturePack(projectSource, "project-same-id", WINNER_PACK, "project", project.id);

	const projectSession = await createSession({ projectId: project.id });
	sessionIds.push(projectSession);
	const projectExtensions = extensionArgs(gateway, projectSession);
	expect(projectExtensions.some(extension => extension.endsWith("/pi-extensions/project-winner/extension.ts"))).toBe(true);
	expect(projectExtensions.some(extension => extension.endsWith("/pi-extensions/server-winner/extension.ts")), "the shadowed server extension must not receive the project winner's binding").toBe(false);
	const projectDirectory = fs.realpathSync(path.join(project.rootPath, ".pi-winner-project"));
	expect(JSON.parse(runtimeEnvironment(gateway, projectSession).BOBBIT_PACK_LOCAL_DATA_JSON)).toEqual({
		[WINNER_PACK]: projectDirectory,
	});
	expect(await runPiTool(projectSession, {}, "pi_same_id_project_marker")).toEqual({
		marker: "project",
		directory: projectDirectory,
		bindingKeys: [WINNER_PACK],
	});

	const removed = await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "project", projectId: project.id, packName: WINNER_PACK }),
	});
	expect(removed.status).toBe(204);
	const fallbackSession = await createSession({ projectId: project.id });
	sessionIds.push(fallbackSession);
	const fallbackExtensions = extensionArgs(gateway, fallbackSession);
	expect(fallbackExtensions.some(extension => extension.endsWith("/pi-extensions/server-winner/extension.ts"))).toBe(true);
	expect(fallbackExtensions.some(extension => extension.endsWith("/pi-extensions/project-winner/extension.ts"))).toBe(false);
	const serverDirectory = fs.realpathSync(path.join(project.rootPath, ".pi-winner-server"));
	expect(JSON.parse(runtimeEnvironment(gateway, fallbackSession).BOBBIT_PACK_LOCAL_DATA_JSON)).toEqual({
		[WINNER_PACK]: serverDirectory,
	});
	expect(await runPiTool(fallbackSession, {}, "pi_same_id_server_marker")).toEqual({
		marker: "server",
		directory: serverDirectory,
		bindingKeys: [WINNER_PACK],
	});
});

test("same-ID Pi packs without local data preserve legacy multiple-entry activation", async ({ gateway }) => {
	const project = await defaultProject();
	const serverSource = createPiPackSource(gateway.bobbitDir, {
		packName: LEGACY_PACK,
		dirName: "legacy-server-same-id",
		piExtension: "legacy-server",
		toolName: "pi_legacy_same_id_server",
		marker: "legacy-server",
	});
	const projectSource = createPiPackSource(gateway.bobbitDir, {
		packName: LEGACY_PACK,
		dirName: "legacy-project-same-id",
		piExtension: "legacy-project",
		toolName: "pi_legacy_same_id_project",
		marker: "legacy-project",
	});
	await installFixturePack(serverSource, "legacy-server-same-id", LEGACY_PACK, "server");
	await installFixturePack(projectSource, "legacy-project-same-id", LEGACY_PACK, "project", project.id);

	const sessionId = await createSession({ projectId: project.id });
	sessionIds.push(sessionId);
	const extensions = extensionArgs(gateway, sessionId);
	expect(extensions.some(extension => extension.endsWith("/pi-extensions/legacy-server/extension.ts"))).toBe(true);
	expect(extensions.some(extension => extension.endsWith("/pi-extensions/legacy-project/extension.ts"))).toBe(true);
	expect(runtimeEnvironment(gateway, sessionId).BOBBIT_PACK_LOCAL_DATA_JSON).toBeUndefined();
	expect(await runPiTool(sessionId, {}, "pi_legacy_same_id_server")).toEqual({ marker: "legacy-server" });
	expect(await runPiTool(sessionId, {}, "pi_legacy_same_id_project")).toEqual({ marker: "legacy-project" });
});

test("sandbox mount is writable in both directions at the stable pack path", async ({ gateway }) => {
	const project = await defaultProject();
	await installAndEnable();
	await waitForPiTool();

	const docker = {
		info: spawnSync("docker", ["info"], { stdio: "ignore" }),
		image: spawnSync("docker", ["image", "inspect", "bobbit-agent"], { stdio: "ignore" }),
	};
	test.skip(docker.info.status !== 0 || docker.image.status !== 0, "Docker and the bobbit-agent image are required for the writable bind-mount round trip");

	initializeFixtureGitRepository(project.rootPath);
	const gitProbe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: project.rootPath, encoding: "utf8" });
	expect(gitProbe.status, gitProbe.stderr || gitProbe.stdout).toBe(0);
	expect(gitProbe.stdout.trim(), "the sandbox project precondition must be a real Git worktree").toBe("true");

	const setSandbox = await apiFetch(`/api/projects/${project.id}/config`, {
		method: "PUT",
		body: JSON.stringify({ sandbox: "docker" }),
	});
	const configText = await setSandbox.text();
	expect(setSandbox.status, configText).toBe(200);
	sandboxConfigured = true;

	const sessionId = await createSession({ projectId: project.id, cwd: project.rootPath, sandboxed: true });
	sessionIds.push(sessionId);
	await waitForSessionStatus(sessionId, "idle");
	const readyResponse = await apiFetch("/api/sandbox-pool");
	expect(readyResponse.status).toBe(200);
	const readySandbox = ((await readyResponse.json()).containers ?? [])
		.find((container: any) => container.projectId === project.id);
	expect(readySandbox, "public sandboxed session creation must initialize the project sandbox").toMatchObject({
		projectId: project.id,
		status: "ready",
	});
	expect(gateway.sessionManager.getSession(sessionId)?.sandboxed, "the mount round trip must run in the requested sandbox realm").toBe(true);
	const declaredHostDirectory = path.join(project.rootPath, ".pack-local-data-fixture");
	expect(fs.existsSync(declaredHostDirectory), "sandbox activation must materialize the host directory before mounting it").toBe(true);
	const expectedHostDirectory = fs.realpathSync(declaredHostDirectory);
	const expectedContainerDirectory = "/bobbit/local-data/pack-local-data";
	const runtimeOptions = gateway.sessionManager.getSession(sessionId)?.rpcClient?.options ?? {};
	const runtimeEnvironment = runtimeOptions.env ?? {};
	const runtimeContainerId = runtimeOptions.containerId;
	expect(runtimeContainerId, "the sandbox session must own a Docker runtime").toBeTruthy();
	expect(JSON.parse(runtimeEnvironment.BOBBIT_PACK_LOCAL_DATA_JSON)).toEqual({ [PACK]: expectedContainerDirectory });

	const containerWrite = runContainerMarker(runtimeContainerId, runtimeEnvironment.BOBBIT_PACK_LOCAL_DATA_JSON, {
		operation: "write",
		name: "container-marker.txt",
		content: "written-in-container",
	});
	expect(containerWrite.directory).toBe(expectedContainerDirectory);
	expect(fs.readFileSync(path.join(expectedHostDirectory, "container-marker.txt"), "utf8")).toBe("written-in-container");

	fs.writeFileSync(path.join(expectedHostDirectory, "host-marker.txt"), "written-on-host", "utf8");
	const containerRead = runContainerMarker(runtimeContainerId, runtimeEnvironment.BOBBIT_PACK_LOCAL_DATA_JSON, {
		operation: "read",
		name: "host-marker.txt",
	});
	expect(containerRead).toMatchObject({ directory: expectedContainerDirectory, content: "written-on-host" });
	const markerBytes = fs.readFileSync(path.join(expectedHostDirectory, "container-marker.txt"));

	await setFixtureActivation({});
	await expect.poll(() => packIsContributed(), { timeout: 15_000 }).toBe(false);
	await expect.poll(piToolIsListed, { timeout: 15_000 }).toBe(false);

	const disabledSession = await createSession({ projectId: project.id });
	sessionIds.push(disabledSession);
	expect(runtimeEnvironment(gateway, disabledSession).BOBBIT_PACK_LOCAL_DATA_JSON).toBeUndefined();
	expect(hasFixturePiExtension(gateway, disabledSession)).toBe(false);
	expect(fs.readFileSync(path.join(expectedHostDirectory, "container-marker.txt"))).toEqual(markerBytes);

	const poolResponse = await apiFetch("/api/sandbox-pool");
	expect(poolResponse.status).toBe(200);
	const containerId = ((await poolResponse.json()).containers ?? [])
		.find((container: any) => container.projectId === project.id)?.containerId;
	expect(containerId, "the refreshed project sandbox must remain tracked").toBeTruthy();
	const inspect = spawnSync("docker", ["inspect", containerId], { encoding: "utf8" });
	expect(inspect.status, inspect.stderr).toBe(0);
	const mounts = JSON.parse(inspect.stdout)[0]?.Mounts ?? [];
	expect(mounts.some((mount: any) => mount.Destination === expectedContainerDirectory),
		"clearing the default-disabled override must remove the stale local-data bind").toBe(false);

	const restoreConfig = await apiFetch(`/api/projects/${project.id}/config`, {
		method: "PUT",
		body: JSON.stringify({ sandbox: "none" }),
	});
	expect(restoreConfig.status).toBe(200);
	sandboxConfigured = false;
});
