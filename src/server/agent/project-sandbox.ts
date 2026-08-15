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

import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./cpu-diagnostics.js";
import { buildDockerRunArgs, isVerificationSignalId, projectSandboxVolumeCreateArgsByKey, projectSandboxVolumeNames, SANDBOX_STATE_MOUNTS, validatedE2ERunId, type ProjectSandboxVolumeKey } from "./docker-args.js";
import { activeAgentSessionsDir } from "./agent-session-path.js";
import { bobbitStateDir, globalAgentDir } from "../bobbit-dir.js";
import { verificationCheckoutProjectDir } from "./verification-checkout-scope.js";
import { toDockerPath } from "./rpc-bridge.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { ToolManager } from "./tool-manager.js";
import { stripTokenFromGitUrl, resolveBaseRefWithExec, hasResolvedHeadWithExec, UnresolvedHeadWorktreeError } from "../skills/git.js";
import { repositoryMutationCoordinator } from "../skills/repository-mutation-coordinator.js";
import { realClock, realCommandRunner, type Clock, type CommandRunner } from "../gateway-deps.js";
import type { Component } from "./project-config-store.js";
import type { SandboxCloneSource } from "./sandbox-clone-source.js";
import { HEADQUARTERS_PROJECT_ID, SYSTEM_PROJECT_ID } from "./project-registry.js";

const DOCKER_BIN = "docker";

/** Env config for docker commands — suppresses MSYS path mangling on Windows. */
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };
const CONTAINER_AGENT_SESSIONS_DIR = "/home/node/.bobbit/agent/sessions";
const CONTAINER_AGENT_MODELS_JSON = "/home/node/.bobbit/agent/models.json";
const VERIFICATION_SIDECAR_LABEL = "bobbit-verification-sidecar";
const VERIFICATION_SIGNAL_LABEL = "bobbit-verification-signal";
const VERIFICATION_CHECKOUT_CONTAINER_ROOT = "/bobbit-state/verification-checkouts";
const VERIFICATION_SOURCE_CONTAINER_ROOT = "/bobbit-state/verification-sources";
const VERIFICATION_SIDECAR_VERSION = "3";
const FULL_DOCKER_ID = /^[a-f0-9]{64}$/i;
const SAFE_IGNORED_OUTPUT_DIR = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const SAFE_WORKTREE_DEPENDENCY = /^\/workspace(?:-wt\/(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)?\/node_modules$/;
const SAFE_DEPENDENCY_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*node_modules$/;

interface DockerMountInfo {
	Type?: string;
	/** Docker uses Source for named-volume identity in inspect output. */
	Source?: string;
	Name?: string;
	Destination?: string;
	RW?: boolean;
	Mode?: string;
}

interface DockerMountSpec {
	Type?: string;
	Source?: string;
	Target?: string;
	ReadOnly?: boolean;
	VolumeOptions?: { Subpath?: string };
}

export interface AgentDirMountExpectation {
	sessionsDir: string;
	modelsJson: string;
	modelsJsonExists: boolean;
}

export interface AgentDirMountStalenessResult {
	stale: boolean;
	reason?: string;
}

export interface StateDirMountExpectation {
	stateDir: string;
}

/** A restartable, signal-owned Docker container that sees one frozen source root. */
export interface VerificationSidecar {
	containerId: string;
	projectId: string;
	signalId: string;
	checkoutPath: string;
	cwd: string;
}

export interface VerificationSidecarDependencyLink {
	/** Signal-root-relative dependency symlink, e.g. services/api/node_modules. */
	path: string;
	/** Exact normal-sandbox dependency directory for that same logical repository. */
	target: string;
}

export interface VerificationSidecarRequest {
	signalId: string;
	/** Canonical completed checkout supplied by the pinned-checkout owner. */
	checkoutPath: string;
	/** Ignored output directories that commands may create in the execution view.
	 * They are intentionally constrained to relative paths and cannot shadow
	 * any materialized source entry. */
	ignoredOutputDirs?: readonly string[];
	/**
	 * Ordered repository-local dependency links. An omitted map retains D-3's
	 * root-only node_modules compatibility path; an explicit (including empty)
	 * map never guesses a live worktree target.
	 */
	dependencyLinks?: readonly VerificationSidecarDependencyLink[];
}

/** Cleanup is bound to the durable full identity recorded for a sidecar. */
export interface VerificationSidecarRemovalRequest extends Omit<VerificationSidecarRequest, "checkoutPath"> {
	/** Persisted expected checkout path. It may no longer exist during terminal recovery. */
	checkoutPath: string;
	containerId: string;
}

interface DockerContainerInspection {
	Id?: string;
	Config?: { Image?: string; Labels?: Record<string, string> };
	Mounts?: DockerMountInfo[];
	HostConfig?: { Mounts?: DockerMountSpec[] };
}

export function getModelsJsonContentStaleness(hostContent: string, containerContent: string): AgentDirMountStalenessResult {
	return hostContent === containerContent
		? { stale: false }
		: { stale: true, reason: "container agent models.json content does not match the atomically published host file" };
}

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

function normalizeContainerMountDestination(value: string | undefined): string {
	return (value ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function comparableMountPath(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
	return comparableMountPath(left) === comparableMountPath(right);
}

function hostPathMountCandidates(hostPath: string): Set<string> {
	const candidates = new Set<string>();
	const add = (value: string | undefined): void => {
		if (!value) return;
		candidates.add(comparableMountPath(value));
	};
	add(path.resolve(hostPath));
	add(toDockerPath(path.resolve(hostPath)));
	const dockerPath = toDockerPath(path.resolve(hostPath));
	if (dockerPath.startsWith("/")) {
		add(`/host_mnt${dockerPath}`);
		add(`/run/desktop/mnt/host${dockerPath}`);
	}
	try { add(fs.realpathSync(hostPath)); } catch { /* path may not exist yet */ }
	return candidates;
}

function mountSourceMatches(source: string | undefined, expectedHostPath: string): boolean {
	if (!source) return false;
	return hostPathMountCandidates(expectedHostPath).has(comparableMountPath(source));
}

function isMountReadOnly(mount: DockerMountInfo): boolean {
	if (mount.RW === false) return true;
	return typeof mount.Mode === "string" && mount.Mode.split(",").includes("ro");
}

function isStrictDescendant(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isWithin(root: string, candidate: string): boolean {
	return samePath(root, candidate) || isStrictDescendant(root, candidate);
}

function pathsOverlap(left: string, right: string): boolean {
	const a = normalizeContainerMountDestination(left);
	const b = normalizeContainerMountDestination(right);
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function sidecarPaths(signalId: string): { source: string; view: string } {
	return {
		source: `${VERIFICATION_SOURCE_CONTAINER_ROOT}/${signalId}`,
		view: `${VERIFICATION_CHECKOUT_CONTAINER_ROOT}/${signalId}`,
	};
}

/** Fixed support mounts are not project source authority. Everything else a
 * verifier sees must be the signal source, a declared output, or a declared
 * exact dependency-volume leaf. */
function isAllowedVerificationSidecarSupportMount(destination: string): boolean {
	return destination === "/tools"
		|| destination === "/tools-builtin"
		|| destination === "/market-packs-builtin"
		|| destination === "/market-packs-server"
		|| destination === "/market-packs-global-user"
		|| destination === "/market-packs-project"
		|| destination === "/bobbit/preview-root"
		|| destination === "/home/node/.bobbit/agent/sessions"
		|| destination === "/home/node/.bobbit/agent/models.json"
		|| destination === "/home/node/.bobbit/agent/auth.json"
		|| destination === "/tmp/session-prompts"
		|| destination === "/mcp-extensions"
		|| SANDBOX_STATE_MOUNTS.some(({ sub }) => destination === `/bobbit-state/${sub}`);
}

function validatedIgnoredOutputDirs(value: readonly string[] | undefined): string[] {
	const outputDirs = [...(value ?? [])];
	for (let index = 0; index < outputDirs.length; index++) {
		if (index > 0 && outputDirs[index - 1]! >= outputDirs[index]!) {
			throw new Error("[project-sandbox] verification output directories must be unique and sorted");
		}
		const output = outputDirs[index]!;
		if (!SAFE_IGNORED_OUTPUT_DIR.test(output) || output.split("/").some(part => part === "." || part === "..")) {
			throw new Error("[project-sandbox] verification output directory is not a safe relative path");
		}
		if (outputDirs.some(other => other !== output && (other.startsWith(`${output}/`) || output.startsWith(`${other}/`)))) {
			throw new Error("[project-sandbox] verification output directories overlap");
		}
	}
	return outputDirs;
}

interface OutputTrieNode {
	children: Map<string, OutputTrieNode>;
	outputDir?: string;
	dependencyTarget?: string;
}

function outputTrie(outputDirs: readonly string[], dependencyLinks: readonly VerificationSidecarDependencyLink[] = []): OutputTrieNode {
	const root: OutputTrieNode = { children: new Map() };
	const resolveNode = (relativePath: string): OutputTrieNode => {
		let node = root;
		for (const segment of relativePath.split("/")) {
			let child = node.children.get(segment);
			if (!child) {
				child = { children: new Map() };
				node.children.set(segment, child);
			}
			node = child;
		}
		return node;
	};
	for (const outputDir of outputDirs) resolveNode(outputDir).outputDir = outputDir;
	for (const dependency of dependencyLinks) {
		if (outputDirs.some(outputDir => outputDir === dependency.path
			|| outputDir.startsWith(`${dependency.path}/`) || dependency.path.startsWith(`${outputDir}/`))) {
			throw new Error("[project-sandbox] verification output and dependency paths overlap");
		}
		resolveNode(dependency.path).dependencyTarget = dependency.target;
	}
	return root;
}

/**
 * Return the canonical, ordinary directory that Docker may bind for one
 * project's frozen checkouts. A pre-existing scope must never be followed:
 * otherwise a project-local symlink could turn its mount into another project's
 * checkout tree (or any host directory).
 */
export function resolveScopedVerificationCheckoutMount(checkoutRoot: string, projectId: string): string {
	fs.mkdirSync(checkoutRoot, { recursive: true });
	const canonicalRoot = fs.realpathSync(checkoutRoot);
	const rootInfo = fs.lstatSync(canonicalRoot);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
		throw new Error("[project-sandbox] verification checkout root is not a safe directory");
	}
	const scoped = verificationCheckoutProjectDir(canonicalRoot, projectId);
	if (!scoped) throw new Error("[project-sandbox] refusing sandbox mount without an authoritative project ID");
	try {
		const info = fs.lstatSync(scoped);
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new Error("[project-sandbox] verification checkout scope is not a safe directory");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		fs.mkdirSync(scoped, { mode: 0o755 });
	}
	// This is the mount root, not an execution tree. Sandbox processes may write
	// inside atomically published signal children but cannot replace this parent.
	fs.chmodSync(scoped, 0o755);
	const canonicalScope = fs.realpathSync(scoped);
	const scopeInfo = fs.lstatSync(canonicalScope);
	if (!scopeInfo.isDirectory() || scopeInfo.isSymbolicLink() || (process.platform !== "win32" && (scopeInfo.mode & 0o022) !== 0) || comparableMountPath(canonicalScope) !== comparableMountPath(scoped) || !isStrictDescendant(canonicalRoot, canonicalScope)) {
		throw new Error("[project-sandbox] verification checkout scope escapes its server-owned root");
	}
	return canonicalScope;
}

export function getAgentDirMountStaleness(
	mounts: DockerMountInfo[] | unknown,
	expected: AgentDirMountExpectation,
): AgentDirMountStalenessResult {
	if (!Array.isArray(mounts)) return { stale: true, reason: "container mount metadata is not an array" };
	const sessionsMounts = mounts.filter((mount) => normalizeContainerMountDestination(mount?.Destination) === CONTAINER_AGENT_SESSIONS_DIR);
	if (sessionsMounts.length === 0) return { stale: true, reason: "missing active agent sessions mount" };
	if (sessionsMounts.some((mount) => !mountSourceMatches(mount.Source, expected.sessionsDir))) {
		return { stale: true, reason: "agent sessions mount source does not match the active agent directory" };
	}

	const modelMounts = mounts.filter((mount) => normalizeContainerMountDestination(mount?.Destination) === CONTAINER_AGENT_MODELS_JSON);
	if (!expected.modelsJsonExists) {
		return modelMounts.length > 0
			? { stale: true, reason: "container still has an agent models.json mount, but the active agent directory does not" }
			: { stale: false };
	}
	if (modelMounts.length === 0) return { stale: true, reason: "missing active agent models.json mount" };
	if (modelMounts.some((mount) => !mountSourceMatches(mount.Source, expected.modelsJson) || !isMountReadOnly(mount))) {
		return { stale: true, reason: "agent models.json mount source does not match the active agent directory" };
	}
	return { stale: false };
}

export function getStateDirMountStaleness(
	mounts: DockerMountInfo[] | unknown,
	expected: StateDirMountExpectation,
): AgentDirMountStalenessResult {
	if (!Array.isArray(mounts)) return { stale: true, reason: "container mount metadata is not an array" };
	// A project container is shared by agents. It must never receive a parent
	// checkout mount, otherwise any agent could inspect another signal's frozen
	// source or replace the mount child before a verifier starts.
	if (mounts.some((mount) => normalizeContainerMountDestination(mount?.Destination) === VERIFICATION_CHECKOUT_CONTAINER_ROOT
		|| normalizeContainerMountDestination(mount?.Destination).startsWith(`${VERIFICATION_CHECKOUT_CONTAINER_ROOT}/`))) {
		return { stale: true, reason: "long-lived project container exposes verification checkout source" };
	}
	for (const { sub, readOnly } of SANDBOX_STATE_MOUNTS) {
		const destination = `/bobbit-state/${sub}`;
		const hostPath = path.join(expected.stateDir, sub);
		const stateMounts = mounts.filter((mount) => normalizeContainerMountDestination(mount?.Destination) === destination);
		if (stateMounts.length === 0) return { stale: true, reason: `missing required state mount ${destination}` };
		const compatible = stateMounts.some((mount) => {
			if (!mountSourceMatches(mount.Source, hostPath)) return false;
			return readOnly ? isMountReadOnly(mount) : !isMountReadOnly(mount);
		});
		if (!compatible) {
			const mode = readOnly ? "read-only" : "writable";
			return { stale: true, reason: `state mount ${destination} does not match the active ${mode} state directory` };
		}
	}
	return { stale: false };
}

async function execDocker(args: readonly string[], options?: any, commandRunner: CommandRunner = realCommandRunner): Promise<{ stdout: string; stderr: string }> {
	if (!cpuDiagnosticsEnabled()) {
		return await commandRunner.execFile(DOCKER_BIN, args, options) as unknown as { stdout: string; stderr: string };
	}
	const start = performance.now();
	let success = 0;
	let errorCode = "none";
	try {
		const result = await commandRunner.execFile(DOCKER_BIN, args, options) as unknown as { stdout: string; stderr: string };
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
export async function getDockerResourceLimits(commandRunner: CommandRunner = realCommandRunner): Promise<DockerResourceLimits | null> {
	if (_cachedDockerLimits !== undefined) return _cachedDockerLimits;

	try {
		const { stdout } = await execDocker(
			["info", "--format", "{{.NCPU}} {{.MemTotal}}"],
			{ timeout: 5_000, env: DOCKER_ENV },
			commandRunner,
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
	/** Whether sandbox policy permits mounting the Google account (Gemini Code Assist) OAuth credential into auth.json. */
	sandboxAgentAuthGoogleAllowed?: boolean;
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
	/** Serializes health recovery and explicit mount recreation. */
	private _containerLifecycleTail: Promise<void> = Promise.resolve();
	private _modelRefreshPromise: Promise<void> | null = null;
	/** Monotonic publication generation requested by models.json writers. */
	private _modelMountGeneration = 0;
	/** Latest publication generation known to be mounted by the live container. */
	private _mountedModelGeneration = 0;
	private readonly commandRunner: CommandRunner;
	private readonly clock: Clock;
	private readonly worktreeSetupRuntime: { skipNpmCi?: boolean; recordSetupPath?: string };
	/**
	 * E2E resource owner captured when this sandbox lifecycle begins. It must not
	 * be reread from process.env during remount, recovery, or destruction: test
	 * coordinators can coexist in one Node process while their environment changes.
	 */
	private readonly e2eRunId: string | undefined;

	constructor(private options: ProjectSandboxOptions, deps: { commandRunner?: CommandRunner; clock?: Clock; worktreeSetupRuntime?: { skipNpmCi?: boolean; recordSetupPath?: string } } = {}) {
		if (!options || typeof options !== "object" || typeof options.projectId !== "string" || !options.projectId) {
			throw new Error("[project-sandbox] ProjectSandbox constructor requires ProjectSandboxOptions with a non-empty projectId");
		}
		this.commandRunner = deps.commandRunner ?? realCommandRunner;
		this.clock = deps.clock ?? realClock;
		this.worktreeSetupRuntime = deps.worktreeSetupRuntime ?? {};
		this.e2eRunId = validatedE2ERunId();
	}

	private execDocker(args: readonly string[], options?: any): Promise<{ stdout: string; stderr: string }> {
		return execDocker(args, options, this.commandRunner);
	}

	// ── Public API ─────────────────────────────────────────────────────

	/** Create or reconnect to the project container. */
	async init(): Promise<void> {
		// Defensive: Headquarters / hidden `system` scopes are data-only /
		// no-worktree / no-git and must never be sandboxed. If an HQ ProjectSandbox
		// is somehow constructed, refuse to run rather than clone the server-run-dir
		// checkout or create a one-off `<projectDir>/.bobbit/{state,config}` layout.
		// The authoritative gate lives in SandboxManager.ensureForProject; this is
		// belt-and-suspenders.
		if (this.options.projectId === HEADQUARTERS_PROJECT_ID || this.options.projectId === SYSTEM_PROJECT_ID) {
			throw new Error(`[project-sandbox] refusing to initialize a sandbox for exempt project ${this.options.projectId} (Headquarters/system are never sandboxed)`);
		}
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

	/**
	 * Return the one durable sidecar allowed to execute a signal. The parent
	 * project container never has any verification source mount; this separate
	 * container binds the completed signal root read-only and constructs a
	 * root-owned execution view so a same-UID process cannot rename or mutate
	 * attested source bytes out from under its cwd.
	 */
	async getVerificationSidecar(request: VerificationSidecarRequest): Promise<VerificationSidecar> {
		return this._withContainerLifecycle(async () => {
			// A verifier owns its own isolated sidecar. It intentionally does not
			// require the mutable project container, clone, or Git worktree lifecycle.
			const checkoutPath = this._validateVerificationCheckout(request);
			const matching = await this._findVerificationSidecars(request.signalId);
			if (matching.length > 1) {
				throw new Error(`[project-sandbox] refusing ambiguous verification sidecars for signal ${request.signalId}`);
			}
			const ignoredOutputDirs = this._validatedSidecarOutputDirs(request, checkoutPath);
			const dependencyLinks = this._validatedSidecarDependencyLinks(request, checkoutPath);
			if (matching.length === 1) {
				const sidecar = await this._validateVerificationSidecar(matching[0], request.signalId, checkoutPath, undefined, ignoredOutputDirs, dependencyLinks);
				if (!(await this._isContainerRunning(sidecar.containerId))) {
					await this.execDocker(["start", sidecar.containerId], { timeout: 30_000, env: DOCKER_ENV });
				}
				return sidecar;
			}
			return this._createVerificationSidecar({ ...request, ignoredOutputDirs, dependencyLinks }, checkoutPath);
		});
	}

	/** List only strictly validated sidecars owned by this ProjectSandbox. */
	async listVerificationSidecars(): Promise<VerificationSidecar[]> {
		return this._withContainerLifecycle(() => this._listVerificationSidecars());
	}

	/** Reconnect validation for persisted verifier state. Full IDs only: Docker's
	 * convenient short-ID aliases are never an authority across a restart. */
	async resolveVerificationSidecar(input: { signalId: string; containerId: string; ignoredOutputDirs: readonly string[]; dependencyLinks?: readonly VerificationSidecarDependencyLink[] }): Promise<VerificationSidecar> {
		return this._withContainerLifecycle(async () => {
			if (!isVerificationSignalId(input.signalId) || !FULL_DOCKER_ID.test(input.containerId)) {
				throw new Error("[project-sandbox] verification sidecar identity is not canonical");
			}
			const checkoutPath = this._validateVerificationCheckout({
				signalId: input.signalId,
				checkoutPath: path.join(resolveScopedVerificationCheckoutMount(path.join(bobbitStateDir(), "verification-checkouts"), this.options.projectId), input.signalId),
			});
			const ignoredOutputDirs = this._validatedSidecarOutputDirs(input, checkoutPath);
			const dependencyLinks = this._validatedSidecarDependencyLinks(input, checkoutPath);
			const sidecar = await this._validateVerificationSidecar(input.containerId, input.signalId, checkoutPath, undefined, ignoredOutputDirs, dependencyLinks);
			if (!(await this._isContainerRunning(sidecar.containerId))) {
				await this.execDocker(["start", sidecar.containerId], { timeout: 30_000, env: DOCKER_ENV });
			}
			return sidecar;
		});
	}

	/** Remove a verified sidecar after its command-tree terminal barrier. */
	async removeVerificationSidecar(request: VerificationSidecarRemovalRequest): Promise<void> {
		await this._withContainerLifecycle(async () => {
			if (!isVerificationSignalId(request.signalId) || !FULL_DOCKER_ID.test(request.containerId)) {
				throw new Error("[project-sandbox] verification sidecar cleanup requires canonical signal and full Docker identities");
			}
			let checkoutPath: string | undefined;
			try {
				checkoutPath = this._validateVerificationCheckout(request);
			} catch (error) {
				// Terminal recovery may run after the pinned-checkout owner removed the
				// host root. It may still remove only the durable exact container after
				// proving every independent ownership and mount identity below.
				const expected = this._expectedVerificationCheckoutPath(request);
				if (fs.existsSync(expected)) throw error;
				const inspection = await this._inspectFullContainer(request.containerId);
				if (inspection.Id.toLowerCase() !== request.containerId.toLowerCase()) {
					throw new Error("[project-sandbox] Docker inspect did not resolve the recorded verification sidecar identity");
				}
				this._validateMissingCheckoutRemoval(inspection, request, expected);
				await this._removeVerificationSidecarContainer(inspection.Id);
				return;
			}
			const matching = await this._findVerificationSidecars(request.signalId);
			if (matching.length > 1) throw new Error(`[project-sandbox] refusing ambiguous verification sidecars for signal ${request.signalId}`);
			if (matching.length === 0) {
				if (!(await this._isExactContainerAbsent(request.containerId))) {
					throw new Error("[project-sandbox] verification sidecar cleanup found no matching label but the recorded sidecar still exists");
				}
				return;
			}
			if (matching[0].toLowerCase() !== request.containerId.toLowerCase()) {
				throw new Error("[project-sandbox] verification sidecar cleanup identity does not match the recorded sidecar");
			}
			await this._validateVerificationSidecar(matching[0], request.signalId, checkoutPath);
			// The caller's persisted canonical identity was compared above; remove
			// that exact ID rather than widening authority through a rediscovery value.
			await this._removeVerificationSidecarContainer(request.containerId);
		});
	}

	private _expectedVerificationCheckoutPath(request: Pick<VerificationSidecarRequest, "signalId" | "checkoutPath">): string {
		const scope = resolveScopedVerificationCheckoutMount(path.join(bobbitStateDir(), "verification-checkouts"), this.options.projectId);
		const expected = path.join(scope, request.signalId);
		if (!samePath(path.resolve(request.checkoutPath), expected)) {
			throw new Error("[project-sandbox] verification checkout is not this project's exact completed signal root");
		}
		return expected;
	}

	private _validateMissingCheckoutRemoval(
		inspection: DockerContainerInspection & { Id: string },
		request: VerificationSidecarRemovalRequest,
		expectedCheckoutPath: string,
	): void {
		const labels = inspection.Config?.Labels ?? {};
		const outputDirs = validatedIgnoredOutputDirs(request.ignoredOutputDirs);
		const dependencyLinks = request.dependencyLinks === undefined ? undefined : this._validatedDependencyLinkList(request.dependencyLinks);
		const dependencyLabel = labels["bobbit-verification-dependencies"];
		const declaredDependencyLinks = dependencyLabel === undefined
			? undefined
			: this._validatedDependencyLinkList(this._dependencyLinksFromLabel(dependencyLabel));
		if (!this._isCurrentSidecarLabels(labels, request.signalId)
			|| labels["bobbit-verification-outputs"] !== outputDirs.join(",")
			|| !declaredDependencyLinks
			|| (dependencyLinks !== undefined && dependencyLabel !== this._serializeDependencyLinks(dependencyLinks))
			|| inspection.Config?.Image !== this.options.image) {
			throw new Error("[project-sandbox] refusing missing-checkout cleanup for foreign, stale, or mismatched verification sidecar");
		}
		const { source, view } = sidecarPaths(request.signalId);
		const mounts = inspection.Mounts ?? [];
		const sourceMounts = mounts.filter(mount => normalizeContainerMountDestination(mount.Destination) === source);
		if (sourceMounts.length !== 1 || sourceMounts[0].Type !== "bind" || !isMountReadOnly(sourceMounts[0])
			|| !mountSourceMatches(sourceMounts[0].Source, expectedCheckoutPath)) {
			throw new Error("[project-sandbox] refusing missing-checkout cleanup with invalid exact source mount");
		}
		const expectedOutputs = new Map(outputDirs.map(outputDir => [`${view}/${outputDir}`, path.join(expectedCheckoutPath, outputDir)]));
		for (const [destination, hostPath] of expectedOutputs) {
			const outputMounts = mounts.filter(mount => normalizeContainerMountDestination(mount.Destination) === destination);
			if (outputMounts.length !== 1 || outputMounts[0].Type !== "bind" || isMountReadOnly(outputMounts[0]) || !mountSourceMatches(outputMounts[0].Source, hostPath)) {
				throw new Error("[project-sandbox] refusing missing-checkout cleanup with invalid writable output mount");
			}
		}
		this._validateDependencyVolumeMounts(inspection, declaredDependencyLinks);
		this._validateNoForeignVerificationMounts(mounts, source, new Set(expectedOutputs.keys()), declaredDependencyLinks);
		if (mounts.some(mount => {
			const destination = normalizeContainerMountDestination(mount.Destination);
			return destination !== source && !expectedOutputs.has(destination) && (pathsOverlap(destination, source) || pathsOverlap(destination, view));
		})) {
			throw new Error("[project-sandbox] refusing missing-checkout cleanup with shadowing mounts");
		}
	}

	/** Remove validated orphan sidecars before the pinned-checkout owner removes host roots. */
	async recoverVerificationSidecars(activeSignalIds: ReadonlySet<string>): Promise<string[]> {
		return this._withContainerLifecycle(async () => {
			const removed: string[] = [];
			// Recovery deliberately classifies candidates independently. A malformed
			// or stale owned orphan must not stop a later valid orphan from being
			// collected, and host checkout roots may already have been removed.
			for (const id of await this._findVerificationSidecarCandidates()) {
				try {
					const inspection = await this._inspectFullContainer(id);
					if (!this._isOwnedSidecarCandidate(inspection) || inspection.Id === this.containerId) continue;
					const signalId = inspection.Config?.Labels?.[VERIFICATION_SIGNAL_LABEL];
					if (signalId && isVerificationSignalId(signalId) && activeSignalIds.has(signalId)
						&& this._isCurrentSidecarLabels(inspection.Config?.Labels ?? {}, signalId)) continue;
					await this._removeVerificationSidecarContainer(inspection.Id);
					if (signalId && isVerificationSignalId(signalId)) removed.push(signalId);
				} catch (error) {
					console.warn(`[project-sandbox] unable to recover verification sidecar candidate ${id.substring(0, 12)}: ${(error as Error).message}`);
				}
			}
			return removed;
		});
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
			await this.execDocker([
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
		const configuredBaseRefTrimmed = (configuredBaseRef ?? "").trim();
		if (!startPoint) {
			const exec = async (args: string[]): Promise<string> => {
				return this._dockerExec(containerId, ["git", ...args], { cwd: "/workspace" });
			};
			const { ref } = await resolveBaseRefWithExec(exec, configuredBaseRef);
			startPoint = ref || "origin/master";
			if (startPoint === "HEAD" && !configuredBaseRefTrimmed && !(await hasResolvedHeadWithExec(exec))) {
				throw new UnresolvedHeadWorktreeError("/workspace");
			}
		}

		await this._createCoordinatedWorktree({
			containerId,
			repoPath: "/workspace",
			worktreePath,
			branch,
			startPoint,
			expectedUpstream: configuredBaseRefTrimmed || undefined,
		});

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
			await this.execDocker([
				"exec", "-u", "root", containerId, "sh", "-c",
				`mkdir -p ${container} && chown node:node ${container}`,
			], { timeout: 10_000, env: DOCKER_ENV });
		}

		const configuredBaseRef = this.options.baseRefResolver?.();
		const configuredBaseRefTrimmed = (configuredBaseRef ?? "").trim();

		const resolvedWorktrees: Array<{ repo: string; repoPath: string; worktreePath: string; startPoint: string }> = [];
		for (const repo of repos) {
			const repoPath = `/workspace/${repo}`;
			const worktreePath = `${container}/${repo}`;

			// Resolve start point (per-repo so different repos can be at different
			// primary branches if they ever drift — we still warn elsewhere).
			let startPoint = baseBranch;
			if (!startPoint) {
				const exec = async (args: string[]): Promise<string> => {
					return this._dockerExec(containerId, ["git", ...args], { cwd: repoPath });
				};
				const { ref } = await resolveBaseRefWithExec(exec, configuredBaseRef);
				startPoint = ref || "origin/master";
				if (startPoint === "HEAD" && !configuredBaseRefTrimmed && !(await hasResolvedHeadWithExec(exec))) {
					console.warn(`[project-sandbox] Skipping worktree ${name}/${repo}: ${new UnresolvedHeadWorktreeError(repoPath).message}`);
					continue;
				}
			}
			resolvedWorktrees.push({ repo, repoPath, worktreePath, startPoint });
		}

		// Acquire every participating repository's common-dir lock in stable order.
		// This prevents overlapping multi-repo allocations from deadlocking while
		// keeping branch creation, explicit upstream configuration, and validation
		// in one repository-scoped transaction.
		const mutationKeys = await Promise.all(resolvedWorktrees.map(({ repoPath }) => this._sandboxGitCommonDir(containerId, repoPath)));
		const out = await this._withSandboxRepositoryMutationKeys(mutationKeys, async () => {
			const created: Array<{ repo: string; worktreePath: string }> = [];
			for (const worktree of resolvedWorktrees) {
				await this._createWorktreeUncoordinated({
					containerId,
					repoPath: worktree.repoPath,
					worktreePath: worktree.worktreePath,
					branch,
					startPoint: worktree.startPoint,
					expectedUpstream: configuredBaseRefTrimmed || undefined,
				});
				created.push({ repo: worktree.repo, worktreePath: worktree.worktreePath });
			}
			return created;
		});

		if (out.length === 0) {
			console.warn(`[project-sandbox] No worktree-able repo remained for ${name}; running without sandbox worktrees`);
			return { container, worktrees: [] };
		}

		// Per-component setup hook — sequential, runs inside the container at
		// each component's resolved root. Shared with the host code path.
		try {
			const { runComponentSetups } = await import("../skills/worktree-setup.js");
			await runComponentSetups({
				components,
				branchContainer: container,
				primaryWorktreeRoot: "/workspace",
				skipNpmCi: this.worktreeSetupRuntime.skipNpmCi,
				recordSetupPath: this.worktreeSetupRuntime.recordSetupPath,
				execHandlesTimeout: true,
				exec: async (cmd, cwd, env, timeoutMs) => {
					const execEnv: Record<string, string> = {};
					if (env.SOURCE_REPO) execEnv.SOURCE_REPO = String(env.SOURCE_REPO);
					await this._dockerExec(containerId, ["sh", "-c", cmd], { cwd, env: execEnv, timeout: timeoutMs });
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

	/**
	 * Resolve a coordinator key from the container's Git common directory.
	 * The container ID scopes identical in-container paths to the one sandbox
	 * that actually shares their config and refs.
	 */
	private async _sandboxGitCommonDir(containerId: string, repoPath: string): Promise<string> {
		let commonDir = repoPath;
		try {
			commonDir = (await this._dockerExec(containerId,
				["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
				{ cwd: repoPath, timeout: 5_000 },
			)).trim() || repoPath;
		} catch {
			try {
				commonDir = (await this._dockerExec(containerId,
					["git", "rev-parse", "--git-common-dir"],
					{ cwd: repoPath, timeout: 5_000 },
				)).trim() || repoPath;
			} catch {
				// Let the actual worktree transaction report a malformed repository.
			}
		}
		return `sandbox:${containerId}:${commonDir}`;
	}

	private async _withSandboxRepositoryMutationKeys<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
		const uniqueKeys = [...new Set(keys)].sort();
		const run = async (index: number): Promise<T> => index === uniqueKeys.length
			? operation()
			: repositoryMutationCoordinator.run(uniqueKeys[index], () => run(index + 1));
		return run(0);
	}

	private async _createCoordinatedWorktree(params: {
		containerId: string;
		repoPath: string;
		worktreePath: string;
		branch: string;
		startPoint: string;
		expectedUpstream?: string;
	}): Promise<void> {
		const key = await this._sandboxGitCommonDir(params.containerId, params.repoPath);
		await repositoryMutationCoordinator.run(key, () => this._createWorktreeUncoordinated(params));
	}

	private async _createWorktreeUncoordinated(params: {
		containerId: string;
		repoPath: string;
		worktreePath: string;
		branch: string;
		startPoint: string;
		expectedUpstream?: string;
	}): Promise<void> {
		const { containerId, repoPath, worktreePath, branch, startPoint, expectedUpstream } = params;
		let branchExists = false;
		try {
			await this._dockerExec(containerId,
				["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
				{ cwd: repoPath, timeout: 5_000 });
			branchExists = true;
		} catch {
			// The creation command below is authoritative for a missing branch.
		}

		try {
			// When a configured base requires explicit tracking, `--no-track` avoids
			// Git's implicit shared config write and the serialized update below is
			// the only config mutation. Without a configured base, preserve Git's
			// normal implicit upstream for remote start points. Git accepts --no-track
			// only while creating a branch, so existing branches use the plain form.
			await this._dockerExec(containerId,
				branchExists
					? ["git", "worktree", "add", worktreePath, branch]
					: expectedUpstream
						? ["git", "worktree", "add", "--no-track", "-b", branch, worktreePath, startPoint]
						: ["git", "worktree", "add", "-b", branch, worktreePath, startPoint],
				{ cwd: repoPath });
		} catch (worktreeError) {
			if (!branchExists) throw worktreeError;
			// A retry after partial setup may own both the branch and worktree. Only
			// reuse it after proving its identity, then repair the explicit upstream.
			try {
				await this._validateSandboxWorktree({ ...params, expectedUpstream: undefined });
				if (expectedUpstream) await this._setSandboxBranchUpstream(params);
				await this._validateSandboxWorktree(params);
				console.log(`[project-sandbox] Worktree ${worktreePath} already exists, reusing`);
				return;
			} catch {
				throw worktreeError;
			}
		}

		if (expectedUpstream) await this._setSandboxBranchUpstream(params);
		await this._validateSandboxWorktree(params);
	}

	private async _readSandboxBranchUpstream(
		containerId: string,
		worktreePath: string,
		branch: string,
	): Promise<string | undefined> {
		try {
			const upstream = await this._dockerExec(containerId,
				["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
				{ cwd: worktreePath, timeout: 5_000 });
			return upstream.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private async _setSandboxBranchUpstream(params: {
		containerId: string;
		worktreePath: string;
		branch: string;
		expectedUpstream?: string;
	}): Promise<void> {
		const { containerId, worktreePath, branch, expectedUpstream } = params;
		if (!expectedUpstream || await this._readSandboxBranchUpstream(containerId, worktreePath, branch) === expectedUpstream) return;
		let lastLockError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await this._dockerExec(containerId,
					["git", "branch", `--set-upstream-to=${expectedUpstream}`, branch],
					{ cwd: worktreePath, timeout: 10_000 });
				if (await this._readSandboxBranchUpstream(containerId, worktreePath, branch) === expectedUpstream) return;
				throw new Error(`Git reported success but branch '${branch}' does not track '${expectedUpstream}'`);
			} catch (err) {
				// A competing process may report config.lock after the write is visible.
				// Reconcile only this narrow ambiguity; every other Git error is genuine.
				if (await this._readSandboxBranchUpstream(containerId, worktreePath, branch) === expectedUpstream) return;
				if (!this._isSandboxConfigLockContention(err)) throw err;
				lastLockError = err;
				if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
			}
		}
		throw lastLockError;
	}

	private _isSandboxConfigLockContention(err: unknown): boolean {
		const candidate = err as { message?: unknown; stderr?: unknown } | null;
		const text = [
			err instanceof Error ? err.message : String(err),
			typeof candidate?.stderr === "string" ? candidate.stderr : "",
		].join("\n");
		return /could not lock config file\b[\s\S]*(?:\.git(?:[\\/])config(?:\.lock)?|config(?:\.lock)?):\s*file exists/i.test(text);
	}

	private async _validateSandboxWorktree(params: {
		containerId: string;
		repoPath: string;
		worktreePath: string;
		branch: string;
		expectedUpstream?: string;
	}): Promise<void> {
		const { containerId, repoPath, worktreePath, branch, expectedUpstream } = params;
		const topLevel = (await this._dockerExec(containerId,
			["git", "rev-parse", "--show-toplevel"], { cwd: worktreePath, timeout: 5_000 })).trim();
		if (topLevel !== worktreePath) {
			throw new Error(`Worktree validation failed: expected ${worktreePath}, found ${topLevel || "no Git worktree"}`);
		}
		const actualBranch = (await this._dockerExec(containerId,
			["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, timeout: 5_000 })).trim();
		if (actualBranch !== branch) {
			throw new Error(`Worktree validation failed: expected branch '${branch}', found '${actualBranch || "detached HEAD"}'`);
		}
		if (expectedUpstream && await this._readSandboxBranchUpstream(containerId, worktreePath, branch) !== expectedUpstream) {
			throw new Error(`Worktree validation failed: branch '${branch}' does not track '${expectedUpstream}'`);
		}
		await this._dockerExec(containerId,
			["git", "rev-parse", "--git-common-dir"], { cwd: repoPath, timeout: 5_000 });
	}

	// ── Health monitoring ──────────────────────────────────────────────

	/** Start periodic health checks. Safe to call multiple times. */
	startHealthMonitor(intervalMs = 20_000): void {
		this.stopHealthMonitor();
		if (cpuDiagnosticsEnabled()) {
			getCpuDiagnostics().recordTimer("project-sandbox:healthMonitor", 0, { starts: 1, intervalMs });
		}
		this._healthInterval = this.clock.setInterval(() => {
			this._healthCheck().catch(err => {
				console.warn(`[project-sandbox] Health check error for project ${this.options.projectId}:`, err?.message || err);
			});
		}, intervalMs);
	}

	/** Stop periodic health checks. */
	stopHealthMonitor(): void {
		if (this._healthInterval) {
			this.clock.clearInterval(this._healthInterval);
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

	/** Run one container lifecycle mutation after every previously queued mutation. */
	private async _withContainerLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this._containerLifecycleTail;
		let release!: () => void;
		this._containerLifecycleTail = new Promise<void>((resolve) => { release = resolve; });
		await previous.catch(() => {});
		try {
			return await operation();
		} finally {
			release();
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
			await this._withContainerLifecycle(async () => {
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

				// Container is dead or previous recovery failed — begin recovery.
				// The lifecycle queue keeps this inspect/recovery sequence atomic with
				// models.json remounts, so neither path can create a competing container.
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
			});
		} finally {
			if (diagEnabled) {
				getCpuDiagnostics().recordTimer("project-sandbox:healthCheck", performance.now() - diagStart, counters);
			}
		}
	}

	/**
	 * Recreate the container after an atomic host models.json publication.
	 * Docker file bind mounts retain the replaced inode while a container is
	 * running; recreation remounts the current inode. Named workspace/worktree
	 * volumes survive, and the normal recovery event respawns live sessions.
	 *
	 * Every call represents a distinct atomic publication. Concurrent calls may
	 * share the drain promise, but never the generation: if another publication
	 * lands while a container is being recreated, the loop recreates it again
	 * until the mounted generation equals the latest published generation.
	 */
	async refreshAgentModelMount(): Promise<void> {
		this._modelMountGeneration++;
		if (this._modelRefreshPromise) return this._modelRefreshPromise;

		const refresh = (async () => {
			while (this._mountedModelGeneration < this._modelMountGeneration) {
				await this._withContainerLifecycle(async () => {
					// Capture only after entering the lifecycle queue so publications that
					// arrived while waiting can be mounted by this recreation.
					const targetGeneration = this._modelMountGeneration;
					if (this._status === "starting" && this._readyPromise) {
						await this._readyPromise;
					}
					const oldContainerId = this.containerId;
					this._recovering = true;
					this._status = "error";
					if (oldContainerId) {
						this._emitHealthEvent({ type: "container-died", projectId: this.options.projectId, containerId: oldContainerId });
					}
					try {
						if (oldContainerId) await this._removeContainer(oldContainerId);
						this.containerId = null;
						await this.init();
						this._mountedModelGeneration = targetGeneration;
						this._emitHealthEvent({ type: "container-recovered", projectId: this.options.projectId, containerId: this.containerId! });
						console.log(`[project-sandbox] Refreshed atomic agent models mount for project ${this.options.projectId} (generation ${targetGeneration})`);
					} finally {
						this._recovering = false;
					}
				});
			}
		})();
		this._modelRefreshPromise = refresh;
		try {
			await refresh;
		} finally {
			if (this._modelRefreshPromise === refresh) this._modelRefreshPromise = null;
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
			await this.execDocker(["stop", this.containerId], {
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
		// A project destroy is terminal: remove only strictly labelled and mounted
		// sidecars before releasing named volumes. Invalid/foreign lookalikes are
		// intentionally left for an operator rather than guessed at.
		await this.recoverVerificationSidecars(new Set());
		const volumes = projectSandboxVolumeNames(this.options.projectId, this.e2eRunId);
		// Production retains its historic workspace-only destroy behavior. Legacy
		// E2E owns both run-namespaced volumes and must remove both even when a
		// spec destroys the container before global teardown can inspect it.
		const volumeNames = this.e2eRunId ? Object.values(volumes) : [volumes.workspace];
		if (this.containerId) {
			try {
				await this.execDocker(["rm", "-f", this.containerId], {
					timeout: 15_000,
					env: DOCKER_ENV,
				});
			} catch { /* already gone */ }
		}
		for (const volumeName of volumeNames) {
			try {
				await this.execDocker(["volume", "rm", "-f", volumeName], {
					timeout: 15_000,
					env: DOCKER_ENV,
				});
			} catch { /* volume may not exist */ }
		}
		this.containerId = null;
		this._status = "starting";
		console.log(`[project-sandbox] Destroyed container and volume for project ${this.options.projectId}`);
	}

	// ── Private: Container lifecycle ───────────────────────────────────

	private async _initContainer(): Promise<void> {
		const { projectId, image } = this.options;
		const label = `bobbit-project=${projectId}`;
		const e2eRunId = this.e2eRunId;

		// 1. Find an existing container only within this test coordinator. A
		// matching project ID from a sibling E2E run must never be reattached.
		const existingId = await this._findContainerByLabel(label, e2eRunId);

		if (existingId) {
			// Docker bind mounts are immutable. If Bobbit restarted with a new
			// active agent directory, an old long-lived project container would still
			// point /home/node/.bobbit/agent/{sessions,models.json} at the previous
			// host dir. Recreate before reconnecting or restarting to avoid split-brain
			// transcripts/models between the container and host path translation.
			const staleAgentMounts = await this._hasStaleAgentDirMounts(existingId);
			if (staleAgentMounts) {
				console.warn(`[project-sandbox] Container ${existingId.substring(0, 12)} has stale agent-dir mounts; recreating`);
				await this._removeContainer(existingId);
				await this._createContainer(e2eRunId);
				await this._runInitSequence();
				return;
			}

			// Docker bind mounts are immutable. Containers created before new
			// sandbox-visible state subdirs were added (for example the generated
			// tool-result-error bridge extension mount) cannot load remapped
			// /bobbit-state/... paths. Recreate stale containers before reuse so the
			// current buildDockerRunArgs mount contract is applied.
			const staleStateMounts = await this._hasStaleStateDirMounts(existingId);
			if (staleStateMounts) {
				console.warn(`[project-sandbox] Container ${existingId.substring(0, 12)} has stale state mounts; recreating`);
				await this._removeContainer(existingId);
				await this._createContainer(e2eRunId);
				await this._runInitSequence();
				return;
			}

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
				await this._createContainer(e2eRunId);
				await this._runInitSequence();
				return;
			}

			// Check if running
			const running = await this._isContainerRunning(existingId);
			if (running) {
				// Validate with a simple exec. Volume-root repair is intentionally
				// best-effort here: a transient root exec failure must not discard a
				// healthy long-lived container and its persisted worktrees.
				try {
					await this._dockerExec(existingId, ["echo", "ok"]);
					await this._repairSandboxVolumeRootsOnExistingContainer(existingId, "reconnect");
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
					await this.execDocker(["start", existingId], {
						timeout: 30_000,
						env: DOCKER_ENV,
					});
					// Validate after start. As with a running reconnect, retain a healthy
					// container when a transient ownership repair cannot run.
					await this._dockerExec(existingId, ["echo", "ok"]);
					await this._repairSandboxVolumeRootsOnExistingContainer(existingId, "restart");
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

		// 2. No usable container — create new one.
		// Keep the run ID captured before lookup through replacement creation.
		await this._createContainer(e2eRunId);

		// 3. Run init sequence if needed
		await this._runInitSequence();
	}

	/**
	 * Create a replacement within the same ownership operation as its lookup.
	 * The captured run ID prevents an ambient environment change from turning a
	 * stale-mount remount into a different coordinator's container/volume set.
	 */
	private async _createContainer(e2eRunId: string | undefined): Promise<void> {
		const { projectId, image, sandboxNetwork, sandboxMounts, sandboxCredentials, sandboxAgentAuthAllowed, sandboxAgentAuthGoogleAllowed, sandboxAgentAuthPrefs, githubToken } = this.options;

		// Ensure the state directory and sandbox-visible subdirectories exist for bind mounts
		const stateDir = path.join(this.options.projectDir, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		for (const { sub } of SANDBOX_STATE_MOUNTS) fs.mkdirSync(path.join(stateDir, sub), { recursive: true });

		// Dynamic resource limits: N-2 cores, M-2GB memory, no PID limit
		// Query Docker daemon to avoid requesting more resources than the VM has
		const dockerLimits = await getDockerResourceLimits(this.commandRunner);
		const { cpus: totalCpus, memoryGB: totalMemGB } = computeResourceLimits(
			os.cpus().length,
			os.totalmem(),
			dockerLimits?.cpus,
			dockerLimits?.memBytes,
		);

		// Collect read-only bind mounts for any `mounted` clone sources (remote-less
		// repos). The caller supplies sanitized git sources (not the full project
		// root) at fixed container paths so the init sequence clones them via
		// `file://<mountPath>` instead of an unreachable host path. De-dupe by
		// mountPath so multi-repo sources can't collide.
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

		// Explicit creation labels volumes so teardown can identify them even after
		// their container is gone. Existing volumes are deliberately retained.
		await this._ensureSandboxVolumes(e2eRunId);
		const dockerArgs = buildDockerRunArgs({
			image,
			workspaceDir: "", // unused for /workspace — named volume instead
			projectMarketPacksRoot: path.join(this.options.projectDir, ".bobbit", "config", "market-packs"),
			label: projectId,
			labelPrefix: "bobbit-project",
			additionalLabels: e2eRunId ? { "bobbit-e2e-run": e2eRunId } : undefined,
			e2eRunId: e2eRunId ?? "",
			projectId,
			stateDir,
			memoryLimit: `${totalMemGB}g`,
			cpuLimit: `${totalCpus}`,
			pidsLimit: "0",  // unlimited — long-lived container runs many agents
			sandboxMounts,
			sandboxCredentials,
			sandboxAgentAuthAllowed,
			sandboxAgentAuthGoogleAllowed,
			sandboxAgentAuthPrefs,
			sandboxNetwork,
			toolManager: this.options.toolManager,
			extraReadonlyMounts: extraReadonlyMounts.length ? extraReadonlyMounts : undefined,
		}, this.commandRunner);

		// Docker inherits credential values from this child environment; argv carries
		// names only so a failed `docker run` cannot serialize secrets in an error.
		if (githubToken) dockerArgs.splice(dockerArgs.length - 3, 0, "-e", "GITHUB_TOKEN");

		const { stdout } = await this.execDocker(dockerArgs, {
			timeout: 60_000,
			env: this._dockerRunEnvironment(),
		});

		const containerId = stdout.trim();
		if (!containerId) {
			throw new Error(`[project-sandbox] docker run returned empty container ID for project ${projectId}`);
		}

		this.containerId = containerId;

		// A fresh container cannot initialize its checkout until both named-volume
		// roots are owned by the image user. Existing healthy containers use the
		// best-effort reconnect repair path instead.
		await this._initializeSandboxVolumeRoots(containerId);

		// Defense-in-depth: mask /proc/1/environ
		try {
			await this.execDocker([
				"exec", "-u", "root", containerId, "sh", "-c",
				"mount --bind /dev/null /proc/1/environ 2>/dev/null || chmod 0400 /proc/1/environ 2>/dev/null || true",
			], { timeout: 10_000, env: DOCKER_ENV });
		} catch {
			// Non-fatal — primary defense is not passing sensitive env vars to docker run
		}

		console.log(`[project-sandbox] Created container ${containerId.substring(0, 12)} for project ${projectId}`);
	}

	/** Create missing named volumes without coupling their mounts to argument order. */
	private async _ensureSandboxVolumes(e2eRunId: string | undefined): Promise<void> {
		const runId = e2eRunId ?? "";
		const names = projectSandboxVolumeNames(this.options.projectId, runId);
		const createArgs = projectSandboxVolumeCreateArgsByKey(this.options.projectId, runId);
		for (const key of ["workspace", "worktrees"] as const satisfies readonly ProjectSandboxVolumeKey[]) {
			if (await this._sandboxVolumeExists(names[key])) continue;
			await this.execDocker(createArgs[key], { timeout: 15_000, env: DOCKER_ENV });
		}
	}

	private async _sandboxVolumeExists(name: string): Promise<boolean> {
		try {
			await this.execDocker(["volume", "inspect", name], { timeout: 10_000, env: DOCKER_ENV });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Docker creates named-volume roots as root. Repair those two stable mount
	 * points on every container creation so a previous interrupted initialization
	 * cannot strand later agents. This intentionally does not recurse: existing
	 * workspace and worktree contents retain their original ownership.
	 */
	private async _initializeSandboxVolumeRoots(containerId: string): Promise<void> {
		await this.execDocker([
			"exec", "-u", "root", containerId, "sh", "-c",
			"mkdir -p /workspace /workspace-wt && chown node:node /workspace /workspace-wt",
		], { timeout: 10_000, env: DOCKER_ENV });
	}

	/**
	 * A newly created container cannot proceed without establishing ownership of
	 * its named-volume roots. Reconnects and restarts, however, already passed a
	 * health check and may retry worktree creation later, so an ownership-repair
	 * exec failure must not turn them into destructive container recreation.
	 */
	private async _repairSandboxVolumeRootsOnExistingContainer(containerId: string, lifecycle: "reconnect" | "restart"): Promise<void> {
		try {
			await this._initializeSandboxVolumeRoots(containerId);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.warn(`[project-sandbox] Failed to repair volume-root ownership during ${lifecycle} for healthy container ${containerId.substring(0, 12)}; continuing with worktree retry fallback: ${detail}`);
		}
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

		// Mark all paths as safe for git BEFORE cloning. When the clone source is a
		// `file://` bind-mount (remote-less project — see resolveSandboxCloneSource),
		// the mounted source repo is owned by the host UID, not the container `node`
		// user, so git's dubious-ownership guard rejects the clone
		// ("fatal: detected dubious ownership in repository at '/workspace-src/.git'")
		// unless safe.directory is configured first. The multi-repo init path
		// (`_runInitSequenceMultiRepo`) already orders this before its clones.
		await this._dockerExec(this.containerId, ["git", "config", "--global", "--add", "safe.directory", "*"]);

		// Clone the repo
		console.log(`[project-sandbox] Cloning ${repoUrl} into /workspace...`);
		await this._dockerExec(this.containerId, ["git", "clone", repoUrl, "."], {
			cwd: "/workspace",
			timeout: 120_000,
		});

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

	// ── Private: Docker helpers ────────────────────────────────────────

	private _validateVerificationCheckout(request: VerificationSidecarRequest): string {
		if (!isVerificationSignalId(request.signalId)) {
			throw new Error("[project-sandbox] verification sidecar requires a canonical signal UUID");
		}
		const scope = resolveScopedVerificationCheckoutMount(path.join(bobbitStateDir(), "verification-checkouts"), this.options.projectId);
		const expected = path.join(scope, request.signalId);
		let actual: string;
		try {
			actual = fs.realpathSync(request.checkoutPath);
		} catch {
			throw new Error("[project-sandbox] verification checkout is unavailable");
		}
		const info = fs.lstatSync(actual);
		if (!info.isDirectory() || info.isSymbolicLink() || !samePath(actual, expected)) {
			throw new Error("[project-sandbox] verification checkout is not this project's exact completed signal root");
		}
		return actual;
	}

	private _serializeDependencyLinks(links: readonly VerificationSidecarDependencyLink[]): string {
		return links.map(link => `${link.path}=${link.target}`).join(",");
	}

	/** The verifier may see only a declared node_modules leaf from its project's
	 * named workspace volume, never a live workspace/worktree root. */
	private _expectedDependencyVolumeMounts(links: readonly VerificationSidecarDependencyLink[]): Map<string, string> {
		const volumes = projectSandboxVolumeNames(this.options.projectId, this.e2eRunId);
		return new Map(links.map(link => [
			link.target,
			link.target.startsWith("/workspace-wt/") ? volumes.worktrees : volumes.workspace,
		]));
	}

	private _validateDependencyVolumeMounts(inspection: DockerContainerInspection, links: readonly VerificationSidecarDependencyLink[]): void {
		const expected = this._expectedDependencyVolumeMounts(links);
		const mounts = inspection.Mounts ?? [];
		const mountSpecs = inspection.HostConfig?.Mounts;
		for (const [destination, volume] of expected) {
			const matches = mounts.filter(mount => normalizeContainerMountDestination(mount.Destination) === destination);
			const subpath = destination.startsWith("/workspace-wt/")
				? destination.slice("/workspace-wt/".length)
				: destination.slice("/workspace/".length);
			const specs = mountSpecs?.filter(mount => normalizeContainerMountDestination(mount.Target) === destination) ?? [];
			if (matches.length !== 1 || matches[0]!.Type !== "volume" || !isMountReadOnly(matches[0]!)
				|| (matches[0]!.Source !== volume && matches[0]!.Name !== volume)
				|| specs.length !== 1 || specs[0]!.Type !== "volume" || specs[0]!.Source !== volume
				|| specs[0]!.ReadOnly !== true || specs[0]!.VolumeOptions?.Subpath !== subpath) {
				throw new Error("[project-sandbox] refusing verification sidecar with an invalid read-only exact dependency volume mount");
			}
		}
		// No broad live workspace/worktree mount (or a foreign subpath) can be
		// adopted. Exact declared leaves above are the entire authority surface.
		const destinations = [
			...mounts.map(mount => normalizeContainerMountDestination(mount.Destination)),
			...(mountSpecs ?? []).map(mount => normalizeContainerMountDestination(mount.Target)),
		];
		if (destinations.some(destination => (destination === "/workspace" || destination.startsWith("/workspace/")
			|| destination === "/workspace-wt" || destination.startsWith("/workspace-wt/"))
			&& !expected.has(destination))) {
			throw new Error("[project-sandbox] refusing verification sidecar with a broad or foreign live workspace mount");
		}
	}

	private _validateNoForeignVerificationMounts(
		mounts: readonly DockerMountInfo[],
		source: string,
		outputDestinations: ReadonlySet<string>,
		links: readonly VerificationSidecarDependencyLink[],
	): void {
		const dependencyDestinations = this._expectedDependencyVolumeMounts(links);
		if (mounts.some(mount => {
			const destination = normalizeContainerMountDestination(mount.Destination);
			return destination !== source && !outputDestinations.has(destination)
				&& !dependencyDestinations.has(destination)
				&& !isAllowedVerificationSidecarSupportMount(destination);
		})) {
			throw new Error("[project-sandbox] refusing verification sidecar with a foreign mount");
		}
	}

	private _dependencyLinksFromLabel(value: string | undefined): VerificationSidecarDependencyLink[] {
		if (value === undefined || value === "") return [];
		return value.split(",").map((entry) => {
			const separator = entry.indexOf("=");
			if (separator <= 0 || separator !== entry.lastIndexOf("=")) {
				throw new Error("[project-sandbox] verification dependency label is malformed");
			}
			return { path: entry.slice(0, separator), target: entry.slice(separator + 1) };
		});
	}

	private _validatedDependencyLinkList(links: readonly VerificationSidecarDependencyLink[]): VerificationSidecarDependencyLink[] {
		const out = [...links];
		for (let index = 0; index < out.length; index++) {
			const link = out[index]!;
			if (!link || typeof link.path !== "string" || typeof link.target !== "string"
				|| !SAFE_DEPENDENCY_PATH.test(link.path) || !SAFE_WORKTREE_DEPENDENCY.test(link.target)
				|| !link.target.endsWith(`/${link.path}`)
				|| (index > 0 && out[index - 1]!.path >= link.path)) {
				throw new Error("[project-sandbox] verification dependencies must be ordered repository-local node_modules links");
			}
		}
		return out;
	}

	private _validatedSidecarDependencyLinks(
		request: Pick<VerificationSidecarRequest, "dependencyLinks">,
		checkoutPath: string,
	): VerificationSidecarDependencyLink[] {
		const explicit = request.dependencyLinks;
		// An omitted map is the D-3 compatibility contract only. D-4 callers pass
		// an explicit ordered map (possibly empty), so a multi-repository layout can
		// never silently select a root or another repository's live dependency tree.
		const links = explicit === undefined
			? (this._isManagedDependencyLink(checkoutPath) ? [{ path: "node_modules", target: "/workspace/node_modules" }] : [])
			: this._validatedDependencyLinkList(explicit);
		for (const link of links) this._validateDependencyLinkPath(checkoutPath, link);
		return links;
	}

	private _validateDependencyLinkPath(checkoutPath: string, link: VerificationSidecarDependencyLink): void {
		const root = fs.realpathSync(checkoutPath);
		let current = root;
		const segments = link.path.split("/");
		for (let index = 0; index < segments.length; index++) {
			current = path.join(current, segments[index]!);
			if (!isStrictDescendant(root, current)) throw new Error("[project-sandbox] verification dependency escapes its checkout");
			const info = fs.lstatSync(current);
			if (index === segments.length - 1) {
				if (!info.isSymbolicLink()) throw new Error("[project-sandbox] verification dependency is not a manager-owned link");
				const target = fs.realpathSync(current);
				const targetInfo = fs.lstatSync(target);
				if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink() || isWithin(root, target)) {
					throw new Error("[project-sandbox] verification dependency link target is unsafe");
				}
			} else if (!info.isDirectory() || info.isSymbolicLink()) {
				throw new Error("[project-sandbox] verification dependency traverses an unsafe source path");
			}
		}
	}

	private _validatedSidecarOutputDirs(
		request: Pick<VerificationSidecarRequest, "ignoredOutputDirs">,
		checkoutPath: string,
	): string[] {
		const declared = validatedIgnoredOutputDirs(request.ignoredOutputDirs);
		// This structural check is intentionally phase-independent. Outputs may
		// already exist after a prior step or restart, while a nested output may
		// share source ancestors (for example tests/results under tests/src).
		for (const outputDir of declared) this._validateOutputPathStructure(checkoutPath, outputDir);
		return declared;
	}

	private _validateOutputPathStructure(checkoutPath: string, outputDir: string): void {
		const root = fs.realpathSync(checkoutPath);
		const rootInfo = fs.lstatSync(root);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("[project-sandbox] verification checkout root is unsafe");
		let current = root;
		for (const segment of outputDir.split("/")) {
			current = path.join(current, segment);
			if (!isStrictDescendant(root, current)) throw new Error("[project-sandbox] verification output escapes its checkout");
			try {
				const info = fs.lstatSync(current);
				if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("[project-sandbox] verification output traverses a symlink or source file");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
		}
	}

	private async _listVerificationSidecars(): Promise<VerificationSidecar[]> {
		const ids = await this._findVerificationSidecars();
		const listed: VerificationSidecar[] = [];
		for (const id of ids) {
			const inspection = await this._inspectFullContainer(id);
			const signalId = inspection.Config?.Labels?.[VERIFICATION_SIGNAL_LABEL];
			if (!signalId || !isVerificationSignalId(signalId)) {
				throw new Error(`[project-sandbox] verification sidecar ${id} has an invalid signal label`);
			}
			const scope = resolveScopedVerificationCheckoutMount(path.join(bobbitStateDir(), "verification-checkouts"), this.options.projectId);
			const checkoutPath = this._validateVerificationCheckout({ signalId, checkoutPath: path.join(scope, signalId) });
			listed.push(await this._validateVerificationSidecar(id, signalId, checkoutPath, inspection));
		}
		return listed;
	}

	private async _findVerificationSidecars(signalId?: string): Promise<string[]> {
		const args = [
			"ps", "-a",
			"--filter", `label=${VERIFICATION_SIDECAR_LABEL}=1`,
			"--filter", `label=bobbit-project=${this.options.projectId}`,
		];
		if (signalId) args.push("--filter", `label=${VERIFICATION_SIGNAL_LABEL}=${signalId}`);
		if (this.e2eRunId) args.push("--filter", `label=bobbit-e2e-run=${this.e2eRunId}`);
		args.push("--format", "{{.ID}}");
		const { stdout } = await this.execDocker(args, { timeout: 10_000, env: DOCKER_ENV });
		const refs = stdout.trim().split("\n").filter(Boolean);
		const ids: string[] = [];
		for (const ref of refs) ids.push((await this._inspectFullContainer(ref)).Id);
		return ids;
	}

	/** Broad project-owned discovery used only for terminal orphan cleanup. */
	private async _findVerificationSidecarCandidates(): Promise<string[]> {
		const args = ["ps", "-a", "--filter", `label=${VERIFICATION_SIDECAR_LABEL}=1`, "--filter", `label=bobbit-project=${this.options.projectId}`];
		if (this.e2eRunId) args.push("--filter", `label=bobbit-e2e-run=${this.e2eRunId}`);
		args.push("--format", "{{.ID}}");
		const { stdout } = await this.execDocker(args, { timeout: 10_000, env: DOCKER_ENV });
		return stdout.trim().split("\n").filter(Boolean);
	}

	private _isOwnedSidecarCandidate(inspection: DockerContainerInspection & { Id: string }): boolean {
		const labels = inspection.Config?.Labels ?? {};
		return FULL_DOCKER_ID.test(inspection.Id)
			&& labels[VERIFICATION_SIDECAR_LABEL] === "1"
			&& labels["bobbit-project"] === this.options.projectId
			&& (this.e2eRunId ? labels["bobbit-e2e-run"] === this.e2eRunId : !labels["bobbit-e2e-run"]);
	}

	private _isCurrentSidecarLabels(labels: Record<string, string>, signalId: string): boolean {
		return labels[VERIFICATION_SIDECAR_LABEL] === "1"
			&& labels["bobbit-project"] === this.options.projectId
			&& labels[VERIFICATION_SIGNAL_LABEL] === signalId
			&& labels["bobbit-verification-version"] === VERIFICATION_SIDECAR_VERSION
			&& typeof labels["bobbit-verification-outputs"] === "string"
			&& typeof labels["bobbit-verification-dependencies"] === "string"
			&& (this.e2eRunId ? labels["bobbit-e2e-run"] === this.e2eRunId : !labels["bobbit-e2e-run"]);
	}

	private async _inspectFullContainer(containerRef: string): Promise<DockerContainerInspection & { Id: string }> {
		const { stdout } = await this.execDocker(["inspect", "--format", "{{json .}}", containerRef], { timeout: 5_000, env: DOCKER_ENV });
		let inspection: DockerContainerInspection;
		try {
			inspection = JSON.parse(stdout.trim()) as DockerContainerInspection;
		} catch {
			throw new Error("[project-sandbox] verification sidecar inspect returned malformed data");
		}
		if (!inspection.Id || !FULL_DOCKER_ID.test(inspection.Id)) {
			throw new Error("[project-sandbox] verification sidecar did not return a canonical full Docker identity");
		}
		return inspection as DockerContainerInspection & { Id: string };
	}

	private async _validateVerificationSidecar(
		containerRef: string,
		signalId: string,
		checkoutPath: string,
		knownInspection?: DockerContainerInspection & { Id: string },
		expectedIgnoredOutputDirs?: readonly string[],
		expectedDependencyLinks?: readonly VerificationSidecarDependencyLink[],
	): Promise<VerificationSidecar> {
		const inspection = knownInspection ?? await this._inspectFullContainer(containerRef);
		if (!FULL_DOCKER_ID.test(inspection.Id) || inspection.Id === this.containerId) {
			throw new Error("[project-sandbox] verification sidecar identity is not a canonical isolated container");
		}
		const labels = inspection.Config?.Labels ?? {};
		if (!this._isCurrentSidecarLabels(labels, signalId)
			|| (expectedIgnoredOutputDirs && labels["bobbit-verification-outputs"] !== expectedIgnoredOutputDirs.join(","))
			|| inspection.Config?.Image !== this.options.image) {
			throw new Error("[project-sandbox] refusing foreign, stale, or mismatched verification sidecar");
		}
		const { source, view } = sidecarPaths(signalId);
		const mounts = inspection.Mounts ?? [];
		const declaredOutputDirs = validatedIgnoredOutputDirs(labels["bobbit-verification-outputs"] ? labels["bobbit-verification-outputs"].split(",").filter(Boolean) : []);
		const outputDirs = this._validatedSidecarOutputDirs({ ignoredOutputDirs: declaredOutputDirs }, checkoutPath);
		const declaredDependencyLinks = labels["bobbit-verification-dependencies"] === undefined
			? this._validatedSidecarDependencyLinks({}, checkoutPath)
			: this._validatedSidecarDependencyLinks({ dependencyLinks: this._dependencyLinksFromLabel(labels["bobbit-verification-dependencies"]) }, checkoutPath);
		if (expectedDependencyLinks && this._serializeDependencyLinks(declaredDependencyLinks) !== this._serializeDependencyLinks(this._validatedDependencyLinkList(expectedDependencyLinks))) {
			throw new Error("[project-sandbox] verification sidecar dependency links do not match the durable identity");
		}
		const matchingMounts = mounts.filter((mount) => normalizeContainerMountDestination(mount.Destination) === source);
		if (matchingMounts.length !== 1 || matchingMounts[0].Type !== "bind"
			|| !mountSourceMatches(matchingMounts[0].Source, checkoutPath) || !isMountReadOnly(matchingMounts[0])) {
			throw new Error("[project-sandbox] refusing verification sidecar with an invalid read-only exact source mount");
		}
		const expectedOutputMounts = new Map(outputDirs.map(outputDir => [`${view}/${outputDir}`, this._validatedOutputMountPath(checkoutPath, outputDir, false)]));
		for (const [destination, hostPath] of expectedOutputMounts) {
			const outputMounts = mounts.filter(mount => normalizeContainerMountDestination(mount.Destination) === destination);
			if (outputMounts.length !== 1 || outputMounts[0].Type !== "bind" || isMountReadOnly(outputMounts[0])
				|| !mountSourceMatches(outputMounts[0].Source, hostPath)) {
				throw new Error("[project-sandbox] refusing verification sidecar with an invalid writable output mount");
			}
		}
		this._validateDependencyVolumeMounts(inspection, declaredDependencyLinks);
		this._validateNoForeignVerificationMounts(mounts, source, new Set(expectedOutputMounts.keys()), declaredDependencyLinks);
		if (mounts.some((mount) => {
			const destination = normalizeContainerMountDestination(mount.Destination);
			return destination !== source && !expectedOutputMounts.has(destination)
				&& (pathsOverlap(destination, source) || pathsOverlap(destination, view));
		})) {
			throw new Error("[project-sandbox] refusing verification sidecar with a shadowing source or execution mount");
		}
		await this._validateVerificationExecutionView(inspection.Id, signalId, checkoutPath, outputDirs, declaredDependencyLinks);
		return { containerId: inspection.Id, projectId: this.options.projectId, signalId, checkoutPath, cwd: view };
	}

	private async _validateVerificationExecutionView(
		containerId: string,
		signalId: string,
		checkoutPath: string,
		declaredOutputDirs: readonly string[],
		dependencyLinks: readonly VerificationSidecarDependencyLink[],
	): Promise<void> {
		const { source, view } = sidecarPaths(signalId);
		const trie = outputTrie(declaredOutputDirs, dependencyLinks);
		const stat = (await this.execDocker(["exec", "-u", "root", containerId, "stat", "-c", "%u:%a", "--", view], { timeout: 10_000, env: DOCKER_ENV })).stdout.trim();
		if (stat !== "0:555") throw new Error("[project-sandbox] verification execution root is not root-owned and non-writable");

		const validateNode = async (node: OutputTrieNode, relative: string): Promise<void> => {
			const hostDir = relative ? path.join(checkoutPath, relative) : checkoutPath;
			const sourceDir = relative ? `${source}/${relative}` : source;
			const viewDir = relative ? `${view}/${relative}` : view;
			const hostInfo = fs.lstatSync(hostDir);
			if (!hostInfo.isDirectory() || hostInfo.isSymbolicLink()) throw new Error("[project-sandbox] verification output ancestor is not a safe source directory");
			if (relative) {
				const ancestorStat = (await this.execDocker(["exec", "-u", "root", containerId, "stat", "-c", "%u:%a", "--", viewDir], { timeout: 10_000, env: DOCKER_ENV })).stdout.trim();
				if (ancestorStat !== "0:555") throw new Error("[project-sandbox] verification execution output ancestor is not root-owned and non-writable");
			}
			const sourceEntries = new Set(fs.readdirSync(hostDir));
			const expectedEntries = new Set([...sourceEntries, ...node.children.keys()]);
			const viewEntries = (await this.execDocker(["exec", "-u", "root", containerId, "find", viewDir, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\n"], { timeout: 10_000, env: DOCKER_ENV })).stdout.trim().split("\n").filter(Boolean);
			if (viewEntries.length !== expectedEntries.size || viewEntries.some(entry => !expectedEntries.has(entry))) {
				throw new Error("[project-sandbox] verification execution view contains missing or unallowlisted entries");
			}
			for (const entry of expectedEntries) {
				const child = node.children.get(entry);
				const childRelative = relative ? `${relative}/${entry}` : entry;
				if (child) {
					if (child.outputDir) continue; // exact output leaf is validated below
					if (child.dependencyTarget) {
						const dependency = (await this.execDocker(["exec", "-u", "root", containerId, "readlink", "--", `${viewDir}/${entry}`], { timeout: 10_000, env: DOCKER_ENV })).stdout.trim();
						if (dependency !== child.dependencyTarget) throw new Error("[project-sandbox] verification dependency link is invalid");
						await this.execDocker(["exec", "-u", "root", containerId, "test", "-d", dependency], { timeout: 10_000, env: DOCKER_ENV });
						continue;
					}
					await validateNode(child, childRelative);
					continue;
				}
				const target = (await this.execDocker(["exec", "-u", "root", containerId, "readlink", "--", `${viewDir}/${entry}`], { timeout: 10_000, env: DOCKER_ENV })).stdout.trim();
				if (target !== `${sourceDir}/${entry}`) throw new Error("[project-sandbox] verification execution view source link is invalid");
			}
		};
		await validateNode(trie, "");
		for (const outputDir of declaredOutputDirs) {
			const outputStat = (await this.execDocker(["exec", "-u", "root", containerId, "stat", "-c", "%F:%a", "--", `${view}/${outputDir}`], { timeout: 10_000, env: DOCKER_ENV })).stdout.trim();
			if (!/^directory:[0-7]{2}[2367]$/u.test(outputStat)) throw new Error("[project-sandbox] verification output directory is not writable");
		}
	}

	private _validatedOutputMountPath(checkoutPath: string, outputDir: string, create: boolean): string {
		const root = fs.realpathSync(checkoutPath);
		const rootInfo = fs.lstatSync(root);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("[project-sandbox] verification checkout root is unsafe");
		let current = root;
		for (const segment of outputDir.split("/")) {
			current = path.join(current, segment);
			if (!isStrictDescendant(root, current)) throw new Error("[project-sandbox] verification output escapes its checkout");
			try {
				const info = fs.lstatSync(current);
				if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("[project-sandbox] verification output traverses a symlink or non-directory");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
				fs.mkdirSync(current, { mode: 0o777 });
				const created = fs.lstatSync(current);
				if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("[project-sandbox] verification output creation was replaced");
			}
		}
		const canonical = fs.realpathSync(current);
		if (!samePath(canonical, current) || !isStrictDescendant(root, canonical)) {
			throw new Error("[project-sandbox] verification output path is not canonical");
		}
		if (create) fs.chmodSync(canonical, 0o777);
		return canonical;
	}

	private _isManagedDependencyLink(checkoutPath: string): boolean {
		const dependency = path.join(checkoutPath, "node_modules");
		try {
			const info = fs.lstatSync(dependency);
			if (!info.isSymbolicLink()) return false;
			const target = fs.realpathSync(dependency);
			const targetInfo = fs.lstatSync(target);
			return targetInfo.isDirectory() && !targetInfo.isSymbolicLink()
				&& path.basename(target) === "node_modules" && !isWithin(checkoutPath, target);
		} catch {
			return false;
		}
	}

	/** Supply Docker's inherited `-e KEY` values without ever placing values in argv. */
	private _dockerRunEnvironment(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...DOCKER_ENV };
		for (const [key, value] of Object.entries(this.options.sandboxCredentials ?? {})) {
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
		}
		if (this.options.githubToken) env.GITHUB_TOKEN = this.options.githubToken;
		return env;
	}

	private async _createVerificationSidecar(request: VerificationSidecarRequest, checkoutPath: string): Promise<VerificationSidecar> {
		const { signalId } = request;
		const ignoredOutputDirs = this._validatedSidecarOutputDirs(request, checkoutPath);
		const dependencyLinks = this._validatedSidecarDependencyLinks(request, checkoutPath);
		for (const outputDir of ignoredOutputDirs) this._validatedOutputMountPath(checkoutPath, outputDir, true);
		const { projectId, image, sandboxNetwork, sandboxCredentials, sandboxAgentAuthAllowed, sandboxAgentAuthGoogleAllowed, sandboxAgentAuthPrefs, githubToken } = this.options;
		const stateDir = path.join(this.options.projectDir, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		for (const { sub } of SANDBOX_STATE_MOUNTS) fs.mkdirSync(path.join(stateDir, sub), { recursive: true });
		const dockerLimits = await getDockerResourceLimits(this.commandRunner);
		const { cpus: totalCpus, memoryGB: totalMemGB } = computeResourceLimits(os.cpus().length, os.totalmem(), dockerLimits?.cpus, dockerLimits?.memBytes);
		const dockerArgs = buildDockerRunArgs({
			image, workspaceDir: "", projectMarketPacksRoot: path.join(this.options.projectDir, ".bobbit", "config", "market-packs"),
			label: projectId, labelPrefix: "bobbit-project", additionalLabels: this.e2eRunId ? { "bobbit-e2e-run": this.e2eRunId } : undefined,
			e2eRunId: this.e2eRunId, projectId, stateDir, verificationSidecar: { signalId, checkoutDir: checkoutPath, ignoredOutputDirs, dependencyLinks },
			memoryLimit: `${totalMemGB}g`, cpuLimit: `${totalCpus}`, sandboxCredentials,
			sandboxAgentAuthAllowed, sandboxAgentAuthGoogleAllowed, sandboxAgentAuthPrefs, sandboxNetwork, toolManager: this.options.toolManager,
		}, this.commandRunner);
		if (githubToken) dockerArgs.splice(dockerArgs.length - 3, 0, "-e", "GITHUB_TOKEN");
		const { stdout } = await this.execDocker(dockerArgs, { timeout: 60_000, env: this._dockerRunEnvironment() });
		const containerId = stdout.trim();
		if (!FULL_DOCKER_ID.test(containerId)) {
			throw new Error(`[project-sandbox] docker run returned a non-canonical verification sidecar ID for project ${projectId}`);
		}
		try {
			await this._buildVerificationExecutionView(containerId, signalId, checkoutPath, ignoredOutputDirs, dependencyLinks);
			return await this._validateVerificationSidecar(containerId, signalId, checkoutPath, undefined, ignoredOutputDirs, dependencyLinks);
		} catch (error) {
			// The ID was returned by this docker invocation, so it is safe to remove
			// the failed candidate without broad label-based cleanup. A failed removal
			// is not hidden: retaining an unverified sidecar is safer than claiming it
			// disappeared and leaving an open frozen-root descriptor behind.
			try {
				await this._removeVerificationSidecarContainer(containerId);
			} catch (cleanupError) {
				throw new Error(`[project-sandbox] verification sidecar setup failed and cleanup could not be confirmed: ${(cleanupError as Error).message}`, { cause: error });
			}
			throw error;
		}
	}

	private async _buildVerificationExecutionView(
		containerId: string,
		signalId: string,
		checkoutPath: string,
		ignoredOutputDirs: readonly string[],
		dependencyLinks: readonly VerificationSidecarDependencyLink[],
	): Promise<void> {
		const { source, view } = sidecarPaths(signalId);
		const trie = outputTrie(ignoredOutputDirs, dependencyLinks);
		const execRoot = async (argv: string[]): Promise<void> => {
			await this.execDocker(["exec", "-u", "root", containerId, ...argv], { timeout: 10_000, env: DOCKER_ENV });
		};
		// No shell is used here: every source name was read from the completed
		// checkout and every caller-supplied output path was grammar-validated.
		await execRoot(["mkdir", "-p", "--", view]);
		await execRoot(["chmod", "0755", "--", view]);
		const buildNode = async (node: OutputTrieNode, relative: string): Promise<void> => {
			const hostDir = relative ? path.join(checkoutPath, relative) : checkoutPath;
			const sourceDir = relative ? `${source}/${relative}` : source;
			const viewDir = relative ? `${view}/${relative}` : view;
			const sourceEntries = new Set(fs.readdirSync(hostDir));
			for (const entry of sourceEntries) {
				const child = node.children.get(entry);
				if (child) continue;
				await execRoot(["ln", "-s", "--", `${sourceDir}/${entry}`, `${viewDir}/${entry}`]);
			}
			for (const [entry, child] of node.children) {
				const childRelative = relative ? `${relative}/${entry}` : entry;
				if (child.outputDir) {
					// Docker already mounted the server-owned persistent leaf. Never remove,
					// recreate, chown, or chmod a mountpoint from the sidecar layer.
					await execRoot(["test", "-d", `${viewDir}/${entry}`]);
					continue;
				}
				if (child.dependencyTarget) {
					await execRoot(["test", "-d", child.dependencyTarget]);
					await execRoot(["ln", "-s", "--", child.dependencyTarget, `${viewDir}/${entry}`]);
					continue;
				}
				// Shared source ancestors are root-owned and non-writable. Their source
				// siblings are linked below, preserving e.g. tests/src beside tests/results.
				await execRoot(["mkdir", "-p", "--", `${viewDir}/${entry}`]);
				await execRoot(["chmod", "0555", "--", `${viewDir}/${entry}`]);
				await buildNode(child, childRelative);
			}
		};
		await buildNode(trie, "");
		await execRoot(["chmod", "0555", "--", view]);
	}

	private async _hasStaleAgentDirMounts(containerId: string): Promise<boolean> {
		const activeAgentDir = globalAgentDir();
		const expected = {
			sessionsDir: activeAgentSessionsDir(),
			modelsJson: path.join(activeAgentDir, "models.json"),
			modelsJsonExists: false,
		};
		try {
			expected.modelsJsonExists = fs.statSync(expected.modelsJson).isFile();
		} catch {
			expected.modelsJsonExists = false;
		}

		try {
			const { stdout } = await this.execDocker([
				"inspect", "--format", "{{json .Mounts}}", containerId,
			], {
				timeout: 5_000,
				env: DOCKER_ENV,
			});
			const mounts = JSON.parse(stdout.trim() || "[]") as DockerMountInfo[];
			const result = getAgentDirMountStaleness(mounts, expected);
			if (result.stale && result.reason) {
				console.warn(`[project-sandbox] Container ${containerId.substring(0, 12)} ${result.reason}`);
				return true;
			}
			if (expected.modelsJsonExists) {
				try {
					const hostContent = fs.readFileSync(expected.modelsJson, "utf-8");
					const containerContent = await this._dockerExec(containerId, ["cat", CONTAINER_AGENT_MODELS_JSON], { timeout: 5_000 });
					const contentResult = getModelsJsonContentStaleness(hostContent, containerContent);
					if (contentResult.stale) {
						console.warn(`[project-sandbox] Container ${containerId.substring(0, 12)} ${contentResult.reason}`);
						return true;
					}
				} catch {
					// A stopped container will remount the current host path when started;
					// inability to exec is therefore not itself proof of stale content.
				}
			}
			return false;
		} catch (err: any) {
			console.warn(`[project-sandbox] Could not inspect agent-dir mounts for container ${containerId.substring(0, 12)}; keeping existing container: ${err?.message || err}`);
			return false;
		}
	}

	private async _hasStaleStateDirMounts(containerId: string): Promise<boolean> {
		const expected = {
			stateDir: path.join(this.options.projectDir, ".bobbit", "state"),
		};
		try {
			const { stdout } = await this.execDocker([
				"inspect", "--format", "{{json .Mounts}}", containerId,
			], {
				timeout: 5_000,
				env: DOCKER_ENV,
			});
			const mounts = JSON.parse(stdout.trim() || "[]") as DockerMountInfo[];
			const result = getStateDirMountStaleness(mounts, expected);
			if (result.stale && result.reason) {
				console.warn(`[project-sandbox] Container ${containerId.substring(0, 12)} ${result.reason}`);
			}
			return result.stale;
		} catch (err: any) {
			console.warn(`[project-sandbox] Could not inspect state mounts for container ${containerId.substring(0, 12)}; keeping existing container: ${err?.message || err}`);
			return false;
		}
	}

	private async _findContainerByLabel(label: string, e2eRunId?: string): Promise<string | null> {
		try {
			const args = [
				"ps", "-a",
				"--filter", `label=${label}`,
				// Verification sidecars share the project label for ownership, but are
				// never interchangeable with the long-lived project container.
				"--filter", `label!=${VERIFICATION_SIDECAR_LABEL}=1`,
			];
			if (e2eRunId) args.push("--filter", `label=bobbit-e2e-run=${e2eRunId}`);
			args.push("--format", "{{.ID}}");
			let stdout: string;
			try {
				({ stdout } = await this.execDocker(args, {
					timeout: 10_000,
					env: DOCKER_ENV,
				}));
			} catch (error) {
				// Docker versions before label-negation support reject `label!=` at
				// parse time. Fall back only for that capability gap; full inspect
				// below remains the mandatory sidecar exclusion on every daemon.
				if (!/invalid filter.*label!|label!.*invalid filter/i.test(String(error))) return null;
				const fallbackArgs = ["ps", "-a", "--filter", `label=${label}`];
				if (e2eRunId) fallbackArgs.push("--filter", `label=bobbit-e2e-run=${e2eRunId}`);
				fallbackArgs.push("--format", "{{.ID}}");
				try {
					({ stdout } = await this.execDocker(fallbackArgs, {
						timeout: 10_000,
						env: DOCKER_ENV,
					}));
				} catch {
					return null;
				}
			}
			for (const ref of stdout.trim().split("\n").filter(Boolean)) {
				// Docker filters are only a first pass: inspect each candidate before
				// adopting it, so a malformed or sidecar-labelled response cannot be
				// restarted, health-checked, or later removed as the project container.
				try {
					const inspection = await this._inspectFullContainer(ref);
					const labels = inspection.Config?.Labels ?? {};
					if (labels["bobbit-project"] !== this.options.projectId
						|| Object.hasOwn(labels, VERIFICATION_SIDECAR_LABEL)
						|| (e2eRunId ? labels["bobbit-e2e-run"] !== e2eRunId : !!labels["bobbit-e2e-run"])) {
						continue;
					}
					return inspection.Id;
				} catch {
					// A candidate can disappear between `ps` and `inspect`, or be a
					// malformed daemon response. Never let it poison later candidates.
				}
			}
			return null;
		} catch {
			// Preserve the historical missing-daemon behavior: callers create a
			// replacement when discovery itself cannot reach Docker.
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
				this.execDocker(["inspect", "--format", "{{.Image}}", containerId], { timeout: 5_000, env: DOCKER_ENV }),
				this.execDocker(["inspect", "--format", "{{.Id}}", imageTag], { timeout: 5_000, env: DOCKER_ENV }),
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
			const { stdout } = await this.execDocker([
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

	/**
	 * Remove one verified sidecar and prove the exact full Docker ID no longer
	 * resolves. Unlike generic project-container teardown this is fail-closed:
	 * an unavailable daemon, a malformed reply, or a surviving container leaves
	 * the checkout lease in place for recovery.
	 */
	private async _removeVerificationSidecarContainer(containerId: string): Promise<void> {
		if (!FULL_DOCKER_ID.test(containerId)) {
			throw new Error("[project-sandbox] verification sidecar cleanup requires a canonical full Docker identity");
		}
		try {
			await this.execDocker(["rm", "-f", containerId], {
				timeout: 15_000,
				env: DOCKER_ENV,
			});
		} catch (error) {
			// Concurrent terminal cleanup is safe only when a follow-up exact-ID
			// inspect proves it won. Do not treat arbitrary Docker errors as absence.
			if (await this._isExactContainerAbsent(containerId)) return;
			throw new Error(`[project-sandbox] verification sidecar removal failed: ${(error as Error).message}`);
		}
		if (!(await this._isExactContainerAbsent(containerId))) {
			throw new Error("[project-sandbox] verification sidecar removal did not remove the recorded container");
		}
	}

	/** Returns true only when Docker explicitly says this full ID no longer exists. */
	private async _isExactContainerAbsent(containerId: string): Promise<boolean> {
		if (!FULL_DOCKER_ID.test(containerId)) {
			throw new Error("[project-sandbox] verification sidecar absence check requires a canonical full Docker identity");
		}
		try {
			const inspection = await this._inspectFullContainer(containerId);
			if (inspection.Id.toLowerCase() !== containerId.toLowerCase()) {
				throw new Error("[project-sandbox] Docker inspect did not resolve the recorded verification sidecar identity");
			}
			return false;
		} catch (error) {
			if (this._isConfirmedExactContainerAbsence(error, containerId)) return true;
			throw new Error(`[project-sandbox] unable to confirm verification sidecar removal: ${(error as Error).message}`);
		}
	}

	private _isConfirmedExactContainerAbsence(error: unknown, containerId: string): boolean {
		const detail = [
			(error as { message?: unknown } | null)?.message,
			(error as { stderr?: unknown } | null)?.stderr,
		].filter((value): value is string => typeof value === "string").join("\n").toLowerCase();
		const escapedId = containerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase();
		return new RegExp(`\\bno such (?:container|object):\\s*${escapedId}\\b`, "u").test(detail);
	}

	private async _removeContainer(containerId: string): Promise<void> {
		try {
			await this.execDocker(["rm", "-f", containerId], {
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

		const { stdout } = await this.execDocker(execArgs, {
			timeout: opts?.timeout ?? 60_000,
			env: DOCKER_ENV,
			maxBuffer: 10 * 1024 * 1024,
		});
		return stdout;
	}

}
