import { spawn, type ChildProcess } from "node:child_process";
import type { Clock } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { bobbitDir, bobbitStateDir, headquartersDir, globalAgentDir } from "../bobbit-dir.js";
import { caCertPath } from "../auth/tls.js";
import { activeAgentSessionsDir } from "./agent-session-path.js";
import { TOOLS_DIR, type ToolManager } from "./tool-manager.js";
import { THINKING_LEVELS } from "../../shared/thinking-levels.js";
import { resolveBuiltinPacksDir } from "./builtin-packs.js";
import { scopePaths } from "./pack-types.js";
import { normalizeToolResultErrorEvent, normalizeToolResultErrorSnapshot } from "./tool-result-error-normalizer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Builtin tools directory — dist/server/defaults/tools/ (read-only, shipped with Bobbit). */
const BUILTIN_TOOLS_DIR = path.join(__dirname, "..", "defaults", "tools");
/** Container mount for shipped first-party market packs. */
export const BUILTIN_PACKS_CONTAINER_DIR = "/market-packs-builtin";
/** Container mounts for installed marketplace packs by activation/install scope. */
export const SERVER_MARKET_PACKS_CONTAINER_DIR = "/market-packs-server";
export const GLOBAL_USER_MARKET_PACKS_CONTAINER_DIR = "/market-packs-global-user";
export const PROJECT_MARKET_PACKS_CONTAINER_DIR = "/market-packs-project";

/**
 * Redact sensitive env vars from Docker arg arrays for logging.
 *
 * Handles both `-e NAME=VALUE` (the form spawnDockerExec uses) and the
 * separated `-e NAME VALUE` form, redacting only the VALUE and leaving the
 * NAME visible for diagnostics.
 *
 * The match is on the env-var NAME, broadened to cover any `*_SECRET` /
 * `*_TOKEN` so per-session capability secrets (BOBBIT_SESSION_SECRET — a
 * replayable `X-Bobbit-Session-Secret` credential) and arbitrary
 * future credentials never leak into gateway logs in cleartext. Exported for
 * regression testing.
 */
export function redactDockerArgs(args: string[]): string {
	// Match on env-var NAME (left of "=", or the bare token in the split form).
	const sensitiveName = /^(BOBBIT_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|AWS_SECRET|.*_SECRET|.*_TOKEN|.*_API_KEY|.*_OAUTH_TOKEN|.*_ACCESS_KEY)$/i;
	const isSensitive = (token: string): boolean => {
		const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		return sensitiveName.test(name);
	};
	return args.map((a, i) => {
		if (i > 0 && args[i - 1] === "-e" && isSensitive(a)) {
			// `-e NAME=VALUE` form: redact the value after the first "=".
			if (a.includes("=")) return a.replace(/=.*/s, "=<REDACTED>");
			// `-e NAME` form: the NAME token itself is fine; the value (next arg)
			// is redacted below.
			return a;
		}
		// Split `-e NAME VALUE` form: redact the VALUE following a sensitive NAME.
		if (i > 1 && args[i - 2] === "-e" && !args[i - 1].includes("=") && isSensitive(args[i - 1])) {
			return "<REDACTED>";
		}
		return a;
	}).join(" ");
}

/** Container home directory for the Docker sandbox (node:20-slim, USER node) */
export const CONTAINER_HOME = "/home/node";
/** Container-side agent directory prefix (always forward slashes) */
export const CONTAINER_AGENT_DIR = "/home/node/.bobbit/agent/";

export interface RuntimePiExtensionInfo {
	listName: string;
	entryPath: string;
	entryRelativePath?: string;
	packRoot: string;
	origin: {
		scope: "server" | "global-user" | "project" | "builtin";
		packName: string;
		packId: string;
		sourceUrl?: string;
	};
}

export interface RuntimePiExtensionDiagnostic {
	status: "runtime-load-failed" | "remap-failed";
	code: string;
	message: string;
	updatedAt: string;
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
	/** Host project marketplace pack root mounted as /market-packs-project in named-volume sandbox mode. */
	projectMarketPacksRoot?: string;
	/** Enabled Marketplace pi extensions passed as --extension; used for sandbox remap and runtime diagnostics. */
	piExtensions?: RuntimePiExtensionInfo[];
	/** Receives runtime/remap diagnostics observed after extension handoff. */
	onPiExtensionDiagnostic?: (diagnostic: RuntimePiExtensionDiagnostic, extension: RuntimePiExtensionInfo) => void;
	/** Tool manager for resolving extension paths (optional — falls back to TOOLS_DIR). */
	toolManager?: ToolManager;
	/**
	 * Pin the agent's model at spawn time via `--model <provider>/<modelId>`.
	 * Avoids the redundant initial `model_change` event that pi-coding-agent
	 * emits when booting with its hardcoded default before Bobbit calls
	 * `setModel`. Silently ignored if malformed.
	 */
	initialModel?: string;
	/**
	 * Pin the agent's thinking level at spawn time via `--thinking <level>`.
	 * Valid: off|minimal|low|medium|high. Silently ignored otherwise.
	 */
	initialThinkingLevel?: string;
	/** Timer/clock implementation. Defaults to real timers. */
	clock?: Clock;
}

export type RpcEventListener = (event: any) => void;

/**
 * Lightweight bridge to a pi-coding-agent running in RPC mode.
 * Communicates via JSONL (one JSON object per line) over stdin/stdout.
 *
 * Test harnesses can register an alternative factory via
 * `RpcBridge.registerFactory(fn)` to route specific options (e.g. the E2E
 * in-process mock) to a custom implementation that matches the public
 * interface (`IRpcBridge`). The production code is unchanged: it still
 * calls `new RpcBridge(opts)` and the factory intercepts transparently.
 */
export interface IRpcBridge {
	start(): Promise<void>;
	stop(): Promise<void>;
	prompt(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, timeoutMs?: number): Promise<any>;
	promptWhenReady(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, opts?: { readyTimeoutMs?: number; promptTimeoutMs?: number }): Promise<any>;
	steer(text: string): Promise<any>;
	abort(): Promise<any>;
	getState(): Promise<any>;
	getMessages(): Promise<any>;
	setModel(provider: string, modelId: string): Promise<any>;
	setThinkingLevel(level: string): Promise<any>;
	compact(timeoutMs?: number): Promise<any>;
	waitForReady(overallTimeoutMs?: number): Promise<void>;
	sendCommand(command: Record<string, any>, timeoutMs?: number): Promise<any>;
	onEvent(listener: RpcEventListener): () => void;
	readonly running: boolean;
}

export type RpcBridgeFactory = (options: RpcBridgeOptions) => IRpcBridge | null;

/**
 * Synthetic text body injected for attachment-only prompts. The model API
 * rejects a user message whose ContentBlock has a blank `text` field (next to
 * an image block, or as a standalone empty text block), so when the user sends
 * only an image/attachment with no text we substitute this phrase.
 *
 * Exported so the transcript sanitizer can use the exact same phrase when
 * un-poisoning already-committed blank-text user messages.
 */
export const ATTACHMENT_ONLY_TEXT = "Attachments:";

/**
 * Cold-restart re-prompt timeouts. A freshly-revived agent — model init + MCP
 * extension load — often needs 30-90s to first respond, worse under parallel
 * restore; the default 30s prompt timeout reliably times out on boot. The
 * verification-harness resume, the mid-turn restore re-prompt, and the
 * team-manager boot-resume nudge all use these via `RpcBridge.promptWhenReady`.
 */
export const COLD_REPROMPT_READY_TIMEOUT_MS = 90_000;
export const COLD_REPROMPT_PROMPT_TIMEOUT_MS = 120_000;

/**
 * Pure helper: decide the model-facing text for a prompt.
 *
 * Returns the synthetic `ATTACHMENT_ONLY_TEXT` ("Attachments:") when `text` is
 * blank/whitespace-only AND at least one image or attachment is present;
 * otherwise returns `text` unchanged.
 *
 * This is the single source of truth for "image/attachment-only prompts must
 * carry a non-blank text body". It is applied at the dispatch boundary
 * (session-manager `enqueuePrompt`) so every dispatch path — direct dispatch,
 * queued drain, error-recovery prefix, retry — sees valid text, and defensively
 * at the bridge `prompt()` (image case) as a backstop.
 *
 * Trims before deciding so whitespace-only text counts as blank (R4). Normal
 * text, text+image, and empty-with-no-attachments are all returned unchanged
 * (R5).
 */
export function synthesizeAttachmentText(
	text: string,
	images?: Array<unknown> | null,
	attachments?: Array<unknown> | null,
): string {
	if (text && text.trim() !== "") return text;
	const hasImages = Array.isArray(images) && images.length > 0;
	const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
	if (hasImages || hasAttachments) return ATTACHMENT_ONLY_TEXT;
	return text;
}

let _factory: RpcBridgeFactory | null = null;

export function getRegisteredRpcBridgeFactory(): RpcBridgeFactory | null {
	return _factory;
}

/**
 * Register an alternative bridge factory. Called by legacy test harnesses to
 * route mock sessions to an in-process implementation. Return `null` from
 * the factory to fall through to the default child-process RpcBridge.
 *
 * @deprecated Pass `GatewayDeps.agentBridgeFactory` to `createGateway` instead.
 */
export function registerRpcBridgeFactory(factory: RpcBridgeFactory | null): void {
	_factory = factory;
}

/**
 * Build the pi-coding-agent CLI arg list from RpcBridgeOptions.
 *
 * Exported for unit testing (mocking child_process.spawn is brittle).
 * Order matters: --model and --thinking are inserted BEFORE caller-supplied
 * `options.args` so any explicit override in `args` (e.g. `--model x` from
 * a custom flow) wins over the spawn-time pin.
 *
 * `--no-approve` (pi 0.79.0 project-trust gate) is ALWAYS present AND
 * NON-OVERRIDABLE: Bobbit injects all config via ~/.bobbit/agent + RPC args and
 * never loads project-local `.pi` directories. `--no-approve` makes pi decline
 * project trust deterministically (projectTrustOverride=false →
 * resolveProjectTrusted returns false immediately), so the agent never stalls on
 * a trust prompt and never loads project-local settings/resources/packages/
 * extensions. Both the local-spawn arg list and the Docker-exec arg list flow
 * through this builder, so a single flag covers both spawn paths. This must NOT
 * depend on settings.json state. See goal: project-trust decision (no `.pi`
 * support).
 *
 * `--no-context-files` is also ALWAYS present AND NON-OVERRIDABLE. Bobbit owns
 * AGENTS.md / CLAUDE.md injection in system-prompt.ts, scoped to the registered
 * project root and configured agent files; pi's independent upward context-file
 * discovery must stay disabled so parent-directory context cannot leak into the
 * runtime system prompt or extension hook events.
 *
 * pi parses the trust/context flags sequentially, last-wins (see
 * pi-coding-agent dist/cli/args.js: `--approve`/`-a` set
 * projectTrustOverride=true, `--no-approve`/`-na` set it false; context-file
 * flags similarly enable/disable context loading). Caller-supplied flags in
 * `options.args` would therefore override Bobbit's policy. To keep the decline
 * deterministic we STRIP every trust/context flag spelling from `options.args`
 * and emit exactly one leading `--no-approve` and `--no-context-files` that no
 * caller can override.
 */
/**
 * Resolve the gateway credentials to inject into a direct (non-sandbox) child's
 * env: BOBBIT_TOKEN + BOBBIT_GATEWAY_URL.
 *
 * Sandbox children receive these via `-e` in spawnDockerExec (from
 * options.gatewayToken / gatewayUrl). Direct children use the same option, but
 * only when SessionManager supplied a scoped token. Never fall back to the
 * gateway admin token here: if no scoped token is provided, BOBBIT_TOKEN is
 * omitted. The gateway URL still resolves from explicit options, env, or the
 * gateway-url state file.
 *
 * Exported (with injectable deps) for deterministic unit testing without a real
 * spawn. Pinned by tests/rpc-bridge-gateway-env.test.ts.
 */
export function resolveDirectGatewayEnv(
	opts: { gatewayToken?: string; gatewayUrl?: string },
	deps: {
		stateDir?: () => string;
		envGatewayUrl?: string;
	} = {},
): Record<string, string> {
	const stateDirFn = deps.stateDir ?? bobbitStateDir;
	const envGatewayUrl = deps.envGatewayUrl ?? process.env.BOBBIT_GATEWAY_URL;

	const env: Record<string, string> = {};
	if (opts.gatewayToken) env.BOBBIT_TOKEN = opts.gatewayToken;

	let gwUrl = opts.gatewayUrl ?? envGatewayUrl;
	if (!gwUrl) {
		try {
			gwUrl = fs.readFileSync(path.join(stateDirFn(), "gateway-url"), "utf-8").trim();
		} catch {
			// gateway-url not yet written (very early startup) — leave unset.
		}
	}
	if (gwUrl) env.BOBBIT_GATEWAY_URL = gwUrl;
	return env;
}

export function buildAgentArgs(options: RpcBridgeOptions): string[] {
	const args = ["--mode", "rpc", "--no-approve", "--no-context-files"];
	if (options.systemPromptPath) args.push("--system-prompt", options.systemPromptPath);
	if (options.initialModel) {
		const slash = options.initialModel.indexOf("/");
		if (slash > 0 && slash < options.initialModel.length - 1) {
			args.push("--model", options.initialModel);
		}
	}
	if (options.initialThinkingLevel) {
		// CLI accepts any known token; per-model clamping is a UI/server-boundary
		// concern, not a CLI concern. The agent itself ignores unsupported levels.
		if ((THINKING_LEVELS as readonly string[]).includes(options.initialThinkingLevel)) {
			args.push("--thinking", options.initialThinkingLevel);
		}
	}
	if (options.args) {
		// Drop any caller-supplied project-trust/context-file flag so the single
		// leading `--no-approve` and `--no-context-files` above are
		// non-overridable. `--context-files`/`-c` may take a following value; remove
		// that paired value when present without disturbing unrelated flags.
		const STRIPPED_VALUELESS_FLAGS = new Set(["--approve", "-a", "--no-approve", "-na", "--no-context-files", "-nc"]);
		const filteredArgs: string[] = [];
		for (let i = 0; i < options.args.length; i++) {
			const arg = options.args[i];
			if (STRIPPED_VALUELESS_FLAGS.has(arg)) continue;
			if (arg === "--context-files" || arg === "-c") {
				const next = options.args[i + 1];
				if (next !== undefined && !next.startsWith("-")) i++;
				continue;
			}
			if (arg.startsWith("--context-files=") || arg.startsWith("-c=")) continue;
			filteredArgs.push(arg);
		}
		args.push(...filteredArgs);
	}
	return args;
}

export class RpcBridge {
	private process: ChildProcess | null = null;
	private requestId = 0;
	private pending = new Map<string, { resolve: (value: any) => void; reject: (reason: any) => void; timeout: ReturnType<Clock["setTimeout"]> }>();
	private eventListeners: RpcEventListener[] = [];
	/** Incomplete trailing JSONL fragment retained between stdout chunks. */
	private lineBuffer = "";
	/** Persistent UTF-8 decoders so a multibyte char split across two stdout/
	 *  stderr reads is reassembled instead of corrupted into U+FFFD (S14 — the
	 *  agent's own stdin reader uses StringDecoder; we mirror it here). A per-
	 *  chunk `chunk.toString("utf-8")` would mojibake long CJK/emoji output. */
	private stdoutDecoder = new StringDecoder("utf8");
	private stderrDecoder = new StringDecoder("utf8");
	/** Ring buffer of last stderr lines — included in exit error messages for diagnostics. */
	private stderrTail: string[] = [];
	private readonly clock: Clock = realClock;

	constructor(private options: RpcBridgeOptions = {}) {
		// If a test-registered factory claims this options object, return that
		// instance instead of the default child-process bridge. This lets the
		// E2E harness swap in an in-process mock without modifying any callers.
		if (_factory) {
			const alt = _factory(options);
			if (alt) {
				// Dynamically forward everything to the alternative. Since
				// `RpcBridge` is a class (not an interface), we return `alt` from
				// the constructor to replace `this`. TypeScript's structural
				// compatibility is enforced at the factory level.
				return alt as unknown as RpcBridge;
			}
		}
		this.clock = options.clock ?? realClock;
	}

	async start(): Promise<void> {
		// Docker uses the Pi runtime baked into the sandbox image. Only direct host
		// spawns resolve Bobbit's installed package (or an explicit CLI override).
		const cliPath = this.options.containerId
			? ""
			: resolveDirectHostPiRuntime({ cliPath: this.options.cliPath }).cliPath;
		const args = buildAgentArgs(this.options);

		// Disable pi's internal builtin tools and re-register the file-tool subset
		// via _builtins/extension.ts. After pi 0.70, `--tools <list>` became a
		// unified allowlist over builtins AND extension-registered tools, so the
		// previous "--tools read,edit,…" pattern stripped our own bash, web,
		// browser, propose_*, etc. extension tools. With --no-builtin-tools every
		// tool comes from an extension; pi's `includeAllExtensionTools: true` at
		// session construction activates all of them by default.
		if (!args.includes("--tools") && !args.includes("--no-tools") && !args.includes("--no-builtin-tools")) {
			args.push("--no-builtin-tools");
		}

		// When computeToolActivationArgs runs, it adds --no-extensions and explicitly
		// loads needed extensions (shell + _builtins + others). For sessions that
		// don't go through tool activation (no role, fallback path), force-load
		// shell/extension.ts (bash + bash_bg) and _builtins/extension.ts (file
		// tools) so the agent has its baseline toolset.
		if (!args.includes("--no-extensions")) {
			const bashExtPath = this.options.toolManager
				? this.options.toolManager.getExtensionPath("shell", "extension.ts")
				: path.join(TOOLS_DIR, "shell", "extension.ts");
			if (!args.includes(bashExtPath)) {
				args.push("--extension", bashExtPath);
			}
			const builtinsExtPath = this.options.toolManager
				? this.options.toolManager.getExtensionPath("_builtins", "extension.ts")
				: path.join(TOOLS_DIR, "_builtins", "extension.ts");
			if (!args.includes(builtinsExtPath)) {
				args.push("--extension", builtinsExtPath);
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
					this.clock.setTimeout(() => {
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
					await new Promise<void>(resolve => this.clock.setTimeout(() => resolve(), delay));
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
			// Trust our self-signed CA cert if available; fall back to disabling TLS
			// verification. TLS material moved to serverSecretsDir() after the S1
			// relocation, so resolve via the tls helper rather than bobbitStateDir().
			const caCert = caCertPath();
			const tlsEnv = fs.existsSync(caCert)
				? { NODE_EXTRA_CA_CERTS: caCert }
				: { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
			this.process = spawn(process.execPath, [cliPath, ...args], {
				stdio: ["pipe", "pipe", "pipe"],
				cwd: this.options.cwd,
				env: {
					...process.env,
					BOBBIT_DIR: bobbitDir(),
					// Direct (non-sandbox) children need the gateway credentials in env so
					// agent-side helpers (defaults/tools/_shared/gateway.ts,
					// tool-guard-extension.ts, tool-activation.ts) can call back into the
					// gateway. Sandbox sessions get these via `-e` in spawnDockerExec; the
					// S1 secret relocation removed the token from a project-reachable file,
					// so the on-disk fallback in those helpers no longer resolves. Inject
					// from the relocation-aware helpers here — the token is never written to
					// a project-reachable path. Placed before `this.options.env` so an
					// explicit caller override still wins.
					...this._resolveDirectGatewayEnv(),
					...tlsEnv,
					...this.options.env,
					// Ensure the agent subprocess uses the same agent dir as Bobbit's globalAgentDir(),
					// preventing split-brain between ~/.bobbit/agent/ and ~/.pi/agent/.
					PI_CODING_AGENT_DIR: globalAgentDir(),
				},
			});
		}
	}

	/**
	 * Resolve the gateway credentials to inject into a direct (non-sandbox)
	 * child's env: BOBBIT_TOKEN + BOBBIT_GATEWAY_URL.
	 *
	 * Sandbox children receive these via `-e` in spawnDockerExec (from
	 * this.options.gatewayToken / gatewayUrl). Direct children use the same option,
	 * but only when SessionManager supplied a scoped token. Never fall back to the
	 * gateway admin token in the agent env.
	 */
	private _resolveDirectGatewayEnv(): Record<string, string> {
		return resolveDirectGatewayEnv({
			gatewayToken: this.options.gatewayToken,
			gatewayUrl: this.options.gatewayUrl,
		});
	}

	/**
	 * Attach stdout/stderr/stdin/error/exit handlers to this.process.
	 * Factored out of start() so retry logic can re-attach after re-spawn.
	 */
	private _attachProcessHandlers(): void {
		this.process!.stdout!.on("data", (chunk: Buffer) => {
			// S14: decode through a persistent StringDecoder so a multibyte char
			// straddling a chunk boundary is reassembled, not corrupted.
			this.handleData(this.stdoutDecoder.write(chunk));
		});

		this.process!.stderr!.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			// Keep last 20 lines of stderr for diagnostics on unexpected exit.
			// pi currently does not expose a stable structured extension-load failure
			// event across versions, so Marketplace pi-extension runtime diagnostics use
			// conservative stderr matching below and only fire when the line names a
			// known enabled extension path/list ref.
			const lines = this.stderrDecoder.write(chunk).split("\n").filter(l => l.trim());
			for (const line of lines) this.recordPiExtensionLoadFailureFromStderr(line);
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
				this.clock.clearTimeout(p.timeout);
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

			// Include the stderr tail in the rejection error so callers (e.g. restoreSession)
			// can surface the actual failure reason instead of a generic "exited with code 1".
			const exitMsg = `Agent process exited with ${reason}${stderrContext}`;
			for (const [, p] of this.pending) {
				this.clock.clearTimeout(p.timeout);
				p.reject(new Error(exitMsg));
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
			const timeout = this.clock.setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Command timed out: ${command.type}`));
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timeout });
			this.process!.stdin!.write(JSON.stringify(msg) + "\n");
		});
	}

	// --- Convenience methods matching the RPC protocol ---

	prompt(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, timeoutMs?: number) {
		// Defensive backstop: if a prompt carries image(s) but blank text, the
		// model API rejects the blank ContentBlock. The primary fix synthesizes
		// text upstream in session-manager.enqueuePrompt (where non-image
		// attachments are also visible); this guard covers the image case for any
		// direct bridge caller that bypasses that path.
		const effectiveText = synthesizeAttachmentText(text, images);
		if (images?.length) {
			console.log(`[rpc-bridge] Sending prompt with ${images.length} image(s), first image: type=${images[0].type}, mimeType=${images[0].mimeType}, data length=${images[0].data?.length}`);
		}
		return this.sendCommand({ type: "prompt", message: effectiveText, ...(images?.length ? { images } : {}) }, timeoutMs);
	}

	/** Wait for a (possibly cold) agent to become responsive, then prompt with a
	 *  generous timeout. Shared by the verification-harness resume, the mid-turn
	 *  restore re-prompt, and the team-manager boot-resume nudge so none of them
	 *  re-implements the wait-for-ready + generous-timeout dance. */
	async promptWhenReady(
		text: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
		opts?: { readyTimeoutMs?: number; promptTimeoutMs?: number },
	): Promise<any> {
		await this.waitForReady(opts?.readyTimeoutMs ?? COLD_REPROMPT_READY_TIMEOUT_MS);
		return this.prompt(text, images, opts?.promptTimeoutMs ?? COLD_REPROMPT_PROMPT_TIMEOUT_MS);
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
		const start = this.clock.now();
		const pingInterval = 2_000;
		while (this.clock.now() - start < overallTimeoutMs) {
			try {
				await this.sendCommand({ type: "get_state" }, 5_000);
				return; // Agent responded — it's ready
			} catch {
				if (!this.process) throw new Error("Agent process exited during initialization");
				await new Promise((r) => this.clock.setTimeout(() => r(undefined), pingInterval));
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

	async getMessages() {
		const response = await this.sendCommand({ type: "get_messages" });
		if (response?.success) return { ...response, data: normalizeToolResultErrorSnapshot(response.data) };
		return response;
	}

	async stop(): Promise<void> {
		if (!this.process) return;

		return new Promise((resolve) => {
			const killTimer = this.clock.setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 3000);

			this.process!.on("exit", () => {
				this.clock.clearTimeout(killTimer);
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
		// S1: the per-session capability secret reaches the sandboxed agent
		// process via docker exec -e (NOT the pool container's PID 1 env — so it
		// never appears in /proc/1/environ). See session-secret.ts.
		if (this.options.env?.BOBBIT_SESSION_SECRET) {
			execArgs.push("-e", `BOBBIT_SESSION_SECRET=${this.options.env.BOBBIT_SESSION_SECRET}`);
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
			"node", "--disable-warning=DEP0123", "/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
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
		// Also handle builtin tools dir (dist/server/defaults/tools/) for cascade-resolved paths.
		const builtinToolsDir = this.options.toolManager?.getBuiltinToolsDir();
		const remapOpts = { builtinToolsDir, projectBase: this.options.cwd, projectMarketPacksRoot: this.options.projectMarketPacksRoot };
		const remappedArgs: string[] = [];

		for (let i = 0; i < agentArgs.length; i++) {
			const arg = agentArgs[i];
			if (arg === "--cwd") {
				// Skip --cwd and its value — the working directory is set via
				// `docker exec -w` in spawnDockerExec() (or spawn cwd for direct).
				i++; // skip the next arg (the host cwd path)
			} else if (arg === "--system-prompt") {
				// session-prompts/ dir is mounted at /tmp/session-prompts/
				const hostPath = agentArgs[i + 1] || "";
				const filename = path.basename(hostPath);
				remappedArgs.push("--system-prompt", `/tmp/session-prompts/${filename}`);
				i++; // skip the next arg (the host prompt path)
			} else if (arg === "--extension" && agentArgs[i + 1]) {
				const hostPath = agentArgs[i + 1];
				const piExtension = this.findRuntimePiExtensionByPath(hostPath);
				if (piExtension) {
					const containerPath = tryHostPathToContainer(hostPath, remapOpts);
					if (!containerPath) {
						this.emitPiExtensionDiagnostic(piExtension, "remap-failed", "remap_failed", `Could not remap Marketplace pi extension ${piExtension.origin.packName}/${piExtension.listName} for Docker sandbox: ${hostPath}`);
						i++;
						continue;
					}
					remappedArgs.push("--extension", containerPath);
					i++;
					continue;
				}
				remappedArgs.push("--extension", hostPathToContainer(hostPath, remapOpts));
				i++;
			} else {
				remappedArgs.push(hostPathToContainer(arg, remapOpts));
			}
		}

		return remappedArgs;
	}

	// --- Private ---

	private findRuntimePiExtensionByPath(value: string | undefined): RuntimePiExtensionInfo | undefined {
		if (!value) return undefined;
		const normalized = normalizePathForPrefix(value);
		return (this.options.piExtensions ?? []).find((extension) => normalizePathForPrefix(extension.entryPath) === normalized);
	}

	private emitPiExtensionDiagnostic(extension: RuntimePiExtensionInfo, status: RuntimePiExtensionDiagnostic["status"], code: string, message: string): void {
		this.options.onPiExtensionDiagnostic?.({ status, code, message: sanitizePiExtensionRuntimeMessage(message), updatedAt: new Date().toISOString() }, extension);
	}

	private recordPiExtensionLoadFailureFromStderr(line: string): void {
		const extension = matchPiExtensionRuntimeFailure(line, this.options.piExtensions ?? [], {
			builtinToolsDir: this.options.toolManager?.getBuiltinToolsDir(),
			projectBase: this.options.cwd,
			projectMarketPacksRoot: this.options.projectMarketPacksRoot,
		});
		if (!extension) return;
		this.emitPiExtensionDiagnostic(extension, "runtime-load-failed", "runtime_load_failed", `Pi extension ${extension.origin.packName}/${extension.listName} failed to load: ${line}`);
	}

	private recordPiExtensionLoadFailureFromEvent(event: any): void {
		const extension = matchPiExtensionStructuredRuntimeFailure(event, this.options.piExtensions ?? [], {
			builtinToolsDir: this.options.toolManager?.getBuiltinToolsDir(),
			projectBase: this.options.cwd,
			projectMarketPacksRoot: this.options.projectMarketPacksRoot,
		});
		if (!extension) return;
		const rawMessage = typeof event?.message === "string" ? event.message : typeof event?.error === "string" ? event.error : JSON.stringify(event);
		this.emitPiExtensionDiagnostic(extension, "runtime-load-failed", "runtime_load_failed", `Pi extension ${extension.origin.packName}/${extension.listName} failed to load: ${rawMessage}`);
	}

	/**
	 * Scan only the newly decoded chunk for JSONL boundaries. Searching the
	 * complete accumulated fragment on every chunk makes a large newline-free
	 * line quadratic; the retained fragment is now joined only when that line
	 * completes.
	 */
	private handleData(data: string): void {
		let newlineIdx = data.indexOf("\n");
		if (newlineIdx === -1) {
			this.lineBuffer += data;
			return;
		}

		const bufferedPrefix = this.lineBuffer;
		// Match the old split-based implementation's state before dispatch: even
		// if a listener throws, the final incomplete fragment remains buffered and
		// the unprocessed complete lines from this chunk are not replayed.
		const lastNewlineIdx = data.lastIndexOf("\n");
		this.lineBuffer = data.slice(lastNewlineIdx + 1);

		let start = 0;
		let firstLine = true;
		while (newlineIdx !== -1) {
			const segment = data.slice(start, newlineIdx);
			const line = firstLine && bufferedPrefix.length > 0
				? bufferedPrefix + segment
				: segment;
			firstLine = false;
			start = newlineIdx + 1;
			this.processLine(line);
			newlineIdx = data.indexOf("\n", start);
		}
	}

	private processLine(line: string): void {
		const trimmed = line.replace(/\r$/, "").trim();
		if (!trimmed) return;

		let parsed: any;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return; // skip non-JSON output (e.g. log lines)
		}

		// Response to a pending request
		if (parsed.type === "response" && parsed.id && this.pending.has(parsed.id)) {
			const p = this.pending.get(parsed.id)!;
			this.clock.clearTimeout(p.timeout);
			this.pending.delete(parsed.id);
			p.resolve(parsed);
		} else {
			this.recordPiExtensionLoadFailureFromEvent(parsed);
			const normalized = normalizeToolResultErrorEvent(parsed);
			// Agent event — forward to listeners
			for (const listener of this.eventListeners) {
				listener(normalized);
			}
		}
	}
}

function sanitizePiExtensionRuntimeMessage(message: string): string {
	return message.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 1000) || "Pi extension runtime failure.";
}

function runtimeFailureLineLooksRelevant(line: string): boolean {
	return /(?:failed|failure|error|exception|cannot|unable)/i.test(line)
		&& /(?:extension|plugin|import|activate|load|register)/i.test(line);
}

function extensionPathAliases(extension: RuntimePiExtensionInfo, opts: MountTableOptions): string[] {
	const aliases = new Set<string>([
		extension.entryPath,
		extension.entryPath.replace(/\\/g, "/"),
		extension.entryRelativePath ?? "",
		`${extension.origin.packName}/${extension.listName}`,
		extension.listName,
	]);
	const containerPath = tryHostPathToContainer(extension.entryPath, opts);
	if (containerPath) aliases.add(containerPath);
	return [...aliases].filter((value) => value.length > 0);
}

function matchPiExtensionRuntimeFailure(line: string, extensions: readonly RuntimePiExtensionInfo[], opts: MountTableOptions): RuntimePiExtensionInfo | undefined {
	if (!runtimeFailureLineLooksRelevant(line)) return undefined;
	const normalizedLine = normalizePathForPrefix(line).toLowerCase();
	return extensions.find((extension) => extensionPathAliases(extension, opts).some((alias) => normalizedLine.includes(normalizePathForPrefix(alias).toLowerCase())));
}

function matchPiExtensionStructuredRuntimeFailure(event: any, extensions: readonly RuntimePiExtensionInfo[], opts: MountTableOptions): RuntimePiExtensionInfo | undefined {
	if (!event || typeof event !== "object") return undefined;
	const type = typeof event.type === "string" ? event.type : "";
	if (!/(extension|plugin).*(error|failed|failure)|runtime-load-failed/i.test(type)) return undefined;
	const pathLike = String(event.path ?? event.entryPath ?? event.extensionPath ?? event.file ?? event.sourcePath ?? event.extension ?? "");
	const message = String(event.message ?? event.error ?? "");
	return matchPiExtensionRuntimeFailure(`${pathLike} ${message}`, extensions, opts);
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

export interface HostPathToContainerOptions {
	builtinToolsDir?: string;
	projectBase?: string;
	projectMarketPacksRoot?: string;
}

type MountTableOptions = HostPathToContainerOptions;

function normalizePathForPrefix(p: string): string {
	const normalized = p.replace(/\\/g, "/");
	return normalized.length > 1 ? normalized.replace(/\/+$/g, "") : normalized;
}

function isSameOrChildPath(normalizedPath: string, normalizedPrefix: string): boolean {
	return normalizedPath === normalizedPrefix || normalizedPath.startsWith(normalizedPrefix + "/");
}

function joinContainerPath(containerPrefix: string, relative: string): string {
	const clean = relative.replace(/^\/+/, "");
	return clean ? `${containerPrefix}/${clean}` : containerPrefix;
}

function marketPackMountMappings(projectBase?: string, projectMarketPacksRoot?: string): MountMapping[] {
	const mappings: MountMapping[] = [
		{
			containerPrefix: SERVER_MARKET_PACKS_CONTAINER_DIR,
			hostPath: scopePaths("server", headquartersDir()).marketPacksRoot,
		},
		{
			containerPrefix: GLOBAL_USER_MARKET_PACKS_CONTAINER_DIR,
			hostPath: scopePaths("global-user", os.homedir()).marketPacksRoot,
		},
	];
	const projectBaseIsContainerPath = projectBase === "/workspace" || projectBase?.startsWith("/workspace/") || projectBase === "/workspace-wt" || projectBase?.startsWith("/workspace-wt/");
	const projectHostRoot = projectMarketPacksRoot ?? (projectBase && !projectBaseIsContainerPath ? scopePaths("project", projectBase).marketPacksRoot : undefined);
	if (projectHostRoot) {
		mappings.push({
			containerPrefix: PROJECT_MARKET_PACKS_CONTAINER_DIR,
			hostPath: projectHostRoot,
		});
	}
	return mappings;
}

function remapUnknownProjectMarketPackPath(hostPath: string): string | null {
	const normalized = normalizePathForPrefix(hostPath);
	const marker = "/.bobbit/config/market-packs/";
	const idx = normalized.lastIndexOf(marker);
	if (idx < 0) return null;
	const relative = normalized.slice(idx + marker.length);
	if (!relative || relative.startsWith("../") || relative.includes("/../")) return null;
	return joinContainerPath(PROJECT_MARKET_PACKS_CONTAINER_DIR, relative);
}

/**
 * Build the mount table that describes container ↔ host path mappings.
 * This is the single source of truth — both containerPathToHost() and
 * hostPathToContainer() derive from it.
 *
 * Accepts optional builtinToolsDir to handle cascade-resolved builtin paths.
 */
function buildMountTable(opts: MountTableOptions = {}): MountMapping[] {
	const stateDir = bobbitStateDir();
	const agentSessionsDir = activeAgentSessionsDir();
	const sessionPromptsDir = path.join(stateDir, "session-prompts");
	const mcpExtDir = path.join(stateDir, "mcp-extensions");
	const builtinPacksDir = resolveBuiltinPacksDir();

	// Order matters: most specific prefixes first so /home/node/.bobbit/agent/sessions
	// matches before a hypothetical /home/node/.bobbit/agent would.
	const table: MountMapping[] = [
		{ containerPrefix: CONTAINER_AGENT_DIR + "sessions", hostPath: agentSessionsDir },
		{ containerPrefix: "/tmp/session-prompts", hostPath: sessionPromptsDir },
		{ containerPrefix: "/mcp-extensions", hostPath: mcpExtDir },
		{ containerPrefix: BUILTIN_PACKS_CONTAINER_DIR, hostPath: builtinPacksDir },
		...marketPackMountMappings(opts.projectBase, opts.projectMarketPacksRoot),
		// Mount only specific state subdirectories — never the full state dir
		// (which contains the host gateway token, TLS keys, etc.)
		{ containerPrefix: "/bobbit-state/sessions", hostPath: path.join(stateDir, "sessions") },
		{ containerPrefix: "/bobbit-state/tool-guard", hostPath: path.join(stateDir, "tool-guard") },
		{ containerPrefix: "/bobbit-state/html-snapshots", hostPath: path.join(stateDir, "html-snapshots") },
		// Generated pi-coding-agent extensions — bind-mounted by docker-args.ts so
		// sandboxed agents can load remapped --extension paths.
		{ containerPrefix: "/bobbit-state/google-code-assist", hostPath: path.join(stateDir, "google-code-assist") },
		{ containerPrefix: "/bobbit-state/tool-result-error-bridge", hostPath: path.join(stateDir, "tool-result-error-bridge") },
		{ containerPrefix: "/bobbit-state/aigw-dns-guard", hostPath: path.join(stateDir, "aigw-dns-guard") },
		{ containerPrefix: "/tools", hostPath: TOOLS_DIR },
	];

	// Add builtin tools dir mapping (for cascade-resolved builtin paths)
	if (opts.builtinToolsDir) {
		// Insert before /tools so /tools-builtin matches first
		table.splice(table.length - 1, 0, { containerPrefix: "/tools-builtin", hostPath: opts.builtinToolsDir });
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
export function containerPathToHost(containerPath: string, opts: HostPathToContainerOptions = {}): string {
	const normalized = normalizePathForPrefix(containerPath);
	for (const { containerPrefix, hostPath } of buildMountTable({ builtinToolsDir: BUILTIN_TOOLS_DIR, ...opts })) {
		// Match exact prefix or prefix followed by "/" to avoid collisions
		// (e.g. "/bobbit-state/sessions" must not match "/bobbit-state/sessions.json")
		if (isSameOrChildPath(normalized, containerPrefix)) {
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
export function tryHostPathToContainer(hostPath: string, opts: MountTableOptions = {}): string | null {
	const normalized = normalizePathForPrefix(hostPath);
	for (const { containerPrefix, hostPath: hp } of buildMountTable({ builtinToolsDir: BUILTIN_TOOLS_DIR, ...opts })) {
		const normalizedHost = normalizePathForPrefix(hp);
		if (isSameOrChildPath(normalized, normalizedHost)) {
			const relative = normalized.substring(normalizedHost.length);
			return joinContainerPath(containerPrefix, relative);
		}
	}
	return null;
}

export function hostPathToContainer(hostPath: string, opts: MountTableOptions = {}): string {
	return tryHostPathToContainer(hostPath, opts) ?? remapUnknownProjectMarketPackPath(hostPath) ?? hostPath;
}

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

export interface DirectHostPiRuntime {
	/** Present for automatic package resolution; an explicit CLI may live anywhere. */
	modulesDir?: string;
	cliPath: string;
}

export interface ResolveDirectHostPiRuntimeOptions {
	/** Explicit CLI overrides automatic package resolution. */
	cliPath?: string;
	/** `import.meta.resolve`-compatible seam for focused tests. */
	resolve?: (specifier: string, parent?: string | URL) => string;
}

function piPackageRootFromEntry(entryPath: string): string {
	let candidate = path.dirname(entryPath);
	while (true) {
		if (
			path.basename(candidate) === "pi-coding-agent"
			&& path.basename(path.dirname(candidate)) === "@earendil-works"
		) {
			return candidate;
		}
		const parent = path.dirname(candidate);
		if (parent === candidate) break;
		candidate = parent;
	}
	throw new Error(`Resolved ${PI_CODING_AGENT_PACKAGE} entry is outside its package directory: ${entryPath}`);
}

/**
 * Resolve the Pi runtime used by direct host-side agent spawns.
 *
 * Automatic resolution deliberately delegates to Node's `import.meta.resolve`
 * semantics and uses Bobbit's installed package in place. It never consults or
 * mutates legacy state-directory runtime snapshots. Docker spawns bypass this
 * helper because their Pi runtime is baked into the sandbox image.
 */
export function resolveDirectHostPiRuntime(
	opts: ResolveDirectHostPiRuntimeOptions = {},
): DirectHostPiRuntime {
	if (opts.cliPath) return { cliPath: opts.cliPath };

	try {
		const resolve = opts.resolve ?? ((specifier: string, parent?: string | URL) => import.meta.resolve(specifier, parent));
		const entryPath = fileURLToPath(resolve(PI_CODING_AGENT_PACKAGE));
		const packageRoot = piPackageRootFromEntry(entryPath);
		return {
			modulesDir: path.dirname(path.dirname(packageRoot)),
			cliPath: path.join(packageRoot, "dist", "cli.js"),
		};
	} catch (cause) {
		throw new Error(
			`Could not resolve ${PI_CODING_AGENT_PACKAGE} for a direct host agent. `
			+ `Install ${PI_CODING_AGENT_PACKAGE} or pass --agent-cli /path/to/cli.js.`,
			{ cause },
		);
	}
}

/** Resolve the node_modules root used by direct host-side agent spawns. */
export function resolveAgentModulesDir(): string {
	const runtime = resolveDirectHostPiRuntime();
	if (runtime.modulesDir) return runtime.modulesDir;
	throw new Error(`Automatic ${PI_CODING_AGENT_PACKAGE} resolution did not return a node_modules directory.`);
}
