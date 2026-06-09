// src/server/extension-host/module-host-bootstrap.ts
//
// The WORKER ENTRY for server-module RESOURCE + CRASH isolation.
//
// This module is the `Worker` entry spawned by `ModuleHost.invoke`
// (module-host-worker.ts). It runs in a worker thread whose memory is capped by
// `resourceLimits` and that inherits a full copy of the gateway env.
//
// **Trust model (Model A).** Pack SERVER code is TRUSTED — same tier as a tool or
// MCP server the user chose to install — so it runs with FULL ambient parity:
// normal `node:` built-ins (`fs`/`child_process`/`net`/`http`…), normal network
// globals (`fetch`/`WebSocket`), and the normal `process` (full env). There is NO
// capability sandbox; a per-capability sandbox over trusted in-process code is false
// security (a native `.node` addon or the shared process trivially defeats it). The
// worker is purely a RESOURCE + CRASH isolation boundary (terminate-on-timeout,
// mem/cpu caps, spawned-child kill) plus module-import containment to the pack root
// (loader/stability hygiene, NOT a security boundary).
//
// The ONLY behavioral adjustments the bootstrap makes to otherwise-ambient Node are
// driven by `workingDir`, are UNCONDITIONAL, and are tool-parity convenience +
// resource hygiene — never a containment boundary:
//
//   - `process.cwd()` → `workingDir`: a tool/MCP server runs rooted at the session
//     worktree; worker threads cannot `chdir()`, so `process.cwd` is overridden to
//     return `workingDir`. Nothing else on `process` is touched (full env, real
//     `argv`/`execPath`/`exit`/`kill`/`binding`/…). This hides nothing.
//   - async child-process spawners default their `cwd` to `workingDir` (an explicit
//     `cwd` is respected verbatim) and report each spawned pid to the parent so the
//     resource-isolation layer can SIGKILL any survivor on terminate-on-timeout.
//   - synchronous child-process spawners get the same default-cwd plus an injected
//     `timeout`/`killSignal` clamped below the wall-cap (a blocking sync child can't
//     report its pid — the thread is frozen — so Node must SIGKILL it before
//     terminate reaps the thread, else the OS child orphans).
//   - LEADING bare-relative `fs` path arguments are rebased onto `workingDir` so
//     relative fs resolves consistently with the overridden `process.cwd()` (libuv's
//     real cwd stays the gateway's). Absolute / Buffer / URL paths pass through; no
//     path is ever rejected.
//
// Bootstrap order:
//
//   1. Statically import `worker_threads` + `module` + the confinement hook
//      (`confinement-loader.ts`) — so the static-import phase creates NO `node:fs`
//      ESM facade. Then, in `confinementReady`, APPLY the session-dir module wraps
//      FIRST (child-process default-cwd + tracking / fs relative-path rebasing —
//      CONVENIENCE, not a boundary) so they are in place BEFORE the `node:fs` facade
//      is created, and only AFTER that dynamically import the shared `path-guard`
//      helper (which creates the now-wrapped facade) and inject its module-import
//      containment check into the confinement loader.
//   2. Install the module-import containment hook (`confinement-loader.ts`) via the
//      IN-THREAD `module.registerHooks({ resolve })`, so the pack module graph
//      imported afterward cannot `import`/`require` any `file:` OUTSIDE its own pack
//      root (relative `../` walk, absolute path, symlink, or ancestor
//      `node_modules`). This is a loader/stability concern, not a security boundary.
//   3. Override `process.cwd()` to the session working dir (tool parity).
//   4. On an `invoke` message: dynamic-import the pack module at the SAME
//      epoch-cache-busted URL the dispatcher built, build a `ctx.host` PROXY whose
//      store/session calls are marshalled back to the parent over the MessagePort
//      (host calls are AUTHORIZED in the parent; those cross-pack/cross-session
//      boundaries ARE enforced), invoke `module[exportKind][member](ctx, arg)`, and
//      post the result.

import { registerHooks, createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { configure as configureConfinement, resolve as confinementResolve } from "./confinement-loader.js";

interface BootstrapData {
	/** The validated pack group root forwarded to the confinement hook so every
	 *  resolved `file:` URL in the pack module graph stays realpath-contained within
	 *  it (module-import containment — a loader/stability concern, NOT an fs boundary). */
	packRoot?: string;
	/** The session working dir — the worker's `process.cwd()` (tool parity), the
	 *  default spawn `cwd`, and the rebase target for bare-relative fs paths. */
	workingDir?: string;
	/** The worker's per-invoke wall-time cap (ms). Used to BOUND a SYNCHRONOUS child
	 *  (`spawnSync`/`execSync`/`execFileSync`): such a blocking call cannot report
	 *  its pid to the parent's kill-set (the worker thread is frozen for the whole
	 *  call), so pid tracking is infeasible. Instead an injected `timeout`/`killSignal`
	 *  is clamped BELOW this cap so Node SIGKILLs the sync child before the parent's
	 *  terminate-on-timeout reaps the thread — it cannot orphan past the cap. */
	wallCapMs?: number;
}

/** Headroom (ms) reserved below the worker wall-cap when bounding a SYNCHRONOUS
 *  child's injected `timeout`. Node kills the sync child at roughly
 *  `spawnStart + injected`; keeping `injected = wallCap - headroom` (never below
 *  half the cap, so a short cap doesn't starve a legitimate sync command) means
 *  Node SIGKILLs the child BEFORE the parent's terminate-on-timeout reaps the
 *  blocked worker thread (which would orphan the OS child — it is a child of the
 *  MAIN process, NOT the worker thread). Generous enough to clear worst-case worker
 *  startup; for the default 30s cap the child still gets ~28.5s. */
const SYNC_CHILD_TIMEOUT_HEADROOM_MS = 1500;

/** The bounded `timeout` to inject into a synchronous child call given the worker
 *  wall-cap: at most `wallCap - headroom`, but never below half the cap (so a short
 *  cap still lets a real sync command run), and at least 1ms. */
function boundedSyncTimeout(wallCapMs: number): number {
	return Math.max(Math.floor(wallCapMs / 2), wallCapMs - SYNC_CHILD_TIMEOUT_HEADROOM_MS, 1);
}

interface InvokeMessage {
	kind: "invoke";
	/** The epoch-cache-busted file URL the dispatcher resolved + validated. */
	url: string;
	exportKind: "actions" | "routes";
	member: string;
	/** Serializable handler context (identity + capability flags; NO live host). */
	ctx: SerializableCtx;
	arg: unknown;
}
interface HostReplyMessage {
	kind: "host-reply";
	id: number;
	ok: boolean;
	value?: unknown;
	error?: string;
}
type ParentMessage = InvokeMessage | HostReplyMessage;

/** The serializable shape of `ActionHandlerCtx` sent across the MessagePort. */
interface SerializableCtx {
	sessionId: string;
	toolUseId?: string;
	tool: string;
	workingDir?: string;
	hostVersion?: number;
	hostContractVersion?: number;
	capabilities: { callRoute: boolean; session: boolean; store: boolean };
}

const port = parentPort;
if (!port) {
	// Not running as a worker — refuse (defensive; the bootstrap is only ever a
	// Worker entry).
	throw new Error("module-host-bootstrap must run inside a worker thread");
}
const data = (workerData ?? {}) as BootstrapData;

// NOTE: `process.chdir()` is unsupported inside a worker thread, so the worker's
// REAL (libuv) cwd stays at startup. The session working dir is surfaced two ways:
// `process.cwd()` is overridden to return it (set in setSessionCwd) for tool parity
// and any pack that reads it, AND — as a CONVENIENCE — the session-dir module wraps
// below default the async spawn `cwd` and rebase LEADING bare-relative fs paths onto
// it, so real fs/git resolution honors the session dir (the cwd() override alone
// does NOT redirect libuv's real cwd).

// ── Confinement setup (ORDER MATTERS). The pack module graph must not run until
// this whole sequence completes; `confinementReady` gates `handleInvoke`.
//
//   (1) Apply the session-dir module wraps FIRST, BEFORE any `node:fs` ESM facade is
//       created (CONVENIENCE only — NOT a security boundary): an async child-process
//       default-cwd + tracking wrap (default cwd to the session dir; report each
//       spawned pid so the parent can SIGKILL a survivor on terminate) and a wrap
//       rebasing LEADING bare-relative fs path arguments onto the session dir.
//       Patching the CJS builtins via createRequire BEFORE the facade is built makes
//       the pack's `node:fs`/`child_process` module objects reflect the wrapped
//       functions. This is why `path-guard` (which imports `node:fs`) is loaded
//       LATER, in step (2), not statically.
//   (2) Load the shared `path-guard` helper (creating the now-wrapped `node:fs`
//       facade) and INJECT its containment check into the confinement loader, then
//       install the module-import containment hook so the pack graph is
//       pack-root-confined (module-IMPORT containment only — loader hygiene).
//   (3) Override `process.cwd()` to the session working dir (tool parity).
const confinementReady: Promise<void> = (async () => {
	applySessionDirWraps(data.workingDir, data.wallCapMs);
	const { isPackPathWithinGroup } = await import("./path-guard.js");
	configureConfinement({ packRoot: data.packRoot, isWithin: isPackPathWithinGroup });
	registerHooks({ resolve: confinementResolve });
	setSessionCwd(data.workingDir);
})();

/**
 * Override ONLY `process.cwd()` so it returns the session working dir (tool parity:
 * a tool/MCP server runs rooted at the session worktree, and worker threads cannot
 * `process.chdir()`). Nothing else about `process` is touched — the worker keeps the
 * real `process` global with the full env, real `argv`/`execPath`/`exit`/`kill`/
 * `binding`/… all present (trusted pack code is the tool/MCP tier). A no-op when
 * `workingDir` is absent/empty (the worker keeps its real cwd).
 */
function setSessionCwd(workingDir?: string): void {
	if (typeof workingDir !== "string" || workingDir.length === 0) return;
	try {
		process.cwd = () => workingDir;
	} catch {
		/* best effort */
	}
}

/**
 * Apply the session-working-dir module wraps to the CJS built-ins BEFORE any pack
 * module imports them, so the pack's module object reflects the wrapped functions.
 * UNCONDITIONAL (driven by `workingDir`). These wraps are tool-parity CONVENIENCE +
 * spawned-child resource hygiene, NOT a security boundary against the trusted pack:
 *   - async child-process default-cwd + spawned-child tracking AND synchronous-child
 *     timeout bounding (`installChildProcessTracking`).
 *   - leading bare-relative fs path args rebased onto `workingDir` (`installFsRebase`).
 */
function applySessionDirWraps(workingDir?: string, wallCapMs?: number): void {
	const dir = typeof workingDir === "string" && workingDir.length > 0 ? workingDir : undefined;
	try {
		installChildProcessTracking(dir, wallCapMs);
	} catch {
		/* best effort — if wrapping fails the child-kill safety net is reduced, but
		   the wall-time terminate still bounds the worker thread itself */
	}
	if (dir) {
		try {
			installFsRebase(dir);
		} catch {
			/* best effort — without rebasing, relative reads resolve against the
			   worker's startup cwd (a convenience regression, not a security one) */
		}
	}
}

/** Build a spawn/exec/execFile/fork argument list with a DEFAULTED `cwd` (the
 *  session working dir) when none was supplied — a CONVENIENCE so a pack's relative
 *  spawns resolve under the session worktree (worker threads cannot
 *  `chdir()`). An EXPLICIT `cwd` (absolute OR relative) is respected verbatim — no
 *  rebasing, no rejection. Handles the optional positional `options` object (absent,
 *  after an `args` array, before a trailing callback). */
function withDefaultCwd(args: unknown[], dir?: string): unknown[] {
	if (!dir) return args;
	let optsIdx = -1;
	for (let i = 1; i < args.length; i++) {
		const a = args[i];
		if (a && typeof a === "object" && !Array.isArray(a)) { optsIdx = i; break; }
	}
	if (optsIdx >= 0) {
		const opts = args[optsIdx] as Record<string, unknown>;
		if (opts.cwd !== undefined) return args; // explicit cwd respected verbatim
		const copy = args.slice();
		copy[optsIdx] = { ...opts, cwd: dir };
		return copy;
	}
	const out = args.slice();
	if (out.length > 0 && typeof out[out.length - 1] === "function") {
		out.splice(out.length - 1, 0, { cwd: dir });
	} else {
		out.push({ cwd: dir });
	}
	return out;
}

/**
 * `child_process` is fully ambient (a trusted pack may run ANY command, sync or
 * async, exactly like a tool). This wrap adds tool-parity CONVENIENCE + resource
 * STABILITY only to the ASYNC spawners (`spawn`/`exec`/
 * `execFile`/`fork`, which return a `ChildProcess`):
 *   - default the spawn `cwd` to the session working dir when unspecified, so a
 *     relative spawn resolves under the session worktree (workers cannot `chdir()`);
 *   - report each spawned child's pid (spawn + exit) to the parent so it SIGKILLs
 *     any survivor on terminate-on-timeout — `worker.terminate()` reaps the THREAD,
 *     not the spawned OS child (a child of the MAIN process).
 *
 * Synchronous APIs (`spawnSync`/`execSync`/`execFileSync`) ARE wrapped too — but a
 * blocking sync call cannot participate in pid tracking (the worker thread is frozen
 * for the call's whole duration, so the parent's kill-set never learns the pid
 * before the call returns; option-(a) tracking is infeasible). Instead the wrap
 * injects a bounded `timeout` (clamped BELOW the wall-cap via `boundedSyncTimeout`)
 * + `killSignal: "SIGKILL"` so NODE kills the sync child before the parent's
 * terminate-on-timeout reaps the blocked thread (terminating the thread would
 * ORPHAN the child — it is a child of the MAIN process). An explicit caller
 * `timeout` is respected but CLAMPED to the cap; `killSignal` defaults to SIGKILL.
 * This is STABILITY only (no leaked long-lived process) — the pack may still run any
 * command; it just cannot outlive the resource cap.
 *
 * Patching the CJS builtin via `createRequire` BEFORE the pack imports it makes the
 * pack's module facade reflect the wrapped functions.
 */
function installChildProcessTracking(dir?: string, wallCapMs?: number): void {
	const require = createRequire(import.meta.url);
	const cp = require("node:child_process") as Record<string, unknown>;
	const report = (child: unknown): void => {
		const c = child as { pid?: number; once?: (e: string, cb: () => void) => void } | undefined;
		const pid = c?.pid;
		if (typeof pid !== "number") return;
		try { port!.postMessage({ kind: "child-spawn", pid }); } catch { /* port gone */ }
		try {
			c?.once?.("exit", () => {
				try { port!.postMessage({ kind: "child-exit", pid }); } catch { /* port gone */ }
			});
		} catch { /* not an emitter */ }
	};
	// ASYNC spawners: default cwd + report pid to the parent kill-set.
	for (const name of ["spawn", "exec", "execFile", "fork"]) {
		const orig = cp[name];
		if (typeof orig !== "function") continue;
		cp[name] = function (this: unknown, ...args: unknown[]): unknown {
			const child = (orig as (...a: unknown[]) => unknown).apply(this, withDefaultCwd(args, dir));
			report(child);
			return child;
		};
	}
	// SYNC spawners: default cwd + inject a bounded timeout/killSignal so the
	// blocking child cannot orphan past the wall-cap (pid tracking is infeasible).
	for (const name of ["spawnSync", "execSync", "execFileSync"]) {
		const orig = cp[name];
		if (typeof orig !== "function") continue;
		cp[name] = function (this: unknown, ...args: unknown[]): unknown {
			return (orig as (...a: unknown[]) => unknown).apply(this, withBoundedSyncChild(args, dir, wallCapMs));
		};
	}
}

/**
 * Build a synchronous child-process argument list with (1) a DEFAULTED `cwd` (same
 * convenience as the async spawners) and (2) a bounded `timeout` + `killSignal` so
 * the blocking child cannot OUTLIVE the worker wall-cap. A sync call cannot report
 * its pid to the parent kill-set (the thread is frozen for the call's duration), so
 * Node's own `timeout` (clamped BELOW the cap by `boundedSyncTimeout`) must SIGKILL
 * the child before the parent terminates the (blocked) worker thread — otherwise the
 * OS child (a child of the MAIN process) orphans. An explicit caller `timeout` is
 * respected but CLAMPED to the bound (so even an explicit huge timeout cannot
 * outlive the cap); `killSignal` defaults to SIGKILL when unset. Handles the
 * optional positional `options` object (absent, or after an `args` array). STABILITY
 * only — no binary/argv restriction, no rejection.
 */
function withBoundedSyncChild(args: unknown[], dir?: string, wallCapMs?: number): unknown[] {
	const out = withDefaultCwd(args, dir).slice(); // fresh copy so the opts slot is safe to mutate
	const cap = typeof wallCapMs === "number" && wallCapMs > 0 ? boundedSyncTimeout(wallCapMs) : undefined;
	// Locate the positional options object — first non-array object after the
	// command/file at index 0 (sync APIs take no trailing callback).
	let optsIdx = -1;
	for (let i = 1; i < out.length; i++) {
		const a = out[i];
		if (a && typeof a === "object" && !Array.isArray(a)) { optsIdx = i; break; }
	}
	const base = optsIdx >= 0 ? (out[optsIdx] as Record<string, unknown>) : {};
	const existing = typeof base.timeout === "number" && base.timeout > 0 ? base.timeout : undefined;
	const timeout = cap === undefined ? existing : existing === undefined ? cap : Math.min(existing, cap);
	const merged: Record<string, unknown> = { ...base };
	if (typeof timeout === "number") merged.timeout = timeout;
	if (merged.killSignal === undefined) merged.killSignal = "SIGKILL";
	if (optsIdx >= 0) out[optsIdx] = merged;
	else out.push(merged);
	return out;
}

/**
 * `fs`/`fs/promises` are fully ambient with NO path containment (a trusted pack may
 * read/write anywhere the gateway process
 * can). This wrap is a CONVENIENCE only: a LEADING bare-relative path argument is
 * rebased onto the session working dir. Worker threads cannot `process.chdir()`, so
 * a real `fs.readFileSync("rel")` would otherwise resolve against the worker's
 * STARTUP cwd; rebasing makes it resolve under the session worktree. Absolute paths
 * and non-string PathLike args (Buffer / `file:` URL / fd) pass through UNCHANGED —
 * no rejection. The wrap is applied in-place on the CJS exports BEFORE the pack
 * imports them, so the pack's `fs` module object reflects the rebasing.
 *
 * The method-name sets are built LOCALLY (not at module scope): this function is
 * invoked from the `confinementReady` IIFE that runs DURING module evaluation, so
 * a module-level `const` would still be in its temporal dead zone here.
 */
function installFsRebase(dir: string): void {
	// Path-accepting fs/fs-promises methods whose FIRST argument is a path; the
	// two-path ops (`rename`/`copyFile`/`cp`/`link`/`symlink`) rebase BOTH args.
	// Both sync + async forms; only methods that exist on the module are wrapped.
	const twoPathBases = ["copyFile", "cp", "link", "rename", "symlink"];
	const singlePathBases = [
		"access", "appendFile", "chmod", "chown", "lchmod", "lchown", "lutimes", "lstat",
		"mkdir", "mkdtemp", "open", "opendir", "readdir", "readFile", "readlink", "realpath",
		"rm", "rmdir", "stat", "statfs", "truncate", "unlink", "utimes", "writeFile", "exists",
		"glob", "createReadStream", "createWriteStream", "watch", "watchFile", "unwatchFile", "openAsBlob",
	];
	const withSync = (bases: string[]): Set<string> => {
		const s = new Set<string>();
		for (const b of bases) { s.add(b); s.add(`${b}Sync`); }
		return s;
	};
	const twoPathSet = withSync(twoPathBases);
	const pathArgSet = new Set<string>([...withSync(singlePathBases), ...twoPathSet]);

	const require = createRequire(import.meta.url);
	const pathMod = require("node:path") as { isAbsolute: (p: string) => boolean; resolve: (...s: string[]) => string };

	// Rebase a LEADING bare-relative string path onto the session dir; anything else
	// (absolute string, Buffer, `file:` URL, fd number, options object, callback)
	// passes through UNTOUCHED. No rejection — fs is fully ambient for trusted code.
	const rebase = (p: unknown): unknown => {
		if (typeof p === "string" && p.length > 0 && !pathMod.isAbsolute(p)) return pathMod.resolve(dir, p);
		return p;
	};
	const wrap = (mod: Record<string, unknown>): void => {
		for (const name of Object.keys(mod)) {
			if (!pathArgSet.has(name)) continue;
			const fn = mod[name];
			if (typeof fn !== "function") continue;
			const twoPath = twoPathSet.has(name);
			const wrapped = function (this: unknown, ...args: unknown[]): unknown {
				if (args.length > 0) args[0] = rebase(args[0]);
				if (twoPath && args.length > 1) args[1] = rebase(args[1]);
				return (fn as (...a: unknown[]) => unknown).apply(this, args);
			};
			// Preserve function sub-properties (e.g. `fs.realpath.native`).
			try { Object.assign(wrapped, fn); } catch { /* non-extensible — best effort */ }
			mod[name] = wrapped;
		}
	};
	wrap(require("node:fs") as Record<string, unknown>);
	try { wrap(require("node:fs/promises") as Record<string, unknown>); } catch { /* always present on supported Node */ }
}

// ── Host-API proxy plumbing: marshal ctx.host.<ns>.<method>() to the parent. ──
let hostCallSeq = 0;
const pendingHostCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function callHost(path: [string, string], args: unknown[]): Promise<unknown> {
	const id = ++hostCallSeq;
	return new Promise<unknown>((resolve, reject) => {
		pendingHostCalls.set(id, { resolve, reject });
		port!.postMessage({ kind: "host-call", id, path, args });
	});
}

/** Build the proxied `ctx.host` handed to pack code. Store/session methods are
 *  marshalled to the parent (authorized there — these cross-pack/cross-session
 *  boundaries ARE enforced); identity + flags are local. */
function buildHostProxy(ctx: SerializableCtx): unknown {
	const flags = ctx.capabilities;
	return {
		version: ctx.hostVersion,
		contractVersion: ctx.hostContractVersion,
		capabilities: {
			callRoute: flags.callRoute,
			session: flags.session,
			store: flags.store,
			has: (name: string) => (flags as Record<string, boolean>)[name] === true,
		},
		store: {
			get: (key: string) => callHost(["store", "get"], [key]),
			put: (key: string, value: unknown) => callHost(["store", "put"], [key, value]),
			list: (prefix?: string) => callHost(["store", "list"], [prefix]),
		},
		// `session` is READ-ONLY for server modules: `postMessage` is intentionally
		// ABSENT (the parent `ServerHostApi` omits it — server modules have no user
		// gesture, so a proxied call would always throw). Authors get an accurate
		// surface: `readTranscript`/`readToolCall` only.
		session: {
			readTranscript: (opts?: unknown) => callHost(["session", "readTranscript"], [opts]),
			readToolCall: (toolUseId: string) => callHost(["session", "readToolCall"], [toolUseId]),
		},
	};
}

async function handleInvoke(msg: InvokeMessage): Promise<void> {
	try {
		// ── (4) Dynamic-import the pack module through the module-import containment hook. ──
		const mod = (await import(msg.url)) as Record<string, Record<string, unknown>>;
		const group = mod[msg.exportKind] ?? (mod.default as Record<string, Record<string, unknown>> | undefined)?.[msg.exportKind];
		// Export-map validation now lives HERE (moved off the parent so the parent never
		// imports pack code): a module with no `actions`/`routes` export object is a 500,
		// matching the status the dispatcher used to throw parent-side.
		if (!group || typeof group !== "object") {
			port!.postMessage({ kind: "result", ok: false, status: 500, error: `module has no '${msg.exportKind}' export` });
			return;
		}
		// Own-property + function check (mirrors the former dispatcher parent-side guard):
		// never invoke an INHERITED member (`constructor`, `toString`, …) — defense-in-depth
		// against a prototype-walk. An unknown/own-non-function member is a 404.
		const fn = Object.prototype.hasOwnProperty.call(group, msg.member) ? group[msg.member] : undefined;
		if (typeof fn !== "function") {
			port!.postMessage({ kind: "result", ok: false, status: 404, error: `unknown ${msg.exportKind} member "${msg.member}"` });
			return;
		}
		const ctx = {
			host: buildHostProxy(msg.ctx),
			sessionId: msg.ctx.sessionId,
			toolUseId: msg.ctx.toolUseId,
			tool: msg.ctx.tool,
			workingDir: msg.ctx.workingDir,
		};
		const result = await (fn as (c: unknown, a: unknown) => unknown)(ctx, msg.arg);
		port!.postMessage({ kind: "result", ok: true, value: result });
	} catch (err) {
		port!.postMessage({ kind: "result", ok: false, error: err instanceof Error ? err.message : String(err) });
	}
}

port.on("message", (msg: ParentMessage) => {
	if (msg.kind === "invoke") {
		// Wait for the confinement setup (session-dir wraps + containment hook +
		// process.cwd override) to
		// finish before importing any pack code. The MessagePort buffers messages
		// until this listener runs; gating here ensures a fast parent `invoke` never
		// races ahead of confinement.
		void confinementReady.then(() => handleInvoke(msg));
		return;
	}
	if (msg.kind === "host-reply") {
		const pending = pendingHostCalls.get(msg.id);
		if (!pending) return;
		pendingHostCalls.delete(msg.id);
		if (msg.ok) pending.resolve(msg.value);
		else pending.reject(new Error(msg.error ?? "host call failed"));
		return;
	}
});
