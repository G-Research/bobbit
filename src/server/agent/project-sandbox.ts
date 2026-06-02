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
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./cpu-diagnostics.js";
import { buildDockerRunArgs } from "./docker-args.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { ToolManager } from "./tool-manager.js";
import { stripTokenFromGitUrl, shouldSkipRemotePush, resolveBaseRefWithExec } from "../skills/git.js";
import type { Component } from "./project-config-store.js";
import type { SandboxCloneSource } from "./sandbox-clone-source.js";

const execFileAsync = promisify(execFileCb);
const DOCKER_BIN = "docker";

/** Env config for docker commands — suppresses MSYS path mangling on Windows. */
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };

function childErrorCode(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" || typeof code === "number" ? String(code) : "error";
}

function dockerOperation(args: readonly string[]): string {
	const cmd = args[0] || "docker";
	if (cmd !== "exec") return cmd;
	let i = 1;
	while (i < args.length) {
		const arg = args[i];
		if (arg === "-w" || arg === "-e" || arg === "-u") { i += 2; continue; }
		if (arg?.startsWith("-")) { i += 1; continue; }
		break;
	}
	const inner = args[i + 1] || "unknown";
	const innerSub = args[i + 2];
	if (inner === "git" && innerSub) return `exec git ${innerSub}`;
	return `exec ${inner}`;
}

function dockerChildLabel(args: readonly string[]): string {
	const op = dockerOperation(args);
	if (op.startsWith("exec git")) return "docker exec git";
	if (op.startsWith("exec ")) return "docker exec";
	return `docker ${args[0] || "command"}`;
}

async function execDocker(args: readonly string[], options?: any): Promise<{ stdout: string; stderr: string }> {
	if (!cpuDiagnosticsEnabled()) {
		return await execFileAsync(DOCKER_BIN, args, options) as unknown as { stdout: string; stderr: string };
	}
	const start = performance.now();
	let success = 0;
	let errorCode = "none";
	try {
		const result = await execFileAsync(DOCKER_BIN, args, options) as unknown as { stdout: string; stderr: string };
		success = 1;
		return result;
	} catch (err) {
		errorCode = childErrorCode(err);
		throw err;
	} finally {
		getCpuDiagnostics().recordChildProcess(dockerChildLabel(args), performance.now() - start, {
			operation: dockerOperation(args),
			success,
			errorCode,
			timeoutMs: typeof options?.timeout === "number" ? options.timeout : 0,
		});
	}
}

// ── Docker resource limits ─────────────────────────────────────────────────

interface DockerResourceLimits {
	cpus: number;
	memBytes: number;
}

let _cachedDockerLimits: DockerResourceLimits | null | undefined; // undefined = not yet queried

/**
 * Query Docker daemon's available CPU and memory.
 * Cached for the process lifetime (Docker resource limits don't change mid-session).
 * Returns null if `docker info` fails (caller should fall back to host values).
 */
export async function getDockerResourceLimits(): Promise<DockerResourceLimits | null> {
	if (_cachedDockerLimits !== undefined) return _cachedDockerLimits;

	try {
		const { stdout } = await execDocker(
			["info", "--format", "{{.NCPU}} {{.MemTotal}}"],
			{ timeout: 5_000, env: DOCKER_ENV },
		);
		const parts = stdout.trim().split(/\s+/);
		const cpus = parseInt(parts[0], 10);
		const memBytes = parseInt(parts[1], 10);
		if (Number.isNaN(cpus) || Number.isNaN(memBytes) || cpus <= 0 || memBytes <= 0) {
			_cachedDockerLimits = null;
			return null;
		}
		_cachedDockerLimits = { cpus, memBytes };
		return _cachedDockerLimits;
	} catch {
		_cachedDockerLimits = null;
		return null;
	}
}

/**
 * Pure computation of container resource limits — easy to unit-test.
 * Takes host values and optional Docker-reported limits; returns { cpus, memoryGB }.
 */
export function computeResourceLimits(
	hostCpus: number,
	hostMemBytes: number,
	dockerCpus?: number,
	dockerMemBytes?: number,
): { cpus: number; memoryGB: number } {
	const effectiveCpus = dockerCpus != null ? Math.min(hostCpus, dockerCpus) : hostCpus;
	const effectiveMemBytes = dockerMemBytes != null ? Math.min(hostMemBytes, dockerMemBytes) : hostMemBytes;

	return {
		cpus: Math.max(2, effectiveCpus - 2),
		memoryGB: Math.max(4, Math.floor(effectiveMemBytes / (1024 ** 3)) - 2),
	};
}

/** @internal — exported for testing only. Resets the cached Docker limits. */
export function _resetDockerLimitsCache(): void {
	_cachedDockerLimits = undefined;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProjectSandboxOptions {
	projectId: string;
	projectDir: string;        // host project root
	repoUrl: string;           // git remote URL to clone inside container (single-repo)
	/**
	 * Resolved clone source for the single-repo clone. When `kind === "mounted"`
	 * the host repo is bind-mounted read-only into the container and cloned via
	 * `file://`, never a raw host path. Falls back to `repoUrl` when absent.
	 * See `resolveSandboxCloneSource` and `docs/design/...`.
	 */
	cloneSource?: SandboxCloneSource;
	image: string;             // Docker image name
	sandboxNetwork?: string;
	sandboxMounts?: string[];
	sandboxCredentials?: Record<string, string>;
	sandboxAgentAuthAllowed?: boolean;
	sandboxAgentAuthPrefs?: PreferencesStore | null;
	githubToken?: string;      // for git push/PR inside container
	/** Tool manager for resolving builtin tools directory in Docker mounts. */
	toolManager?: ToolManager;
	/**
	 * Multi-repo: components driving worktree-set creation. When present and any
	 * component has `repo !== "."`, the sandbox enters multi-repo mode — each
	 * distinct repo gets its own clone under `/workspace/<repo>` and worktrees
	 * land at `/workspace-wt/<branchSlug>/<repo>`.
	 * Single-repo (omitted, empty, or all `repo === "."`) is unchanged.
	 */
	components?: Component[];
	/**
	 * Multi-repo: optional per-repo clone URLs. Falls back to `repoUrl` if a
	 * mapping is missing for a given repo (useful when all repos share a
	 * remote prefix and the host can resolve them via `git remote get-url`).
	 */
	repoUrlByName?: Record<string, string>;
	/**
	 * Multi-repo: optional per-repo resolved clone sources. When a repo has no
	 * `origin`, the resolver yields a `mounted` source so the container clones
	 * via `file://` instead of an unreachable host path. Each `mounted` source's
	 * host path is bind-mounted read-only at its `mountPath`.
	 */
	cloneSourceByName?: Record<string, SandboxCloneSource>;
	/**
	 * Live resolver for the project's `base_ref` setting. Called fresh on every
	 * `createWorktree` / `createWorktreeSet` so the container path adopts the
	 * current setting without sandbox recreation. Empty/undefined preserves
	 * today's `symbolic-ref refs/remotes/origin/HEAD` fallback inside the
	 * container. See `docs/design/base-ref.md` §6.
	 */
	baseRefResolver?: () => string | undefined;
}

export interface ContainerState {
	containerId: string;
	status: "starting" | "ready" | "error";
	projectId: string;
}

export type SandboxHealthEvent =
	| { type: "container-died"; projectId: string; containerId: string }
	| { type: "container-recovered"; projectId: string; containerId: string };

// ── ProjectSandbox ─────────────────────────────────────────────────────────

export class ProjectSandbox {
	private containerId: string | null = null;
	private _status: ContainerState["status"] = "starting";
	private _readyPromise: Promise<void> | null = null;
	private _readyResolve: (() => void) | null = null;
	private _readyReject: ((err: Error) => void) | null = null;
	private _healthInterval: ReturnType<typeof setInterval> | null = null;
	private _healthListeners: Array<(event: SandboxHealthEvent) => void> = [];
	private _recovering = false;


	constructor(private options: ProjectSandboxOptions) {
		if (!options || typeof options !== "object" || typeof options.projectId !== "string" || !options.projectId) {
			throw new Error("[project-sandbox] ProjectSandbox constructor requires ProjectSandboxOptions with a non-empty projectId");
		}
	}

	// ── Public API ─────────────────────────────────────────────────────

	/** Create or reconnect to the project container. */
	async init(): Promise<void> {
		this._readyPromise = new Promise((resolve, reject) => {
			this._readyResolve = resolve;
			this._readyReject = reject;
		});
		// Always "handle" the ready promise so a failed init with no concurrent
		// awaiter (only `getContainerId()` awaits it) never surfaces as a global
		// `unhandledRejection` — which under load can wedge the gateway for other
		// sessions. The real rejection is still observed by `getContainerId()`
		// (which awaits the same promise) and re-thrown on the awaited `init()`
		// boundary below. See tests/sandbox-init-rejection.test.ts.
		this._readyPromise.catch(() => {});

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
			await execDocker([
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

		// Resolve start point: use baseBranch if provided, otherwise consult the
		// project's configured `base_ref` (via the host-injected resolver),
		// falling back to the container's `symbolic-ref refs/remotes/origin/HEAD`
		// chain when unset. See `docs/design/base-ref.md` §6.
		let startPoint = baseBranch;
		const configuredBaseRef = this.options.baseRefResolver?.();
		if (!startPoint) {
			const exec = async (args: string[]): Promise<string> => {
				return this._dockerExec(containerId, ["git", ...args], { cwd: "/workspace" });
			};
			const { ref } = await resolveBaseRefWithExec(exec, configuredBaseRef);
			startPoint = ref || "origin/master";
		}

		// Create the worktree
		const args = ["git", "worktree", "add", worktreePath, "-b", branch, startPoint];
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

		// Publish with an explicit destination refspec, then set upstream tracking
		// only after that safe publish succeeds (non-fatal).
		if (!shouldSkipRemotePush()) {
			try {
				await this._publishBranchToOrigin(containerId, worktreePath, branch, true);
			} catch { /* push may fail with no remote, auth issues, or offline */ }
		}

		// When the project has a configured `base_ref`, override the per-branch
		// upstream so `@{u}` (and the ahead/behind pair) points at the configured
		// integration target rather than `origin/<branch>` created above.
		// Mirrors host-side `createWorktree` (see `docs/design/base-ref.md` §2).
		// Non-fatal in the sandbox — host-side save-time validation already
		// guarantees the ref resolves; this is defence-in-depth.
		const configuredBaseRefTrimmed = (configuredBaseRef ?? "").trim();
		if (configuredBaseRefTrimmed) {
			try {
				await this._dockerExec(containerId,
					["git", "branch", `--set-upstream-to=${configuredBaseRefTrimmed}`, branch],
					{ cwd: worktreePath });
			} catch (err: any) {
				console.warn(`[project-sandbox] Failed to set upstream for ${branch} to ${configuredBaseRefTrimmed}:`, err?.message || err);
			}
		}

		console.log(`[project-sandbox] Created worktree ${name} (branch: ${branch}) at ${worktreePath}`);
		return worktreePath;
	}

	/**
	 * Multi-repo aware worktree creation. Single-repo (one component with
	 * `repo === "."`) collapses to today's `createWorktree(name, branch,
	 * baseBranch)`. Multi-repo creates one worktree per distinct `repo` under
	 * `/workspace-wt/<name>/<repo>` from sources at `/workspace/<repo>` and
	 * runs each component's `worktree_setup_command` inside the container.
	 *
	 * See docs/design/multi-repo-components.md §7.2.
	 */
	async createWorktreeSet(
		name: string,
		branch: string,
		components: Component[],
		baseBranch?: string,
	): Promise<{ container: string; worktrees: Array<{ repo: string; worktreePath: string }> }> {
		const seen = new Set<string>();
		const repos: string[] = [];
		for (const c of components) {
			if (!seen.has(c.repo)) { seen.add(c.repo); repos.push(c.repo); }
		}
		if (repos.length === 1 && repos[0] === ".") {
			const container = await this.createWorktree(name, branch, baseBranch);
			return { container, worktrees: [{ repo: ".", worktreePath: container }] };
		}

		// Multi-repo: per-branch container at `/workspace-wt/<name>`, per-repo
		// worktrees underneath. Each repo's source clone lives at `/workspace/<repo>`.
		const containerId = await this.getContainerId();
		const container = `/workspace-wt/${name}`;

		try {
			await this._dockerExec(containerId, ["mkdir", "-p", container]);
		} catch {
			await execDocker([
				"exec", "-u", "root", containerId, "sh", "-c",
				`mkdir -p ${container} && chown node:node ${container}`,
			], { timeout: 10_000, env: DOCKER_ENV });
		}

		const configuredBaseRef = this.options.baseRefResolver?.();
		const configuredBaseRefTrimmed = (configuredBaseRef ?? "").trim();

		const out: Array<{ repo: string; worktreePath: string }> = [];
		for (const repo of repos) {
			const repoSrc = `/workspace/${repo}`;
			const wtPath = `${container}/${repo}`;

			// Resolve start point (per-repo so different repos can be at different
			// primary branches if they ever drift — we still warn elsewhere).
			// Honors the project's configured `base_ref` via the resolver injected
			// from the host; empty/undefined falls back to the in-container
			// `symbolic-ref refs/remotes/origin/HEAD` chain (today's behaviour).
			let startPoint = baseBranch;
			if (!startPoint) {
				const exec = async (args: string[]): Promise<string> => {
					return this._dockerExec(containerId, ["git", ...args], { cwd: repoSrc });
				};
				const { ref } = await resolveBaseRefWithExec(exec, configuredBaseRef);
				startPoint = ref || "origin/master";
			}

			try {
				await this._dockerExec(containerId, ["git", "worktree", "add", wtPath, "-b", branch, startPoint], { cwd: repoSrc });
			} catch {
				try {
					await this._dockerExec(containerId, ["git", "worktree", "add", wtPath, branch], { cwd: repoSrc });
				} catch (err2: any) {
					if (!(err2?.message?.includes("already exists") || err2?.stderr?.includes("already exists"))) {
						throw err2;
					}
					console.log(`[project-sandbox] Worktree ${name}/${repo} already exists, reusing`);
				}
			}

			await this._installPostCommitHook(containerId, wtPath);

			if (!shouldSkipRemotePush()) {
				try {
					await this._publishBranchToOrigin(containerId, wtPath, branch, true);
				} catch { /* push may fail with no remote, auth issues, or offline */ }
			}

			// Override per-branch upstream to the configured `base_ref` when set,
			// mirroring host-side `createWorktreeSet` (see `docs/design/base-ref.md` §2).
			// Non-fatal — host-side save-time validation already guarantees the ref
			// resolves; this is defence-in-depth for the container path.
			if (configuredBaseRefTrimmed) {
				try {
					await this._dockerExec(containerId,
						["git", "branch", `--set-upstream-to=${configuredBaseRefTrimmed}`, branch],
						{ cwd: wtPath });
				} catch (err: any) {
					console.warn(`[project-sandbox] Failed to set upstream for ${branch} (${repo}) to ${configuredBaseRefTrimmed}:`, err?.message || err);
				}
			}

			out.push({ repo, worktreePath: wtPath });
		}

		// Per-component setup hook — sequential, runs inside the container at
		// each component's resolved root. Shared with the host code path.
		try {
			const { runComponentSetups } = await import("../skills/worktree-setup.js");
			await runComponentSetups({
				components,
				branchContainer: container,
				primaryWorktreeRoot: "/workspace",
				exec: async (cmd, cwd, env) => {
					const execEnv: Record<string, string> = {};
					if (env.SOURCE_REPO) execEnv.SOURCE_REPO = String(env.SOURCE_REPO);
					await this._dockerExec(containerId, ["sh", "-c", cmd], { cwd, env: execEnv, timeout: 120_000 });
				},
			});
		} catch (err) {
			console.warn(`[project-sandbox] Component setup failed (non-fatal):`, err);
		}

		console.log(`[project-sandbox] Created multi-repo worktree set ${name} (branch: ${branch}) at ${container}`);
		return { container, worktrees: out };
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

	// ── Health monitoring ──────────────────────────────────────────────

	/** Start periodic health checks. Safe to call multiple times. */
	startHealthMonitor(intervalMs = 20_000): void {
		this.stopHealthMonitor();
		if (cpuDiagnosticsEnabled()) {
			getCpuDiagnostics().recordTimer("project-sandbox:healthMonitor", 0, { starts: 1, intervalMs });
		}
		this._healthInterval = setInterval(() => {
			this._healthCheck().catch(err => {
				console.warn(`[project-sandbox] Health check error for project ${this.options.projectId}:`, err?.message || err);
			});
		}, intervalMs);
	}

	/** Stop periodic health checks. */
	stopHealthMonitor(): void {
		if (this._healthInterval) {
			clearInterval(this._healthInterval);
			this._healthInterval = null;
			if (cpuDiagnosticsEnabled()) {
				getCpuDiagnostics().recordTimer("project-sandbox:healthMonitor", 0, { stops: 1 });
			}
		}
	}

	/** Subscribe to health events. Returns unsubscribe function. */
	onHealthEvent(listener: (event: SandboxHealthEvent) => void): () => void {
		this._healthListeners.push(listener);
		return () => {
			const idx = this._healthListeners.indexOf(listener);
			if (idx >= 0) this._healthListeners.splice(idx, 1);
		};
	}

	private _emitHealthEvent(event: SandboxHealthEvent): void {
		for (const listener of this._healthListeners) {
			try { listener(event); } catch { /* listener error — ignore */ }
		}
	}

	private async _healthCheck(): Promise<void> {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		const counters = diagEnabled ? {
			ticks: 1,
			skippedRecovering: 0,
			skippedStarting: 0,
			skippedNoContainer: 0,
			inspectCalls: 0,
			running: 0,
			dead: 0,
			recoveryAttempts: 0,
			recovered: 0,
			recoveryErrors: 0,
		} : undefined;
		try {
			if (this._recovering) { if (counters) counters.skippedRecovering = 1; return; }
			// Skip if never initialized (still in first-time startup)
			if (this._status === "starting") { if (counters) counters.skippedStarting = 1; return; }
			// If status is "ready", check container health; if "error", retry recovery
			if (this._status === "ready") {
				if (!this.containerId) { if (counters) counters.skippedNoContainer = 1; return; }
				if (counters) counters.inspectCalls = 1;
				const isRunning = await this._isContainerRunning(this.containerId);
				if (isRunning) { if (counters) counters.running = 1; return; }
				if (counters) counters.dead = 1;
			}

			// Container is dead or previous recovery failed — begin recovery
			this._recovering = true;
			const oldContainerId = this.containerId ?? "unknown";
			this._status = "error";
			if (counters) counters.recoveryAttempts = 1;

			console.log(`[project-sandbox] Container ${oldContainerId.substring(0, 12)} died for project ${this.options.projectId}, attempting recovery...`);
			this._emitHealthEvent({ type: "container-died", projectId: this.options.projectId, containerId: oldContainerId });

			try {
				await this.init();
				if (counters) counters.recovered = 1;
				console.log(`[project-sandbox] Container recovered for project ${this.options.projectId} (new container: ${this.containerId!.substring(0, 12)})`);
				this._emitHealthEvent({ type: "container-recovered", projectId: this.options.projectId, containerId: this.containerId! });
			} catch (err: any) {
				if (counters) counters.recoveryErrors = 1;
				console.error(`[project-sandbox] Recovery failed for project ${this.options.projectId}:`, err?.message || err);
				// Will retry on next poll cycle — _recovering resets so next cycle can try again
			} finally {
				this._recovering = false;
			}
		} finally {
			if (diagEnabled) {
				getCpuDiagnostics().recordTimer("project-sandbox:healthCheck", performance.now() - diagStart, counters);
			}
		}
	}

	/** Graceful shutdown: stop the container (don't remove — named volume persists). */
	async shutdown(): Promise<void> {
		this.stopHealthMonitor();
		if (!this.containerId) return;
		try {
			// Audit worktree state before stopping — helps diagnose lost worktrees on restart
			try {
				const wtList = await this._dockerExec(this.containerId, ["sh", "-c", "ls -d /workspace-wt/session/* 2>/dev/null || echo '(none)'"]);
				console.log(`[project-sandbox] Pre-shutdown worktrees in ${this.containerId.substring(0, 12)}: ${wtList.trim()}`);
			} catch { /* best-effort audit */ }
			await execDocker(["stop", this.containerId], {
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
		this.stopHealthMonitor();
		const volumeName = this._volumeName();
		if (this.containerId) {
			try {
				await execDocker(["rm", "-f", this.containerId], {
					timeout: 15_000,
					env: DOCKER_ENV,
				});
			} catch { /* already gone */ }
		}
		try {
			await execDocker(["volume", "rm", "-f", volumeName], {
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
		const { projectId, image } = this.options;
		const label = `bobbit-project=${projectId}`;

		// 1. Find existing container by label
		const existingId = await this._findContainerByLabel(label);

		if (existingId) {
			// Stale-image check: if the container was created from an older image
			// than the current tag (e.g. host upgraded pi-coding-agent and
			// `ensureImageAgentVersion` rebuilt the image), the container still
			// has the old binaries installed. Reconnecting would fail at first
			// RPC invocation (MODULE_NOT_FOUND for pi-coding-agent cli.js, or
			// version drift between host bridge and container agent). Recreate
			// the container — named volumes preserve /workspace and /workspace-wt
			// so worktrees survive.
			const stale = await this._isContainerImageStale(existingId, image);
			if (stale) {
				console.warn(`[project-sandbox] Container ${existingId.substring(0, 12)} was created from a stale image (image "${image}" has been rebuilt since); recreating`);
				await this._removeContainer(existingId);
				await this._createContainer();
				await this._runInitSequence();
				return;
			}

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
					await execDocker(["start", existingId], {
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
		const { projectId, image, sandboxNetwork, sandboxMounts, sandboxCredentials, sandboxAgentAuthAllowed, sandboxAgentAuthPrefs, githubToken } = this.options;

		// Ensure the state directory and sandbox-visible subdirectories exist for bind mounts
		const stateDir = path.join(this.options.projectDir, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		for (const sub of ["sessions", "tool-guard", "html-snapshots"]) {
			fs.mkdirSync(path.join(stateDir, sub), { recursive: true });
		}

		// Dynamic resource limits: N-2 cores, M-2GB memory, no PID limit
		// Query Docker daemon to avoid requesting more resources than the VM has
		const dockerLimits = await getDockerResourceLimits();
		const { cpus: totalCpus, memoryGB: totalMemGB } = computeResourceLimits(
			os.cpus().length,
			os.totalmem(),
			dockerLimits?.cpus,
			dockerLimits?.memBytes,
		);

		// Collect read-only bind mounts for any `mounted` clone sources (remote-less
		// repos). The host repo is mounted at a fixed container path so the init
		// sequence clones it via `file://<mountPath>` instead of an unreachable
		// host path. De-dupe by mountPath so multi-repo sources can't collide.
		const extraReadonlyMounts: Array<{ hostPath: string; mountPath: string }> = [];
		const seenMountPaths = new Set<string>();
		const addMount = (src?: SandboxCloneSource): void => {
			if (src?.kind === "mounted" && !seenMountPaths.has(src.mountPath)) {
				seenMountPaths.add(src.mountPath);
				extraReadonlyMounts.push({ hostPath: src.hostPath, mountPath: src.mountPath });
			}
		};
		addMount(this.options.cloneSource);
		for (const src of Object.values(this.options.cloneSourceByName ?? {})) addMount(src);

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
			sandboxAgentAuthAllowed,
			sandboxAgentAuthPrefs,
			sandboxNetwork,
			toolManager: this.options.toolManager,
			extraReadonlyMounts: extraReadonlyMounts.length ? extraReadonlyMounts : undefined,
		});

		// Inject GITHUB_TOKEN for git push/PR inside container
		if (githubToken) {
			const insertIdx = dockerArgs.length - 3; // before image + sleep + infinity
			dockerArgs.splice(insertIdx, 0, "-e", `GITHUB_TOKEN=${githubToken}`);
		}

		const { stdout } = await execDocker(dockerArgs, {
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
			await execDocker([
				"exec", "-u", "root", containerId, "sh", "-c",
				"mkdir -p /workspace-wt && chown node:node /workspace-wt",
			], { timeout: 10_000, env: DOCKER_ENV });
		} catch {
			// Non-fatal — createWorktree will retry
		}

		// Defense-in-depth: mask /proc/1/environ
		try {
			await execDocker([
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

		// Multi-repo: each declared repo gets its own clone under `/workspace/<repo>/`.
		// Detect by inspecting components for any repo !== ".".
		const components = this.options.components ?? [];
		const repoNames: string[] = [];
		const seen = new Set<string>();
		for (const c of components) {
			if (!seen.has(c.repo)) { seen.add(c.repo); repoNames.push(c.repo); }
		}
		const isMultiRepo = repoNames.some(r => r !== ".");

		if (isMultiRepo) {
			await this._runInitSequenceMultiRepo(repoNames);
			return;
		}

		// Check if the workspace already has a git repo (volume persisted from prior run)
		try {
			await this._dockerExec(this.containerId, ["test", "-d", "/workspace/.git"]);
			// .git exists — skip init
			console.log(`[project-sandbox] Workspace already initialized (volume persisted)`);
			return;
		} catch {
			// .git doesn't exist — need to clone
		}

		// Resolve the clone source. Prefer the pre-resolved `cloneSource`
		// (which is guaranteed to never be a raw host path — remote-less repos
		// become a `file://` bind-mount source). Fall back to the legacy
		// `repoUrl` for backward compatibility, stripping any embedded token
		// (defense-in-depth — auth is via the GITHUB_TOKEN credential helper).
		const repoUrl = this.options.cloneSource?.cloneUrl ?? stripTokenFromGitUrl(this.options.repoUrl);

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

	/**
	 * Multi-repo init: clone each declared repo into `/workspace/<repo>/`.
	 * Idempotent — a repo with `.git` already present is skipped.
	 * Component setup commands are NOT run here; they run on each
	 * worktree-set creation via `runComponentSetups`.
	 */
	private async _runInitSequenceMultiRepo(repoNames: string[]): Promise<void> {
		if (!this.containerId) return;
		const urlMap = this.options.repoUrlByName ?? {};
		const cloneSourceMap = this.options.cloneSourceByName ?? {};
		const defaultUrl = this.options.cloneSource?.cloneUrl ?? stripTokenFromGitUrl(this.options.repoUrl);

		// Mark all of /workspace as a safe directory for git
		await this._dockerExec(this.containerId, ["git", "config", "--global", "--add", "safe.directory", "*"]);

		for (const repo of repoNames) {
			if (repo === ".") continue;  // sanity
			const dest = `/workspace/${repo}`;
			try {
				await this._dockerExec(this.containerId, ["test", "-d", `${dest}/.git`]);
				console.log(`[project-sandbox] Repo ${repo} already cloned`);
				continue;
			} catch { /* not cloned yet */ }

			// Prefer the pre-resolved per-repo clone source (never a raw host
			// path); fall back to the legacy per-repo URL map, then the default.
			const url = cloneSourceMap[repo]?.cloneUrl ?? stripTokenFromGitUrl(urlMap[repo] ?? defaultUrl);
			try {
				await this._dockerExec(this.containerId, ["sh", "-c", `mkdir -p ${dest}`]);
			} catch { /* will be created by clone */ }
			try {
				console.log(`[project-sandbox] Cloning ${url} into ${dest}...`);
				await this._dockerExec(this.containerId, ["git", "clone", url, dest], { timeout: 120_000 });
			} catch (err: any) {
				console.warn(`[project-sandbox] Clone failed for repo ${repo}: ${err?.message || err}`);
			}
		}

		console.log(`[project-sandbox] Multi-repo init sequence complete for project ${this.options.projectId}`);
	}

	// ── Private: Post-commit hook ──────────────────────────────────────

	private async _publishBranchToOrigin(containerId: string, worktreePath: string, branch: string, setUpstream: boolean): Promise<void> {
		await this._dockerExec(containerId, ["git", "push", "origin", `${branch}:refs/heads/${branch}`], {
			cwd: worktreePath,
			timeout: 30_000,
		});
		if (!setUpstream) return;
		await this._dockerExec(containerId, ["git", "fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], {
			cwd: worktreePath,
			timeout: 15_000,
		});
		await this._dockerExec(containerId, ["git", "branch", `--set-upstream-to=origin/${branch}`, branch], {
			cwd: worktreePath,
			timeout: 10_000,
		});
	}

	private async _installPostCommitHook(containerId: string, worktreePath: string): Promise<void> {
		if (shouldSkipRemotePush()) return; // No push hook in test mode

		// Determine the .git dir for this worktree (may be a file pointing to the main repo)
		const hookScript = [
			"#!/bin/sh",
			'branch=$(git symbolic-ref --short HEAD 2>/dev/null)',
			'[ -n "$branch" ] && git push origin "HEAD:refs/heads/$branch" 2>/dev/null &',
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
			const { stdout } = await execDocker([
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

	/**
	 * Returns true if the container was created from an image whose ID no
	 * longer matches the current image tag — i.e. the image has been rebuilt
	 * (or retagged) since the container was created. Such containers still
	 * have the *old* layers installed (e.g. older pi-coding-agent version),
	 * so reconnecting would fail at first RPC invocation. Conservative: on
	 * any inspect error, returns false (stick with reconnect attempt rather
	 * than nuking a possibly-working container).
	 */
	private async _isContainerImageStale(containerId: string, imageTag: string): Promise<boolean> {
		try {
			const [containerImg, currentImg] = await Promise.all([
				execDocker(["inspect", "--format", "{{.Image}}", containerId], { timeout: 5_000, env: DOCKER_ENV }),
				execDocker(["inspect", "--format", "{{.Id}}", imageTag], { timeout: 5_000, env: DOCKER_ENV }),
			]);
			const a = containerImg.stdout.trim();
			const b = currentImg.stdout.trim();
			if (!a || !b) return false; // can't determine — don't nuke
			return a !== b;
		} catch {
			return false;
		}
	}

	private async _isContainerRunning(containerId: string): Promise<boolean> {
		try {
			const { stdout } = await execDocker([
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
			await execDocker(["rm", "-f", containerId], {
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

		const { stdout } = await execDocker(execArgs, {
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
