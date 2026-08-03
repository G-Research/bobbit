import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
import { MaintenanceGitModel } from "./helpers/maintenance-git-model.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = "maintenance-request-runner-isolation-token";
const ENV_KEYS = [
	"BOBBIT_DIR",
	"BOBBIT_SECRETS_DIR",
	"BOBBIT_AGENT_DIR",
	"BOBBIT_SKIP_AIGW_DISCOVERY",
	"BOBBIT_TEST_NO_EXTERNAL",
	"NODE_ENV",
] as const;

type ProcessState = {
	env: Record<(typeof ENV_KEYS)[number], string | undefined>;
	projectRoot: string;
	agentDirState?: AgentDirRuntimeState;
};

type RunnerCall = { file: string; args: readonly string[]; cwd?: string };
type GatewayFixture = {
	label: string;
	root: string;
	repoPath: string;
	worktreePath: string;
	branch: string;
	sessionId: string;
	projectId: string;
	model: MaintenanceGitModel;
	runner: CommandRunner & { calls: RunnerCall[] };
	gateway: ReturnType<typeof createGateway>;
	baseUrl: string;
};

function snapshotProcessState(): ProcessState {
	let agentDirState: AgentDirRuntimeState | undefined;
	try { agentDirState = getAgentDirState(); } catch { /* no active runtime */ }
	return {
		env: Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as ProcessState["env"],
		projectRoot: getProjectRoot(),
		...(agentDirState ? { agentDirState } : {}),
	};
}

function activateFixtureRoot(root: string): void {
	process.env.BOBBIT_DIR = root;
	process.env.BOBBIT_SECRETS_DIR = join(root, "secrets");
	process.env.BOBBIT_AGENT_DIR = join(root, "agent");
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
	process.env.NODE_ENV = "test";
	setProjectRoot(root);
	resetAgentDirStateForTests();
}

function restoreProcessState(state: ProcessState): void {
	for (const key of ENV_KEYS) {
		const value = state.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setProjectRoot(state.projectRoot);
	resetAgentDirStateForTests();
	if (state.agentDirState) {
		initializeAgentDirRuntime({
			env: process.env,
			projectRoot: state.agentDirState.startup.projectRoot,
			stateDir: bobbitStateDir(state.agentDirState.startup.projectRoot),
			persisted: state.agentDirState.persisted,
		});
	}
}

function ownsPath(root: string, cwd: string | undefined): boolean {
	return !!cwd && (cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`));
}

function createRunner(root: string, model: MaintenanceGitModel): CommandRunner & { calls: RunnerCall[] } {
	const calls: RunnerCall[] = [];
	return {
		calls,
		async execFile(file: string, args: readonly string[], options?: ExecFileOptions) {
			const cwd = typeof options?.cwd === "string" ? options.cwd : undefined;
			calls.push({ file, args, cwd });
			if (file === "docker") throw new Error(`Docker unavailable in ${root} fixture`);
			if (file !== "git") throw new Error(`unexpected ${root} fixture executable: ${file}`);
			if (!ownsPath(root, cwd)) {
				throw new Error(`MAINTENANCE_REQUEST_RUNNER_ISOLATION_REGRESSION: ${root} runner received foreign cwd ${cwd ?? "<none>"}`);
			}
			return { stdout: model.run(cwd!, args), stderr: "" };
		},
	};
}

async function bootGatewayFixture(label: string): Promise<GatewayFixture> {
	const root = mkdtempSync(join(tmpdir(), `bobbit-maintenance-runner-${label}-`));
	const repoPath = join(root, "project-repo");
	const worktreePath = join(root, "archived-worktree");
	const branch = `session/${label}-archived-worktree`;
	const sessionId = `${label}-archived-session`;
	const model = new MaintenanceGitModel(`maintenance-request-runner-${label}`);
	let gateway: ReturnType<typeof createGateway> | undefined;
	try {
		activateFixtureRoot(root);
		mkdirSync(join(root, "state", "session-prompts"), { recursive: true });
		mkdirSync(join(root, "secrets"), { recursive: true });
		mkdirSync(join(root, "agent"), { recursive: true });
		mkdirSync(join(repoPath, ".git"), { recursive: true });
		writeFileSync(join(root, "state", "projects.json"), "[]");
		writeFileSync(join(root, "state", "setup-complete"), "test\n");
		writeFileSync(join(repoPath, "README.md"), `# ${label} maintenance runner fixture\n`);
		scaffoldBobbitDir(root);
		model.registerRepo(repoPath);
		model.addWorktree(repoPath, worktreePath, branch);
		const runner = createRunner(root, model);
		const deps: GatewayDeps = {
			clock: realClock,
			commandRunner: runner,
			fetchImpl: async () => new Response("network fenced", { status: 503 }),
			agentBridgeFactory: () => null,
			fsImpl: realFs,
		};
		gateway = createGateway({
			host: "127.0.0.1",
			port: 0,
			portExplicit: true,
			authToken: TOKEN,
			defaultCwd: root,
			forceAuth: true,
			skipMcp: true,
			skipWorktreePool: true,
			skipTitleGeneration: true,
			skipRemotePush: true,
			skipNonLocalRemoteGit: true,
			builtinsDir: join(REPO_ROOT, "defaults"),
			builtinPacksDir: join(REPO_ROOT, "market-packs"),
		}, deps);
		const baseUrl = `http://127.0.0.1:${await gateway.start()}`;
		const projectResponse = await fetch(`${baseUrl}/api/projects`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ name: `${label} maintenance project`, rootPath: repoPath, upsert: true, acceptCanonical: true }),
		});
		if (!projectResponse.ok) throw new Error(`fixture ${label} project registration returned ${projectResponse.status}: ${await projectResponse.text()}`);
		const project = await projectResponse.json() as { id: string };
		gateway.sessionManager.getSessionStore(project.id).put({
			id: sessionId,
			projectId: project.id,
			title: `${label} archived worktree`,
			cwd: worktreePath,
			createdAt: 1,
			lastActivity: 2,
			archived: true,
			archivedAt: 3,
			repoPath,
			worktreePath,
			branch,
		} as any);
		return { label, root, repoPath, worktreePath, branch, sessionId, projectId: project.id, model, runner, gateway, baseUrl };
	} catch (error) {
		try { await gateway?.shutdown(); } catch { /* preserve the setup error */ }
		model.reset();
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

async function shutdownFixture(fixture: GatewayFixture | undefined): Promise<void> {
	if (!fixture) return;
	try { await fixture.gateway.shutdown(); }
	finally {
		fixture.model.reset();
		rmSync(fixture.root, { recursive: true, force: true });
	}
}

function archivedItem(body: any, fixture: GatewayFixture): any {
	return body.items.find((item: any) => item.sessionId === fixture.sessionId);
}

describe.sequential("maintenance request command-runner isolation", () => {
	const processState = snapshotProcessState();
	let gatewayA!: GatewayFixture;
	let gatewayB!: GatewayFixture;

	beforeAll(async () => {
		// Both cases must boot A then B: selected-test runs still exercise the
		// live-gateway construction order that exposes mutable runner leaks.
		gatewayA = await bootGatewayFixture("gateway-a");
		gatewayB = await bootGatewayFixture("gateway-b");
	});

	afterAll(async () => {
		try {
			await shutdownFixture(gatewayB);
			await shutdownFixture(gatewayA);
		} finally {
			restoreProcessState(processState);
		}
	});

	it("keeps archived-worktree scans on the runner captured by each live gateway", async () => {
		// Construction order is the regression trigger: current production code stores
		// B's runner globally, then A's request incorrectly resolves through B.
		const [responseA, responseB] = await Promise.all([
			fetch(`${gatewayA!.baseUrl}/api/maintenance/archived-session-worktrees`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
			fetch(`${gatewayB!.baseUrl}/api/maintenance/archived-session-worktrees`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
		]);
		expect(responseA.status).toBe(200);
		expect(responseB.status).toBe(200);
		const [bodyA, bodyB] = await Promise.all([responseA.json(), responseB.json()]);

		expect(archivedItem(bodyA, gatewayA), "MAINTENANCE_REQUEST_RUNNER_ISOLATION_REGRESSION: gateway A must classify only its archived worktree as removable").toMatchObject({
			status: "removable",
			reason: "safe-archived-session-worktree",
			repoPath: gatewayA.repoPath,
			path: gatewayA.worktreePath,
		});
		expect(archivedItem(bodyB, gatewayB), "MAINTENANCE_REQUEST_RUNNER_ISOLATION_REGRESSION: gateway B must classify only its archived worktree as removable").toMatchObject({
			status: "removable",
			reason: "safe-archived-session-worktree",
			repoPath: gatewayB.repoPath,
			path: gatewayB.worktreePath,
		});

		for (const fixture of [gatewayA, gatewayB]) {
			expect(fixture.runner.calls.length, `MAINTENANCE_REQUEST_RUNNER_ISOLATION_REGRESSION: ${fixture.label} runner must receive its scan probes`).toBeGreaterThan(0);
			expect(fixture.runner.calls.every(call => call.file !== "git" || ownsPath(fixture.root, call.cwd)), `MAINTENANCE_REQUEST_RUNNER_ISOLATION_REGRESSION: ${fixture.label} runner must never receive a foreign fixture path`).toBe(true);
		}
	});

	it("keeps sandbox-status Docker probes on the runner captured by each live gateway", async () => {
		const callsBeforeA = gatewayA!.runner.calls.length;
		const callsBeforeB = gatewayB!.runner.calls.length;

		const responseA = await fetch(`${gatewayA!.baseUrl}/api/sandbox-status?projectId=${encodeURIComponent(gatewayA!.projectId)}`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(responseA.status).toBe(200);
		expect(gatewayA!.runner.calls.slice(callsBeforeA)).toContainEqual(expect.objectContaining({
			file: "docker",
			args: ["info", "--format", "{{.ServerVersion}}"],
		}));
		expect(gatewayB!.runner.calls, "SANDBOX_STATUS_RUNNER_ISOLATION_REGRESSION: gateway A must not send Docker probes to gateway B's mutable global runner").toHaveLength(callsBeforeB);

		const responseB = await fetch(`${gatewayB!.baseUrl}/api/sandbox-status?projectId=${encodeURIComponent(gatewayB!.projectId)}`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(responseB.status).toBe(200);
		expect(gatewayB!.runner.calls.slice(callsBeforeB)).toContainEqual(expect.objectContaining({
			file: "docker",
			args: ["info", "--format", "{{.ServerVersion}}"],
		}));
	});
});
