import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	bobbitStateDir,
	getAgentDirState,
	getProjectRoot,
	initializeAgentDirRuntime,
	resetAgentDirStateForTests,
	setProjectRoot,
	type AgentDirRuntimeState,
} from "../../src/server/bobbit-dir.js";
import type { CommandRunner, ExecFileOptions, GatewayDeps } from "../../src/server/gateway-deps.js";
import { realClock, realFs } from "../../src/server/gateway-deps.js";
import { scaffoldBobbitDir } from "../../src/server/scaffold.js";
import { createGateway } from "../../src/server/server.js";
import { SandboxManager } from "../../src/server/agent/sandbox-manager.js";
import { ProjectSandbox } from "../../src/server/agent/project-sandbox.js";

const TOKEN = "sandbox-extension-requirements-token";
const PACK_ID = "sandbox-requirements-integration-fixture";
const REQUIREMENT_ID = "python-analysis";

const ENV_KEYS = ["BOBBIT_DIR", "BOBBIT_SECRETS_DIR", "BOBBIT_AGENT_DIR", "BOBBIT_SKIP_AIGW_DISCOVERY", "BOBBIT_TEST_NO_EXTERNAL", "NODE_ENV"] as const;
type ProcessState = { env: Record<(typeof ENV_KEYS)[number], string | undefined>; projectRoot: string; agentDirState?: AgentDirRuntimeState };
type DockerImage = { fingerprint: string; piVersion: string };
type RunnerCall = { file: string; args: readonly string[]; options?: ExecFileOptions };

type Fixture = {
	root: string;
	packDir: string;
	baseUrl: string;
	gateway: ReturnType<typeof createGateway>;
	runner: CommandRunner & { calls: RunnerCall[]; images: Map<string, DockerImage> };
	projectA: string;
	projectB: string;
	operatorHeaders: Record<string, string>;
};

function snapshotProcessState(): ProcessState {
	let agentDirState: AgentDirRuntimeState | undefined;
	try { agentDirState = getAgentDirState(); } catch { /* no active runtime */ }
	return { env: Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as ProcessState["env"], projectRoot: getProjectRoot(), ...(agentDirState ? { agentDirState } : {}) };
}

function restoreProcessState(state: ProcessState): void {
	for (const key of ENV_KEYS) {
		const value = state.env[key];
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	setProjectRoot(state.projectRoot);
	resetAgentDirStateForTests();
	if (state.agentDirState) initializeAgentDirRuntime({ env: process.env, projectRoot: state.agentDirState.startup.projectRoot, stateDir: bobbitStateDir(state.agentDirState.startup.projectRoot), persisted: state.agentDirState.persisted });
}

function activateFixtureRoot(root: string): void {
	process.env.BOBBIT_DIR = root;
	process.env.BOBBIT_SECRETS_DIR = path.join(root, "secrets");
	process.env.BOBBIT_AGENT_DIR = path.join(root, "agent");
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
	process.env.NODE_ENV = "test";
	setProjectRoot(root);
	resetAgentDirStateForTests();
}

function writeFixturePack(root: string): string {
	const packDir = path.join(root, "config", "market-packs", PACK_ID);
	fs.mkdirSync(path.join(packDir, "sandbox-requirements"), { recursive: true });
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: test", "sourceRef: local", "commit: fixture", `packName: ${PACK_ID}`,
		"version: 1.0.0", "installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 3", `name: ${PACK_ID}`, "description: Inert sandbox requirement fixture", "version: 1.0.0",
		"contents:", "  roles: []", "  tools: []", "  skills: []", "  entrypoints: []", "  providers: []", "  hooks: []", "  mcp: []", "  pi-extensions: []", "  runtimes: []", "  workflows: []", `  sandboxRequirements: [${REQUIREMENT_ID}]`,
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "sandbox-requirements", `${REQUIREMENT_ID}.yaml`), [
		`id: ${REQUIREMENT_ID}`, "profiles: [python]", "config:", "  enabled: { type: boolean, default: true }", "activation:", "  requiresConfig: [enabled]",
	].join("\n") + "\n");
	return packDir;
}

function fakeDockerRunner(): CommandRunner & { calls: RunnerCall[]; images: Map<string, DockerImage> } {
	const calls: RunnerCall[] = [];
	const images = new Map<string, DockerImage>();
	return {
		calls,
		images,
		async execFile(file: string, args: readonly string[], options?: ExecFileOptions) {
			calls.push({ file, args, options });
			if (file !== "docker") throw new Error(`SANDBOX_REQUIREMENTS_UNEXPECTED_COMMAND: ${file}`);
			if (args[0] === "info") return { stdout: "25.0.0\n", stderr: "" };
			if (args[0] === "image" && args[1] === "inspect") {
				if (!images.has(args[2]!)) throw new Error("image not found");
				return { stdout: "[]", stderr: "" };
			}
			if (args[0] === "inspect") {
				const image = images.get(args.at(-1)!);
				if (!image) throw new Error("image not found");
				const label = args[2]?.includes("sandbox-requirements-fingerprint") ? image.fingerprint : image.piVersion;
				return { stdout: `${label}\n`, stderr: "" };
			}
			if (args[0] === "build") {
				const tag = args[args.indexOf("-t") + 1];
				const fingerprintArg = args.find(arg => arg.startsWith("BOBBIT_SANDBOX_REQUIREMENTS_FINGERPRINT="));
				if (!tag || !fingerprintArg) throw new Error("SANDBOX_REQUIREMENTS_BUILD_ARGS_MISSING");
				const piVersion = args.find(arg => arg.startsWith("PI_AGENT_VERSION="))?.slice("PI_AGENT_VERSION=".length) ?? "";
				images.set(tag, { fingerprint: fingerprintArg.slice("BOBBIT_SANDBOX_REQUIREMENTS_FINGERPRINT=".length), piVersion });
				return { stdout: "built\n", stderr: "" };
			}
			throw new Error(`SANDBOX_REQUIREMENTS_UNEXPECTED_DOCKER: ${args.join(" ")}`);
		},
	};
}

async function responseJson(response: Response): Promise<any> {
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

async function api(fixture: Fixture, requestPath: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${fixture.baseUrl}${requestPath}`, {
		...init,
		headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) },
	});
}

async function status(fixture: Fixture, projectId: string): Promise<any> {
	const response = await api(fixture, `/api/sandbox-status?projectId=${encodeURIComponent(projectId)}`);
	expect(response.status, await response.clone().text()).toBe(200);
	return responseJson(response);
}

function requirementStatus(body: any): any {
	expect(body.requirements, "SANDBOX_REQUIREMENTS_STATUS_MISSING: status must expose the server-resolved requirement state").toBeTruthy();
	return body.requirements;
}

async function setPackActivation(fixture: Fixture, disabled: Record<string, unknown>): Promise<void> {
	const response = await api(fixture, "/api/marketplace/pack-activation", { method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled }) });
	expect(response.status, await response.clone().text()).toBe(200);
}

async function grant(fixture: Fixture): Promise<void> {
	const response = await api(fixture, `/api/projects/${encodeURIComponent(fixture.projectA)}/extension-grants`, {
		method: "PUT", headers: fixture.operatorHeaders,
		body: JSON.stringify({ packId: PACK_ID, principal: "pack", capability: "sandbox:build" }),
	});
	expect(response.status, await response.clone().text()).toBe(200);
}

async function revoke(fixture: Fixture): Promise<void> {
	const response = await api(fixture, `/api/projects/${encodeURIComponent(fixture.projectA)}/extension-grants/${encodeURIComponent(PACK_ID)}/principals/pack/sandbox%3Abuild`, {
		method: "DELETE", headers: fixture.operatorHeaders,
	});
	expect(response.status, await response.clone().text()).toBe(200);
}

async function setRequirementEnabled(fixture: Fixture, enabled: boolean): Promise<void> {
	const settingsPath = `/api/projects/${encodeURIComponent(fixture.projectA)}/extension-settings`;
	const current = await api(fixture, settingsPath);
	expect(current.status, await current.clone().text()).toBe(200);
	const body = await responseJson(current);
	const target = body.targets?.find((candidate: any) => candidate.ref?.packId === PACK_ID && candidate.ref?.kind === "sandboxRequirement" && candidate.ref?.id === REQUIREMENT_ID);
	expect(target, "SANDBOX_REQUIREMENTS_SETTINGS_TARGET_MISSING").toBeTruthy();
	const response = await api(fixture, `${settingsPath}/${encodeURIComponent(PACK_ID)}/sandboxRequirement/${REQUIREMENT_ID}`, {
		method: "PATCH", headers: fixture.operatorHeaders,
		body: JSON.stringify({ expectedRevision: body.revision, enabled }),
	});
	expect(response.status, await response.clone().text()).toBe(200);
}

async function bootFixture(): Promise<Fixture> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sandbox-requirements-"));
	let gateway: ReturnType<typeof createGateway> | undefined;
	try {
		activateFixtureRoot(root);
		fs.mkdirSync(path.join(root, "state", "session-prompts"), { recursive: true });
		fs.mkdirSync(path.join(root, "secrets"), { recursive: true });
		fs.mkdirSync(path.join(root, "agent"), { recursive: true });
		fs.writeFileSync(path.join(root, "state", "projects.json"), "[]");
		fs.writeFileSync(path.join(root, "state", "setup-complete"), "test\n");
		scaffoldBobbitDir(root);
		const packDir = writeFixturePack(root);
		const runner = fakeDockerRunner();
		const deps: GatewayDeps = { clock: realClock, commandRunner: runner, fetchImpl: async () => new Response("network fenced", { status: 503 }), agentBridgeFactory: () => null, fsImpl: realFs };
		gateway = createGateway({ host: "127.0.0.1", port: 0, portExplicit: true, authToken: TOKEN, defaultCwd: root, forceAuth: true, skipMcp: true, skipWorktreePool: true, skipTitleGeneration: true, skipRemotePush: true, skipNonLocalRemoteGit: true, builtinsDir: path.resolve("defaults"), builtinPacksDir: path.resolve("market-packs") }, deps);
		const baseUrl = `http://127.0.0.1:${await gateway.start()}`;
		const register = async (name: string, image: string): Promise<string> => {
			const projectRoot = path.join(root, name);
			fs.mkdirSync(projectRoot, { recursive: true });
			const response = await fetch(`${baseUrl}/api/projects`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, rootPath: projectRoot, upsert: true, acceptCanonical: true }) });
			if (!response.ok) throw new Error(`fixture project registration failed: ${response.status} ${await response.text()}`);
			const project = await response.json() as { id: string };
			const config = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}/config`, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ sandbox: "docker", sandbox_image: image }) });
			if (!config.ok) throw new Error(`fixture sandbox config failed: ${config.status} ${await config.text()}`);
			return project.id;
		};
		const projectA = await register("project-a", "registry.example.test/team/agent:a");
		const projectB = await register("project-b", "registry.example.test/team/agent:b");
		const cookieResponse = await fetch(`${baseUrl}/api/goals`, { headers: { Authorization: `Bearer ${TOKEN}`, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" } });
		const setCookies = (cookieResponse.headers as any).getSetCookie?.() as string[] | undefined ?? (cookieResponse.headers.get("set-cookie") ? [cookieResponse.headers.get("set-cookie")!] : []);
		const cookie = setCookies.map(value => value.split(";")[0]).find(value => value.startsWith("bobbit_session="));
		if (!cookie) throw new Error("fixture did not mint an operator cookie");
		return { root, packDir, baseUrl, gateway, runner, projectA, projectB, operatorHeaders: { Cookie: cookie } };
	} catch (error) {
		await gateway?.shutdown().catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

describe.sequential("sandbox extension requirements integration", () => {
	const processState = snapshotProcessState();
	let fixture!: Fixture;

	beforeAll(async () => { fixture = await bootFixture(); });
	afterAll(async () => {
		try { await fixture?.gateway.shutdown(); } finally { if (fixture?.root) fs.rmSync(fixture.root, { recursive: true, force: true }); restoreProcessState(processState); }
	});

	it("resolves only the selected project's authorized requirement, ignores client build inputs, and reports pending to available", async () => {
		await setPackActivation(fixture, { enabled: true, sandboxRequirements: [] });
		const beforeGrant = requirementStatus(await status(fixture, fixture.projectA));
		expect(beforeGrant).toMatchObject({ profiles: [], entries: [] });

		await grant(fixture);
		const pending = requirementStatus(await status(fixture, fixture.projectA));
		expect(pending).toMatchObject({ profiles: ["python"], entries: [{ packId: PACK_ID, requirementId: REQUIREMENT_ID, state: "pending" }] });
		const otherProject = requirementStatus(await status(fixture, fixture.projectB));
		expect(otherProject).toMatchObject({ profiles: [], entries: [] });

		const build = await api(fixture, "/api/sandbox-image/build", {
			method: "POST",
			body: JSON.stringify({ projectId: fixture.projectA, requirements: [{ packId: "attacker", profiles: ["python --build-arg EVIL=1"], imageName: "attacker/owned:tag" }] }),
		});
		expect(build.status, await build.clone().text()).toBe(200);
		const dockerBuild = fixture.runner.calls.find(call => call.file === "docker" && call.args[0] === "build");
		expect(dockerBuild, "SANDBOX_REQUIREMENTS_BUILD_NOT_RUN").toBeTruthy();
		expect(dockerBuild!.args).toContain("BOBBIT_SANDBOX_TOOLCHAINS=python");
		expect(dockerBuild!.args.join("\n")).not.toContain("attacker");
		expect(dockerBuild!.args.join("\n")).not.toContain("EVIL");

		const available = requirementStatus(await status(fixture, fixture.projectA));
		expect(available).toMatchObject({ fingerprint: pending.fingerprint, profiles: ["python"], entries: [{ packId: PACK_ID, requirementId: REQUIREMENT_ID, state: "available" }] });
		expect(requirementStatus(await status(fixture, fixture.projectB))).toMatchObject({ profiles: [], entries: [] });
	});

	it("invalidates persisted plans on reload, grant revoke, settings disable, activation disable, and pack removal", async () => {
		// A fresh request after a completed build is the API-level reload boundary.
		expect(requirementStatus(await status(fixture, fixture.projectA))).toMatchObject({ profiles: ["python"], entries: [{ state: "available" }] });

		await revoke(fixture);
		expect(requirementStatus(await status(fixture, fixture.projectA))).toMatchObject({ profiles: [], entries: [] });
		await grant(fixture);
		expect(requirementStatus(await status(fixture, fixture.projectA))).toMatchObject({ profiles: ["python"] });

		await setRequirementEnabled(fixture, false);
		expect(requirementStatus(await status(fixture, fixture.projectA))).toMatchObject({ profiles: [], entries: [] });
		await setRequirementEnabled(fixture, true);
		expect(requirementStatus(await status(fixture, fixture.projectA))).toMatchObject({ profiles: ["python"] });

		await setPackActivation(fixture, { enabled: true, sandboxRequirements: [REQUIREMENT_ID] });
		expect(requirementStatus(await status(fixture, fixture.projectA))).toMatchObject({ profiles: [], entries: [] });
		await setPackActivation(fixture, { enabled: true, sandboxRequirements: [] });
		expect(requirementStatus(await status(fixture, fixture.projectA))).toMatchObject({ profiles: ["python"] });

		fs.rmSync(fixture.packDir, { recursive: true, force: true });
		const order = await api(fixture, "/api/marketplace/pack-order?scope=server");
		expect(order.status, await order.clone().text()).toBe(200);
		const reordered = await api(fixture, "/api/marketplace/pack-order", { method: "PUT", body: JSON.stringify({ scope: "server", order: (await responseJson(order)).order ?? [] }) });
		expect(reordered.status, await reordered.clone().text()).toBe(200);
		expect(requirementStatus(await status(fixture, fixture.projectA))).toMatchObject({ profiles: [], entries: [] });
	});

	it("recreates only the sandbox whose resolved plan changes", async () => {
		const created: string[] = [];
		const removed: string[] = [];
		const generations = new Map<string, number>();
		const init = vi.spyOn(ProjectSandbox.prototype, "init").mockImplementation(async function () {
			const sandbox = this as any;
			const projectId = sandbox.options?.projectId ?? "unknown";
			const generation = (generations.get(projectId) ?? 0) + 1;
			generations.set(projectId, generation);
			created.push(projectId);
			sandbox.containerId = `fixture-${projectId}-${generation}`;
			sandbox._status = "ready";
		});
		const remove = vi.spyOn(ProjectSandbox.prototype as any, "_removeContainer").mockImplementation(async (containerId: string) => { removed.push(containerId); });
		const start = vi.spyOn(ProjectSandbox.prototype, "startHealthMonitor").mockImplementation(() => {});
		const onHealth = vi.spyOn(ProjectSandbox.prototype, "onHealthEvent").mockImplementation(() => () => {});
		const stop = vi.spyOn(ProjectSandbox.prototype, "stopHealthMonitor").mockImplementation(() => {});
		try {
			const plans = new Map([["project-a", { image: "agent:a", fingerprint: "a" }], ["project-b", { image: "agent:b", fingerprint: "b" }]]);
			const manager = new SandboxManager({ bootstrap: async (projectId) => ({ projectId, projectDir: "/fixture", repoUrl: "file:///fixture", networkName: "fixture", image: plans.get(projectId)!.image, sandboxImageFingerprint: plans.get(projectId)!.fingerprint } as any) });
			await manager.ensureForProject("project-a");
			await manager.ensureForProject("project-b");
			plans.set("project-a", { image: "agent:a-python", fingerprint: "a-python" });
			await manager.ensureForProject("project-a");
			expect(created).toEqual(["project-a", "project-b", "project-a"]);
			expect(removed).toEqual(["fixture-project-a-1"]);
			expect(manager.get("project-a")?.getStatus().containerId).toBe("fixture-project-a-2");
			expect(manager.get("project-b")?.getStatus().containerId).toBe("fixture-project-b-1");
		} finally {
			init.mockRestore(); remove.mockRestore(); start.mockRestore(); onHealth.mockRestore(); stop.mockRestore();
		}
	});
});
