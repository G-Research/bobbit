/**
 * Custom bash tool extension for Bobbit.
 *
 * Replaces the built-in bash tool with a version that:
 * 1. Listens for 'exit' instead of 'close' — resolves when the shell exits,
 *    not when all FD holders (grandchild processes) close their pipes.
 * 2. Forcefully destroys pipes after the process exits.
 * 3. Applies a default safety timeout (5 min) when none is specified.
 *
 * Also provides bash_bg_create, bash_bg_logs, bash_bg_kill tools for
 * managing long-running background processes via the gateway API.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { createWriteStream } from "node:fs";

const MAX_BYTES = 50 * 1024; // 50KB output limit
const MAX_LINES = 2000;
const DEFAULT_TIMEOUT = 300; // 5 minutes
const FOREGROUND_GROUP_GRACE_MS = 250;
const FOREGROUND_GROUP_DRAIN_MS = 2_000;
const FOREGROUND_GROUP_POLL_MS = 25;

type PosixGroupSignal = "SIGTERM" | "SIGKILL";
type ForegroundGroupWitnessStatus = "pending" | "live" | "lost";
export type ForegroundGroupWitness = { status: () => ForegroundGroupWitnessStatus };
type ForegroundGroupOps = {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	signal: (processGroupId: number, signal: PosixGroupSignal) => void;
	report: (message: string) => void;
};

type ForegroundSignalAttempt = "not-attempted" | "sent" | "esrch" | "failed";
export type ForegroundGroupDrainFailureReason =
	| "ownership-never-established"
	| "ownership-lost"
	| "signal-failed"
	| "deadline-exceeded";
export type ForegroundGroupDrainDiagnostic = {
	processGroupId: number;
	finalWitnessStatus: ForegroundGroupWitnessStatus;
	termAttempt: ForegroundSignalAttempt;
	killAttempt: ForegroundSignalAttempt;
	reason: ForegroundGroupDrainFailureReason;
	elapsedMs: number;
	deadlineMs: number;
};

export class ForegroundShellGroupDrainError extends Error {
	readonly code = "FOREGROUND_SHELL_GROUP_DRAIN_FAILED";
	readonly elapsedMs: number;
	readonly deadlineMs: number;
	readonly groups: readonly ForegroundGroupDrainDiagnostic[];

	constructor(elapsedMs: number, deadlineMs: number, groups: ForegroundGroupDrainDiagnostic[]) {
		const summary = groups.map(group =>
			`pgid=${group.processGroupId} status=${group.finalWitnessStatus} reason=${group.reason} TERM=${group.termAttempt} KILL=${group.killAttempt}`
		).join("; ");
		super(`[bash-tool] Foreground process-group drain failed after ${elapsedMs}ms (deadline=${deadlineMs}ms; ${summary})`);
		this.name = "ForegroundShellGroupDrainError";
		this.elapsedMs = elapsedMs;
		this.deadlineMs = deadlineMs;
		this.groups = groups;
	}
}

type ForegroundGroup = {
	processGroupId: number;
	witness: ForegroundGroupWitness;
	termAttempt: ForegroundSignalAttempt;
	killAttempt: ForegroundSignalAttempt;
	finalizePromise?: Promise<void>;
	failureReason?: ForegroundGroupDrainFailureReason;
};

function isNoSuchProcess(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function defaultForegroundGroupOps(): ForegroundGroupOps {
	return {
		now: () => performance.now(),
		sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
		signal: (processGroupId, signal) => {
			process.kill(-processGroupId, signal);
		},
		report: message => console.error(message),
	};
}

type ForegroundSentinelIdentity = {
	pid: number;
	pgid: number;
	kind: "linux-proc-stat-22" | "darwin-lstart-argv-nonce";
	startToken: string;
	nonce: string;
};

// The sentinel is born in the detached shell's process group, acknowledges its
// installed signal dispositions and exact process identity over FD 3, then keeps
// that group allocated after the command root exits. A bare numeric PGID is never
// sufficient to probe or signal a group.
const POSIX_FOREGROUND_SENTINEL_CHILD = "trap '' HUP INT TERM; case \"$(uname -s 2>/dev/null)\" in Linux) __kind=linux-proc-stat-22; __start=$(awk '{print $22}' \"/proc/$$/stat\" 2>/dev/null); __pgid=$(awk '{print $5}' \"/proc/$$/stat\" 2>/dev/null) ;; Darwin) __kind=darwin-lstart-argv-nonce; __start=$(LC_ALL=C ps -o lstart= -p \"$$\" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'); __pgid=$(ps -o pgid= -p \"$$\" 2>/dev/null | tr -d '[:space:]') ;; *) exit 125 ;; esac; [ -n \"$__start\" ] && [ -n \"$__pgid\" ] || exit 125; printf 'R\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$$\" \"$__pgid\" \"$__kind\" \"$__start\" \"$BOBBIT_FOREGROUND_SENTINEL_NONCE\" >&3; while :; do sleep 2147483647; done";
const POSIX_FOREGROUND_SENTINEL_WRAPPER = "/bin/sh -c \"$BOBBIT_FOREGROUND_SENTINEL_CHILD\" \"bobbit-foreground-sentinel:$BOBBIT_FOREGROUND_SENTINEL_NONCE\" & unset BOBBIT_FOREGROUND_SENTINEL_CHILD BOBBIT_FOREGROUND_SENTINEL_NONCE; exec 3>&-; exec \"$@\"";

export function foregroundShellSpawnSpec(shell: string, args: string[], command: string): {
	file: string;
	args: string[];
	stdio: ["ignore", "pipe", "pipe", "pipe"];
	env: NodeJS.ProcessEnv;
	witnessNonce: string;
} {
	const witnessNonce = randomBytes(16).toString("hex");
	return {
		file: "/bin/sh",
		args: ["-c", POSIX_FOREGROUND_SENTINEL_WRAPPER, "bobbit-foreground-wrapper", shell, ...args, command],
		stdio: ["ignore", "pipe", "pipe", "pipe"],
		env: {
			...getShellEnv(),
			BOBBIT_FOREGROUND_SENTINEL_CHILD: POSIX_FOREGROUND_SENTINEL_CHILD,
			BOBBIT_FOREGROUND_SENTINEL_NONCE: witnessNonce,
		},
		witnessNonce,
	};
}

function inspectForegroundSentinel(pid: number, platform: NodeJS.Platform): Omit<ForegroundSentinelIdentity, "nonce"> & { sentinelNonce?: string } | undefined {
	try {
		if (platform === "linux") {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const closeParen = stat.lastIndexOf(")");
			const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
			const pgid = Number(fields[2]);
			const startToken = fields[19];
			return Number.isSafeInteger(pgid) && pgid > 0 && !!startToken
				? { pid, pgid, kind: "linux-proc-stat-22", startToken }
				: undefined;
		}
		if (platform === "darwin") {
			const startToken = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
			const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
			const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			const sentinelNonce = /bobbit-foreground-sentinel:([^\s]+)/.exec(command)?.[1];
			return Number.isSafeInteger(pgid) && pgid > 0 && !!startToken
				? { pid, pgid, kind: "darwin-lstart-argv-nonce", startToken, sentinelNonce }
				: undefined;
		}
	} catch { /* a missing or reused sentinel is not ownership */ }
	return undefined;
}

export function createForegroundGroupWitness(
	readiness: NodeJS.ReadableStream | undefined,
	processGroupId: number,
	nonce: string,
	platform: NodeJS.Platform = process.platform,
	inspect: (pid: number, platform: NodeJS.Platform) => ReturnType<typeof inspectForegroundSentinel> = inspectForegroundSentinel,
): ForegroundGroupWitness {
	let state: ForegroundGroupWitnessStatus = readiness ? "pending" : "lost";
	let handshake = "";
	let identity: ForegroundSentinelIdentity | undefined;
	if (readiness) {
		readiness.on("data", chunk => {
			if (state !== "pending") return;
			handshake += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
			if (!handshake.includes("\n")) return;
			const lines = handshake.split("\n");
			const fields = lines[0].split("\t");
			const pid = Number(fields[1]);
			const pgid = Number(fields[2]);
			const kind = fields[3];
			if (lines.length !== 2 || lines[1] !== "" || fields.length !== 6 || fields[0] !== "R" ||
				!Number.isSafeInteger(pid) || pid <= 0 || pgid !== processGroupId ||
				(kind !== "linux-proc-stat-22" && kind !== "darwin-lstart-argv-nonce") ||
				!fields[4] || fields[5] !== nonce) {
				state = "lost";
				return;
			}
			identity = { pid, pgid, kind, startToken: fields[4], nonce };
			state = "live";
		});
		const lose = () => { state = "lost"; };
		readiness.once("end", lose);
		readiness.once("close", lose);
		readiness.once("error", lose);
	}
	return {
		status: () => {
			if (state !== "live" || !identity) return state;
			const current = inspect(identity.pid, platform);
			const nonceMatches = identity.kind !== "darwin-lstart-argv-nonce" || current?.sentinelNonce === identity.nonce;
			if (!current || current.pgid !== identity.pgid || current.kind !== identity.kind ||
				current.startToken !== identity.startToken || !nonceMatches) state = "lost";
			return state;
		},
	};
}

/**
 * Tracks process groups through an exact spawn-time sentinel. Once that witness
 * is lost, the numeric PGID is permanently retired and cannot become signal
 * authority again even if the kernel reuses it; the unresolved owner record is
 * retained so terminal shutdown fails closed.
 */
export function createForegroundShellGroupTracker(options: {
	platform?: NodeJS.Platform;
	graceMs?: number;
	deadlineMs?: number;
	pollMs?: number;
	ops?: Partial<ForegroundGroupOps>;
	onActiveChange?: (active: boolean) => void;
} = {}) {
	const enabled = (options.platform ?? process.platform) !== "win32";
	const graceMs = options.graceMs ?? FOREGROUND_GROUP_GRACE_MS;
	const deadlineMs = options.deadlineMs ?? FOREGROUND_GROUP_DRAIN_MS;
	const pollMs = options.pollMs ?? FOREGROUND_GROUP_POLL_MS;
	const ops = { ...defaultForegroundGroupOps(), ...options.ops };
	const groups = new Map<number, ForegroundGroup>();
	let drainPromise: Promise<void> | undefined;

	const notifyActiveChange = (wasActive: boolean) => {
		const isActive = groups.size > 0;
		if (wasActive !== isActive) options.onActiveChange?.(isActive);
	};

	const remove = (processGroupId: number) => {
		const wasActive = groups.size > 0;
		groups.delete(processGroupId);
		notifyActiveChange(wasActive);
	};

	const markFailure = (group: ForegroundGroup, reason: ForegroundGroupDrainFailureReason) => {
		group.failureReason ??= reason;
	};

	const observeLostWitness = (group: ForegroundGroup) => {
		// A successful group-wide SIGKILL followed by loss of the exact sentinel is
		// verified termination. In every other case witness loss destroys signal
		// authority but cannot prove that descendants released the group.
		if (group.killAttempt === "sent" && !group.failureReason) remove(group.processGroupId);
		else markFailure(group, "ownership-lost");
	};

	const signalOnce = (group: ForegroundGroup, signal: PosixGroupSignal) => {
		const status = group.witness.status();
		if (status !== "live") {
			markFailure(group, status === "pending" ? "ownership-never-established" : "ownership-lost");
			return;
		}
		const key = signal === "SIGTERM" ? "termAttempt" : "killAttempt";
		if (group[key] !== "not-attempted") return;
		try {
			ops.signal(group.processGroupId, signal);
			group[key] = "sent";
		} catch (error) {
			if (isNoSuchProcess(error)) {
				group[key] = "esrch";
				remove(group.processGroupId);
			} else {
				group[key] = "failed";
				markFailure(group, "signal-failed");
			}
		}
	};

	const waitForGroupUntil = async (group: ForegroundGroup, deadline: number) => {
		while (groups.get(group.processGroupId) === group) {
			if (group.witness.status() === "lost") {
				observeLostWitness(group);
				return;
			}
			const remaining = deadline - ops.now();
			if (remaining <= 0) return;
			await ops.sleep(Math.min(pollMs, remaining));
		}
	};

	const diagnosticFor = (group: ForegroundGroup, startedAt: number): ForegroundGroupDrainDiagnostic => {
		const finalWitnessStatus = group.witness.status();
		return {
			processGroupId: group.processGroupId,
			finalWitnessStatus,
			termAttempt: group.termAttempt,
			killAttempt: group.killAttempt,
			reason: group.failureReason ?? (finalWitnessStatus === "live"
				? "deadline-exceeded"
				: finalWitnessStatus === "pending"
					? "ownership-never-established"
					: "ownership-lost"),
			elapsedMs: Math.max(0, ops.now() - startedAt),
			deadlineMs,
		};
	};

	const finalizeGroup = (group: ForegroundGroup, terminateFirst: boolean): Promise<void> => {
		if (group.finalizePromise) return group.finalizePromise;
		// Defer the body one microtask so every competing exit/error/timeout/abort
		// path observes the stored promise before signaling can remove the record.
		group.finalizePromise = Promise.resolve().then(async () => {
			const startedAt = ops.now();
			const deadline = startedAt + deadlineMs;

			while (groups.get(group.processGroupId) === group && group.witness.status() === "pending") {
				const remaining = deadline - ops.now();
				if (remaining <= 0) break;
				await ops.sleep(Math.min(pollMs, remaining));
			}

			if (groups.get(group.processGroupId) !== group) return;
			const readyStatus = group.witness.status();
			if (readyStatus !== "live") {
				markFailure(group, readyStatus === "pending" ? "ownership-never-established" : "ownership-lost");
			} else if (terminateFirst) {
				signalOnce(group, "SIGTERM");
				if (groups.get(group.processGroupId) === group) {
					await waitForGroupUntil(group, Math.min(ops.now() + graceMs, deadline));
				}
			}

			if (groups.get(group.processGroupId) === group) signalOnce(group, "SIGKILL");
			if (groups.get(group.processGroupId) === group) await waitForGroupUntil(group, deadline);
			if (groups.get(group.processGroupId) === group) {
				const finalStatus = group.witness.status();
				if (finalStatus === "lost") observeLostWitness(group);
				else if (!group.failureReason) markFailure(group, finalStatus === "pending" ? "ownership-never-established" : "deadline-exceeded");
			}

			if (groups.get(group.processGroupId) === group || group.failureReason) {
				const diagnostic = diagnosticFor(group, startedAt);
				const error = new ForegroundShellGroupDrainError(diagnostic.elapsedMs, deadlineMs, [diagnostic]);
				try { ops.report(error.message); } catch { /* diagnostics must not replace the owner failure */ }
				throw error;
			}
		});
		return group.finalizePromise;
	};

	return {
		track(processGroupId: number | undefined, witness?: ForegroundGroupWitness): void {
			if (!enabled || !processGroupId || drainPromise) return;
			const wasActive = groups.size > 0;
			if (!groups.has(processGroupId)) {
				groups.set(processGroupId, {
					processGroupId,
					witness: witness ?? { status: () => "lost" },
					termAttempt: "not-attempted",
					killAttempt: "not-attempted",
				});
			}
			notifyActiveChange(wasActive);
		},
		finalizeRootExit(processGroupId: number | undefined): Promise<void> {
			if (!enabled || !processGroupId) return Promise.resolve();
			const group = groups.get(processGroupId);
			return group ? finalizeGroup(group, false) : Promise.resolve();
		},
		terminate(processGroupId: number | undefined): Promise<void> {
			if (!enabled || !processGroupId) return Promise.resolve();
			const group = groups.get(processGroupId);
			return group ? finalizeGroup(group, true) : Promise.resolve();
		},
		drain(): Promise<void> {
			if (!enabled || groups.size === 0) return Promise.resolve();
			if (drainPromise) return drainPromise;
			drainPromise = (async () => {
				const results = await Promise.allSettled([...groups.values()].map(group => finalizeGroup(group, true)));
				const failures = results
					.filter((result): result is PromiseRejectedResult => result.status === "rejected")
					.map(result => result.reason);
				if (failures.length === 0) return;
				if (failures.length === 1) throw failures[0];
				const diagnostics = failures.flatMap(failure =>
					failure instanceof ForegroundShellGroupDrainError ? failure.groups : []);
				if (diagnostics.length > 0) {
					throw new ForegroundShellGroupDrainError(
						Math.max(...diagnostics.map(diagnostic => diagnostic.elapsedMs)),
						deadlineMs,
						diagnostics,
					);
				}
				throw new AggregateError(failures, "Foreground process-group drain failed");
			})();
			return drainPromise;
		},
		get activeCount(): number {
			return groups.size;
		},
	};
}

function getShellConfig(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
		try { if (fs.existsSync(gitBash)) return { shell: gitBash, args: ["-c"] }; } catch { /* */ }
		return { shell: "cmd.exe", args: ["/c"] };
	}
	return { shell: "/bin/bash", args: ["-c"] };
}

function getShellEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	// Ensure color output is disabled for cleaner parsing
	env.NO_COLOR = "1";
	env.FORCE_COLOR = "0";
	return env;
}

function stripAnsiCodes(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function truncateTail(content: string): { content: string; truncated: boolean } {
	const lines = content.split("\n");
	if (lines.length <= MAX_LINES && content.length <= MAX_BYTES) {
		return { content, truncated: false };
	}
	// Take last MAX_LINES lines
	const tail = lines.slice(-MAX_LINES);
	let result = tail.join("\n");
	if (result.length > MAX_BYTES) {
		result = result.slice(-MAX_BYTES);
	}
	return { content: result, truncated: true };
}

function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			process.kill(-pid, "SIGTERM");
		}
	} catch { /* process may already be dead */ }
}

function getModelName(sessionId: string | undefined): string {
	if (!sessionId) return '';
	try {
		const stateDir = process.env.BOBBIT_DIR
			? path.join(process.env.BOBBIT_DIR, 'state')
			: path.join(homedir(), '.pi');
		return fs.readFileSync(path.join(stateDir, `model-name-${sessionId}.txt`), 'utf-8').trim();
	} catch { return ''; }
}

type BgSpawnFailure = {
	kind: "spawn";
	code: "ENOENT" | "EACCES" | "EPERM" | "UNKNOWN";
	message: string;
};

type BgProcessTerminalInfo = {
	terminalReason?: string | null;
	spawnFailure?: BgSpawnFailure | null;
};

/** Returns the server-sanitized start-failure detail without exposing a null exit code. */
function spawnFailureSummary(info: BgProcessTerminalInfo): string | null {
	if (info.terminalReason !== "spawn-failed") return null;
	const message = info.spawnFailure?.message?.trim();
	return message || "The process could not be started.";
}

function injectCoAuthorTrailer(command: string, sessionId: string | undefined): string {
	// Only match actual git commit commands
	const gitCommitPattern = /\bgit\s+commit\b/;
	if (!gitCommitPattern.test(command)) return command;

	// Don't add if already has Co-Authored-By trailer
	if (/--trailer\s+["']?Co-Authored/i.test(command)) return command;

	// Don't intercept merge commits, reverts, or cherry-picks (mechanical operations)
	if (/\bgit\s+(merge|revert|cherry-pick)\b/.test(command)) return command;

	// Build the trailer value — strip provider suffix like " (anthropic)" to keep it clean
	const modelName = getModelName(sessionId).replace(/\s*\([^)]*\)\s*$/, '');
	const author = modelName ? `Bobbit (${modelName})` : 'Bobbit';
	const trailer = `--trailer "Co-Authored-By: ${author} <bobbit@bobbit.ai>"`;

	// For chained commands (&&, ;, ||), find and modify each git commit portion
	return command.replace(
		/(\bgit\s+commit\b[^&|;]*)/g,
		(match) => {
			// Don't double-add if individual match already has --trailer
			if (match.includes('--trailer')) return match;
			return `${match.trimEnd()} ${trailer}`;
		}
	);
}

export default function (pi: ExtensionAPI) {
	// Foreground commands are separate POSIX process groups. Pi's RPC signal
	// handler owns the agent root but cannot see a group whose shell already
	// exited, so keep the exact spawn-time identities until their groups empty.
	let signalHandlersInstalled = false;
	let sessionShuttingDown = false;
	const signalHandlers = new Map<NodeJS.Signals, () => void>();
	const removeSignalHandlers = () => {
		if (!signalHandlersInstalled) return;
		for (const [signal, handler] of signalHandlers) process.off(signal, handler);
		signalHandlers.clear();
		signalHandlersInstalled = false;
	};
	const foregroundGroups = createForegroundShellGroupTracker({
		onActiveChange: active => {
			if (active) installSignalHandlers();
			else removeSignalHandlers();
		},
	});
	function installSignalHandlers(): void {
		if (signalHandlersInstalled || sessionShuttingDown || process.platform === "win32") return;
		signalHandlersInstalled = true;
		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			const handler = () => {
				const hasAnotherHandler = process.listenerCount(signal) > 1;
				const drained = foregroundGroups.drain();
				// RPC mode owns SIGTERM and awaits session_shutdown. For a signal Pi
				// does not own, restore Node's default disposition only after the
				// bounded drain so the agent cannot exit ahead of its shell groups.
				if (!hasAnotherHandler) {
					void drained.finally(() => {
						removeSignalHandlers();
						process.kill(process.pid, signal);
					}).catch(() => { /* the terminal signal owns process exit */ });
				} else {
					// Pi's RPC lifecycle awaits the same coalesced promise from
					// session_shutdown, where a drain failure must remain observable.
					void drained.catch(() => {});
				}
			};
			signalHandlers.set(signal, handler);
			process.on(signal, handler);
		}
	}

	const lifecyclePi = pi as ExtensionAPI & {
		on?: (event: "session_shutdown", handler: () => Promise<void>) => void;
	};
	lifecyclePi.on?.("session_shutdown", async () => {
		sessionShuttingDown = true;
		try {
			await foregroundGroups.drain();
		} finally {
			removeSignalHandlers();
		}
	});

	// ── Gateway config ────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	let token: string;
	let baseUrl: string;
	const envToken = process.env.BOBBIT_TOKEN;
	const envUrl = process.env.BOBBIT_GATEWAY_URL;
	if (envToken && envUrl) {
		token = envToken;
		baseUrl = envUrl.replace(/\/+$/, "");
	} else {
		try {
			const stateDir = process.env.BOBBIT_DIR
				? path.join(process.env.BOBBIT_DIR, "state")
				: path.join(homedir(), ".pi");
			const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
			token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
			baseUrl = fs.readFileSync(path.join(stateDir, "gateway-url"), "utf-8").trim().replace(/\/+$/, "");
		} catch {
			console.error("[bash-tool] Cannot read gateway credentials");
			token = "";
			baseUrl = "";
		}
	}

	async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
		const res = await fetch(`${baseUrl}${urlPath}`, {
			method,
			headers: {
				"Authorization": `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`API ${method} ${urlPath} failed (${res.status}): ${text}`);
		}
		return res.json();
	}

	// ── Custom bash tool ──────────────────────────────────────────

	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: "Run a bash command. Output truncated to last 2000 lines / 50KB.",
		parameters: Type.Object({
			command: Type.String(),
			timeout: Type.Optional(Type.Number({ description: "Seconds. Default 300." })),
			description: Type.Optional(Type.String({ description: "Short label (3-6 words); recommended for multi-line or non-obvious commands." })),
		}),
		async execute(_toolCallId, { command, timeout }, abortSignal, onUpdate) {
			return new Promise((resolve, reject) => {
				const timeoutSec = timeout ?? DEFAULT_TIMEOUT;
				const { shell, args } = getShellConfig();

				command = injectCoAuthorTrailer(command, sessionId);

				const posixSpawn = process.platform === "win32" ? undefined : foregroundShellSpawnSpec(shell, args, command);
				const child = spawn(posixSpawn?.file ?? shell, posixSpawn?.args ?? [...args, command], {
					detached: true,
					env: posixSpawn?.env ?? getShellEnv(),
					cwd: process.cwd(),
					stdio: posixSpawn?.stdio ?? ["ignore", "pipe", "pipe"],
				});
				const foregroundWitness = process.platform === "win32" || !child.pid || !posixSpawn
					? undefined
					: createForegroundGroupWitness(
						child.stdio[3] as NodeJS.ReadableStream | undefined,
						child.pid,
						posixSpawn.witnessNonce,
					);
				foregroundGroups.track(child.pid, foregroundWitness);

				const outputChunks: string[] = [];
				let outputBytes = 0;
				let tempFilePath: string | undefined;
				let tempFileStream: fs.WriteStream | undefined;
				let totalBytes = 0;
				let timedOut = false;
				let completionStarted = false;
				const abortedAtStart = abortSignal?.aborted === true;

				const handleData = (data: Buffer) => {
					totalBytes += data.length;
					const text = stripAnsiCodes(data.toString("utf-8")).replace(/\r/g, "");

					// Temp file for large output
					if (totalBytes > MAX_BYTES && !tempFilePath) {
						const id = randomBytes(8).toString("hex");
						tempFilePath = path.join(tmpdir(), `bobbit-bash-${id}.log`);
						tempFileStream = createWriteStream(tempFilePath);
						for (const chunk of outputChunks) tempFileStream.write(chunk);
					}
					if (tempFileStream) tempFileStream.write(text);

					outputChunks.push(text);
					outputBytes += text.length;
					while (outputBytes > MAX_BYTES * 2 && outputChunks.length > 1) {
						const removed = outputChunks.shift()!;
						outputBytes -= removed.length;
					}

					// Stream to agent UI
					if (onUpdate) onUpdate({ content: [{ type: "text" as const, text }], details: {} });
				};

				child.stdout?.on("data", handleData);
				child.stderr?.on("data", handleData);

				let timer: NodeJS.Timeout;
				const stopIo = () => {
					clearTimeout(timer);
					if (abortSignal) abortSignal.removeEventListener("abort", abortHandler);
					// Destroy inherited pipes after the root event; group finalization is the
					// independent authority that proves escaped descendants are gone.
					child.stdout?.destroy();
					child.stderr?.destroy();
					if (tempFileStream) tempFileStream.end();
				};

				const failFinalization = (error: unknown) => {
					if (completionStarted) return;
					completionStarted = true;
					stopIo();
					reject(error);
				};

				const terminateChildTree = () => {
					if (!child.pid) return;
					if (process.platform === "win32") {
						killProcessTree(child.pid);
					} else {
						void foregroundGroups.terminate(child.pid).catch(failFinalization);
					}
				};

				const abortHandler = () => {
					clearTimeout(timer);
					terminateChildTree();
				};

				const completeExit = async (code: number | null) => {
					if (completionStarted) return;
					completionStarted = true;
					stopIo();
					try {
						await foregroundGroups.finalizeRootExit(child.pid);
					} catch (error) {
						reject(error);
						return;
					}

					if (abortedAtStart) {
						resolve({ content: [{ type: "text" as const, text: "" }], details: { truncated: false } });
						return;
					}
					const fullOutput = outputChunks.join("");
					const { content, truncated } = truncateTail(fullOutput);
					const cancelled = code === null;

					let output = truncated ? content : fullOutput;
					if (timedOut) output += `\n[Command timed out after ${timeoutSec}s and was killed]`;
					if (truncated && tempFilePath) output += `\n[Output truncated. Full output saved to ${tempFilePath}]`;

					resolve({
						content: [{ type: "text" as const, text: `Exit code: ${cancelled ? "killed" : code}\n${output}` }],
						details: { truncated, fullOutputPath: tempFilePath },
					});
				};

				const completeSpawnError = async (err: Error) => {
					if (completionStarted) return;
					completionStarted = true;
					stopIo();
					try {
						await foregroundGroups.finalizeRootExit(child.pid);
					} catch (error) {
						reject(error);
						return;
					}
					resolve({
						content: [{ type: "text" as const, text: `Error spawning command: ${err.message}` }],
						details: {},
					});
				};

				// Use the root event for command output, but never publish it until the
				// exact POSIX group witness has been reaped (Windows remains Job-owned).
				child.on("exit", code => { void completeExit(code); });
				child.on("error", err => { void completeSpawnError(err); });

				timer = setTimeout(() => {
					timedOut = true;
					terminateChildTree();
				}, timeoutSec * 1000);

				if (abortSignal) {
					abortSignal.addEventListener("abort", abortHandler, { once: true });
					if (abortedAtStart) {
						abortHandler();
						// Preserve the pre-existing Windows fast path; its outer Job/task-tree
						// owner remains authoritative rather than the POSIX witness finalizer.
						if (process.platform === "win32") {
							completionStarted = true;
							stopIo();
							resolve({ content: [{ type: "text" as const, text: "" }], details: { truncated: false } });
						}
					}
				}
			});
		},
	});

	// ── bash_bg_create ────────────────────────────────────────────

	pi.registerTool({
		name: "bash_bg",
		label: "Background Process",
		description: "Manage background shell processes. bash_bg does not notify on completion. If you need to take follow up actions, use bash_bg wait",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("create"),
				Type.Literal("logs"),
				Type.Literal("grep"),
				Type.Literal("head"),
				Type.Literal("slice"),
				Type.Literal("kill"),
				Type.Literal("list"),
				Type.Literal("wait"),
			]),
			command: Type.Optional(Type.String({ description: "Shell command (create)." })),
			name: Type.Optional(Type.String({ description: "Short process name, max 3 words (create)." })),
			id: Type.Optional(Type.String({ description: "Background process ID." })),
			timeout: Type.Optional(Type.Number({ description: "Max seconds to wait. Default 300 (wait)." })),
			tail: Type.Optional(Type.Number({ description: "Lines from end. Default 15 (logs)." })),
			pattern: Type.Optional(Type.String({ description: "Search pattern, string or regex (grep)." })),
			context: Type.Optional(Type.Number({ description: "Lines of context around match. Default 0 (grep)." })),
			max_results: Type.Optional(Type.Number({ description: "Max matches. Default 50 (grep)." })),
			lines: Type.Optional(Type.Number({ description: "Number of lines. Default 50 (head)." })),
			from: Type.Optional(Type.Number({ description: "Start line, 1-indexed (slice)." })),
			to: Type.Optional(Type.Number({ description: "End line, inclusive (slice)." })),
		}),
		async execute(_toolCallId, { action, command, name, id, tail, timeout, pattern, context, max_results, lines, from, to }) {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

			if (!sessionId || !baseUrl) {
				return text("Error: Missing BOBBIT_SESSION_ID or gateway credentials");
			}

			try {
				// Helper: resolve process name for an id (used in headers for readability)
				const resolveProcessName = async (processId: string): Promise<string> => {
					try {
						const data = await api("GET", `/api/sessions/${sessionId}/bg-processes`) as any;
						const proc = (data.processes || []).find((p: any) => p.id === processId);
						return proc?.name || processId;
					} catch { return processId; }
				};

				// Format a header like "bg-12 (branch cleanup)" when a name exists
				const header = async (processId: string): Promise<string> => {
					const pName = await resolveProcessName(processId);
					return pName !== processId ? `${processId} (${pName})` : processId;
				};

				switch (action) {
					case "create": {
						if (!command) return text("Error: 'command' is required for create");
						if (!name) return text("Error: 'name' is required for create — provide a short descriptive name (max 3 words)");
						const result = await api("POST", `/api/sessions/${sessionId}/bg-processes`, { command, name }) as any;
						return text(`Background process started.\nID: ${result.id}\nPID: ${result.pid}\nCommand: ${command}\n\nbash_bg does not notify on completion. If you need to take follow up actions, use bash_bg wait.\nUse bash_bg with action "logs" and id "${result.id}" to check output.\nUse bash_bg with action "kill" and id "${result.id}" to terminate.`);
					}
					case "logs": {
						if (!id) return text("Error: 'id' is required for logs");
						const [logs, hdr] = await Promise.all([
							api("GET", `/api/sessions/${sessionId}/bg-processes/${id}/logs?tail=${tail ?? 15}`) as any,
							header(id),
						]);
						const output = logs.log?.map((e: any) => typeof e === "string" ? e : e.text ?? String(e)).join("\n") || "(no output)";
						return text(`Logs for ${hdr}:\n${output}`);
					}
					case "grep": {
						if (!id) return text("Error: 'id' is required for grep");
						if (!pattern) return text("Error: 'pattern' is required for grep");
						const params = new URLSearchParams({ pattern });
						if (context) params.set("context", String(context));
						if (max_results) params.set("max", String(max_results));
						const [grepResult, hdr] = await Promise.all([
							api("GET", `/api/sessions/${sessionId}/bg-processes/${id}/grep?${params}`) as any,
							header(id),
						]);
						if (grepResult.matches.length === 0) return text(`No matches for "${pattern}" in ${hdr} (${grepResult.total} total lines searched)`);
						const matchLines = grepResult.matches.map((m: any) => `${String(m.line).padStart(5)}  ${m.text}`).join("\n");
						return text(`${grepResult.total} match${grepResult.total !== 1 ? "es" : ""} for "${pattern}" in ${hdr}${grepResult.total > grepResult.matches.length ? ` (showing first ${grepResult.matches.length})` : ""}:\n${matchLines}`);
					}
					case "head": {
						if (!id) return text("Error: 'id' is required for head");
						const [headResult, hdr] = await Promise.all([
							api("GET", `/api/sessions/${sessionId}/bg-processes/${id}/head?lines=${lines || 50}`) as any,
							header(id),
						]);
						const headOutput = headResult.log?.map((e: any) => typeof e === "string" ? e : e.text ?? String(e)).join("\n") || "(no output)";
						return text(`First ${headResult.log?.length ?? 0} of ${headResult.totalLines} lines from ${hdr}:\n${headOutput}`);
					}
					case "slice": {
						if (!id) return text("Error: 'id' is required for slice");
						if (!from || !to) return text("Error: 'from' and 'to' are required for slice (1-indexed line numbers)");
						const [sliceResult, hdr] = await Promise.all([
							api("GET", `/api/sessions/${sessionId}/bg-processes/${id}/slice?from=${from}&to=${to}`) as any,
							header(id),
						]);
						const sliceOutput = sliceResult.log?.map((e: any, i: number) => `${String(from + i).padStart(5)}  ${typeof e === "string" ? e : e.text ?? String(e)}`).join("\n") || "(no output)";
						return text(`Lines ${from}-${to} of ${sliceResult.totalLines} from ${hdr}:\n${sliceOutput}`);
					}
					case "kill": {
						if (!id) return text("Error: 'id' is required for kill");
						const hdr = await header(id);
						await api("DELETE", `/api/sessions/${sessionId}/bg-processes/${id}`);
						return text(`Background process ${hdr} killed.`);
					}
					case "wait": {
						if (!id) return text("Error: 'id' is required for wait");
						const waitSec = timeout || 300;
						const [waitResult, hdr] = await Promise.all([
							api("GET", `/api/sessions/${sessionId}/bg-processes/${id}/wait?timeout=${waitSec}`) as any,
							header(id),
						]);
						const info = waitResult.info;
						if (waitResult.aborted) {
							return text(`Process ${hdr} wait interrupted by steer.\n\nThe user has new instructions for you. End your turn now WITHOUT generating further text or tool calls so the steered message can be processed. Do not summarise, do not acknowledge — just stop. The bg process is still running; you can resume monitoring with 'logs' or 'wait' after acting on the steer.`);
						}
						if (waitResult.timedOut) {
							return text(`Process ${hdr} still running after ${waitSec}s (pid=${info.pid}, status=${info.status}). Use "logs", "grep", or "kill" to manage it.`);
						}
						const failure = spawnFailureSummary(info);
						if (failure) {
							return text(`Process ${hdr} failed to start: ${failure}\nCheck its working directory or runtime configuration, then retry. Use "logs" for any available output.`);
						}
						return text(`Process ${hdr} exited with code ${info.exitCode}.\nUse bash_bg with action "grep" and id "${id}" to search output, or "logs" to see the tail.`);
					}
					case "list": {
						const data = await api("GET", `/api/sessions/${sessionId}/bg-processes`) as any;
						const procs = data.processes || [];
						if (procs.length === 0) return text("No background processes.");
						const lines = procs.map((p: any) => {
							const failure = spawnFailureSummary(p);
							const outcome = failure
								? "failed to start"
								: p.exitCode !== null ? `exit=${p.exitCode}` : "";
							const diagnostic = failure ? `: ${failure}` : "";
							return `${p.id} (${p.name || p.id}) [${failure ? "failed to start" : p.status}] pid=${p.pid} cmd="${p.command}"${outcome ? ` ${outcome}` : ""}${diagnostic}`;
						});
						return text(`Background processes:\n${lines.join("\n")}`);
					}
					default:
						return text(`Unknown action: ${action}`);
				}
			} catch (err: any) {
				return text(`Error: ${err.message}`);
			}
		},
	});
}
