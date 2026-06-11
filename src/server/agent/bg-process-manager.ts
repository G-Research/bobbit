/**
 * Background process manager — spawns and tracks long-running shell processes
 * per session, and (since the persistence rework) makes them survive a gateway
 * restart and re-attach to still-running processes.
 *
 * The crux (see `docs/design/persistent-bg-processes.md`): output and exit
 * status live in DURABLE FILES, not in-memory pipes, so a restarted gateway can
 * tail the same files and capture the real exit code. Each process redirects
 * stdout/stderr into transient per-stream SPOOLS (host files, or container-
 * internal for docker); the gateway tails the spools, interleaves them into the
 * capped in-memory `log[]`, and continuously rewrites a single durable COMBINED
 * projection `<bgId>.log` it owns exclusively (always a HOST file). Exit is
 * captured via a per-process STATUS file written by a shell wrapper / Node
 * helper. Metadata persists to `bg-processes.json` via {@link BgProcessStore}.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import { getShellConfig, GIT_BASH } from "./shell-util.js";
import type { BgProcessStore, PersistedBgProcess } from "./bg-process-store.js";
import { bgRunnerHelperPath } from "./bg-runner.js";

const MAX_LOG_LINES = 5000;
const MAX_LOG_BYTES = 512 * 1024; // 512KB per process (COMBINED across stdout+stderr)
/** Retained tail when a spool is trimmed by the gateway/ wrapper copytruncate. */
const KEEP_BYTES = MAX_LOG_BYTES;
/** Status-watcher poll interval. */
const STATUS_POLL_MS = 150;
/** Debounce for the durable combined-projection rewrite. */
const PROJECTION_DEBOUNCE_MS = 300;
/** Grace period after an explicit kill before we mark `terminalReason="killed"`. */
const KILL_GRACE_MS = 1500;
/** Container-internal base path for docker spool/status/pid source files. */
const CONTAINER_BG_ROOT = "/tmp/bobbit-bg";

// ── Injectable OS / docker surface (so unit tests need no real processes) ──

export interface BgEnv {
	/** host pid liveness — `process.kill(pid, 0)`. */
	isHostPidAlive(pid: number): boolean;
	/** kill the host process tree/group rooted at `processPid`. */
	killHostTree(processPid: number, signal: "SIGTERM" | "SIGKILL"): void;
	/** run a `docker ...` CLI command synchronously, capturing stdout. */
	dockerCli(argv: string[]): { code: number; stdout: string };
}

export const defaultEnv: BgEnv = {
	isHostPidAlive(pid: number): boolean {
		if (!pid || pid <= 0) return false;
		try { process.kill(pid, 0); return true; }
		catch (e: any) { return e?.code === "EPERM"; }
	},
	killHostTree(processPid: number, signal: "SIGTERM" | "SIGKILL"): void {
		if (!processPid || processPid <= 0) return;
		if (process.platform === "win32") {
			// taskkill /T takes the whole tree; always /F (only force form is reliable).
			try { spawnSync("taskkill", ["/pid", String(processPid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ignore */ }
		} else {
			try { process.kill(-processPid, signal); }
			catch { try { process.kill(processPid, signal); } catch { /* already dead */ } }
		}
	},
	dockerCli(argv: string[]): { code: number; stdout: string } {
		try {
			const r = spawnSync("docker", argv, { encoding: "utf-8", env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
			return { code: r.status ?? -1, stdout: r.stdout ?? "" };
		} catch {
			return { code: -1, stdout: "" };
		}
	},
};

// ── Spawn model ────────────────────────────────────────────────────────────

/** Paths + identity threaded into the spawned wrapper/helper. See design §4. */
export interface BgPaths {
	// HOST-owned, gateway-written — ALWAYS host for BOTH host and docker:
	logFile: string;        // durable COMBINED projection <bgId>.log
	statusSnapshot: string; // HOST <bgId>.status terminal snapshot
	// LIVE SOURCE — host spawns: host paths; docker spawns: "" (use container* below):
	outSpool: string;
	errSpool: string;
	pidFile: string;
	// LIVE SOURCE — docker spawns only, container-internal (/tmp/bobbit-bg/...):
	containerOutSpool?: string;
	containerErrSpool?: string;
	containerStatus?: string;
	containerPid?: string;
	/** per-spawn random token written into the pidfile (pid-reuse guard). */
	nonce: string;
	/** true => docker: live source is the container* paths. */
	inContainer: boolean;
}

/**
 * Function used to spawn the underlying child process. Injected via the
 * constructor so unit tests can supply a fake EventEmitter-backed child.
 */
export type SpawnFn = (command: string, cwd: string, containerId: string | undefined, paths: BgPaths) => ChildProcess;

/**
 * POSIX single-quote a string for safe interpolation into an `sh -c` script:
 * wrap in single quotes and replace each embedded `'` with `'\''`. Used for
 * EVERY interpolated path and the nonce so a project path containing a single
 * quote (legal on POSIX) cannot break out of the redirection/trimmer/status
 * commands. See review Fix 5.
 */
function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the POSIX host wrapper (Git Bash on Windows, `/bin/sh` elsewhere).
 * Isolated subshell `( <command> )` so a user `exit N` is contained and the
 * wrapper still captures the real `code=$?`; a wrapper-owned background trimmer
 * bounds both spools restart-independently; pidfile carries `$$` + nonce.
 */
export function buildHostWrapper(command: string, paths: BgPaths): string {
	return buildPosixWrapper(command, {
		outSpool: paths.outSpool,
		errSpool: paths.errSpool,
		status: paths.statusSnapshot,
		pid: paths.pidFile,
		nonce: paths.nonce,
		mkdir: false,
	});
}

/**
 * Build the docker wrapper — identical POSIX wrapper run inside the container,
 * with a leading `mkdir -p` for the container-internal source dir. Spawned
 * under `setsid` (added by the spawner) so `$$` is the process-group leader.
 */
export function buildDockerWrapper(command: string, paths: BgPaths): string {
	return buildPosixWrapper(command, {
		outSpool: paths.containerOutSpool!,
		errSpool: paths.containerErrSpool!,
		status: paths.containerStatus!,
		pid: paths.containerPid!,
		nonce: paths.nonce,
		mkdir: true,
	});
}

function buildPosixWrapper(
	command: string,
	o: { outSpool: string; errSpool: string; status: string; pid: string; nonce: string; mkdir: boolean },
): string {
	const lines: string[] = [];
	const qOut = shQuote(o.outSpool);
	const qErr = shQuote(o.errSpool);
	if (o.mkdir) lines.push(`mkdir -p ${shQuote(path.posix.dirname(o.outSpool))}`);
	lines.push(`printf '%s\\n%s\\n' "$$" ${shQuote(o.nonce)} > ${shQuote(o.pid)}`);
	// wrapper-owned trimmer: bounds each spool to KEEP_BYTES, restart-independent.
	lines.push(
		`( while kill -0 "$$" 2>/dev/null; do ` +
		`for f in ${qOut} ${qErr}; do ` +
		`if [ -f "$f" ] && [ "$(wc -c < "$f" 2>/dev/null || echo 0)" -gt ${MAX_LOG_BYTES} ]; then ` +
		`tail -c ${KEEP_BYTES} "$f" > "$f.trim" 2>/dev/null && cat "$f.trim" > "$f" && rm -f "$f.trim"; ` +
		`fi; done; sleep 5; done ) &`,
	);
	lines.push(`trimmer=$!`);
	// isolated subshell so user `exit N` only exits the subshell.
	lines.push(`( ${command} ) >> ${qOut} 2>> ${qErr}`);
	lines.push(`code=$?`);
	lines.push(`kill "$trimmer" 2>/dev/null`);
	// Final SYNCHRONOUS trim (Fix 1): a fast chatty burst can exit before the 5s
	// trimmer pass, leaving the spool over cap until restart. Trim each spool to
	// KEEP_BYTES in place (same-inode copytruncate, never mv) BEFORE the status
	// write so the on-disk spool is bounded the instant the command finishes.
	lines.push(
		`for f in ${qOut} ${qErr}; do ` +
		`tail -c ${KEEP_BYTES} "$f" > "$f.trim" 2>/dev/null && cat "$f.trim" > "$f" && rm -f "$f.trim"; done`,
	);
	lines.push(`printf '%s\\n' "$code" > ${shQuote(o.status)}`);
	lines.push(`exit "$code"`);
	return lines.join("\n");
}

/** Default production spawner: POSIX wrapper, Node helper, or docker setsid wrapper. */
function defaultSpawn(command: string, cwd: string, containerId: string | undefined, paths: BgPaths): ChildProcess {
	if (containerId) {
		const wrapper = buildDockerWrapper(command, paths);
		return spawn("docker", ["exec", "-w", cwd, containerId, "setsid", "/bin/sh", "-c", wrapper], {
			stdio: ["ignore", "ignore", "ignore"],
			detached: false,
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
	}
	const { shell, args } = getShellConfig();
	const isPosix = process.platform !== "win32" || !!GIT_BASH;
	if (isPosix) {
		const wrapper = buildHostWrapper(command, paths);
		return spawn(shell, [...args, wrapper], {
			cwd,
			stdio: ["ignore", "ignore", "ignore"],
			detached: true,
			env: process.env,
		});
	}
	// Windows without Git Bash: detached Node bg-runner helper (full parity).
	return spawn(process.execPath, [
		bgRunnerHelperPath(),
		"--shell", shell,
		"--shell-args", JSON.stringify(args),
		"--command", command,
		"--out", paths.outSpool,
		"--err", paths.errSpool,
		"--status", paths.statusSnapshot,
		"--pid", paths.pidFile,
		"--nonce", paths.nonce,
		"--max-bytes", String(MAX_LOG_BYTES),
	], {
		cwd,
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
		env: process.env,
	});
}

// ── Tailer abstraction ───────────────────────────────────────────────────────

export interface Tailer {
	start(startOffset: number): void;
	stop(): void;
}
export interface TailerSpec {
	outSpool: string;
	errSpool: string;
	inContainer: boolean;
	containerId?: string;
	onChunk: (stream: "stdout" | "stderr", text: string, newOffset: number) => void;
}
export type TailerFactory = (spec: TailerSpec) => { out: Tailer; err: Tailer };

/** Default host poll tailer (200ms) with §6.2 truncation/offset-rebase + gateway copytruncate. */
export class PollTailer implements Tailer {
	private offset = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	constructor(
		private readonly file: string,
		private readonly stream: "stdout" | "stderr",
		private readonly onChunk: (stream: "stdout" | "stderr", text: string, newOffset: number) => void,
	) {}
	start(startOffset: number): void {
		this.offset = startOffset;
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), 200);
		if (typeof (this.timer as any).unref === "function") (this.timer as any).unref();
	}
	private tick(): void {
		let size: number;
		try { size = fs.statSync(this.file).size; } catch { return; /* ENOENT → not yet created */ }
		if (size < this.offset) this.offset = 0; // §6.2 rebase after copytruncate
		if (size > this.offset) {
			try {
				const fd = fs.openSync(this.file, "r");
				try {
					// Bounded read (Fix 2): never allocate more than the cap per tick.
					// A high-volume burst could otherwise exhaust gateway memory (a
					// sandboxed command DoSing the host). If the delta exceeds the cap,
					// seek to `size - cap` (older bytes are beyond the retained window)
					// and read only the last cap bytes, advancing the offset to size.
					let from = this.offset;
					if (size - from > MAX_LOG_BYTES) from = size - MAX_LOG_BYTES;
					const len = size - from;
					const buf = Buffer.alloc(len);
					const read = fs.readSync(fd, buf, 0, len, from);
					this.offset = from + read;
					if (read > 0) this.onChunk(this.stream, buf.subarray(0, read).toString("utf-8"), this.offset);
				} finally { fs.closeSync(fd); }
			} catch { /* transient */ }
		}
		// Gateway secondary copytruncate once consumed and over cap.
		if (size > MAX_LOG_BYTES && this.offset >= size) {
			try { fs.truncateSync(this.file, 0); this.offset = 0; } catch { /* ignore */ }
		}
	}
	stop(): void {
		if (this.timer) { clearInterval(this.timer); this.timer = null; }
	}
}

/** Default docker tailer: `docker exec <cid> tail -c +<off+1> -F <spool>`. */
class DockerTailer implements Tailer {
	private offset = 0;
	private child: ChildProcess | null = null;
	constructor(
		private readonly spool: string,
		private readonly containerId: string,
		private readonly stream: "stdout" | "stderr",
		private readonly onChunk: (stream: "stdout" | "stderr", text: string, newOffset: number) => void,
	) {}
	start(startOffset: number): void {
		this.offset = startOffset;
		// Probe size for §6.2 rebase before following.
		try {
			const r = spawnSync("docker", ["exec", this.containerId, "sh", "-c", `wc -c < ${shQuote(this.spool)} 2>/dev/null || echo 0`], { encoding: "utf-8" });
			const size = parseInt((r.stdout || "0").trim(), 10) || 0;
			if (size < this.offset) this.offset = 0;
		} catch { /* ignore */ }
		this.child = spawn("docker", ["exec", this.containerId, "tail", "-c", `+${this.offset + 1}`, "-F", this.spool], {
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
		this.child.stdout?.on("data", (c: Buffer) => {
			this.offset += c.length;
			this.onChunk(this.stream, c.toString("utf-8"), this.offset);
		});
	}
	stop(): void {
		if (this.child) { try { this.child.kill("SIGTERM"); } catch { /* ignore */ } this.child = null; }
	}
}

/**
 * Serialised on-disk BYTE size of one projection line: "<ts>\t<tag(3)>\t<text>\n".
 * Uses {@link Buffer.byteLength} for the text (Fix 3) so multibyte output cannot
 * blow past the 512KB BYTE cap (JS string `.length` counts UTF-16 code units).
 * `ts` is ASCII digits; `\t<tag(3)>\t` is 5 ASCII bytes; trailing `\n` is 1.
 */
function projectedLineSize(ts: number, text: string): number {
	return String(ts).length + 5 + Buffer.byteLength(text, "utf8") + 1;
}

const defaultTailerFactory: TailerFactory = (spec: TailerSpec) => {
	if (spec.inContainer && spec.containerId) {
		return {
			out: new DockerTailer(spec.outSpool, spec.containerId, "stdout", spec.onChunk),
			err: new DockerTailer(spec.errSpool, spec.containerId, "stderr", spec.onChunk),
		};
	}
	return {
		out: new PollTailer(spec.outSpool, "stdout", spec.onChunk),
		err: new PollTailer(spec.errSpool, "stderr", spec.onChunk),
	};
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface LogEntry {
	ts: number;
	text: string;
	/** which stream produced the line — needed to serialise the combined projection */
	stream?: "stdout" | "stderr";
}

export type TerminalReason = "normal" | "killed" | "unrecoverable" | null;

export interface BgProcess {
	id: string;
	name: string;
	command: string;
	/** host child.pid (docker: the docker-exec handle; invalid after restart) */
	hostPid: number;
	/** signalable wrapper pid (host: child.pid; docker: in-container pid). 0 = pending. */
	processPid: number;
	nonce: string;
	child: ChildProcess | null;
	stdout: string[];
	stderr: string[];
	log: LogEntry[];
	status: "running" | "exited" | "unrecoverable";
	exitCode: number | null;
	terminalReason: TerminalReason;
	startTime: number;
	endTime: number | null;
	cwd: string;
	containerId?: string;
	paths: BgPaths;
	outOffset: number;
	errOffset: number;
	exited: Promise<void>;
	// runtime-only
	_resolveExited: () => void;
	_logBytes: number;
	_tailers: { out: Tailer; err: Tailer } | null;
	_statusTimer: ReturnType<typeof setInterval> | null;
	_projectionTimer: ReturnType<typeof setTimeout> | null;
	_killIntent: number | null;
	_killEscalate: ReturnType<typeof setTimeout> | null;
}

export interface BgProcessInfo {
	id: string;
	name: string;
	command: string;
	pid: number;
	status: "running" | "exited" | "unrecoverable";
	exitCode: number | null;
	terminalReason: TerminalReason;
	startTime: number;
	endTime: number | null;
}

export class BgProcessManager {
	private processes = new Map<string, Map<string, BgProcess>>();
	private clientsProvider: (sessionId: string) => Set<WebSocket> | undefined;
	private waits = new Map<string, Set<AbortController>>();
	private nextId = 1;
	private spawnFn: SpawnFn;
	private storeProvider: (sessionId: string) => BgProcessStore | undefined;
	private tailerFactory: TailerFactory;
	private env: BgEnv;

	constructor(
		clientsProvider: (sessionId: string) => Set<WebSocket> | undefined,
		spawnFn: SpawnFn = defaultSpawn,
		storeProvider: (sessionId: string) => BgProcessStore | undefined = () => undefined,
		tailerFactory: TailerFactory = defaultTailerFactory,
		env: BgEnv = defaultEnv,
	) {
		this.clientsProvider = clientsProvider;
		this.spawnFn = spawnFn;
		this.storeProvider = storeProvider;
		this.tailerFactory = tailerFactory;
		this.env = env;
	}

	private store(sessionId: string): BgProcessStore | undefined {
		return this.storeProvider(sessionId);
	}

	private broadcast(sessionId: string, msg: ServerMessage): void {
		const clients = this.clientsProvider(sessionId);
		if (!clients) return;
		const data = JSON.stringify(msg);
		for (const client of clients) {
			if (client.readyState === 1) client.send(data);
		}
	}

	// ── create ────────────────────────────────────────────────────────────────

	create(sessionId: string, command: string, cwd: string, containerId?: string, sandboxed?: boolean, name?: string): BgProcessInfo {
		if (sandboxed && !containerId) {
			throw new Error("Sandboxed session without containerId — refusing host-side execution");
		}
		const id = `bg-${this.nextId++}`;
		const store = this.store(sessionId);
		const paths = this.computePaths(sessionId, id, containerId, store);
		try { fs.mkdirSync(path.dirname(paths.logFile), { recursive: true }); } catch { /* ignore */ }

		const child = this.spawnFn(command, cwd, containerId, paths);
		if (!containerId && typeof child.unref === "function") child.unref();

		let resolveExited!: () => void;
		const exited = new Promise<void>((res) => { resolveExited = res; });

		const hostPid = child.pid ?? 0;
		const bg: BgProcess = {
			id, name: name || id, command,
			hostPid,
			processPid: containerId ? 0 : hostPid, // docker resolved async below
			nonce: paths.nonce,
			child,
			stdout: [], stderr: [], log: [],
			status: "running", exitCode: null, terminalReason: null,
			startTime: Date.now(), endTime: null,
			cwd, containerId, paths,
			outOffset: 0, errOffset: 0,
			exited, _resolveExited: resolveExited, _logBytes: 0,
			_tailers: null, _statusTimer: null, _projectionTimer: null,
			_killIntent: null, _killEscalate: null,
		};

		if (!this.processes.has(sessionId)) this.processes.set(sessionId, new Map());
		this.processes.get(sessionId)!.set(id, bg);

		// Persist (recovery-critical → synchronous put) BEFORE broadcasting created.
		store?.put(this.toPersisted(sessionId, bg));

		// `exit` event is only a HINT to check the status file promptly.
		child.on?.("exit", () => { this.checkStatus(sessionId, bg); });

		this.startTailers(sessionId, bg);
		this.startStatusWatcher(sessionId, bg);

		// Resolve the in-container processPid asynchronously (docker only).
		if (containerId) this.resolveDockerProcessPid(sessionId, bg);

		this.broadcast(sessionId, { type: "bg_process_created", process: this.toInfo(bg) } as any);
		return this.toInfo(bg);
	}

	private computePaths(sessionId: string, id: string, containerId: string | undefined, store: BgProcessStore | undefined): BgPaths {
		const dir = store ? store.filesDir(sessionId) : path.join(process.cwd(), ".bobbit", "state", "bg-processes", sessionId);
		const nonce = randomUUID();
		const logFile = path.join(dir, `${id}.log`);
		const statusSnapshot = path.join(dir, `${id}.status`);
		if (containerId) {
			const cdir = `${CONTAINER_BG_ROOT}/${sessionId}`;
			return {
				logFile, statusSnapshot,
				outSpool: "", errSpool: "", pidFile: "",
				containerOutSpool: `${cdir}/${id}.out.spool`,
				containerErrSpool: `${cdir}/${id}.err.spool`,
				containerStatus: `${cdir}/${id}.status`,
				containerPid: `${cdir}/${id}.pid`,
				nonce, inContainer: true,
			};
		}
		return {
			logFile, statusSnapshot,
			outSpool: path.join(dir, `${id}.out.spool`),
			errSpool: path.join(dir, `${id}.err.spool`),
			pidFile: path.join(dir, `${id}.pid`),
			nonce, inContainer: false,
		};
	}

	private resolveDockerProcessPid(sessionId: string, bg: BgProcess, attempt = 0): void {
		if (bg.status !== "running" || !bg.containerId) return;
		const parsed = this.readPidFile(bg);
		if (parsed && parsed.nonce === bg.nonce && parsed.pid > 0) {
			bg.processPid = parsed.pid;
			this.store(sessionId)?.update(sessionId, bg.id, { processPid: parsed.pid });
			return;
		}
		if (attempt >= 50) return; // ~5s of retries
		const t = setTimeout(() => this.resolveDockerProcessPid(sessionId, bg, attempt + 1), 100);
		if (typeof (t as any).unref === "function") (t as any).unref();
	}

	// ── tailing + projection ────────────────────────────────────────────────────

	private startTailers(sessionId: string, bg: BgProcess): void {
		const spec: TailerSpec = {
			outSpool: bg.paths.inContainer ? bg.paths.containerOutSpool! : bg.paths.outSpool,
			errSpool: bg.paths.inContainer ? bg.paths.containerErrSpool! : bg.paths.errSpool,
			inContainer: bg.paths.inContainer,
			containerId: bg.containerId,
			onChunk: (stream, text, newOffset) => this.onChunk(sessionId, bg, stream, text, newOffset),
		};
		bg._tailers = this.tailerFactory(spec);
		bg._tailers.out.start(bg.outOffset);
		bg._tailers.err.start(bg.errOffset);
	}

	private onChunk(sessionId: string, bg: BgProcess, stream: "stdout" | "stderr", text: string, newOffset: number): void {
		if (stream === "stdout") bg.outOffset = newOffset; else bg.errOffset = newOffset;
		const ts = Date.now();
		const lines = text.split("\n");
		for (const line of lines) {
			if (line.length > 0) this.appendLog(bg, stream, line, ts);
		}
		const arr = stream === "stdout" ? bg.stdout : bg.stderr;
		for (const line of lines) if (line.length > 0) arr.push(line);
		while (arr.length > MAX_LOG_LINES) arr.shift();

		this.broadcast(sessionId, { type: "bg_process_output", processId: bg.id, stream, text, ts } as any);
		this.scheduleProjection(bg);
		this.store(sessionId)?.update(sessionId, bg.id, { outOffset: bg.outOffset, errOffset: bg.errOffset });
	}

	private appendLog(bg: BgProcess, stream: "stdout" | "stderr", line: string, ts: number): void {
		bg.log.push({ ts, text: line, stream });
		// Count the SERIALISED line size ("<ts>\t<tag>\t<text>\n") so the durable
		// combined projection — not just the raw text — stays within the cap.
		bg._logBytes += projectedLineSize(ts, line);
		while (bg.log.length > MAX_LOG_LINES || bg._logBytes > MAX_LOG_BYTES) {
			const removed = bg.log.shift();
			if (removed) bg._logBytes -= projectedLineSize(removed.ts, removed.text);
		}
	}

	private scheduleProjection(bg: BgProcess): void {
		if (bg._projectionTimer) return;
		const t = setTimeout(() => { bg._projectionTimer = null; this.writeProjection(bg); }, PROJECTION_DEBOUNCE_MS);
		if (typeof (t as any).unref === "function") (t as any).unref();
		bg._projectionTimer = t;
	}

	/** Atomic (tmp+rename) full rewrite of the durable combined projection from the capped buffer. */
	private writeProjection(bg: BgProcess): void {
		try {
			fs.mkdirSync(path.dirname(bg.paths.logFile), { recursive: true });
			const body = bg.log.map(e => `${e.ts}\t${e.stream === "stderr" ? "err" : "out"}\t${e.text}`).join("\n");
			const tmp = `${bg.paths.logFile}.tmp`;
			fs.writeFileSync(tmp, body, "utf-8");
			fs.renameSync(tmp, bg.paths.logFile);
		} catch { /* best-effort */ }
	}

	private loadProjection(bg: BgProcess): void {
		let raw: string;
		try { raw = fs.readFileSync(bg.paths.logFile, "utf-8"); } catch { return; }
		bg.log = []; bg.stdout = []; bg.stderr = []; bg._logBytes = 0;
		for (const line of raw.split("\n")) {
			if (!line) continue;
			const t1 = line.indexOf("\t");
			const t2 = line.indexOf("\t", t1 + 1);
			if (t1 < 0 || t2 < 0) continue;
			const ts = parseInt(line.slice(0, t1), 10) || Date.now();
			const tag = line.slice(t1 + 1, t2);
			const text = line.slice(t2 + 1);
			const stream: "stdout" | "stderr" = tag === "err" ? "stderr" : "stdout";
			this.appendLog(bg, stream, text, ts);
			(stream === "stdout" ? bg.stdout : bg.stderr).push(text);
		}
		while (bg.stdout.length > MAX_LOG_LINES) bg.stdout.shift();
		while (bg.stderr.length > MAX_LOG_LINES) bg.stderr.shift();
	}

	// ── status watcher + exit reconciliation ─────────────────────────────────────

	private startStatusWatcher(sessionId: string, bg: BgProcess): void {
		if (bg._statusTimer) return;
		const t = setInterval(() => this.checkStatus(sessionId, bg), STATUS_POLL_MS);
		if (typeof (t as any).unref === "function") (t as any).unref();
		bg._statusTimer = t;
	}

	/** Poll the status file; reconcile exit (normal) or detect a killed-without-status terminal state. */
	private checkStatus(sessionId: string, bg: BgProcess): void {
		if (bg.status !== "running") return;
		const status = this.readStatus(bg);
		if (status != null) {
			const m = status.trim().match(/^-?\d+$/);
			if (m) { this.reconcileExit(sessionId, bg, parseInt(m[0], 10), "normal"); return; }
		}
		if (bg._killIntent != null) {
			const alive = bg.paths.inContainer ? this.isContainerProcAlive(bg) : this.env.isHostPidAlive(bg.processPid);
			if (!alive || Date.now() - bg._killIntent > KILL_GRACE_MS) {
				this.reconcileExit(sessionId, bg, null, "killed");
			}
		}
	}

	private reconcileExit(sessionId: string, bg: BgProcess, exitCode: number | null, reason: Exclude<TerminalReason, null>): void {
		if (bg.status !== "running") return;
		// Final flush of any remaining spool bytes → projection.
		this.finalFlush(bg);
		if (bg.paths.inContainer && exitCode != null) this.mirrorStatusSnapshot(bg, exitCode);
		bg.status = reason === "unrecoverable" ? "unrecoverable" : "exited";
		bg.exitCode = exitCode;
		bg.terminalReason = reason;
		bg.endTime = Date.now();
		this.stopTimers(bg);
		this.writeProjection(bg);
		this.store(sessionId)?.update(sessionId, bg.id, {
			status: bg.status, exitCode: bg.exitCode, terminalReason: bg.terminalReason, endTime: bg.endTime,
		});
		bg._resolveExited();
		this.broadcast(sessionId, {
			type: "bg_process_exited", processId: bg.id, exitCode: bg.exitCode, endTime: bg.endTime, terminalReason: bg.terminalReason,
		} as any);
		// Delete the now-consumed spools (durable projection + status snapshot survive).
		this.deleteSpools(bg);
	}

	private finalFlush(bg: BgProcess): void {
		// Read any remaining spool bytes past the offset and project them.
		for (const stream of ["stdout", "stderr"] as const) {
			const tail = this.readSpoolFrom(bg, stream, stream === "stdout" ? bg.outOffset : bg.errOffset);
			if (tail && tail.text) {
				const ts = Date.now();
				for (const line of tail.text.split("\n")) {
					if (line.length > 0) {
						this.appendLog(bg, stream, line, ts);
						(stream === "stdout" ? bg.stdout : bg.stderr).push(line);
					}
				}
				if (stream === "stdout") bg.outOffset = tail.newOffset; else bg.errOffset = tail.newOffset;
			}
		}
	}

	private stopTimers(bg: BgProcess): void {
		if (bg._tailers) { try { bg._tailers.out.stop(); bg._tailers.err.stop(); } catch { /* ignore */ } bg._tailers = null; }
		if (bg._statusTimer) { clearInterval(bg._statusTimer); bg._statusTimer = null; }
		if (bg._projectionTimer) { clearTimeout(bg._projectionTimer); bg._projectionTimer = null; }
		if (bg._killEscalate) { clearTimeout(bg._killEscalate); bg._killEscalate = null; }
	}

	// ── file readers (host fs / docker exec) ──────────────────────────────────────

	private readStatus(bg: BgProcess): string | null {
		// Host snapshot first (mirrored for docker; written directly for host).
		try {
			const s = fs.readFileSync(bg.paths.statusSnapshot, "utf-8");
			if (s.trim().length > 0) return s;
		} catch { /* not present */ }
		if (bg.paths.inContainer && bg.containerId) {
			const r = this.env.dockerCli(["exec", bg.containerId, "cat", bg.paths.containerStatus!]);
			if (r.code === 0 && r.stdout.trim().length > 0) return r.stdout;
		}
		return null;
	}

	private readPidFile(bg: BgProcess): { pid: number; nonce: string } | null {
		let content: string | null = null;
		if (bg.paths.inContainer && bg.containerId) {
			const r = this.env.dockerCli(["exec", bg.containerId, "cat", bg.paths.containerPid!]);
			if (r.code === 0) content = r.stdout;
		} else {
			try { content = fs.readFileSync(bg.paths.pidFile, "utf-8"); } catch { /* none */ }
		}
		if (!content) return null;
		const parts = content.split("\n").map(s => s.trim()).filter(s => s.length > 0);
		if (parts.length < 1) return null;
		const pid = parseInt(parts[0], 10);
		if (!Number.isFinite(pid)) return null;
		return { pid, nonce: parts[1] ?? "" };
	}

	private readSpoolFrom(bg: BgProcess, stream: "stdout" | "stderr", fromOffset: number): { text: string; newOffset: number } | null {
		if (bg.paths.inContainer && bg.containerId) {
			const spool = stream === "stdout" ? bg.paths.containerOutSpool! : bg.paths.containerErrSpool!;
			const sz = this.env.dockerCli(["exec", bg.containerId, "sh", "-c", `wc -c < ${shQuote(spool)} 2>/dev/null || echo 0`]);
			// docker exec itself failing (non-zero) means the container is gone /
			// unreadable → null so restore falls back to the host projection (Fix 4).
			if (sz.code !== 0) return null;
			const size = parseInt((sz.stdout || "0").trim(), 10) || 0;
			let off = fromOffset;
			if (size < off) off = 0; // §6.2 rebase
			if (size <= off) return { text: "", newOffset: size };
			// Bounded read (Fix 2): never pull an unbounded `tail -c +<off>` payload
			// through spawnSync. Read at most the last cap bytes; `tail -c <want>`
			// returns exactly the delta when it is ≤cap, else skips older bytes.
			const want = Math.min(size - off, MAX_LOG_BYTES);
			const r = this.env.dockerCli(["exec", bg.containerId, "sh", "-c", `tail -c ${want} ${shQuote(spool)} 2>/dev/null`]);
			return { text: r.code === 0 ? r.stdout : "", newOffset: size };
		}
		const file = stream === "stdout" ? bg.paths.outSpool : bg.paths.errSpool;
		let size: number;
		try { size = fs.statSync(file).size; } catch { return null; }
		let off = fromOffset;
		if (size < off) off = 0; // §6.2 rebase
		if (size <= off) return { text: "", newOffset: size };
		// Bounded read (Fix 2): cap the allocation at MAX_LOG_BYTES; skip older
		// bytes beyond the retained window and advance the offset to size.
		if (size - off > MAX_LOG_BYTES) off = size - MAX_LOG_BYTES;
		try {
			const fd = fs.openSync(file, "r");
			try {
				const len = size - off;
				const buf = Buffer.alloc(len);
				const read = fs.readSync(fd, buf, 0, len, off);
				return { text: buf.subarray(0, read).toString("utf-8"), newOffset: off + read };
			} finally { fs.closeSync(fd); }
		} catch { return null; }
	}

	private isContainerProcAlive(bg: BgProcess): boolean {
		if (!bg.containerId || bg.processPid <= 0) return false;
		const running = this.env.dockerCli(["inspect", "-f", "{{.State.Running}}", bg.containerId]);
		if (running.code !== 0 || running.stdout.trim() !== "true") return false;
		const k = this.env.dockerCli(["exec", bg.containerId, "kill", "-0", String(bg.processPid)]);
		return k.code === 0;
	}

	private mirrorStatusSnapshot(bg: BgProcess, exitCode: number): void {
		try {
			fs.mkdirSync(path.dirname(bg.paths.statusSnapshot), { recursive: true });
			const tmp = `${bg.paths.statusSnapshot}.tmp`;
			fs.writeFileSync(tmp, `${exitCode}\n`, "utf-8");
			fs.renameSync(tmp, bg.paths.statusSnapshot);
		} catch { /* best-effort */ }
	}

	private deleteSpools(bg: BgProcess): void {
		if (bg.paths.inContainer) {
			if (bg.containerId) {
				this.env.dockerCli(["exec", bg.containerId, "rm", "-f",
					bg.paths.containerOutSpool!, bg.paths.containerErrSpool!]);
			}
		} else {
			for (const f of [bg.paths.outSpool, bg.paths.errSpool]) {
				try { fs.unlinkSync(f); } catch { /* already gone */ }
			}
		}
	}

	// ── restore + re-attach (§7) ─────────────────────────────────────────────────

	async restoreSession(sessionId: string): Promise<void> {
		const store = this.store(sessionId);
		if (!store) return;
		const records = store.getForSession(sessionId);
		if (records.length === 0) return;
		if (!this.processes.has(sessionId)) this.processes.set(sessionId, new Map());
		// Keep the id sequence ahead of any restored ids.
		for (const rec of records) {
			const n = parseInt(rec.id.replace(/^bg-/, ""), 10);
			if (Number.isFinite(n) && n >= this.nextId) this.nextId = n + 1;
		}
		for (const rec of records) {
			try { await this.restoreOne(sessionId, rec); }
			catch (err) { console.warn(`[bg-process] restore failed for ${rec.id}:`, err); }
		}
	}

	private async restoreOne(sessionId: string, rec: PersistedBgProcess): Promise<void> {
		const bg = this.rehydrate(rec);
		this.processes.get(sessionId)!.set(rec.id, bg);

		if (rec.status === "exited" || rec.status === "unrecoverable") {
			// Terminal already — the durable projection is the sole output source
			// (spools were deleted on exit). Client re-fetches via GET on reconnect.
			this.loadProjection(bg);
			return;
		}

		// status === "running": reconcile.
		const status = this.readStatus(bg);
		const statusMatch = status?.trim().match(/^-?\d+$/);
		if (statusMatch) {
			// COMPLETED during downtime — real code available. Rebuild output from the
			// final spool (projection fallback), then reconcile with the real code.
			this.restoreLoadOutput(bg);
			this.reconcileExit(sessionId, bg, parseInt(statusMatch[0], 10), "normal");
			return;
		}

		const alive = bg.paths.inContainer ? this.isContainerProcAlive(bg) : this.env.isHostPidAlive(bg.processPid);
		if (alive) {
			// Pid-reuse guard: re-read pidfile nonce.
			const pf = this.readPidFile(bg);
			if (pf && pf.nonce === bg.nonce) {
				// ALIVE → re-attach. Rebuild the buffer from a SINGLE source (Fix 4) to
				// avoid duplicating overlapping lines, then resume tailing + watcher.
				this.restoreLoadOutput(bg);
				this.writeProjection(bg);
				this.store(sessionId)?.update(sessionId, bg.id, { outOffset: bg.outOffset, errOffset: bg.errOffset });
				this.startTailers(sessionId, bg);
				this.startStatusWatcher(sessionId, bg);
				return;
			}
			// pid reused / foreign — UNRECOVERABLE (never fabricate a code); keep retained projection.
			this.loadProjection(bg);
			this.markUnrecoverable(sessionId, bg);
			return;
		}
		// Not alive AND no status anywhere → UNRECOVERABLE; keep retained projection.
		this.loadProjection(bg);
		this.markUnrecoverable(sessionId, bg);
	}

	/**
	 * Rebuild the in-memory buffer from a SINGLE source on restore (Fix 4) so
	 * already-retained lines are never duplicated. PREFER the bounded spool tail
	 * (it holds retained + any downtime output, ≤cap) read whole from offset 0
	 * (we rebuild from scratch); FALL BACK to the host projection only when the
	 * spool is gone/unreadable (container recreated, completed-during-downtime
	 * with spools deleted). Never loads both.
	 */
	private restoreLoadOutput(bg: BgProcess): void {
		const tails: Partial<Record<"stdout" | "stderr", { text: string; newOffset: number }>> = {};
		let anyReadable = false;
		for (const stream of ["stdout", "stderr"] as const) {
			const tail = this.readSpoolFrom(bg, stream, 0);
			if (tail) { tails[stream] = tail; anyReadable = true; }
		}
		if (!anyReadable) { this.loadProjection(bg); return; }
		bg.log = []; bg.stdout = []; bg.stderr = []; bg._logBytes = 0;
		for (const stream of ["stdout", "stderr"] as const) {
			const tail = tails[stream];
			if (!tail) { if (stream === "stdout") bg.outOffset = 0; else bg.errOffset = 0; continue; }
			if (tail.text) {
				const ts = Date.now();
				for (const line of tail.text.split("\n")) {
					if (line.length > 0) {
						this.appendLog(bg, stream, line, ts);
						(stream === "stdout" ? bg.stdout : bg.stderr).push(line);
					}
				}
			}
			if (stream === "stdout") bg.outOffset = tail.newOffset; else bg.errOffset = tail.newOffset;
		}
	}

	private markUnrecoverable(sessionId: string, bg: BgProcess): void {
		bg.status = "unrecoverable";
		bg.exitCode = null;
		bg.terminalReason = "unrecoverable";
		bg.endTime = Date.now();
		this.stopTimers(bg);
		this.store(sessionId)?.update(sessionId, bg.id, {
			status: bg.status, exitCode: null, terminalReason: "unrecoverable", endTime: bg.endTime,
		});
		bg._resolveExited();
		this.broadcast(sessionId, {
			type: "bg_process_exited", processId: bg.id, exitCode: null, endTime: bg.endTime, terminalReason: "unrecoverable",
		} as any);
	}

	private rehydrate(rec: PersistedBgProcess): BgProcess {
		let resolveExited!: () => void;
		const exited = new Promise<void>((res) => { resolveExited = res; });
		const paths: BgPaths = {
			logFile: rec.logFile, statusSnapshot: rec.statusSnapshot,
			outSpool: rec.outSpool, errSpool: rec.errSpool, pidFile: rec.pidFile,
			containerOutSpool: rec.containerOutSpool, containerErrSpool: rec.containerErrSpool,
			containerStatus: rec.containerStatus, containerPid: rec.containerPid,
			nonce: rec.nonce, inContainer: rec.inContainer,
		};
		const bg: BgProcess = {
			id: rec.id, name: rec.name, command: rec.command,
			hostPid: rec.hostPid, processPid: rec.processPid, nonce: rec.nonce,
			child: null,
			stdout: [], stderr: [], log: [],
			status: rec.status, exitCode: rec.exitCode, terminalReason: rec.terminalReason,
			startTime: rec.startTime, endTime: rec.endTime,
			cwd: rec.cwd, containerId: rec.containerId, paths,
			outOffset: rec.outOffset, errOffset: rec.errOffset,
			exited, _resolveExited: resolveExited, _logBytes: 0,
			_tailers: null, _statusTimer: null, _projectionTimer: null,
			_killIntent: null, _killEscalate: null,
		};
		if (rec.status !== "running") resolveExited();
		return bg;
	}

	// ── kill / dismiss ────────────────────────────────────────────────────────────

	kill(sessionId: string, processId: string): boolean {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg || bg.status !== "running") return false;
		bg._killIntent = Date.now();
		if (bg.paths.inContainer && bg.containerId && bg.processPid > 0) {
			this.env.dockerCli(["exec", bg.containerId, "kill", "-TERM", `-${bg.processPid}`]);
			const esc = setTimeout(() => {
				if (bg.status === "running" && bg.containerId) {
					this.env.dockerCli(["exec", bg.containerId, "kill", "-KILL", `-${bg.processPid}`]);
				}
			}, KILL_GRACE_MS);
			if (typeof (esc as any).unref === "function") (esc as any).unref();
			bg._killEscalate = esc;
		} else if (bg.processPid > 0) {
			this.env.killHostTree(bg.processPid, "SIGTERM");
			const esc = setTimeout(() => {
				if (bg.status === "running") this.env.killHostTree(bg.processPid, "SIGKILL");
			}, KILL_GRACE_MS);
			if (typeof (esc as any).unref === "function") (esc as any).unref();
			bg._killEscalate = esc;
		}
		// Prompt a status check shortly after (in case the wrapper wrote the real code).
		this.checkStatus(sessionId, bg);
		return true;
	}

	/** Remove the record + purge persisted files. Refuses a running process unless forced. */
	dismiss(sessionId: string, processId: string, opts?: { force?: boolean }): boolean {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) {
			// Maybe only persisted (never rehydrated) — purge from store + best-effort files.
			const store = this.store(sessionId);
			const rec = store?.get(sessionId, processId);
			if (!rec) return false;
			this.purgeFiles(this.rehydrate(rec));
			store?.remove(sessionId, processId);
			this.broadcast(sessionId, { type: "bg_process_dismissed", processId } as any);
			return true;
		}
		if (bg.status === "running" && !opts?.force) return false;
		if (bg.status === "running") { try { this.kill(sessionId, processId); } catch { /* ignore */ } }
		this.stopTimers(bg);
		this.purgeFiles(bg);
		this.processes.get(sessionId)!.delete(processId);
		if (this.processes.get(sessionId)!.size === 0) this.processes.delete(sessionId);
		this.store(sessionId)?.remove(sessionId, processId);
		this.broadcast(sessionId, { type: "bg_process_dismissed", processId } as any);
		return true;
	}

	private purgeFiles(bg: BgProcess): void {
		for (const f of [bg.paths.logFile, bg.paths.statusSnapshot, bg.paths.outSpool, bg.paths.errSpool, bg.paths.pidFile]) {
			if (!f) continue;
			try { fs.unlinkSync(f); } catch { /* already gone */ }
		}
		if (bg.paths.inContainer && bg.containerId) {
			this.env.dockerCli(["exec", bg.containerId, "rm", "-f",
				bg.paths.containerOutSpool!, bg.paths.containerErrSpool!, bg.paths.containerStatus!, bg.paths.containerPid!]);
		}
	}

	/** Legacy index-only remove → delegates to dismiss (kept for back-compat callers). */
	remove(sessionId: string, processId: string): boolean {
		return this.dismiss(sessionId, processId);
	}

	// ── reads (operate on the in-memory combined buffer) ──────────────────────────

	list(sessionId: string): BgProcessInfo[] {
		const map = this.processes.get(sessionId);
		if (!map) return [];
		return Array.from(map.values()).map((bg) => this.toInfo(bg));
	}

	getLogs(sessionId: string, processId: string): { log: LogEntry[]; stdout: string[]; stderr: string[] } | null {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;
		return { log: bg.log, stdout: bg.stdout, stderr: bg.stderr };
	}

	grepLogs(sessionId: string, processId: string, pattern: string, contextLines = 0, maxResults = 50): { matches: { line: number; ts: number; text: string }[]; total: number } | null {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;
		let regex: RegExp;
		try { regex = new RegExp(pattern, "i"); }
		catch { regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
		const log = bg.log;
		const matchIndices: number[] = [];
		for (let i = 0; i < log.length; i++) if (regex.test(log[i].text)) matchIndices.push(i);
		const total = matchIndices.length;
		const seen = new Set<number>();
		const matches: { line: number; ts: number; text: string }[] = [];
		for (const idx of matchIndices.slice(0, maxResults)) {
			const start = Math.max(0, idx - contextLines);
			const end = Math.min(log.length - 1, idx + contextLines);
			for (let i = start; i <= end; i++) {
				if (!seen.has(i)) { seen.add(i); matches.push({ line: i + 1, ts: log[i].ts, text: log[i].text }); }
			}
		}
		return { matches, total };
	}

	headLogs(sessionId: string, processId: string, lines = 50): { log: LogEntry[]; totalLines: number } | null {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;
		return { log: bg.log.slice(0, lines), totalLines: bg.log.length };
	}

	sliceLogs(sessionId: string, processId: string, from: number, to: number): { log: LogEntry[]; totalLines: number } | null {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;
		return { log: bg.log.slice(Math.max(0, from - 1), to), totalLines: bg.log.length };
	}

	/** Clean up all bg processes for a session on real terminate — kill + purge files. */
	cleanup(sessionId: string): void {
		this.abortAllWaits(sessionId);
		const map = this.processes.get(sessionId);
		if (map) {
			for (const [id] of Array.from(map)) {
				const bg = map.get(id);
				if (!bg) continue;
				if (bg.status === "running") { try { this.kill(sessionId, id); } catch { /* ignore */ } }
				this.stopTimers(bg);
				this.purgeFiles(bg);
			}
			this.processes.delete(sessionId);
		}
		this.store(sessionId)?.removeForSession(sessionId);
	}

	registerWait(sessionId: string, controller: AbortController): void {
		let set = this.waits.get(sessionId);
		if (!set) { set = new Set(); this.waits.set(sessionId, set); }
		set.add(controller);
	}

	unregisterWait(sessionId: string, controller: AbortController): void {
		const set = this.waits.get(sessionId);
		if (!set) return;
		set.delete(controller);
		if (set.size === 0) this.waits.delete(sessionId);
	}

	abortAllWaits(sessionId: string): void {
		const set = this.waits.get(sessionId);
		if (!set) return;
		for (const controller of set) { try { controller.abort(); } catch { /* ignore */ } }
	}

	async waitForExit(sessionId: string, processId: string, timeoutMs: number, signal?: AbortSignal): Promise<{ info: BgProcessInfo; timedOut: boolean; aborted: boolean } | null> {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;
		if (bg.status !== "running") return { info: this.toInfo(bg), timedOut: false, aborted: false };
		if (signal?.aborted) return { info: this.toInfo(bg), timedOut: false, aborted: true };

		let timer: ReturnType<typeof setTimeout> | null = null;
		let onAbort: (() => void) | null = null;
		const timeoutP = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs); });
		const abortP = new Promise<"abort">((res) => {
			if (!signal) return;
			onAbort = () => res("abort");
			signal.addEventListener("abort", onAbort, { once: true });
		});
		const exitP = bg.exited.then(() => "exit" as const);
		try {
			const winner = await Promise.race([exitP, timeoutP, abortP]);
			return { info: this.toInfo(bg), timedOut: winner === "timeout", aborted: winner === "abort" };
		} finally {
			if (timer) clearTimeout(timer);
			if (onAbort && signal) signal.removeEventListener("abort", onAbort);
		}
	}

	prune(sessionId: string): void {
		const map = this.processes.get(sessionId);
		if (!map) return;
		for (const [id, bg] of map) if (bg.status !== "running") map.delete(id);
		if (map.size === 0) this.processes.delete(sessionId);
	}

	/** Flush pending projection writes + store (for tests / shutdown). */
	flush(sessionId?: string): void {
		const flushOne = (sid: string, bg: BgProcess) => {
			if (bg._projectionTimer) { clearTimeout(bg._projectionTimer); bg._projectionTimer = null; this.writeProjection(bg); }
			this.store(sid)?.flush();
		};
		if (sessionId) {
			const map = this.processes.get(sessionId);
			if (map) for (const bg of map.values()) flushOne(sessionId, bg);
			else this.store(sessionId)?.flush();
		} else {
			for (const [sid, map] of this.processes) for (const bg of map.values()) flushOne(sid, bg);
		}
	}

	private toPersisted(sessionId: string, bg: BgProcess): PersistedBgProcess {
		return {
			sessionId, id: bg.id, name: bg.name, command: bg.command,
			hostPid: bg.hostPid, processPid: bg.processPid, nonce: bg.nonce,
			cwd: bg.cwd, containerId: bg.containerId,
			status: bg.status, exitCode: bg.exitCode, terminalReason: bg.terminalReason,
			startTime: bg.startTime, endTime: bg.endTime,
			logFile: bg.paths.logFile, statusSnapshot: bg.paths.statusSnapshot,
			outSpool: bg.paths.outSpool, errSpool: bg.paths.errSpool, pidFile: bg.paths.pidFile,
			containerOutSpool: bg.paths.containerOutSpool, containerErrSpool: bg.paths.containerErrSpool,
			containerStatus: bg.paths.containerStatus, containerPid: bg.paths.containerPid,
			inContainer: bg.paths.inContainer,
			outOffset: bg.outOffset, errOffset: bg.errOffset,
		};
	}

	private toInfo(bg: BgProcess): BgProcessInfo {
		return {
			id: bg.id, name: bg.name, command: bg.command,
			pid: bg.processPid || bg.hostPid,
			status: bg.status, exitCode: bg.exitCode, terminalReason: bg.terminalReason,
			startTime: bg.startTime, endTime: bg.endTime,
		};
	}
}
