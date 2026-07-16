import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, normalize, resolve } from "node:path";
import type { CommandRunner, ExecFileOptions, ExecFileResult } from "../../../src/server/gateway-deps.js";

type RepoState = {
	root: string;
	branches: Set<string>;
	worktrees: Map<string, { path: string; branch: string }>;
};

type RunnerRestore = () => void;

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
	private readonly repos = new Map<string, RepoState>();
	private readonly worktreeOwners = new Map<string, string>();

	reset(): void {
		this.repos.clear();
		this.worktreeOwners.clear();
	}

	registerRepo(root: string): void {
		const repoRoot = resolve(root);
		const repoKey = key(repoRoot);
		const previous = this.repos.get(repoKey);
		if (previous) {
			for (const worktreePath of previous.worktrees.keys()) {
				if (this.worktreeOwners.get(worktreePath) === repoKey) this.worktreeOwners.delete(worktreePath);
			}
		}
		this.repos.set(repoKey, {
			root: repoRoot,
			branches: new Set(["master"]),
			worktrees: new Map([[repoKey, { path: repoRoot, branch: "master" }]]),
		});
		this.worktreeOwners.set(repoKey, repoKey);
	}

	forgetRepo(root: string): void {
		const repoKey = key(root);
		const repo = this.repos.get(repoKey);
		if (!repo) return;
		for (const worktreePath of repo.worktrees.keys()) {
			if (this.worktreeOwners.get(worktreePath) === repoKey) this.worktreeOwners.delete(worktreePath);
		}
		this.repos.delete(repoKey);
	}

	addBranch(root: string, branch: string): void {
		this.requireRootRepo(root).branches.add(branch);
	}

	deleteBranches(root: string, branches: readonly string[]): void {
		const repo = this.repos.get(key(root));
		if (!repo) return;
		for (const branch of branches) repo.branches.delete(branch);
	}

	branchExists(root: string, branch: string): boolean {
		return this.repos.get(key(root))?.branches.has(branch) ?? false;
	}

	addWorktree(root: string, worktreePath: string, branch: string): void {
		const repo = this.requireRootRepo(root);
		const worktreeKey = key(worktreePath);
		repo.branches.add(branch);
		repo.worktrees.set(worktreeKey, { path: resolve(worktreePath), branch });
		this.worktreeOwners.set(worktreeKey, key(repo.root));
		mkdirSync(worktreePath, { recursive: true });
		writeFileSync(resolve(worktreePath, ".git"), `gitdir: ${resolve(repo.root, ".git", "worktrees", worktreeKey.split("/").pop() ?? "worktree")}\n`);
	}

	removeWorktree(root: string, worktreePath: string): void {
		const repoKey = key(root);
		const repo = this.repos.get(repoKey);
		const worktreeKey = key(worktreePath);
		if (repo && worktreeKey !== repoKey) repo.worktrees.delete(worktreeKey);
		if (this.worktreeOwners.get(worktreeKey) === repoKey) this.worktreeOwners.delete(worktreeKey);
		rmSync(worktreePath, { recursive: true, force: true });
	}

	listedWorktreePaths(root: string): string[] {
		const repo = this.requireRootRepo(root);
		return [...repo.worktrees.values()].map(worktree => worktree.path);
	}

	run(rootOrWorktree: string, args: readonly string[]): string {
		const cwd = resolve(rootOrWorktree);
		const repo = this.findRepo(cwd);
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
		const originalExecFile = runner.execFile;
		runner.execFile = async (file: string, args: readonly string[], options?: ExecFileOptions): Promise<ExecFileResult> => {
			if (basename(file).replace(/\.exe$/i, "").toLowerCase() !== "git") return originalExecFile.call(runner, file, args, options);
			const cwd = typeof options?.cwd === "string" ? options.cwd : process.cwd();
			return { stdout: this.run(cwd, args), stderr: "" };
		};
		return () => { runner.execFile = originalExecFile; };
	}

	private worktreeList(repo: RepoState): string {
		return [...repo.worktrees.values()]
			.map(worktree => `worktree ${worktree.path}\nHEAD 0000000000000000000000000000000000000001\nbranch refs/heads/${worktree.branch}\n`)
			.join("\n");
	}

	private findRepo(path: string): RepoState | undefined {
		const pathKey = key(path);
		const exactRepo = this.repos.get(pathKey);
		if (exactRepo) return exactRepo;
		const directOwner = this.worktreeOwners.get(pathKey);
		if (directOwner) return this.repos.get(directOwner);

		let best: { repo: RepoState; prefixLength: number } | undefined;
		for (const [repoKey, repo] of this.repos) {
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
		const repo = this.repos.get(key(path));
		if (!repo) throw new Error(`[maintenance-git-model] repository root is not registered: ${resolve(path)} (exists=${existsSync(path)})`);
		return repo;
	}
}
