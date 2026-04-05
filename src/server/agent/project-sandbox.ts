/**
 * ProjectSandbox — One long-lived Docker container per project.
 *
 * Replaces the per-agent SandboxPool with a single container that persists
 * across gateway restarts. Agents work inside the container using standard
 * git worktrees — the same isolation model as non-sandbox mode.
 *
 * Key properties:
 * - Named Docker volume (`bobbit-workspace-<projectId>`) for /workspace
 * - `--restart unless-stopped` survives Docker daemon restarts
 * - Host .bobbit/state bind-mounted so session logs are never lost
 * - Container label `bobbit-project=<projectId>` for discovery on reconnect
 * - Init sequence (clone, npm ci, build) runs only on first create
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDockerRunArgs } from "./docker-args.js";

const execFileAsync = promisify(execFileCb);

/** Env config for docker commands — suppresses MSYS path mangling on Windows. */
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProjectSandboxOptions {
	projectId: string;
	projectDir: string;        // host project root
	repoUrl: string;           // git remote URL to clone inside container
	image: string;             // Docker image name
	sandboxNetwork?: string;
	sandboxMounts?: string[];
	sandboxCredentials?: Record<string, string>;
	githubToken?: string;      // for git push/PR inside container
}

export interface ContainerState {
	containerId: string;
	status: "starting" | "ready" | "error";
	projectId: string;
}

// ── ProjectSandbox ─────────────────────────────────────────────────────────

export class ProjectSandbox {
	private containerId: string | null = null;
	private _status: ContainerState["status"] = "starting";
	private _readyPromise: Promise<void> | null = null;
	private _readyResolve: (() => void) | null = null;
	private _readyReject: ((err: Error) => void) | null = null;


	constructor(private options: ProjectSandboxOptions) {}

	// ── Public API ─────────────────────────────────────────────────────

	/** Create or reconnect to the project container. */
	async init(): Promise<void> {
		this._readyPromise = new Promise((resolve, reject) => {
			this._readyResolve = resolve;
			this._readyReject = reject;
		});

		try {
			await this._initContainer();
			this._status = "ready";
			this._readyResolve!();
		} catch (err: any) {
			this._status = "error";
			this._readyReject!(err);
			throw err;
		}
	}

	/** Get the container ID (waits for init if not ready). */
	async getContainerId(): Promise<string> {
		if (this._readyPromise) await this._readyPromise;
		if (!this.containerId) throw new Error(`[project-sandbox] No container for project ${this.options.projectId}`);
		return this.containerId;
	}

	/** Get container status. */
	getStatus(): ContainerState {
		return {
			containerId: this.containerId ?? "",
			status: this._status,
			projectId: this.options.projectId,
		};
	}

	/** Create a git worktree inside the container. Returns the container-internal path. */
	async createWorktree(name: string, branch: string, baseBranch?: string): Promise<string> {
		const containerId = await this.getContainerId();
		const worktreePath = `/workspace-wt/${name}`;

		// Ensure the parent directory exists (may need root if not created during init)
		try {
			await this._dockerExec(containerId, ["mkdir", "-p", "/workspace-wt"]);
		} catch {
			// Permission denied — create as root and chown to node
			await execFileAsync("docker", [
				"exec", "-u", "root", containerId, "sh", "-c",
				"mkdir -p /workspace-wt && chown node:node /workspace-wt",
			], { timeout: 10_000, env: DOCKER_ENV });
		}

		// Fetch latest before creating worktree
		try {
			await this._dockerExec(containerId, ["git", "fetch", "origin"], { cwd: "/workspace" });
		} catch {
			// Fetch failure is non-fatal — may be offline
		}

		// Create the worktree
		const args = ["git", "worktree", "add", worktreePath, "-b", branch];
		if (baseBranch) {
			args.push(baseBranch);
		}
		try {
			await this._dockerExec(containerId, args, { cwd: "/workspace" });
		} catch {
			// Branch may already exist — try without -b
			try {
				await this._dockerExec(containerId, ["git", "worktree", "add", worktreePath, branch], { cwd: "/workspace" });
			} catch (err2: any) {
				// Worktree might already exist (e.g. after gateway restart)
				if (err2?.message?.includes("already exists") || err2?.stderr?.includes("already exists")) {
					console.log(`[project-sandbox] Worktree ${name} already exists, reusing`);
					return worktreePath;
				}
				throw err2;
			}
		}

		// Install post-commit hook for push-to-remote durability
		await this._installPostCommitHook(containerId, worktreePath);

		// Set upstream tracking (non-fatal)
		try {
			await this._dockerExec(containerId, ["git", "push", "-u", "origin", branch], { cwd: worktreePath });
		} catch { /* push may fail if branch doesn't exist on remote yet */ }

		console.log(`[project-sandbox] Created worktree ${name} (branch: ${branch}) at ${worktreePath}`);
		return worktreePath;
	}

	/** Remove a git worktree inside the container. */
	async removeWorktree(name: string): Promise<void> {
		const containerId = await this.getContainerId();
		const worktreePath = `/workspace-wt/${name}`;

		try {
			await this._dockerExec(containerId, ["git", "worktree", "remove", "--force", worktreePath], { cwd: "/workspace" });
			console.log(`[project-sandbox] Removed worktree ${name}`);
		} catch (err: any) {
			// Worktree may already be gone
			if (!err?.message?.includes("is not a working tree")) {
				console.warn(`[project-sandbox] Failed to remove worktree ${name}:`, err?.message || err);
			}
		}
	}

	/** Execute a command inside the container. Returns stdout. */
	async exec(args: string[], opts?: { cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<string> {
		const containerId = await this.getContainerId();
		return this._dockerExec(containerId, args, opts);
	}

	/** Graceful shutdown: stop the container (don't remove — named volume persists). */
	async shutdown(): Promise<void> {
		if (!this.containerId) return;
		try {
			// Audit worktree state before stopping — helps diagnose lost worktrees on restart
			try {
				const wtList = await this._dockerExec(this.containerId, ["sh", "-c", "ls -d /workspace-wt/session/* 2>/dev/null || echo '(none)'"]);
				console.log(`[project-sandbox] Pre-shutdown worktrees in ${this.containerId.substring(0, 12)}: ${wtList.trim()}`);
			} catch { /* best-effort audit */ }
			await execFileAsync("docker", ["stop", this.containerId], {
				timeout: 30_000,
				env: DOCKER_ENV,
			});
			console.log(`[project-sandbox] Stopped container ${this.containerId.substring(0, 12)} for project ${this.options.projectId}`);
		} catch (err: any) {
			console.warn(`[project-sandbox] Failed to stop container:`, err?.message || err);
		}
	}

	/** Full destroy: remove container AND volume. */
	async destroy(): Promise<void> {
		const volumeName = this._volumeName();
		if (this.containerId) {
			try {
				await execFileAsync("docker", ["rm", "-f", this.containerId], {
					timeout: 15_000,
					env: DOCKER_ENV,
				});
			} catch { /* already gone */ }
		}
		try {
			await execFileAsync("docker", ["volume", "rm", "-f", volumeName], {
				timeout: 15_000,
				env: DOCKER_ENV,
			});
		} catch { /* volume may not exist */ }
		this.containerId = null;
		this._status = "starting";
		console.log(`[project-sandbox] Destroyed container and volume for project ${this.options.projectId}`);
	}

	// ── Private: Container lifecycle ───────────────────────────────────

	private async _initContainer(): Promise<void> {
		const { projectId } = this.options;
		const label = `bobbit-project=${projectId}`;

		// 1. Find existing container by label
		const existingId = await this._findContainerByLabel(label);

		if (existingId) {
			// Check if running
			const running = await this._isContainerRunning(existingId);
			if (running) {
				// Validate with a simple exec
				try {
					await this._dockerExec(existingId, ["echo", "ok"]);
					this.containerId = existingId;
					// Audit worktree state on reconnect — helps debug disappearing worktrees
					try {
						const wtList = await this._dockerExec(existingId, ["sh", "-c", "ls -d /workspace-wt/session/* 2>/dev/null || echo '(none)'"]);
						console.log(`[project-sandbox] Reconnected to running container ${existingId.substring(0, 12)} for project ${projectId} — worktrees: ${wtList.trim()}`);
					} catch {
						console.log(`[project-sandbox] Reconnected to running container ${existingId.substring(0, 12)} for project ${projectId}`);
					}
					return;
				} catch {
					// Container is in a bad state — remove and recreate
					console.warn(`[project-sandbox] Container ${existingId.substring(0, 12)} failed health check, recreating`);
					await this._removeContainer(existingId);
				}
			} else {
				// Stopped — try to start it
				try {
					await execFileAsync("docker", ["start", existingId], {
						timeout: 30_000,
						env: DOCKER_ENV,
					});
					// Validate after start
					await this._dockerExec(existingId, ["echo", "ok"]);
					this.containerId = existingId;
					// Audit worktree state after restart — overlay FS data may have been lost
					try {
						const wtList = await this._dockerExec(existingId, ["sh", "-c", "ls -d /workspace-wt/session/* 2>/dev/null || echo '(none)'"]);
						console.log(`[project-sandbox] Restarted stopped container ${existingId.substring(0, 12)} for project ${projectId} — worktrees: ${wtList.trim()}`);
					} catch {
						console.log(`[project-sandbox] Restarted stopped container ${existingId.substring(0, 12)} for project ${projectId}`);
					}
					return;
				} catch {
					console.warn(`[project-sandbox] Failed to restart container ${existingId.substring(0, 12)}, recreating`);
					await this._removeContainer(existingId);
				}
			}
		}

		// 2. No usable container — create new one
		await this._createContainer();

		// 3. Run init sequence if needed
		await this._runInitSequence();
	}

	private async _createContainer(): Promise<void> {
		const { projectId, image, sandboxNetwork, sandboxMounts, sandboxCredentials, githubToken } = this.options;

		// Ensure the state directory and sandbox-visible subdirectories exist for bind mounts
		const stateDir = path.join(this.options.projectDir, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		for (const sub of ["sessions", "tool-guard", "html-snapshots"]) {
			fs.mkdirSync(path.join(stateDir, sub), { recursive: true });
		}

		// Dynamic resource limits: N-2 cores, M-2GB memory, no PID limit
		const totalMemGB = Math.max(4, Math.floor(os.totalmem() / (1024 ** 3)) - 2);
		const totalCpus = Math.max(2, os.cpus().length - 2);

		const dockerArgs = buildDockerRunArgs({
			image,
			workspaceDir: "", // unused — named volume instead
			label: projectId,
			labelPrefix: "bobbit-project",
			projectId,
			stateDir,
			memoryLimit: `${totalMemGB}g`,
			cpuLimit: `${totalCpus}`,
			pidsLimit: "0",  // unlimited — long-lived container runs many agents
			sandboxMounts,
			sandboxCredentials,
			sandboxNetwork,
		});

		// Inject GITHUB_TOKEN for git push/PR inside container
		if (githubToken) {
			const insertIdx = dockerArgs.length - 3; // before image + sleep + infinity
			dockerArgs.splice(insertIdx, 0, "-e", `GITHUB_TOKEN=${githubToken}`);
		}

		const { stdout } = await execFileAsync("docker", dockerArgs, {
			timeout: 60_000,
			env: DOCKER_ENV,
		});

		const containerId = stdout.trim();
		if (!containerId) {
			throw new Error(`[project-sandbox] docker run returned empty container ID for project ${projectId}`);
		}

		this.containerId = containerId;

		// Create /workspace-wt for agent worktrees (needs root since / is root-owned)
		try {
			await execFileAsync("docker", [
				"exec", "-u", "root", containerId, "sh", "-c",
				"mkdir -p /workspace-wt && chown node:node /workspace-wt",
			], { timeout: 10_000, env: DOCKER_ENV });
		} catch {
			// Non-fatal — createWorktree will retry
		}

		// Defense-in-depth: mask /proc/1/environ
		try {
			await execFileAsync("docker", [
				"exec", "-u", "root", containerId, "sh", "-c",
				"mount --bind /dev/null /proc/1/environ 2>/dev/null || chmod 0400 /proc/1/environ 2>/dev/null || true",
			], { timeout: 10_000, env: DOCKER_ENV });
		} catch {
			// Non-fatal — primary defense is not passing sensitive env vars to docker run
		}

		console.log(`[project-sandbox] Created container ${containerId.substring(0, 12)} for project ${projectId}`);
	}

	private async _runInitSequence(): Promise<void> {
		if (!this.containerId) return;

		// Check if the workspace already has a git repo (volume persisted from prior run)
		try {
			await this._dockerExec(this.containerId, ["test", "-d", "/workspace/.git"]);
			// .git exists — skip init
			console.log(`[project-sandbox] Workspace already initialized (volume persisted)`);
			return;
		} catch {
			// .git doesn't exist — need to clone
		}

		const { repoUrl } = this.options;

		// Clone the repo
		console.log(`[project-sandbox] Cloning ${repoUrl} into /workspace...`);
		await this._dockerExec(this.containerId, ["git", "clone", repoUrl, "."], {
			cwd: "/workspace",
			timeout: 120_000,
		});

		// Mark /workspace-wt as safe for git
		await this._dockerExec(this.containerId, ["git", "config", "--global", "--add", "safe.directory", "*"]);

		// npm ci if package-lock.json exists
		try {
			await this._dockerExec(this.containerId, ["test", "-f", "/workspace/package-lock.json"]);
			console.log(`[project-sandbox] Running npm ci...`);
			await this._dockerExec(this.containerId, ["npm", "ci", "--no-audit", "--no-fund"], {
				cwd: "/workspace",
				timeout: 300_000,
			});
		} catch {
			// No package-lock.json or npm ci failed — non-fatal
		}

		// Install Playwright chromium if it's a dependency
		try {
			await this._dockerExec(this.containerId, ["test", "-f", "/workspace/node_modules/@playwright/test/package.json"]);
			console.log(`[project-sandbox] Installing Playwright chromium...`);
			const pwVersion = (await this._dockerExec(this.containerId, [
				"node", "-e", "console.log(require('/workspace/node_modules/@playwright/test/package.json').version)",
			])).trim();
			if (pwVersion) {
				await this._dockerExec(this.containerId, ["npx", "-y", `playwright@${pwVersion}`, "install", "chromium"], {
					cwd: "/workspace",
					timeout: 120_000,
				});
			}
		} catch {
			// Playwright not a dependency or install failed — non-fatal
		}

		// npm run build if the script exists
		try {
			await this._dockerExec(this.containerId, [
				"node", "-e", "const p=require('/workspace/package.json'); if(!p.scripts?.build) process.exit(1)",
			]);
			console.log(`[project-sandbox] Running npm run build...`);
			await this._dockerExec(this.containerId, ["npm", "run", "build"], {
				cwd: "/workspace",
				timeout: 120_000,
			});
		} catch {
			// No build script or build failed — non-fatal
		}

		console.log(`[project-sandbox] Init sequence complete for project ${this.options.projectId}`);
	}

	// ── Private: Post-commit hook ──────────────────────────────────────

	private async _installPostCommitHook(containerId: string, worktreePath: string): Promise<void> {
		// Determine the .git dir for this worktree (may be a file pointing to the main repo)
		const hookScript = [
			"#!/bin/sh",
			'branch=$(git symbolic-ref --short HEAD 2>/dev/null)',
			'[ -n "$branch" ] && git push origin "$branch" 2>/dev/null &',
		].join("\n");

		try {
			// Create hooks directory and write the hook
			await this._dockerExec(containerId, ["sh", "-c", `
				gitdir=$(git rev-parse --git-dir) &&
				mkdir -p "$gitdir/hooks" &&
				printf '%s\\n' '${hookScript.replace(/'/g, "'\\''")}' > "$gitdir/hooks/post-commit" &&
				chmod +x "$gitdir/hooks/post-commit"
			`], { cwd: worktreePath });
		} catch (err: any) {
			console.warn(`[project-sandbox] Failed to install post-commit hook in ${worktreePath}:`, err?.message || err);
		}
	}

	// ── Private: Docker helpers ────────────────────────────────────────

	private async _findContainerByLabel(label: string): Promise<string | null> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"ps", "-a",
				"--filter", `label=${label}`,
				"--format", "{{.ID}}",
			], {
				timeout: 10_000,
				env: DOCKER_ENV,
			});
			const ids = stdout.trim().split("\n").filter(Boolean);
			return ids[0] ?? null;
		} catch {
			return null;
		}
	}

	private async _isContainerRunning(containerId: string): Promise<boolean> {
		try {
			const { stdout } = await execFileAsync("docker", [
				"inspect", "--format", "{{.State.Running}}", containerId,
			], {
				timeout: 5_000,
				env: DOCKER_ENV,
			});
			return stdout.trim() === "true";
		} catch {
			return false;
		}
	}

	private async _removeContainer(containerId: string): Promise<void> {
		try {
			await execFileAsync("docker", ["rm", "-f", containerId], {
				timeout: 15_000,
				env: DOCKER_ENV,
			});
		} catch { /* already gone */ }
	}

	private async _dockerExec(
		containerId: string,
		args: string[],
		opts?: { cwd?: string; env?: Record<string, string>; timeout?: number },
	): Promise<string> {
		const execArgs = ["exec"];
		if (opts?.cwd) {
			execArgs.push("-w", opts.cwd);
		}
		if (opts?.env) {
			for (const [key, value] of Object.entries(opts.env)) {
				execArgs.push("-e", `${key}=${value}`);
			}
		}
		execArgs.push(containerId, ...args);

		const { stdout } = await execFileAsync("docker", execArgs, {
			timeout: opts?.timeout ?? 60_000,
			env: DOCKER_ENV,
			maxBuffer: 10 * 1024 * 1024,
		});
		return stdout;
	}

	private _volumeName(): string {
		return `bobbit-workspace-${this.options.projectId}`;
	}
}
