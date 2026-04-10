import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitDir, bobbitStateDir, globalAgentDir } from "../bobbit-dir.js";
import { TOOLS_DIR, type ToolManager } from "./tool-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Builtin tools directory — dist/server/defaults/tools/ (read-only, shipped with Bobbit). */
const BUILTIN_TOOLS_DIR = path.join(__dirname, "..", "defaults", "tools");

/** Redact sensitive env vars (-e KEY=VALUE) from Docker arg arrays for logging. */
function redactDockerArgs(args: string[]): string {
	const sensitiveKeys = /^(BOBBIT_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|AWS_SECRET|.*_API_KEY|.*_OAUTH_TOKEN|.*_ACCESS_KEY)/i;
	return args.map((a, i) => {
		if (i > 0 && args[i - 1] === "-e" && sensitiveKeys.test(a)) {
			return a.replace(/=.*/, "=<REDACTED>");
		}
		return a;
	}).join(" ");
}

/** Container home directory for the Docker sandbox (node:20-slim, USER node) */
export const CONTAINER_HOME = "/home/node";
/** Container-side agent directory prefix (always forward slashes) */
export const CONTAINER_AGENT_DIR = "/home/node/.bobbit/agent/";

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
	/** Whether this session runs in a Docker sandbox (affects timeouts). */
	sandboxed?: boolean;
	/** Env vars to inject into the container (API keys, etc.) */
	sandboxCredentials?: Record<string, string>;
	/** Gateway URL for the agent to call back */
	gatewayUrl?: string;
	/** Auth token for the agent */
	gatewayToken?: string;
	/** Container ID to use with docker exec (from sandbox pool) */
	containerId?: string;
	/** Tool manager for resolving extension paths (optional — falls back to TOOLS_DIR). */
	toolManager?: ToolManager;
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
	/** Ring buffer of last stderr lines — included in exit error messages for diagnostics. */
	private stderrTail: string[] = [];

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

		// When computeToolActivationArgs runs, it adds --no-extensions and explicitly
		// loads needed extensions (including shell/extension.ts for bash/bash_bg).
		// For sessions that don't go through tool activation (no role, fallback path),
		// force-load shell/extension.ts so bash/bash_bg remain available.
		if (!args.includes("--no-extensions")) {
			const bashExtPath = this.options.toolManager
				? this.options.toolManager.getExtensionPath("shell", "extension.ts")
				: path.join(TOOLS_DIR, "shell", "extension.ts");
			if (!args.includes(bashExtPath)) {
				args.push("--extension", bashExtPath);
			}
		}

		// Retry spawn on transient socket errors (ENOTCONN on Windows under fd pressure).
		// The ENOTCONN can throw either synchronously from spawn() or asynchronously from
		// socket initialization — we catch both by wrapping spawn + a brief stabilization delay.
		const MAX_SPAWN_RETRIES = 2;
		for (let attempt = 0; attempt <= MAX_SPAWN_RETRIES; attempt++) {
			try {
				this._spawnProcess(cliPath, args);
				this._attachProcessHandlers();
				// Brief pause to let async socket initialization errors surface.
				// If ENOTCONN occurs during socket read setup, the process 'error'
				// event fires within the next microtask. We wait for that.
				await new Promise<void>((resolve, reject) => {
					// Check immediately if process already died
					if (!this.process) {
						reject(new Error("Process failed to start"));
						return;
					}
					let settled = false;
					const onError = (err: Error) => {
						if (!settled) { settled = true; reject(err); }
					};
					const onExit = (code: number | null, signal: string | null) => {
						if (!settled) {
							settled = true;
							reject(new Error(`Process exited immediately (${signal ? `signal ${signal}` : `code ${code}`})`));
						}
					};
					this.process!.once("error", onError);
					this.process!.once("exit", onExit);
					// If no error within 100ms, the spawn is stable
					const startupDelay = this.options.containerId ? 100 : 100;
					setTimeout(() => {
						if (!settled) {
							settled = true;
							this.process?.removeListener("error", onError);
							this.process?.removeListener("exit", onExit);
							resolve();
						}
					}, startupDelay);
				});
				// Spawn succeeded and stabilized
				return;
			} catch (err: any) {
				// Clean up the failed process
				this.process?.kill().toString(); // best-effort kill
				this.process = null;
				this.pending.clear();

				const isTransient = err?.code === "ENOTCONN" || err?.code === "EMFILE" ||
					err?.code === "ENFILE" || err?.code === "EAGAIN" ||
					err?.message?.includes("ENOTCONN");

				if (isTransient && attempt < MAX_SPAWN_RETRIES) {
					const delay = 300 * (attempt + 1);
					console.warn(
						`[rpc-bridge] Transient spawn error (${err.code || err.message}) — ` +
						`retry ${attempt + 1}/${MAX_SPAWN_RETRIES} in ${delay}ms` +
						`${this.options.cwd ? ` cwd=${this.options.cwd}` : ""}`,
					);
					await new Promise(resolve => setTimeout(resolve, delay));
					continue;
				}
				throw err;
			}
		}
	}

	/**
	 * Spawn the child process (docker exec or direct node).
	 * Factored out of start() so retry logic can re-attempt.
	 */
	private _spawnProcess(cliPath: string, args: string[]): void {
		if (this.options.containerId) {
			this.process = this.spawnDockerExec(this.options.containerId, cliPath, args);
		} else {
			// Trust our self-signed CA cert if available; fall back to disabling TLS verification
			const caCertPath = path.join(bobbitStateDir(), "tls", "ca.crt");
			const tlsEnv = fs.existsSync(caCertPath)
				? { NODE_EXTRA_CA_CERTS: caCertPath }
				: { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
			this.process = spawn("node", [cliPath, ...args], {
				stdio: ["pipe", "pipe", "pipe"],
				cwd: this.options.cwd,
				env: {
					...process.env,
					BOBBIT_DIR: bobbitDir(),
					// Ensure the agent subprocess uses the same agent dir as Bobbit's globalAgentDir(),
					// preventing split-brain between ~/.bobbit/agent/ and ~/.pi/agent/.
					PI_CODING_AGENT_DIR: globalAgentDir(),
					...tlsEnv,
					...this.options.env,
				},
			});
		}
	}

	/**
	 * Attach stdout/stderr/stdin/error/exit handlers to this.process.
	 * Factored out of start() so retry logic can re-attach after re-spawn.
	 */
	private _attachProcessHandlers(): void {
		this.process!.stdout!.on("data", (chunk: Buffer) => {
			this.handleData(chunk.toString("utf-8"));
		});

		this.process!.stderr!.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			// Keep last 20 lines of stderr for diagnostics on unexpected exit
			const lines = chunk.toString("utf-8").split("\n").filter(l => l.trim());
			this.stderrTail.push(...lines);
			if (this.stderrTail.length > 20) {
				this.stderrTail = this.stderrTail.slice(-20);
			}
		});

		// Absorb EPIPE on stdin — the agent process may exit while we still have
		// queued writes. Without this handler, the error surfaces as an uncaught
		// exception and crashes the gateway.
		this.process!.stdin!.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
			console.warn(`[rpc-bridge] stdin error: ${err.code || err.message}`);
		});

		// Handle spawn errors (e.g. ENOENT when executable not found) — without this
		// the error becomes an uncaught exception and crashes the gateway.
		this.process!.on("error", (err: NodeJS.ErrnoException) => {
			console.error(`[rpc-bridge] Process error: ${err.code || err.message}${this.options.cwd ? ` cwd=${this.options.cwd}` : ""}`);
			for (const [, p] of this.pending) {
				clearTimeout(p.timeout);
				p.reject(err);
			}
			this.pending.clear();
			this.process = null;
		});

		this.process!.on("exit", (code, signal) => {
			const reason = signal ? `signal ${signal}` : `code ${code}`;
			const stderrContext = this.stderrTail.length > 0
				? `\n  Last stderr:\n    ${this.stderrTail.slice(-5).join("\n    ")}`
				: "";
			console.warn(`[rpc-bridge] Agent process exited (${reason})${this.options.cwd ? ` cwd=${this.options.cwd}` : ""}${stderrContext}`);

			for (const [, p] of this.pending) {
				clearTimeout(p.timeout);
				p.reject(new Error(`Agent process exited with ${reason}`));
			}
			this.pending.clear();
			this.stderrTail = [];
			this.process = null;

			// Notify event listeners so waitForIdle() and other watchers
			// can detect the unexpected exit instead of hanging until timeout.
			for (const listener of this.eventListeners) {
				try {
					listener({ type: "process_exit", code, signal });
				} catch { /* listener errors are non-fatal */ }
			}
		});
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

	abort() {
		return this.sendCommand({ type: "abort" });
	}

	getState() {
		return this.sendCommand({ type: "get_state" });
	}

	/**
	 * Wait for the agent process to become responsive.
	 * Sends get_state pings with short timeouts until one succeeds.
	 * Used after spawning Docker containers where initialization can take 30-60s.
	 */
	async waitForReady(overallTimeoutMs = 90_000): Promise<void> {
		const start = Date.now();
		const pingInterval = 2_000;
		while (Date.now() - start < overallTimeoutMs) {
			try {
				await this.sendCommand({ type: "get_state" }, 5_000);
				return; // Agent responded — it's ready
			} catch {
				if (!this.process) throw new Error("Agent process exited during initialization");
				await new Promise((r) => setTimeout(r, pingInterval));
			}
		}
		throw new Error(`Agent did not become ready within ${overallTimeoutMs}ms`);
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
	 * Spawn an agent process inside an already-running pool container via docker exec.
	 * The container already has all bind mounts and env vars configured.
	 */
	private spawnDockerExec(containerId: string, _cliPath: string, agentArgs: string[]): ChildProcess {
		const execArgs: string[] = ["exec", "-i"];

		// Pass session-specific env vars via docker exec -e (overrides container env)
		if (this.options.env?.BOBBIT_SESSION_ID) {
			execArgs.push("-e", `BOBBIT_SESSION_ID=${this.options.env.BOBBIT_SESSION_ID}`);
		}
		if (this.options.env?.BOBBIT_GOAL_ID) {
			execArgs.push("-e", `BOBBIT_GOAL_ID=${this.options.env.BOBBIT_GOAL_ID}`);
		}
		if (this.options.gatewayToken) {
			execArgs.push("-e", `BOBBIT_TOKEN=${this.options.gatewayToken}`);
		}
		if (this.options.gatewayUrl) {
			execArgs.push("-e", `BOBBIT_GATEWAY_URL=${this.options.gatewayUrl}`);
		}
		execArgs.push("-e", "NODE_TLS_REJECT_UNAUTHORIZED=0");
		execArgs.push("-e", "NODE_OPTIONS=--no-warnings");

		// Pass sandbox credentials (API keys, etc.) via docker exec env vars
		if (this.options.sandboxCredentials) {
			for (const [key, value] of Object.entries(this.options.sandboxCredentials)) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
				execArgs.push("-e", `${key}=${value}`);
			}
		}

		// Set the container process working directory via docker exec -w.
		// The agent CLI (pi) uses process.cwd() — not --cwd — to determine the
		// working directory for tools and the system prompt's "Current working
		// directory" line. Without -w, docker exec defaults to the container's
		// WORKDIR (/workspace), which is wrong for worktree sessions.
		const containerCwd = this.options.cwd || "/workspace";
		execArgs.push("-w", containerCwd);

		execArgs.push(
			containerId,
			"node", "--disable-warning=DEP0123", "/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
			...this.remapArgsForContainer(agentArgs),
		);

		console.log(`[rpc-bridge] Docker exec args: ${redactDockerArgs(execArgs)}`);

		// Host-side spawn doesn't need a specific cwd — the container working
		// directory is set via `docker exec -w` above.
		return spawn("docker", execArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
	}

	/**
	 * Remap agent CLI args from host paths to container paths.
	 * All sandbox sessions use pool containers with session-prompts/ mounted.
	 */
	private remapArgsForContainer(agentArgs: string[]): string[] {
		const toolsDir = TOOLS_DIR;
		const stateDir = bobbitStateDir();
		const mcpExtDir = path.join(stateDir, "mcp-extensions");
		const normalizedToolsDir = toolsDir.replace(/\\/g, "/");
		const normalizedStateDir = stateDir.replace(/\\/g, "/");
		const normalizedMcpExtDir = mcpExtDir.replace(/\\/g, "/");

		// Also handle builtin tools dir (dist/server/defaults/tools/) for cascade-resolved paths
		const builtinToolsDir = this.options.toolManager?.getBuiltinToolsDir();
		const normalizedBuiltinToolsDir = builtinToolsDir?.replace(/\\/g, "/");

		const remappedArgs: string[] = [];

		for (let i = 0; i < agentArgs.length; i++) {
			const arg = agentArgs[i];
			if (arg === "--cwd") {
				// Remap to container-internal path. Note: the current pi agent
				// ignores --cwd (it uses process.cwd() instead), so the actual
				// working directory is set via `docker exec -w` in spawnDockerExec().
				// We still pass --cwd for forward-compatibility with future CLIs.
				const containerCwd = this.options.cwd || "/workspace";
				remappedArgs.push("--cwd", containerCwd);
				i++; // skip the next arg (the host cwd path)
			} else if (arg === "--system-prompt") {
				// session-prompts/ dir is mounted at /tmp/session-prompts/
				const hostPath = agentArgs[i + 1] || "";
				const filename = path.basename(hostPath);
				remappedArgs.push("--system-prompt", `/tmp/session-prompts/${filename}`);
				i++; // skip the next arg (the host prompt path)
			} else {
				const normalized = arg.replace(/\\/g, "/");
				if (normalized.startsWith(normalizedToolsDir)) {
					// Remap tool extension paths: config TOOLS_DIR/... → /tools/...
					const relative = normalized.substring(normalizedToolsDir.length);
					remappedArgs.push(`/tools${relative}`);
				} else if (normalizedBuiltinToolsDir && normalized.startsWith(normalizedBuiltinToolsDir)) {
					// Remap builtin tool extension paths: dist/.../defaults/tools/... → /tools-builtin/...
					const relative = normalized.substring(normalizedBuiltinToolsDir.length);
					remappedArgs.push(`/tools-builtin${relative}`);
				} else if (normalized.startsWith(normalizedMcpExtDir)) {
					// Remap MCP extension paths: .bobbit/state/mcp-extensions/... → /mcp-extensions/...
					const relative = normalized.substring(normalizedMcpExtDir.length);
					remappedArgs.push(`/mcp-extensions${relative}`);
				} else if (normalized.startsWith(normalizedStateDir)) {
					// Remap state dir paths (tool-guard, etc.): .bobbit/state/... → /bobbit-state/...
					const relative = normalized.substring(normalizedStateDir.length);
					remappedArgs.push(`/bobbit-state${relative}`);
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

// ── Container ↔ Host path translation ──────────────────────────────────────

/**
 * Mount-table entry: maps a container-internal prefix to a host-side path.
 * Built dynamically from the same values used by docker-args.ts bind mounts.
 */
interface MountMapping {
	containerPrefix: string;
	hostPath: string;
}

/**
 * Build the mount table that describes container ↔ host path mappings.
 * This is the single source of truth — both containerPathToHost() and
 * hostPathToContainer() derive from it.
 *
 * Accepts optional builtinToolsDir to handle cascade-resolved builtin paths.
 */
function buildMountTable(builtinToolsDir?: string): MountMapping[] {
	const stateDir = bobbitStateDir();
	const agentSessionsDir = path.join(globalAgentDir(), "sessions");
	const sessionPromptsDir = path.join(stateDir, "session-prompts");
	const mcpExtDir = path.join(stateDir, "mcp-extensions");

	// Order matters: most specific prefixes first so /home/node/.bobbit/agent/sessions
	// matches before a hypothetical /home/node/.bobbit/agent would.
	const table: MountMapping[] = [
		{ containerPrefix: CONTAINER_AGENT_DIR + "sessions", hostPath: agentSessionsDir },
		{ containerPrefix: "/tmp/session-prompts", hostPath: sessionPromptsDir },
		{ containerPrefix: "/mcp-extensions", hostPath: mcpExtDir },
		// Mount only specific state subdirectories — never the full state dir
		// (which contains the host gateway token, TLS keys, etc.)
		{ containerPrefix: "/bobbit-state/sessions", hostPath: path.join(stateDir, "sessions") },
		{ containerPrefix: "/bobbit-state/tool-guard", hostPath: path.join(stateDir, "tool-guard") },
		{ containerPrefix: "/bobbit-state/html-snapshots", hostPath: path.join(stateDir, "html-snapshots") },
		{ containerPrefix: "/tools", hostPath: TOOLS_DIR },
	];

	// Add builtin tools dir mapping (for cascade-resolved builtin paths)
	if (builtinToolsDir) {
		// Insert before /tools so /tools-builtin matches first
		table.splice(table.length - 1, 0, { containerPrefix: "/tools-builtin", hostPath: builtinToolsDir });
	}

	return table;
}

/**
 * Translate a container-internal path back to its host-side equivalent.
 * Uses the known bind-mount mappings from docker-args.ts.
 *
 * Returns the original path unchanged if it doesn't match any known mount.
 * On Windows, the returned path uses OS-native separators.
 */
export function containerPathToHost(containerPath: string): string {
	const normalized = containerPath.replace(/\\/g, "/");
	for (const { containerPrefix, hostPath } of buildMountTable(BUILTIN_TOOLS_DIR)) {
		// Match exact prefix or prefix followed by "/" to avoid collisions
		// (e.g. "/bobbit-state/sessions" must not match "/bobbit-state/sessions.json")
		if (normalized === containerPrefix || normalized.startsWith(containerPrefix + "/")) {
			const relative = normalized.substring(containerPrefix.length);
			return path.join(hostPath, ...relative.split("/").filter(Boolean));
		}
	}
	return containerPath;
}

/**
 * Translate a host-side path to its container-internal equivalent.
 * Inverse of containerPathToHost().
 *
 * Returns the original path unchanged if it doesn't match any known mount.
 */
export function hostPathToContainer(hostPath: string): string {
	const normalized = hostPath.replace(/\\/g, "/");
	for (const { containerPrefix, hostPath: hp } of buildMountTable(BUILTIN_TOOLS_DIR)) {
		const normalizedHost = hp.replace(/\\/g, "/");
		if (normalized.startsWith(normalizedHost)) {
			const relative = normalized.substring(normalizedHost.length);
			return containerPrefix + relative;
		}
	}
	return hostPath;
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
