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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bobbitDir, globalAgentDir } from "../bobbit-dir.js";
import { toDockerPath } from "./rpc-bridge.js";
import { TOOLS_DIR } from "./tool-manager.js";
import type { ToolManager } from "./tool-manager.js";

// ── Config ─────────────────────────────────────────────────────────────────

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

	// ── Per-project container ────────────────────────────────────────────
	/** Project ID — when set, uses a named Docker volume instead of bind mount for /workspace. */
	projectId?: string;
	/** Host state directory — when set, bind-mounted to /bobbit-state for session logs. */
	stateDir?: string;
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
}

// ── Builder ────────────────────────────────────────────────────────────────

export function buildDockerRunArgs(config: DockerRunConfig): string[] {
	const {
		image, workspaceDir,
		label, labelVersion, labelPrefix, worktreePath,
		projectId, stateDir, sessionId,
		sandboxMounts, sandboxCredentials,
		sandboxNetwork,
	} = config;

	const toolsDir = TOOLS_DIR;
	const builtinToolsDir = config.toolManager?.getBuiltinToolsDir();

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

	// ── Bind mounts / volumes ──────────────────────────────────────────
	if (projectId) {
		// Per-project container: named Docker volumes (survive container recreation)
		args.push("-v", `bobbit-workspace-${projectId}:/workspace`);
		args.push("-v", `bobbit-worktrees-${projectId}:/workspace-wt`);
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
	if (stateDir) {
		const sandboxStateDirs = ["sessions", "tool-guard", "html-snapshots"];
		for (const sub of sandboxStateDirs) {
			const hostPath = path.join(stateDir, sub);
			fs.mkdirSync(hostPath, { recursive: true });
			args.push("-v", `${toDockerPath(hostPath)}:/bobbit-state/${sub}`);
		}
	}

	// Host agent sessions dir (~/.bobbit/agent/sessions/) — mount ONLY sessions, not the
	// full agent dir, to prevent sandboxed agents from accessing auth.json credentials.
	const hostAgentDir = globalAgentDir();
	const hostSessionsDir = path.join(hostAgentDir, "sessions");
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

	// Session prompts directory
	const sessionPromptsDir = path.join(bobbitDir(), "state", "session-prompts");
	fs.mkdirSync(sessionPromptsDir, { recursive: true });
	args.push("-v", `${toDockerPath(sessionPromptsDir)}:/tmp/session-prompts`);

	// User-configured mounts
	if (sandboxMounts) {
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

	// Sandbox credentials
	if (sandboxCredentials) {
		for (const [key, value] of Object.entries(sandboxCredentials)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				console.warn(`[docker-args] Skipping invalid credential key: ${key}`);
				continue;
			}
			args.push("-e", `${key}=${value}`);
		}
	}

	// ── Git identity ───────────────────────────────────────────────────
	// Inherit the host user's git identity so agents can commit without
	// manual `git config` setup. Uses env vars (highest priority in git).
	const gitIdentity = getHostGitIdentity();
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

function getHostGitIdentity(): { name: string; email: string } {
	if (_gitIdentityCache) return _gitIdentityCache;
	const read = (key: string): string => {
		try {
			return execFileSync("git", ["config", "--global", key], {
				encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch { return ""; }
	};
	_gitIdentityCache = { name: read("user.name"), email: read("user.email") };
	return _gitIdentityCache;
}
