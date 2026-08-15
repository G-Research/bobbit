import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _resetDockerLimitsCache, ProjectSandbox } from "../../src/server/agent/project-sandbox.js";
import { repositoryMutationCoordinator } from "../../src/server/skills/repository-mutation-coordinator.js";

type Deferred<T = void> = { promise: Promise<T>; resolve(value: T): void };

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

const CONFIG_LOCK = "could not lock config file .git/config.lock: File exists";

type DockerModel = {
	calls: Array<{ args: string[]; cwd?: string }>;
	upstreams: Map<string, string>;
	worktreeBranches: Map<string, string>;
	existingBranches?: Set<string>;
	upstreamWrites: number;
	upstreamWritesInFlight: number;
	maxUpstreamWritesInFlight: number;
	onFirstUpstreamWrite?: () => Promise<void>;
	lockAfterFirstWrite?: boolean;
	upstreamError?: Error;
};

function installDockerModel(sandbox: ProjectSandbox, model: DockerModel): void {
	(sandbox as any).containerId = "sandbox-shared-container";
	(sandbox as any)._dockerExec = async (
		_containerId: string,
		args: string[],
		opts?: { cwd?: string },
	): Promise<string> => {
		model.calls.push({ args: [...args], cwd: opts?.cwd });
		if (args[0] !== "git") return "";
		if (args[1] === "rev-parse" && args.includes("--git-common-dir")) {
			return `${opts?.cwd === "/workspace" ? "/workspace/.git" : `${opts?.cwd}/.git`}\n`;
		}
		if (args[1] === "fetch") return "";
		if (args[1] === "show-ref") {
			const branch = args.at(-1)?.slice("refs/heads/".length);
			if (!branch || !model.existingBranches?.has(branch)) throw new Error("missing local branch");
			return "existing branch\n";
		}
		if (args[1] === "worktree" && args[2] === "add") {
			const branchIndex = args.indexOf("-b");
			if (branchIndex >= 0) expect(args).toContain("--no-track");
			else expect(args).not.toContain("--no-track");
			const branch = branchIndex >= 0 ? args[branchIndex + 1] : args.at(-1)!;
			const worktreePath = branchIndex >= 0 ? args[branchIndex + 2] : args.at(-2)!;
			model.worktreeBranches.set(worktreePath, branch);
			return "";
		}
		if (args[1] === "branch" && args.some(arg => arg.startsWith("--set-upstream-to="))) {
			model.upstreamWritesInFlight++;
			model.maxUpstreamWritesInFlight = Math.max(model.maxUpstreamWritesInFlight, model.upstreamWritesInFlight);
			if (model.upstreamWritesInFlight > 1) {
				model.upstreamWritesInFlight--;
				const collision = new Error(CONFIG_LOCK) as Error & { stderr?: string };
				collision.stderr = CONFIG_LOCK;
				throw collision;
			}
			try {
				if (model.upstreamError) throw model.upstreamError;
				const branch = args.at(-1)!;
				const upstream = args.find(arg => arg.startsWith("--set-upstream-to="))!.slice("--set-upstream-to=".length);
				model.upstreams.set(branch, upstream);
				model.upstreamWrites++;
				if (model.onFirstUpstreamWrite && model.upstreamWrites === 1) await model.onFirstUpstreamWrite();
				if (model.lockAfterFirstWrite && model.upstreamWrites === 1) {
					const collision = new Error(CONFIG_LOCK) as Error & { stderr?: string };
					collision.stderr = CONFIG_LOCK;
					throw collision;
				}
				return "";
			} finally {
				model.upstreamWritesInFlight--;
			}
		}
		if (args[1] === "rev-parse" && args.some(arg => arg.endsWith("@{upstream}"))) {
			const branch = args.find(arg => arg.endsWith("@{upstream}"))!.slice(0, -"@{upstream}".length);
			const upstream = model.upstreams.get(branch);
			if (!upstream) throw new Error("no upstream");
			return `${upstream}\n`;
		}
		if (args[1] === "rev-parse" && args.includes("--show-toplevel")) return `${opts?.cwd}\n`;
		if (args[1] === "rev-parse" && args.includes("HEAD")) {
			const branch = model.worktreeBranches.get(opts?.cwd ?? "");
			return `${branch ?? ""}\n`;
		}
		return "";
	};
}

function makeSandbox(): ProjectSandbox {
	return new ProjectSandbox({
		projectId: "sandbox-git-config-coordination",
		projectDir: "/host/project",
		repoUrl: "https://example.invalid/repo.git",
		image: "bobbit-test-image",
		baseRefResolver: () => "origin/main",
	});
}

afterEach(() => vi.restoreAllMocks());

describe("ProjectSandbox container workspace bootstrap", () => {
	it("fails container creation rather than running init after root-volume bootstrap fails", async () => {
		_resetDockerLimitsCache();
		const projectDir = mkdtempSync(path.join(tmpdir(), "bobbit-workspace-bootstrap-"));
		const sandbox = new ProjectSandbox({
			projectId: "workspace-bootstrap",
			projectDir,
			repoUrl: "https://example.invalid/repo.git",
			image: "bobbit-test-image",
		}, {
			commandRunner: {
				async execFile(_file: string, args: readonly string[]) {
					return { stdout: args[0] === "info" ? "4 8589934592\n" : "", stderr: "" };
				},
				execFileSync() { return ""; },
			},
		});
		const calls: string[][] = [];
		(sandbox as any)._prepareClaudeAgentSdkStateParent = async () => undefined;
		(sandbox as any).execDocker = async (args: string[]) => {
			calls.push(args);
			if (args[0] === "run") return { stdout: "workspace-container\n", stderr: "" };
			if (args.at(-1) === "mkdir -p /workspace /workspace-wt && chown node:node /workspace /workspace-wt") {
				throw new Error("workspace root bootstrap failed");
			}
			return { stdout: "", stderr: "" };
		};

		try {
			await expect((sandbox as any)._createContainer(undefined)).rejects.toThrow("workspace root bootstrap failed");
			const bootstrap = calls.find((args) => args.at(-1) === "mkdir -p /workspace /workspace-wt && chown node:node /workspace /workspace-wt");
			expect(bootstrap).toEqual([
				"exec", "-u", "root", "workspace-container", "sh", "-ceu",
				"mkdir -p /workspace /workspace-wt && chown node:node /workspace /workspace-wt",
			]);
			expect(calls).toContainEqual(["rm", "-f", "workspace-container"]);
			expect((sandbox as any).containerId).toBeNull();
		} finally {
			_resetDockerLimitsCache();
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});

describe("ProjectSandbox Git config coordination", () => {
	it("serializes root and child-like single-repo setup through the shared Git common directory", async () => {
		const sandbox = makeSandbox();
		const firstWriteEntered = deferred();
		const releaseFirstWrite = deferred();
		const secondCoordinatorEntry = deferred();
		const model: DockerModel = {
			calls: [], upstreams: new Map(), worktreeBranches: new Map(), upstreamWrites: 0,
			upstreamWritesInFlight: 0, maxUpstreamWritesInFlight: 0,
			onFirstUpstreamWrite: async () => {
				firstWriteEntered.resolve();
				await releaseFirstWrite.promise;
			},
		};
		installDockerModel(sandbox, model);

		const originalRun = repositoryMutationCoordinator.run.bind(repositoryMutationCoordinator);
		let coordinatorEntries = 0;
		vi.spyOn(repositoryMutationCoordinator, "run").mockImplementation(async (key, operation) => {
			if (++coordinatorEntries === 2) secondCoordinatorEntry.resolve();
			return originalRun(key, operation);
		});

		const root = sandbox.createWorktree("goal/root", "goal/root", "origin/main");
		await firstWriteEntered.promise;
		const child = sandbox.createWorktree("goal/child", "goal/child", "origin/main");
		await secondCoordinatorEntry.promise;
		expect(model.maxUpstreamWritesInFlight).toBe(1);
		expect(model.upstreamWritesInFlight).toBe(1);

		releaseFirstWrite.resolve();
		await Promise.all([root, child]);
		expect(model.maxUpstreamWritesInFlight).toBe(1);
		expect(model.upstreams).toEqual(new Map([
			["goal/root", "origin/main"],
			["goal/child", "origin/main"],
		]));
	});

	it("attaches an existing branch with valid syntax and validates its configured upstream", async () => {
		const sandbox = makeSandbox();
		const model: DockerModel = {
			calls: [], upstreams: new Map(), worktreeBranches: new Map(), existingBranches: new Set(["goal/reused"]),
			upstreamWrites: 0, upstreamWritesInFlight: 0, maxUpstreamWritesInFlight: 0,
		};
		installDockerModel(sandbox, model);

		await expect(sandbox.createWorktree("goal/reused", "goal/reused", "origin/main"))
			.resolves.toBe("/workspace-wt/goal/reused");

		const worktreeAdd = model.calls.find(call => call.args[1] === "worktree" && call.args[2] === "add");
		expect(worktreeAdd?.args).toEqual(["git", "worktree", "add", "/workspace-wt/goal/reused", "goal/reused"]);
		expect(model.worktreeBranches.get("/workspace-wt/goal/reused")).toBe("goal/reused");
		expect(model.upstreams.get("goal/reused")).toBe("origin/main");
	});

	it("uses no implicit tracking, validates every multi-repo worktree, and reconciles an ambiguous config lock", async () => {
		const sandbox = makeSandbox();
		const model: DockerModel = {
			calls: [], upstreams: new Map(), worktreeBranches: new Map(), upstreamWrites: 0,
			upstreamWritesInFlight: 0, maxUpstreamWritesInFlight: 0, lockAfterFirstWrite: true,
		};
		installDockerModel(sandbox, model);

		const result = await sandbox.createWorktreeSet("goal/multi", "goal/multi", [
			{ name: "api", repo: "services/api" },
			{ name: "web", repo: "apps/web" },
		], "origin/main");

		expect(result.worktrees).toEqual([
			{ repo: "services/api", worktreePath: "/workspace-wt/goal/multi/services/api" },
			{ repo: "apps/web", worktreePath: "/workspace-wt/goal/multi/apps/web" },
		]);
		expect(model.upstreams.get("goal/multi")).toBe("origin/main");
		expect(model.calls.filter(call => call.args[1] === "worktree" && call.args[2] === "add").every(call => call.args.includes("--no-track"))).toBe(true);
	});

	it("keeps a genuine upstream configuration failure actionable", async () => {
		const sandbox = makeSandbox();
		const upstreamError = new Error("permission denied writing repository config");
		const model: DockerModel = {
			calls: [], upstreams: new Map(), worktreeBranches: new Map(), upstreamWrites: 0,
			upstreamWritesInFlight: 0, maxUpstreamWritesInFlight: 0, upstreamError,
		};
		installDockerModel(sandbox, model);

		await expect(sandbox.createWorktree("goal/error", "goal/error", "origin/main")).rejects.toBe(upstreamError);
	});
});
