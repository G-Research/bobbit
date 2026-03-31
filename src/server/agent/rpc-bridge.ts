import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitDir, globalAgentDir } from "../bobbit-dir.js";
import { TOOLS_DIR } from "./tool-manager.js";
import { buildDockerRunArgs } from "./docker-args.js";

/** Container home directory for the Docker sandbox (node:20-slim, USER node) */
export const CONTAINER_HOME = "/home/node";
/** Container-side agent directory prefix (always forward slashes) */
export const CONTAINER_AGENT_DIR = "/home/node/.bobbit/agent/";

/**
 * Remap a container-internal path to the equivalent host path.
 * e.g. /home/node/.bobbit/agent/sessions/x/y.jsonl → <agentDir>/sessions/x/y.jsonl
 * Non-matching paths pass through unchanged.
 * @param homeDir - override os.homedir() for testing
 */
export function containerToHostSessionPath(containerPath: string, homeDir?: string): string {
	if (!containerPath.startsWith(CONTAINER_AGENT_DIR)) return containerPath;
	const relative = containerPath.substring(CONTAINER_AGENT_DIR.length);
	const agentDir = homeDir ? path.join(homeDir, ".bobbit", "agent") : globalAgentDir();
	return path.join(agentDir, relative).replace(/\\/g, "/");
}

/**
 * Remap a host path back to the container-internal path. Inverse of containerToHostSessionPath.
 * @param homeDir - override os.homedir() for testing
 */
export function hostToContainerSessionPath(hostPath: string, homeDir?: string): string {
	const hostAgentDir = (homeDir ? path.join(homeDir, ".bobbit", "agent") : globalAgentDir()).replace(/\\/g, "/") + "/";
	const normalized = hostPath.replace(/\\/g, "/");
	if (!normalized.startsWith(hostAgentDir)) return hostPath;
	const relative = normalized.substring(hostAgentDir.length);
	return CONTAINER_AGENT_DIR + relative;
}

export interface RpcBridgeOptions {
	/** Path to pi-coding-agent cli.js. Auto-resolved if omitted. */
	cliPath?: string;
	/** Working directory for the agent process */
	cwd?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Path to a custom system prompt file. When set, passed as --system-prompt to the agent. */
	systemPromptPath?: string;
	/** Extra environment variables */
	env?: Record<string, string>;
	/** When true, run the agent inside a Docker container */
	sandboxed?: boolean;
	/** Docker image to use (default: "bobbit-agent") */
	sandboxImage?: string;
	/** Env vars to inject into the container */
	sandboxCredentials?: Record<string, string>;
	/** Additional bind mounts (validated by session-manager before reaching here) */
	sandboxMounts?: string[];
	/** Gateway URL for the agent to call back */
	gatewayUrl?: string;
	/** Auth token for the agent */
	gatewayToken?: string;
	/** Proxy port for network allowlist (set when SandboxProxy is active) */
	sandboxProxyPort?: number;
	/** Container ID to use with docker exec (pool mode) */
	containerId?: string;
}

export type RpcEventListener = (event: any) => void;

/**
 * Lightweight bridge to a pi-coding-agent running in RPC mode.
 * Communicates via JSONL (one JSON object per line) over stdin/stdout.
 */
export class RpcBridge {
	private process: ChildProcess | null = null;
	private requestId = 0;
	private pending = new Map<string, { resolve: (value: any) => void; reject: (reason: any) => void; timeout: ReturnType<typeof setTimeout> }>();
	private eventListeners: RpcEventListener[] = [];
	private lineBuffer = "";

	constructor(private options: RpcBridgeOptions = {}) {}

	async start(): Promise<void> {
		const cliPath = this.options.cliPath || findAgentCli();
		const args = ["--mode", "rpc"];
		if (this.options.cwd) args.push("--cwd", this.options.cwd);
		if (this.options.systemPromptPath) args.push("--system-prompt", this.options.systemPromptPath);
		if (this.options.args) args.push(...this.options.args);

		// Enable all built-in tools EXCEPT bash (which is provided by our custom extension)
		// unless --tools was explicitly passed (e.g. by role-based tool activation).
		if (!args.includes("--tools") && !args.includes("--no-tools")) {
			args.push("--tools", "read,edit,write,grep,find,ls");
		}

		// Always load the custom bash tool extension (FD-safe bash + bash_bg)
		const bashExtPath = path.join(TOOLS_DIR, "shell", "extension.ts");
		if (!args.includes(bashExtPath)) {
			args.push("--extension", bashExtPath);
		}

		if (this.options.containerId) {
			this.process = this.spawnDockerExec(this.options.containerId, cliPath, args);
		} else if (this.options.sandboxed) {
			this.process = this.spawnDocker(cliPath, args);
		} else {
			this.process = spawn("node", [cliPath, ...args], {
				stdio: ["pipe", "pipe", "pipe"],
				cwd: this.options.cwd,
				env: { ...process.env, BOBBIT_DIR: bobbitDir(), ...this.options.env },
			});
		}

		this.process.stdout!.on("data", (chunk: Buffer) => {
			this.handleData(chunk.toString("utf-8"));
		});

		this.process.stderr!.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
		});

		this.process.on("exit", (code) => {
			for (const [, p] of this.pending) {
				clearTimeout(p.timeout);
				p.reject(new Error(`Agent process exited with code ${code}`));
			}
			this.pending.clear();
			this.process = null;
		});

		// Brief pause for process initialization.
		// Pool containers (containerId) are already running — stdin is buffered,
		// so writes before the process reads are safe. No delay needed.
		// Cold docker run needs time for container + node startup (~2-3s).
		// Bare node processes need a brief init pause.
		const startupDelay = this.options.containerId ? 0 : this.options.sandboxed ? 3000 : 200;
		if (startupDelay > 0) {
			await new Promise((r) => setTimeout(r, startupDelay));
		}
	}

	/** Subscribe to agent events. Returns unsubscribe function. */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx >= 0) this.eventListeners.splice(idx, 1);
		};
	}

	/** Send an RPC command and wait for its response. */
	sendCommand(command: Record<string, any>, timeoutMs = 30_000): Promise<any> {
		if (!this.process?.stdin) {
			throw new Error("Agent process not running");
		}

		const id = `req_${++this.requestId}`;
		const msg = { ...command, id };

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Command timed out: ${command.type}`));
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timeout });
			this.process!.stdin!.write(JSON.stringify(msg) + "\n");
		});
	}

	// --- Convenience methods matching the RPC protocol ---

	prompt(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>) {
		if (images?.length) {
			console.log(`[rpc-bridge] Sending prompt with ${images.length} image(s), first image: type=${images[0].type}, mimeType=${images[0].mimeType}, data length=${images[0].data?.length}`);
		}
		return this.sendCommand({ type: "prompt", message: text, ...(images?.length ? { images } : {}) });
	}

	steer(text: string) {
		return this.sendCommand({ type: "steer", message: text });
	}

	followUp(text: string) {
		return this.sendCommand({ type: "follow_up", message: text });
	}

	abort() {
		return this.sendCommand({ type: "abort" });
	}

	getState() {
		return this.sendCommand({ type: "get_state" });
	}

	setModel(provider: string, modelId: string) {
		// Docker containers need longer for first API call (OAuth token refresh)
		const timeout = this.options.sandboxed ? 90_000 : 30_000;
		return this.sendCommand({ type: "set_model", provider, modelId }, timeout);
	}

	setThinkingLevel(level: string) {
		return this.sendCommand({ type: "set_thinking_level", level });
	}

	compact(timeoutMs = 120_000) {
		return this.sendCommand({ type: "compact" }, timeoutMs);
	}

	getMessages() {
		return this.sendCommand({ type: "get_messages" });
	}

	async stop(): Promise<void> {
		if (!this.process) return;

		return new Promise((resolve) => {
			const killTimer = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 3000);

			this.process!.on("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});

			this.process!.kill("SIGTERM");
		});
	}

	get running(): boolean {
		return this.process !== null;
	}

	/**
	 * Build and spawn the Docker container for sandboxed execution.
	 * The agent process runs inside the container with restricted filesystem/network.
	 */
	private spawnDocker(_cliPath: string, agentArgs: string[]): ChildProcess {
		const projectDir = this.options.cwd || process.cwd();
		const image = this.options.sandboxImage || "bobbit-agent";

		// Build session-specific env vars
		const sessionEnv: Record<string, string> = {};
		if (this.options.env?.BOBBIT_SESSION_ID) {
			sessionEnv.BOBBIT_SESSION_ID = this.options.env.BOBBIT_SESSION_ID;
		}
		if (this.options.env?.BOBBIT_GOAL_ID) {
			sessionEnv.BOBBIT_GOAL_ID = this.options.env.BOBBIT_GOAL_ID;
		}

		// Use a project-dir hash as label for named cache volumes
		const projectDirHash = crypto.createHash("sha256").update(projectDir).digest("hex").substring(0, 12);

		const dockerArgs = buildDockerRunArgs({
			mode: "cold",
			image,
			workspaceDir: projectDir,
			label: projectDirHash,
			sandboxMounts: this.options.sandboxMounts,
			sandboxCredentials: this.options.sandboxCredentials,
			gatewayUrl: this.options.gatewayUrl,
			gatewayToken: this.options.gatewayToken,
			sandboxProxyPort: this.options.sandboxProxyPort,
			sessionEnv,
			systemPromptPath: this.options.systemPromptPath,
		});

		// Command: node + agent CLI path remapped to container
		dockerArgs.push("node", "/node_modules/@mariozechner/pi-coding-agent/dist/cli.js");

		// Remap agent args: replace host paths with container paths
		dockerArgs.push(...this.remapArgsForContainer(agentArgs, false));

		console.log(`[rpc-bridge] Docker sandbox args: ${dockerArgs.join(" ")}`);

		return spawn("docker", dockerArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: this.options.cwd,
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
	}

	/**
	 * Spawn an agent process inside an already-running pool container via docker exec.
	 * The container already has all bind mounts and env vars configured.
	 */
	private spawnDockerExec(containerId: string, _cliPath: string, agentArgs: string[]): ChildProcess {
		const execArgs: string[] = ["exec", "-i"];

		// Pass session-specific env vars via docker exec -e (overrides container env)
		if (this.options.sandboxProxyPort) {
			const proxyUrl = `http://host.docker.internal:${this.options.sandboxProxyPort}`;
			execArgs.push("-e", `http_proxy=${proxyUrl}`);
			execArgs.push("-e", `https_proxy=${proxyUrl}`);
			execArgs.push("-e", "no_proxy=localhost,127.0.0.1");
		}
		if (this.options.env?.BOBBIT_SESSION_ID) {
			execArgs.push("-e", `BOBBIT_SESSION_ID=${this.options.env.BOBBIT_SESSION_ID}`);
		}
		if (this.options.env?.BOBBIT_GOAL_ID) {
			execArgs.push("-e", `BOBBIT_GOAL_ID=${this.options.env.BOBBIT_GOAL_ID}`);
		}
		execArgs.push("-e", "NODE_TLS_REJECT_UNAUTHORIZED=0");

		execArgs.push(
			containerId,
			"node", "/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
			...this.remapArgsForContainer(agentArgs, true),
		);

		console.log(`[rpc-bridge] Docker exec args: ${execArgs.join(" ")}`);

		return spawn("docker", execArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: this.options.cwd,
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
	}

	/**
	 * Remap agent CLI args from host paths to container paths.
	 * @param agentArgs - The agent CLI arguments with host paths
	 * @param isPoolMode - When true, system prompt maps to /tmp/session-prompts/<filename>;
	 *                     when false, maps to /tmp/system-prompt (single-file mount).
	 */
	private remapArgsForContainer(agentArgs: string[], isPoolMode: boolean): string[] {
		const toolsDir = TOOLS_DIR;
		const mcpExtDir = path.join(bobbitDir(), "state", "mcp-extensions");
		const normalizedToolsDir = toolsDir.replace(/\\/g, "/");
		const normalizedMcpExtDir = mcpExtDir.replace(/\\/g, "/");
		const remappedArgs: string[] = [];

		for (let i = 0; i < agentArgs.length; i++) {
			const arg = agentArgs[i];
			if (arg === "--cwd") {
				// SandboxPool: each slot's worktree is mounted as /workspace.
				// Cold docker run: project dir is mounted as /workspace.
				// In both cases, CWD maps to /workspace.
				remappedArgs.push("--cwd", "/workspace");
				i++; // skip the next arg (the host cwd path)
			} else if (arg === "--system-prompt") {
				if (isPoolMode) {
					// Pool mode: session-prompts/ dir is mounted at /tmp/session-prompts/
					const hostPath = agentArgs[i + 1] || "";
					const filename = path.basename(hostPath);
					remappedArgs.push("--system-prompt", `/tmp/session-prompts/${filename}`);
				} else {
					// Docker-run mode: single file mounted at /tmp/system-prompt
					remappedArgs.push("--system-prompt", "/tmp/system-prompt");
				}
				i++; // skip the next arg (the host prompt path)
			} else {
				const normalized = arg.replace(/\\/g, "/");
				if (normalized.startsWith(normalizedToolsDir)) {
					// Remap tool extension paths: TOOLS_DIR/... → /tools/...
					const relative = normalized.substring(normalizedToolsDir.length);
					remappedArgs.push(`/tools${relative}`);
				} else if (normalized.startsWith(normalizedMcpExtDir)) {
					// Remap MCP extension paths
					const relative = normalized.substring(normalizedMcpExtDir.length);
					remappedArgs.push(`/mcp-extensions${relative}`);
				} else {
					remappedArgs.push(arg);
				}
			}
		}

		return remappedArgs;
	}

	// --- Private ---

	private handleData(data: string) {
		this.lineBuffer += data;
		const lines = this.lineBuffer.split("\n");
		this.lineBuffer = lines.pop()!; // keep incomplete trailing fragment

		for (const line of lines) {
			const trimmed = line.replace(/\r$/, "").trim();
			if (!trimmed) continue;

			let parsed: any;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue; // skip non-JSON output (e.g. log lines)
			}

			// Response to a pending request
			if (parsed.type === "response" && parsed.id && this.pending.has(parsed.id)) {
				const p = this.pending.get(parsed.id)!;
				clearTimeout(p.timeout);
				this.pending.delete(parsed.id);
				p.resolve(parsed);
			} else {
				// Agent event — forward to listeners
				for (const listener of this.eventListeners) {
					listener(parsed);
				}
			}
		}
	}
}

/**
 * Convert a Windows path (e.g. C:\foo\bar) to Docker-compatible POSIX path (/c/foo/bar).
 * On non-Windows platforms, returns the path unchanged.
 */
export function toDockerPath(p: string): string {
	// Match drive letter pattern: C:\ or C:/
	const match = p.match(/^([A-Za-z]):[/\\](.*)/);
	if (match) {
		const drive = match[1].toLowerCase();
		const rest = match[2].replace(/\\/g, "/");
		return `/${drive}/${rest}`;
	}
	return p.replace(/\\/g, "/");
}

/**
 * Resolve the parent directory of @mariozechner/pi-coding-agent package.
 * This is the directory that will be mounted as /node_modules in Docker,
 * so that /node_modules/@mariozechner/pi-coding-agent/dist/cli.js works.
 */
export function resolveAgentModulesDir(): string {
	const mainUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
	const mainPath = fileURLToPath(mainUrl);
	// mainPath = .../node_modules/@mariozechner/pi-coding-agent/dist/index.js
	// Package root = .../node_modules/@mariozechner/pi-coding-agent
	const pkgRoot = path.resolve(path.dirname(mainPath), "..");
	// We need the parent of @mariozechner (= node_modules dir)
	// so that /node_modules/@mariozechner/pi-coding-agent/... works
	return path.resolve(pkgRoot, "..", "..");
}

/** Resolve the pi-coding-agent cli.js path from the installed package */
function findAgentCli(): string {
	try {
		// import.meta.resolve returns the URL of the package's main entry
		const mainUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
		const mainPath = fileURLToPath(mainUrl);
		// Main entry is dist/index.js; cli.js is in the same directory
		return path.join(path.dirname(mainPath), "cli.js");
	} catch {
		throw new Error(
			"Could not find pi-coding-agent CLI. " +
				"Either install @mariozechner/pi-coding-agent or pass --agent-cli /path/to/cli.js",
		);
	}
}
