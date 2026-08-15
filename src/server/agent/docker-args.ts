/**
 * Docker argument builder for sandbox pool containers.
 *
 * Builds `docker run -d ... sleep infinity` args for detached containers
 * managed by the sandbox pool. All sandbox sessions use pool containers
 * (pre-warmed or created on-demand).
 *
 * Multi-repo layout (Phase 4a):
 *   - `bobbit-workspace-<projectId>` at `/workspace`: single-repo holds the
 *     repo at the volume root; multi-repo holds one subdir per declared
 *     repo (`/workspace/<repo>/`).
 *   - `bobbit-worktrees-<projectId>` at `/workspace-wt/`: single-repo lays
 *     out worktrees as `/workspace-wt/<branchSlug>/`; multi-repo lays them
 *     out as `/workspace-wt/<branchSlug>/<repo>/` side-by-side.
 *
 * Mount args are identical for both shapes — the volume is just a flat
 * filesystem and the layout differences live in the worktree-creation paths
 * (see `ProjectSandbox._runInitSequenceMultiRepo` and `createWorktreeSet`).
 * `toDockerPath` host-path rewriting is unchanged and works for both modes.
 * See docs/design/multi-repo-components.md §7.2.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bobbitDir, headquartersDir, globalAgentDir } from "../bobbit-dir.js";
import { activeAgentSessionsDir } from "./agent-session-path.js";
import { resolveBuiltinPacksDir } from "./builtin-packs.js";
import { ensureSandboxAgentAuthFile } from "./host-tokens.js";
import { BUILTIN_PACKS_CONTAINER_DIR, GLOBAL_USER_MARKET_PACKS_CONTAINER_DIR, PROJECT_MARKET_PACKS_CONTAINER_DIR, SERVER_MARKET_PACKS_CONTAINER_DIR, toDockerPath } from "./rpc-bridge.js";
import { scopePaths } from "./pack-types.js";
import { TOOLS_DIR } from "./tool-manager.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { ToolManager } from "./tool-manager.js";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";

// ── Config ─────────────────────────────────────────────────────────────────

/** State mounts safe for every long-lived project container. Verification
 * source is deliberately absent: it is only mounted into a signal sidecar. */
export const SANDBOX_STATE_MOUNTS: Array<{ sub: string; readOnly?: boolean }> = [
	{ sub: "sessions" },
	{ sub: "tool-guard", readOnly: true },
	{ sub: "html-snapshots" },
	{ sub: "provider-bridge", readOnly: true },
	{ sub: "google-code-assist", readOnly: true },
	{ sub: "tool-result-error-bridge", readOnly: true },
	{ sub: "tool-result-filter", readOnly: true },
	{ sub: "aigw-dns-guard", readOnly: true },
];

/** Validated legacy E2E run ID. Invalid/unset values deliberately preserve production names. */
export function validatedE2ERunId(value = process.env.BOBBIT_E2E_RUN_ID): string | undefined {
	const runId = value?.trim();
	return runId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId) ? runId : undefined;
}

/** Gate signal IDs are UUIDs; keeping this strict makes a mount destination a
 * fixed path component rather than caller-controlled Docker syntax. */
export function isVerificationSignalId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Docker volume names for a project sandbox. Legacy E2E runs get an opaque
 * run suffix so concurrent coordinators cannot attach the same workspace.
 * Normal production callers retain the longstanding names exactly.
 */
export function projectSandboxVolumeNames(projectId: string, runId = process.env.BOBBIT_E2E_RUN_ID): { workspace: string; worktrees: string } {
	const validatedRunId = validatedE2ERunId(runId);
	const suffix = validatedRunId ? `-e2e-${validatedRunId}` : "";
	return {
		workspace: `bobbit-workspace-${projectId}${suffix}`,
		worktrees: `bobbit-worktrees-${projectId}${suffix}`,
	};
}

/**
 * Explicitly create E2E volumes before the container so they carry ownership
 * labels. Docker's implicit named-volume creation cannot attach labels, which
 * would make teardown depend on a surviving container to discover a project.
 */
export function e2eSandboxVolumeCreateArgs(projectId: string, runId = process.env.BOBBIT_E2E_RUN_ID): string[][] {
	const validatedRunId = validatedE2ERunId(runId);
	if (!validatedRunId) return [];
	return Object.values(projectSandboxVolumeNames(projectId, validatedRunId)).map((name) => [
		"volume", "create",
		"--label", `bobbit-project=${projectId}`,
		"--label", `bobbit-e2e-run=${validatedRunId}`,
		name,
	]);
}

export interface DockerRunConfig {
	image: string;
	/** Host path to mount as /workspace (used for bind-mount mode when projectId is not set). */
	workspaceDir: string;

	// ── Labels ───────────────────────────────────────────────────────────
	/** Label value for the label prefix. */
	label?: string;
	/** Label version string (e.g. "2" for sandbox-pool). */
	labelVersion?: string;
	/** Label prefix — e.g. "bobbit-project" or "bobbit-sandbox". */
	labelPrefix?: string;
	/** Worktree path label for sandbox-pool containers. */
	worktreePath?: string;
	/** Additional internally supplied ownership labels. */
	additionalLabels?: Record<string, string>;
	/** Captured E2E owner passed from a ProjectSandbox lifecycle operation. */
	e2eRunId?: string;

	// ── Per-project container ────────────────────────────────────────────
	/** Project ID — when set, uses a named Docker volume instead of bind mount for /workspace. */
	projectId?: string;
	/** Host project marketplace pack root to mount in named-volume sandbox mode. */
	projectMarketPacksRoot?: string;
	/** Host state directory — when set, bind-mounted to /bobbit-state for session logs. */
	stateDir?: string;
	/**
	 * A short-lived (but restartable) verification sidecar binds precisely one
	 * completed checkout at this signal-specific destination. Long-lived project
	 * containers must omit this field and receive no verification source mount.
	 */
	verificationSidecar?: { signalId: string; checkoutDir: string; ignoredOutputDirs?: readonly string[]; dependencyLinks?: readonly { path: string; target: string }[] };
	/**
	 * Per-session preview mount (WP-A/F).
	 *
	 * - Per-session containers (sessionId set, projectId unset): the host
	 *   directory `<stateDir>/preview/<sessionId>` is bind-mounted at
	 *   `/bobbit/preview` so the agent can read back its own preview tree.
	 * - Per-project containers (projectId set): `<stateDir>/preview/` is
	 *   bind-mounted at `/bobbit/preview-root` so every session sharing the
	 *   long-lived container can resolve its own subtree by
	 *   `BOBBIT_SESSION_ID`.
	 *
	 * Note: the gateway runs the actual writes (via `mount.writeInline` /
	 * `mount.mountFile`) — the bind-mount mainly exists for symmetry, so
	 * tools that read back what they wrote see the same bytes the gateway
	 * just persisted. The agent never needs the host path; it always POSTs
	 * to `/api/preview/mount` (WP-D).
	 */
	sessionId?: string;

	// ── Resource limits ──────────────────────────────────────────────────
	/** Container memory limit (default: "32g"). */
	memoryLimit?: string;
	/** Container CPU limit (default: "12"). */
	cpuLimit?: string;
	/** Container PID limit (default: "512"). */
	pidsLimit?: string;

	// ── Sandbox config ───────────────────────────────────────────────────
	sandboxMounts?: string[];
	sandboxCredentials?: Record<string, string>;
	/** Docker network to attach the container to (e.g. "bobbit-sandbox-net"). */
	sandboxNetwork?: string;
	/** Tool manager for resolving builtin tools directory (optional — falls back to TOOLS_DIR only). */
	toolManager?: ToolManager;
	/** Whether sandbox policy permits mounting host OpenAI Codex auth into auth.json. */
	sandboxAgentAuthAllowed?: boolean;
	/** Whether sandbox policy permits mounting the Google account (Gemini Code Assist) OAuth credential into auth.json. */
	sandboxAgentAuthGoogleAllowed?: boolean;
	/** Preferences store used to include preference-backed OpenAI Codex credentials when policy allows. */
	sandboxAgentAuthPrefs?: PreferencesStore | null;
	/** Scope for the generated auth.json file; defaults to projectId when present. */
	sandboxAgentAuthScope?: string;

	/**
	 * Extra read-only bind mounts as `{ hostPath, mountPath }` pairs. Used for
	 * the remote-less sandbox clone source: the host repo is mounted read-only
	 * at a container-internal path so `git clone file://<mountPath>` works
	 * without ever passing a raw host path (or Windows drive letter) to git.
	 * Host paths are rewritten via `toDockerPath` for Docker Desktop on
	 * Windows/macOS.
	 */
	extraReadonlyMounts?: Array<{ hostPath: string; mountPath: string }>;
}

// ── Builder ────────────────────────────────────────────────────────────────

export function buildDockerRunArgs(config: DockerRunConfig, commandRunner: CommandRunner = realCommandRunner): string[] {
	const {
		image, workspaceDir,
		label, labelVersion, labelPrefix, worktreePath, additionalLabels, e2eRunId,
		projectId, stateDir, sessionId,
		verificationSidecar,
		sandboxMounts, sandboxCredentials,
		sandboxNetwork,
		extraReadonlyMounts,
	} = config;

	const toolsDir = TOOLS_DIR;
	const builtinToolsDir = config.toolManager?.getBuiltinToolsDir();
	const builtinPacksDir = resolveBuiltinPacksDir();

	const baseHostArgs = ["--add-host=host.docker.internal:host-gateway"];

	// Resource limits — prevent containers from consuming all host resources
	baseHostArgs.push(`--memory=${config.memoryLimit ?? "32g"}`);
	baseHostArgs.push(`--cpus=${config.cpuLimit ?? "12"}`);
	const pidsLimit = config.pidsLimit ?? "512";
	if (pidsLimit !== "0") {
		baseHostArgs.push(`--pids-limit=${pidsLimit}`);
	}

	// Attach to a restricted Docker network for sandboxed containers
	if (sandboxNetwork) {
		baseHostArgs.push(`--network=${sandboxNetwork}`);
		// Black-hole cloud metadata endpoints (defense-in-depth)
		baseHostArgs.push("--add-host=metadata.google.internal:0.0.0.0");
		baseHostArgs.push("--add-host=metadata.internal:0.0.0.0");
		baseHostArgs.push("--add-host=169.254.169.254:0.0.0.0");
	}

	const args: string[] = ["run", "-d", "--restart=unless-stopped", ...baseHostArgs];

	// ── Labels ─────────────────────────────────────────────────────────
	if (label && labelPrefix) {
		args.push("--label", `${labelPrefix}=${label}`);
		if (labelVersion) {
			args.push("--label", `${labelPrefix}-version=${labelVersion}`);
		}
		if (worktreePath) {
			args.push("--label", `${labelPrefix}-wt=${worktreePath}`);
		}
	}
	if (verificationSidecar) {
		if (!projectId || !isVerificationSignalId(verificationSidecar.signalId)) {
			throw new Error("verification sidecars require a project and canonical signal UUID");
		}
		const outputDirs = verificationSidecar.ignoredOutputDirs ?? [];
		const dependencyLinks = verificationSidecar.dependencyLinks ?? [];
		if (new Set(outputDirs).size !== outputDirs.length) throw new Error("verification sidecars require unique ignored output paths");
		for (const outputDir of outputDirs) {
			if (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(outputDir)
				|| outputDir.split("/").some(part => part === "." || part === "..")) {
				throw new Error("verification sidecars require safe relative ignored output paths");
			}
			if (outputDirs.some(other => other !== outputDir && (other.startsWith(`${outputDir}/`) || outputDir.startsWith(`${other}/`)))) {
				throw new Error("verification sidecars require non-overlapping ignored output paths");
			}
		}
		if (dependencyLinks.some((dependency, index) => !dependency
			|| !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*node_modules$/u.test(dependency.path)
			|| !/^\/workspace(?:-wt\/(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)?\/node_modules$/u.test(dependency.target)
			|| (index > 0 && dependencyLinks[index - 1]!.path >= dependency.path)
			|| !dependency.target.endsWith(`/${dependency.path}`))) {
			throw new Error("verification sidecars require ordered repository-local dependency links");
		}
		if (new Set(dependencyLinks.map(dependency => dependency.target)).size !== dependencyLinks.length) {
			throw new Error("verification sidecars require unique dependency mount targets");
		}
		// Verification execution must not inherit arbitrary host mounts or clone
		// sources. Its only project-volume access is the exact read-only dependency
		// subpath declared above.
		if (sandboxMounts?.length || extraReadonlyMounts?.length) {
			throw new Error("verification sidecars do not permit sandbox or clone-source mounts");
		}
		args.push("--label", "bobbit-verification-sidecar=1");
		args.push("--label", `bobbit-verification-signal=${verificationSidecar.signalId}`);
		args.push("--label", "bobbit-verification-version=3");
		args.push("--label", `bobbit-verification-outputs=${outputDirs.join(",")}`);
		args.push("--label", `bobbit-verification-dependencies=${dependencyLinks.map(dependency => `${dependency.path}=${dependency.target}`).join(",")}`);
	}
	for (const [key, value] of Object.entries(additionalLabels ?? {})) {
		if (key && value) args.push("--label", `${key}=${value}`);
	}

	// ── Bind mounts / volumes ──────────────────────────────────────────
	if (projectId) {
		// Long-lived project containers receive both workspace volumes. A verifier
		// receives neither broad live tree: every declared dependency gets its own
		// read-only named-volume subpath at the exact target used by its view link.
		const volumes = projectSandboxVolumeNames(projectId, e2eRunId);
		if (verificationSidecar) {
			for (const dependency of verificationSidecar.dependencyLinks ?? []) {
				const isWorktree = dependency.target.startsWith("/workspace-wt/");
				const volume = isWorktree ? volumes.worktrees : volumes.workspace;
				const subpath = dependency.target.slice(isWorktree ? "/workspace-wt/".length : "/workspace/".length);
				// `-v volume:/deep/path` mounts the complete volume at a deep
				// destination. `volume-subpath` is required to expose only the
				// validated node_modules leaf inside the named volume.
				args.push("--mount", `type=volume,src=${volume},dst=${dependency.target},readonly,volume-subpath=${subpath}`);
			}
		} else {
			args.push("-v", `${volumes.workspace}:/workspace`);
			args.push("-v", `${volumes.worktrees}:/workspace-wt`);
		}
	} else if (workspaceDir) {
		// Legacy pool mode: bind-mount host directory as /workspace
		args.push("-v", `${toDockerPath(workspaceDir)}:/workspace`);
	}
	// pi-coding-agent is baked into the Docker image (avoids 20x slower
	// bind-mount I/O on Docker Desktop Windows/macOS). No node_modules mount needed.
	args.push("-v", `${toDockerPath(toolsDir)}:/tools:ro`);

	// Mount builtin tools directory for cascade-resolved builtin extensions
	if (builtinToolsDir && builtinToolsDir !== toolsDir) {
		args.push("-v", `${toDockerPath(builtinToolsDir)}:/tools-builtin:ro`);
	}

	// Mount shipped first-party market packs so pack-owned bobbit-extension tools
	// (and any shared pack modules they import) resolve inside Docker sandboxes.
	const addReadonlyDirectoryMount = (hostPath: string, containerPath: string): void => {
		try {
			if (fs.statSync(hostPath).isDirectory()) {
				args.push("-v", `${toDockerPath(hostPath)}:${containerPath}:ro`);
			}
		} catch {
			// Optional mount roots are absent until their corresponding feature/scope is used.
		}
	};
	addReadonlyDirectoryMount(builtinPacksDir, BUILTIN_PACKS_CONTAINER_DIR);

	// Mount installed marketplace pack roots, not only their tools/ subtrees, so
	// standalone pi-extension entries and shared pack-local modules resolve in Docker.
	// Long-lived project containers must receive these mounts even before any pack
	// is installed; Docker cannot add a later host bind mount to an existing
	// container, so create the scope roots before assembling docker run args.
	const addMarketPacksRootMount = (hostPath: string, containerPath: string): void => {
		fs.mkdirSync(hostPath, { recursive: true });
		addReadonlyDirectoryMount(hostPath, containerPath);
	};
	addMarketPacksRootMount(scopePaths("server", headquartersDir()).marketPacksRoot, SERVER_MARKET_PACKS_CONTAINER_DIR);
	addMarketPacksRootMount(scopePaths("global-user", os.homedir()).marketPacksRoot, GLOBAL_USER_MARKET_PACKS_CONTAINER_DIR);
	const projectMarketPacksRoot = config.projectMarketPacksRoot ?? (workspaceDir ? scopePaths("project", workspaceDir).marketPacksRoot : undefined);
	if (projectMarketPacksRoot) {
		addMarketPacksRootMount(projectMarketPacksRoot, PROJECT_MARKET_PACKS_CONTAINER_DIR);
	}

	// ── Per-session preview mount (WP-A/F) ────────────────────────────
	// `<stateDir>/preview/<sid>/` is the single source of truth for the
	// preview content; the gateway populates it via mount.writeInline /
	// mount.mountFile. Bind it into the container so the agent (and any
	// in-container tooling) can read back the same bytes. Replaces the
	// old BOBBIT_HOST_CWD path-translation dance.
	if (stateDir && projectId) {
		// Per-project (long-lived) container: bind the parent so every
		// session sharing the container resolves its own subtree.
		const previewRoot = path.join(stateDir, "preview");
		fs.mkdirSync(previewRoot, { recursive: true });
		args.push("-v", `${toDockerPath(previewRoot)}:/bobbit/preview-root`);
	} else if (stateDir && sessionId) {
		// Per-session container: bind only this session's mount.
		const previewMount = path.join(stateDir, "preview", sessionId);
		fs.mkdirSync(previewMount, { recursive: true });
		args.push("-v", `${toDockerPath(previewMount)}:/bobbit/preview`);
	}

	// Bind mount ONLY specific state subdirectories — never the full state dir,
	// which contains the host gateway token, TLS keys, sessions.json, etc.
	//
	// Generated extension state dirs (`tool-guard`, `provider-bridge`,
	// `google-code-assist`, `tool-result-error-bridge`, `tool-result-filter`,
	// and `aigw-dns-guard`) hold content-addressed Pi inputs.
	// Most are loaded via `--extension`; the result gate is a private loader input.
	// rpc-bridge rewrites their host paths to `/bobbit-state/<subdir>/...`; those container paths only
	// resolve if the subdirs are bind-mounted here. They contain only generated
	// extension source (no secrets), so mounting them is safe.
	//
	// Generated extension dirs are mounted READ-ONLY (`:ro`): sandboxed agents
	// only ever *load* these files via `--extension`, never write them. A writable
	// mount would let a compromised sandbox tamper with content-addressed source
	// reused by later sessions. The `:ro` flag closes that hole at the kernel
	// mount level; the gateway also revalidates cached contents before reuse as
	// defense-in-depth (see tool-activation.ts,
	// google-code-assist-provider-extension.ts, tool-result-error-bridge-extension.ts,
	// and aigw-manager.ts).
	if (stateDir) {
		for (const { sub, readOnly } of SANDBOX_STATE_MOUNTS) {
			const hostPath = path.join(stateDir, sub);
			fs.mkdirSync(hostPath, { recursive: true });
			const suffix = readOnly ? ":ro" : "";
			args.push("-v", `${toDockerPath(hostPath)}:/bobbit-state/${sub}${suffix}`);
		}
		if (verificationSidecar) {
			// ProjectSandbox canonicalizes the completed server-owned checkout and
			// builds a root-owned execution view after startup. The exact source is
			// deliberately mounted read-only at a separate path: Docker bind modes are
			// the kernel boundary that prevents same-UID verifier commands changing the
			// bytes attested by the pinned checkout digest.
			args.push("-v", `${toDockerPath(verificationSidecar.checkoutDir)}:/bobbit-state/verification-sources/${verificationSidecar.signalId}:ro`);
			for (const outputDir of verificationSidecar.ignoredOutputDirs ?? []) {
				// ProjectSandbox creates and validates each exact child before Docker
				// starts. A child RW bind overlays only that ignored directory while
				// its enclosing frozen source mount remains kernel read-only.
				args.push("-v", `${toDockerPath(path.join(verificationSidecar.checkoutDir, outputDir))}:/bobbit-state/verification-checkouts/${verificationSidecar.signalId}/${outputDir}`);
			}
		}
	}

	// Host agent sessions dir — mount ONLY sessions, not the full agent dir, to
	// prevent sandboxed agents from accessing host auth.json credentials.
	const hostAgentDir = globalAgentDir();
	const hostSessionsDir = activeAgentSessionsDir();
	fs.mkdirSync(hostSessionsDir, { recursive: true });
	args.push("-v", `${toDockerPath(hostSessionsDir)}:/home/node/.bobbit/agent/sessions`);

	// Mount models.json (read-only) so the agent can discover available models.
	const hostModelsJson = path.join(hostAgentDir, "models.json");
	try {
		if (fs.statSync(hostModelsJson).isFile()) {
			args.push("-v", `${toDockerPath(hostModelsJson)}:/home/node/.bobbit/agent/models.json:ro`);
		}
	} catch {
		// models.json doesn't exist — agent will rely on env vars for model discovery
	}

	// Mount a sandbox-scoped auth.json. When sandbox token policy does not allow
	// OpenAI/Codex credentials, the file is an empty non-secret object so Pi still
	// sees the expected path without exposing host auth.
	const sandboxAuthJson = ensureSandboxAgentAuthFile({
		prefs: config.sandboxAgentAuthPrefs,
		includeCodexAuth: config.sandboxAgentAuthAllowed === true,
		includeGoogleAuth: config.sandboxAgentAuthGoogleAllowed === true,
		scope: config.sandboxAgentAuthScope || projectId,
	});
	args.push("-v", `${toDockerPath(sandboxAuthJson)}:/home/node/.bobbit/agent/auth.json:ro`);

	// Session prompts directory
	const sessionPromptsDir = path.join(bobbitDir(), "state", "session-prompts");
	fs.mkdirSync(sessionPromptsDir, { recursive: true });
	args.push("-v", `${toDockerPath(sessionPromptsDir)}:/tmp/session-prompts`);

	// Clone-source and user-configured mounts are intentionally absent from
	// verification sidecars (validated above). They remain available to ordinary
	// project containers.
	if (!verificationSidecar && extraReadonlyMounts) {
		for (const { hostPath, mountPath } of extraReadonlyMounts) {
			if (!hostPath || !mountPath) continue;
			args.push("-v", `${toDockerPath(hostPath)}:${mountPath}:ro`);
		}
	}

	if (!verificationSidecar && sandboxMounts) {
		for (const mount of sandboxMounts) {
			const parts = mount.split(":");
			if (parts.length >= 2) {
				parts[0] = toDockerPath(parts[0]);
				args.push("-v", parts.join(":"));
			}
		}
	}

	// ── Environment variables ──────────────────────────────────────────
	// NOTE: BOBBIT_GATEWAY_URL and BOBBIT_TOKEN are intentionally NOT set here.
	// PID 1 (sleep infinity) does not need them, and exposing them would leak
	// the gateway auth token via /proc/1/environ. The agent process receives
	// its scoped sandbox token via `docker exec -e` in rpc-bridge.ts.
	args.push("-e", "NODE_TLS_REJECT_UNAUTHORIZED=0");
	args.push("-e", "NODE_OPTIONS=--no-warnings");
	args.push("-e", "PI_CODING_AGENT_DIR=/home/node/.bobbit/agent");

	// Propagate PI_OFFLINE into the container so pi-coding-agent inside the
	// sandbox skips GitHub fd/rg downloads when the host gateway detected no
	// internet at startup. The container has its own apt-installed binaries,
	// so this is belt-and-braces — but if those are ever missing, pi fails
	// fast instead of hanging on a doomed download.
	if (process.env.PI_OFFLINE && process.env.PI_OFFLINE !== "") {
		args.push("-e", `PI_OFFLINE=${process.env.PI_OFFLINE}`);
	}

	// Sandbox credentials inherit from the Docker CLI child's environment. Values
	// must never appear in argv: execFile errors and process inspection can expose
	// argv to logs, gate history, and other local users.
	if (sandboxCredentials) {
		for (const key of Object.keys(sandboxCredentials)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				console.warn(`[docker-args] Skipping invalid credential key: ${key}`);
				continue;
			}
			args.push("-e", key);
		}
	}

	// ── Git identity ───────────────────────────────────────────────────
	// Inherit the host user's git identity so agents can commit without
	// manual `git config` setup. Uses env vars (highest priority in git).
	const gitIdentity = getHostGitIdentity(commandRunner);
	if (gitIdentity.name) {
		args.push("-e", `GIT_AUTHOR_NAME=${gitIdentity.name}`);
		args.push("-e", `GIT_COMMITTER_NAME=${gitIdentity.name}`);
	}
	if (gitIdentity.email) {
		args.push("-e", `GIT_AUTHOR_EMAIL=${gitIdentity.email}`);
		args.push("-e", `GIT_COMMITTER_EMAIL=${gitIdentity.email}`);
	}

	// ── MCP extensions ─────────────────────────────────────────────────
	const mcpExtDir = path.join(bobbitDir(), "state", "mcp-extensions");
	try {
		if (fs.statSync(mcpExtDir).isDirectory()) {
			args.push("-v", `${toDockerPath(mcpExtDir)}:/mcp-extensions:ro`);
		}
	} catch {
		// MCP extensions dir doesn't exist — skip
	}

	// ── Image + command ────────────────────────────────────────────────
	args.push(image, "sleep", "infinity");

	return args;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Cache the host git identity so we only shell out once per process. */
let _gitIdentityCache: { name: string; email: string } | undefined;

function getHostGitIdentity(commandRunner: CommandRunner = realCommandRunner): { name: string; email: string } {
	if (_gitIdentityCache) return _gitIdentityCache;
	if (!commandRunner.execFileSync) throw new Error("CommandRunner.execFileSync is required for git identity detection");
	const read = (key: string): string => {
		try {
			return commandRunner.execFileSync!("git", ["config", "--global", key], {
				encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
			}).toString().trim();
		} catch { return ""; }
	};
	_gitIdentityCache = { name: read("user.name"), email: read("user.email") };
	return _gitIdentityCache;
}
