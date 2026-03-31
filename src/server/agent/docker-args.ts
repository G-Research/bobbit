/**
 * Shared Docker argument builder for sandbox containers.
 *
 * Consolidates the duplicated docker-run argument logic from:
 *   - sandbox-pool.ts `_buildDockerArgs()`
 *   - rpc-bridge.ts `spawnDocker()`
 *
 * Two modes:
 *   - "pool": `docker run -d ... sleep infinity` — pre-warmed container
 *   - "cold": `docker run --rm -i ...` — one-shot container for a single session
 */

import fs from "node:fs";
import path from "node:path";
import { bobbitDir, globalAgentDir } from "../bobbit-dir.js";
import { toDockerPath } from "./rpc-bridge.js";
import { TOOLS_DIR } from "./tool-manager.js";

// ── Config ─────────────────────────────────────────────────────────────────

export interface DockerRunConfig {
	mode: "pool" | "cold";

	image: string;
	/** Host path to mount as /workspace. */
	workspaceDir: string;

	// ── Labels (pool mode) ───────────────────────────────────────────────
	/** Label value for `bobbit-pool=` or `bobbit-sandbox=`. */
	label?: string;
	/** Label version string (e.g. "2" for sandbox-pool). */
	labelVersion?: string;
	/** Label prefix — e.g. "bobbit-pool" or "bobbit-sandbox". */
	labelPrefix?: string;
	/** Worktree path label for sandbox-pool containers. */
	worktreePath?: string;

	// ── Extra mounts (pool mode) ─────────────────────────────────────────
	/** Whether to mount a sibling -wt/ directory as /worktrees. */
	mountWorktreeRoot?: boolean;

	// ── Sandbox config ───────────────────────────────────────────────────
	sandboxMounts?: string[];
	sandboxCredentials?: Record<string, string>;
	gatewayUrl?: string;
	gatewayToken?: string;
	sandboxProxyPort?: number;

	// ── Session env (cold mode) ──────────────────────────────────────────
	sessionEnv?: Record<string, string>;

	// ── System prompt (cold mode) ────────────────────────────────────────
	systemPromptPath?: string;
}

// ── Builder ────────────────────────────────────────────────────────────────

export function buildDockerRunArgs(config: DockerRunConfig): string[] {
	const {
		mode, image, workspaceDir,
		label, labelVersion, labelPrefix, worktreePath,
		mountWorktreeRoot,
		sandboxMounts, sandboxCredentials,
		gatewayUrl, gatewayToken, sandboxProxyPort,
		sessionEnv, systemPromptPath,
	} = config;

	const toolsDir = TOOLS_DIR;

	const args: string[] = mode === "pool"
		? ["run", "-d", "--add-host=host.docker.internal:host-gateway"]
		: ["run", "--rm", "-i", "--add-host=host.docker.internal:host-gateway"];

	// ── Labels (pool mode only) ────────────────────────────────────────
	if (mode === "pool" && label && labelPrefix) {
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

	// Session prompts directory (pool mode mounts the whole dir; cold mode mounts individual file)
	if (mode === "pool") {
		const sessionPromptsDir = path.join(bobbitDir(), "state", "session-prompts");
		fs.mkdirSync(sessionPromptsDir, { recursive: true });
		args.push("-v", `${toDockerPath(sessionPromptsDir)}:/tmp/session-prompts`);
	}

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
	if (gatewayUrl) {
		args.push("-e", `BOBBIT_GATEWAY_URL=${gatewayUrl}`);
	}
	if (gatewayToken) {
		args.push("-e", `BOBBIT_TOKEN=${gatewayToken}`);
	}

	// Session-specific env vars (cold mode)
	if (sessionEnv) {
		for (const [key, value] of Object.entries(sessionEnv)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
			args.push("-e", `${key}=${value}`);
		}
	}

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

	// Proxy env vars
	if (sandboxProxyPort) {
		const proxyUrl = `http://host.docker.internal:${sandboxProxyPort}`;
		args.push("-e", `http_proxy=${proxyUrl}`);
		args.push("-e", `https_proxy=${proxyUrl}`);
		args.push("-e", "no_proxy=localhost,127.0.0.1");
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

	// ── System prompt (cold mode only) ─────────────────────────────────
	if (mode === "cold" && systemPromptPath) {
		args.push("-v", `${toDockerPath(systemPromptPath)}:/tmp/system-prompt:ro`);
	}

	// ── Image + command ────────────────────────────────────────────────
	if (mode === "pool") {
		args.push(image, "sleep", "infinity");
	} else {
		// Cold mode: caller appends node + cli.js + agent args after this
		args.push(image);
	}

	return args;
}
