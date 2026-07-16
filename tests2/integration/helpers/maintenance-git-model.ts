import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, normalize, resolve } from "node:path";
import type { CommandRunner } from "../../../src/server/gateway-deps.js";
import { installCommandRunnerInterceptor } from "./command-runner-dispatcher.js";

type RepoState = {
	root: string;
	owner: symbol;
	branches: Set<string>;
	worktrees: Map<string, { path: string; branch: string }>;
};

type RunnerRestore = () => void;
type DeferredPath = { path: string; owner: symbol };
type MaintenanceGitGlobalState = {
	repos: Map<string, RepoState>;
	worktreeOwners: Map<string, string>;
	deferredPaths: Map<string, DeferredPath[]>;
	deferredSequence: number;
	modelInstallCounts: Map<symbol, number>;
};

const GLOBAL_STATE_KEY = Symbol.for("bobbit.tests2.maintenance-git-model.state");

function globalState(): MaintenanceGitGlobalState {
	const scope = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: MaintenanceGitGlobalState };
	return scope[GLOBAL_STATE_KEY] ??= {
		repos: new Map(),
		worktreeOwners: new Map(),
		deferredPaths: new Map(),
		deferredSequence: 0,
		modelInstallCounts: new Map(),
	};
}

export type MaintenanceGitSnapshot = {
	repos: Array<{
		root: string;
		branches: string[];
		worktrees: Array<{ path: string; branch: string }>;
	}>;
};

function key(path: string): string {
	const normalized = normalize(resolve(path)).replace(/\\/g, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function containsPath(parent: string, candidate: string): boolean {
	return candidate === parent || candidate.startsWith(`${parent}/`);
}

function commandError(args: readonly string[], cwd: string): Error & { code: number; stderr: string } {
	const message = `[maintenance-git-model] unsupported or missing git state: git ${args.join(" ")} (cwd=${cwd})`;
	return Object.assign(new Error(message), { code: 128, stderr: message });
}

/**
 * Small in-memory Git seam for maintenance route tests.
 *
 * The filesystem carries the shared-validation template plus lightweight repo
 * and worktree directories, while ref/worktree command decisions are served
 * without starting child processes. This keeps the maintenance classifier
 * exercising its production command-runner boundary and filesystem checks.
 */
export class MaintenanceGitModel {
	private readonly owner: symbol;

	constructor(ownerLabel = "maintenance-git-model-owner") {
		this.owner = Symbol(ownerLabel);
	}

	reset(): void {
		const state = globalState();
		// A duplicate prebundle entry can construct another facade for the same
		// process-wide model. Never clear this facade's repositories while any
		// maintenance file using it still has the gateway runner installed.
		if ((state.modelInstallCounts.get(this.owner) ?? 0) > 0) return;
		for (const [repoKey, repo] of state.repos) {
			if (repo.owner !== this.owner) continue;
			for (const worktreeKey of repo.worktrees.keys()) {
				if (state.worktreeOwners.get(worktreeKey) === repoKey) state.worktreeOwners.delete(worktreeKey);
			}
			state.repos.delete(repoKey);
		}
		for (const [pathKey, deferred] of state.deferredPaths) {
			const retained = deferred.filter(item => item.owner !== this.owner);
			for (const item of deferred) {
				if (item.owner === this.owner) rmSync(item.path, { recursive: true, force: true });
			}
			if (retained.length > 0) state.deferredPaths.set(pathKey, retained);
			else state.deferredPaths.delete(pathKey);
		}
	}

	snapshot(): MaintenanceGitSnapshot {
		return {
			repos: [...globalState().repos.values()]
				.filter(repo => repo.owner === this.owner)
				.map(repo => ({
					root: repo.root,
					branches: [...repo.branches],
					worktrees: [...repo.worktrees.values()].map(worktree => ({ ...worktree })),
				})),
		};
	}

	/** Restore only this facade's state; other maintenance files may still be active. */
	restore(snapshot: MaintenanceGitSnapshot): void {
		const state = globalState();
		const expectedPaths = new Set(snapshot.repos.flatMap(repo => repo.worktrees.map(worktree => key(worktree.path))));
		for (const [repoKey, repo] of state.repos) {
			if (repo.owner !== this.owner) continue;
			for (const worktree of repo.worktrees.values()) {
				const worktreeKey = key(worktree.path);
				if (worktreeKey !== repoKey && !expectedPaths.has(worktreeKey)) this.deferRemovePath(worktree.path, this.owner);
				if (state.worktreeOwners.get(worktreeKey) === repoKey) state.worktreeOwners.delete(worktreeKey);
			}
			state.repos.delete(repoKey);
		}

		for (const source of snapshot.repos) {
			const repoKey = key(source.root);
			const occupied = state.repos.get(repoKey);
			if (occupied && occupied.owner !== this.owner) {
				throw new Error(`[maintenance-git-model] cannot restore repository owned by another fixture: ${source.root}`);
			}
			const worktrees = new Map<string, { path: string; branch: string }>();
			for (const worktree of source.worktrees) {
				const worktreeKey = key(worktree.path);
				if (!existsSync(worktree.path)) this.restoreDeferredPath(source.root, worktree.path, this.owner);
				worktrees.set(worktreeKey, { ...worktree });
				state.worktreeOwners.set(worktreeKey, repoKey);
			}
			state.repos.set(repoKey, {
				root: source.root,
				owner: this.owner,
				branches: new Set(source.branches),
				worktrees,
			});
		}
	}

	registerRepo(root: string): void {
		const state = globalState();
		const repoRoot = resolve(root);
		const repoKey = key(repoRoot);
		const previous = state.repos.get(repoKey);
		if (previous?.owner !== undefined && previous.owner !== this.owner) {
			throw new Error(`[maintenance-git-model] repository already belongs to another fixture: ${repoRoot}`);
		}
		if (previous) {
			for (const worktreePath of previous.worktrees.keys()) {
				if (state.worktreeOwners.get(worktreePath) === repoKey) state.worktreeOwners.delete(worktreePath);
			}
		}
		state.repos.set(repoKey, {
			root: repoRoot,
			owner: this.owner,
			branches: new Set(["master"]),
			worktrees: new Map([[repoKey, { path: repoRoot, branch: "master" }]]),
		});
		state.worktreeOwners.set(repoKey, repoKey);
	}

	forgetRepo(root: string): void {
		const state = globalState();
		const repoKey = key(root);
		const repo = state.repos.get(repoKey);
		if (!repo || repo.owner !== this.owner) return;
		for (const worktreePath of repo.worktrees.keys()) {
			if (state.worktreeOwners.get(worktreePath) === repoKey) state.worktreeOwners.delete(worktreePath);
		}
		state.repos.delete(repoKey);
	}

	addBranch(root: string, branch: string): void {
		this.requireRootRepo(root).branches.add(branch);
	}

	deleteBranches(root: string, branches: readonly string[]): void {
		const repo = globalState().repos.get(key(root));
		if (!repo || repo.owner !== this.owner) return;
		for (const branch of branches) repo.branches.delete(branch);
	}

	branchExists(root: string, branch: string): boolean {
		const repo = globalState().repos.get(key(root));
		return repo?.owner === this.owner && repo.branches.has(branch);
	}

	addWorktree(root: string, worktreePath: string, branch: string): void {
		const repo = this.requireRootRepo(root);
		const worktreeKey = key(worktreePath);
		repo.branches.add(branch);
		repo.worktrees.set(worktreeKey, { path: resolve(worktreePath), branch });
		globalState().worktreeOwners.set(worktreeKey, key(repo.root));
		mkdirSync(worktreePath, { recursive: true });
		writeFileSync(resolve(worktreePath, ".git"), `gitdir: ${resolve(repo.root, ".git", "worktrees", worktreeKey.split("/").pop() ?? "worktree")}\n`);
	}

	removeWorktree(root: string, worktreePath: string): void {
		const state = globalState();
		const repoKey = key(root);
		const repo = state.repos.get(repoKey);
		if (!repo || repo.owner !== this.owner) return;
		const worktreeKey = key(worktreePath);
		if (worktreeKey !== repoKey) repo.worktrees.delete(worktreeKey);
		if (state.worktreeOwners.get(worktreeKey) === repoKey) state.worktreeOwners.delete(worktreeKey);
		this.deferRemovePath(worktreePath, this.owner);
	}

	listedWorktreePaths(root: string): string[] {
		const repo = this.requireRootRepo(root);
		return [...repo.worktrees.values()].map(worktree => worktree.path);
	}

	run(rootOrWorktree: string, args: readonly string[]): string {
		const cwd = resolve(rootOrWorktree);
		const repo = this.findOwnedRepo(cwd);
		if (!repo) throw commandError(args, cwd);
		const [command, ...rest] = args;

		if (command === "worktree" && rest[0] === "list") return this.worktreeList(repo);
		if (command === "worktree" && rest[0] === "add") {
			const branchIndex = rest.indexOf("-b");
			const branch = branchIndex >= 0 ? rest[branchIndex + 1] : undefined;
			const worktreePath = branchIndex >= 0 ? rest[branchIndex + 2] : rest.find(arg => !arg.startsWith("-") && arg !== "add");
			if (!branch || !worktreePath) throw commandError(args, cwd);
			this.addWorktree(repo.root, worktreePath, branch);
			return "";
		}
		if (command === "worktree" && rest[0] === "remove") {
			const worktreePath = rest.slice(1).find(arg => !arg.startsWith("-"));
			if (!worktreePath) throw commandError(args, cwd);
			this.removeWorktree(repo.root, worktreePath);
			return "";
		}
		if (command === "branch" && rest[0] === "-D") {
			this.deleteBranches(repo.root, rest.slice(1));
			return "";
		}
		if (command === "branch" && rest[0] && !rest[0].startsWith("-")) {
			this.addBranch(repo.root, rest[0]);
			return "";
		}
		if (command === "show-ref" && rest.includes("--verify")) {
			const ref = rest.find(arg => arg.startsWith("refs/heads/"));
			const branch = ref?.slice("refs/heads/".length);
			if (!branch || !repo.branches.has(branch)) throw commandError(args, cwd);
			return "";
		}
		if (command === "rev-parse") {
			if (rest.includes("--show-toplevel")) return repo.root;
			if (rest.includes("--is-inside-work-tree")) return "true";
			const verify = rest[rest.indexOf("--verify") + 1];
			if (rest.includes("--verify") && verify?.startsWith("refs/heads/")) {
				const branch = verify.slice("refs/heads/".length);
				if (!repo.branches.has(branch)) throw commandError(args, cwd);
			}
			return "0000000000000000000000000000000000000001";
		}
		if (command === "symbolic-ref") {
			if (rest.includes("refs/remotes/origin/HEAD")) throw commandError(args, cwd);
			return rest.includes("--short") ? "master" : "refs/heads/master";
		}
		if (command === "remote" && rest[0] === "get-url") throw commandError(args, cwd);
		if (command === "status") return "";
		if (command === "for-each-ref") return "";
		if (command === "config") return "";
		if (command === "add" || command === "commit" || command === "init") return "";
		if (command === "push") return "";

		throw commandError(args, cwd);
	}

	install(runner: CommandRunner): RunnerRestore {
		const state = globalState();
		state.modelInstallCounts.set(this.owner, (state.modelInstallCounts.get(this.owner) ?? 0) + 1);
		const model = this;
		const restoreDispatcher = installCommandRunnerInterceptor(runner, {
			label: `maintenance-git-model:${String(this.owner.description ?? "owner")}`,
			async execFile(file, args, options, next) {
				if (basename(file).replace(/\.exe$/i, "").toLowerCase() !== "git") return next();
				const cwd = typeof options?.cwd === "string" ? options.cwd : process.cwd();
				// Multiple integration files share one process-global model and runner.
				// Each lease claims only repositories registered by its exact owner.
				if (!model.findOwnedRepo(resolve(cwd))) return next();
				return { stdout: model.run(cwd, args), stderr: "" };
			},
		});

		let restored = false;
		return () => {
			if (restored) return;
			restored = true;
			restoreDispatcher();
			const remaining = (state.modelInstallCounts.get(this.owner) ?? 1) - 1;
			if (remaining > 0) state.modelInstallCounts.set(this.owner, remaining);
			else state.modelInstallCounts.delete(this.owner);
		};
	}

	private deferRemovePath(targetPath: string, owner: symbol): void {
		if (!existsSync(targetPath)) return;
		const state = globalState();
		const targetKey = key(targetPath);
		const deferredPath = `${targetPath}.bobbit-removed-${process.pid}-${++state.deferredSequence}`;
		try {
			renameSync(targetPath, deferredPath);
			const paths = state.deferredPaths.get(targetKey) ?? [];
			paths.push({ path: deferredPath, owner });
			state.deferredPaths.set(targetKey, paths);
		} catch {
			rmSync(targetPath, { recursive: true, force: true });
		}
	}

	private restoreDeferredPath(repoRoot: string, worktreePath: string, owner: symbol): void {
		const state = globalState();
		const worktreeKey = key(worktreePath);
		const deferred = state.deferredPaths.get(worktreeKey);
		while (deferred?.length) {
			let candidateIndex = -1;
			for (let index = deferred.length - 1; index >= 0; index--) {
				if (deferred[index].owner === owner) { candidateIndex = index; break; }
			}
			if (candidateIndex < 0) break;
			const [candidate] = deferred.splice(candidateIndex, 1);
			if (!existsSync(candidate.path)) continue;
			mkdirSync(resolve(worktreePath, ".."), { recursive: true });
			renameSync(candidate.path, worktreePath);
			if (deferred.length === 0) state.deferredPaths.delete(worktreeKey);
			return;
		}
		mkdirSync(worktreePath, { recursive: true });
		writeFileSync(resolve(worktreePath, ".git"), `gitdir: ${resolve(repoRoot, ".git", "worktrees", worktreeKey.split("/").pop() ?? "worktree")}\n`);
	}

	private worktreeList(repo: RepoState): string {
		return [...repo.worktrees.values()]
			.map(worktree => `worktree ${worktree.path}\nHEAD 0000000000000000000000000000000000000001\nbranch refs/heads/${worktree.branch}\n`)
			.join("\n");
	}

	private findOwnedRepo(path: string): RepoState | undefined {
		const state = globalState();
		const pathKey = key(path);
		const exactRepo = state.repos.get(pathKey);
		if (exactRepo?.owner === this.owner) return exactRepo;
		const directOwner = state.worktreeOwners.get(pathKey);
		if (directOwner) {
			const directRepo = state.repos.get(directOwner);
			if (directRepo?.owner === this.owner) return directRepo;
		}

		let best: { repo: RepoState; prefixLength: number } | undefined;
		for (const [repoKey, repo] of state.repos) {
			if (repo.owner !== this.owner) continue;
			if (containsPath(repoKey, pathKey) && (!best || repoKey.length > best.prefixLength)) {
				best = { repo, prefixLength: repoKey.length };
			}
			for (const worktreeKey of repo.worktrees.keys()) {
				if (containsPath(worktreeKey, pathKey) && (!best || worktreeKey.length > best.prefixLength)) {
					best = { repo, prefixLength: worktreeKey.length };
				}
			}
		}
		return best?.repo;
	}

	private requireRootRepo(path: string): RepoState {
		const repo = globalState().repos.get(key(path));
		if (!repo || repo.owner !== this.owner) throw new Error(`[maintenance-git-model] repository root is not registered for this owner: ${resolve(path)} (exists=${existsSync(path)})`);
		return repo;
	}
}
