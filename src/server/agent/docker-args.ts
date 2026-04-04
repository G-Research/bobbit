/**
 * Docker argument builder for sandbox pool containers.
 *
 * Builds `docker run -d ... sleep infinity` args for detached containers
 * managed by the sandbox pool. All sandbox sessions use pool containers
 * (pre-warmed or created on-demand).
 */

import fs from "node:fs";
import path from "node:path";
import { bobbitDir, globalAgentDir } from "../bobbit-dir.js";
import { toDockerPath } from "./rpc-bridge.js";
import { TOOLS_DIR } from "./tool-manager.js";

// ── Config ─────────────────────────────────────────────────────────────────

export interface DockerRunConfig {
	image: string;
	/** Host path to mount as /workspace. */
	workspaceDir: string;

	// ── Labels ───────────────────────────────────────────────────────────
	/** Label value for `bobbit-pool=` or `bobbit-sandbox=`. */
	label?: string;
	/** Label version string (e.g. "2" for sandbox-pool). */
	labelVersion?: string;
	/** Label prefix — e.g. "bobbit-pool" or "bobbit-sandbox". */
	labelPrefix?: string;
	/** Worktree path label for sandbox-pool containers. */
	worktreePath?: string;

	// ── Extra mounts ─────────────────────────────────────────────────────
	/** Whether to mount a sibling -wt/ directory as /worktrees. */
	mountWorktreeRoot?: boolean;

	// ── Resource limits ──────────────────────────────────────────────────
	/** Container memory limit (default: "4g"). */
	memoryLimit?: string;
	/** Container CPU limit (default: "2"). */
	cpuLimit?: string;
	/** Container PID limit (default: "256"). */
	pidsLimit?: string;

	// ── Sandbox config ───────────────────────────────────────────────────
	sandboxMounts?: string[];
	sandboxCredentials?: Record<string, string>;
	/** Docker network to attach the container to (e.g. "bobbit-sandbox-net"). */
	sandboxNetwork?: string;
}

// ── Builder ────────────────────────────────────────────────────────────────

export function buildDockerRunArgs(config: DockerRunConfig): string[] {
	const {
		image, workspaceDir,
		label, labelVersion, labelPrefix, worktreePath,
		mountWorktreeRoot,
		sandboxMounts, sandboxCredentials,
		sandboxNetwork,
	} = config;

	const toolsDir = TOOLS_DIR;

	const baseHostArgs = ["--add-host=host.docker.internal:host-gateway"];

	// Resource limits — prevent containers from consuming all host resources
	baseHostArgs.push(`--memory=${config.memoryLimit ?? "32g"}`);
	baseHostArgs.push(`--cpus=${config.cpuLimit ?? "12"}`);
	baseHostArgs.push(`--pids-limit=${String(config.pidsLimit ?? "512")}`);

	// Attach to a restricted Docker network for sandboxed containers
	if (sandboxNetwork) {
		baseHostArgs.push(`--network=${sandboxNetwork}`);
		// Black-hole cloud metadata endpoints (defense-in-depth)
		baseHostArgs.push("--add-host=metadata.google.internal:0.0.0.0");
		baseHostArgs.push("--add-host=metadata.internal:0.0.0.0");
		baseHostArgs.push("--add-host=169.254.169.254:0.0.0.0");
	}

	const args: string[] = ["run", "-d", ...baseHostArgs];

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

	// ── Bind mounts ────────────────────────────────────────────────────
	args.push("-v", `${toDockerPath(workspaceDir)}:/workspace`);
	// pi-coding-agent is baked into the Docker image (avoids 20x slower
	// bind-mount I/O on Docker Desktop Windows/macOS). No node_modules mount needed.
	args.push("-v", `${toDockerPath(toolsDir)}:/tools:ro`);

	// Mount sibling worktree root
	if (mountWorktreeRoot) {
		const wtRoot = workspaceDir.replace(/\\/g, "/").replace(/\/$/, "") + "-wt";
		fs.mkdirSync(wtRoot, { recursive: true });
		args.push("-v", `${toDockerPath(wtRoot)}:/worktrees`);
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

	// Persistent named volumes for caches
	if (label) {
		args.push("-v", `bobbit-nm-cache-${label}:/home/node/.node_modules_cache`);
		args.push("-v", `bobbit-npm-cache-${label}:/home/node/.npm-cache`);
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
