// src/server/extension-host/module-host-bootstrap.ts
//
// Slice C3 — the WORKER ENTRY for server-module RESOURCE + CRASH isolation
// (Extension Host Phase 2, design docs/design/extension-host-phase2.md §9 / C3.2).
//
// This module is the `Worker` entry spawned by `ModuleHost.invoke`
// (module-host-worker.ts). It runs in a worker thread whose env is empty (no gateway
// token / secret — set by the parent via `new Worker(..., { env: {} })`) and whose
// memory is capped by `resourceLimits`.
//
// **Trust model (Model A).** Pack SERVER code is TRUSTED — same tier as a tool or
// MCP server the user chose to install. The worker is a RESOURCE + CRASH isolation
// boundary (terminate-on-timeout, mem/cpu caps, spawned-child kill, module-import
// containment to the pack root) — it is explicitly NOT a security sandbox against
// the pack's own code. A per-capability sandbox over trusted in-process code is
// false security (a native `.node` addon or the shared process trivially defeats
// it). `permissions:` is install-time DISCLOSURE + the switch that ENABLES ambient
// OS capabilities — NOT an enforced privilege boundary:
//
//   - NO grant  → deny-all DEFAULT (the enable-switch baseline): every dangerous
//     built-in import is denied, every outbound-network global is stripped, and the
//     `process` global is an inert shim. This is the disclosure default (a pack that
//     discloses nothing reaches only the host-API proxy), not a security claim.
//   - `git`     → `child_process` is fully un-gated; the trusted pack may run ANY
//     command (sync or async), exactly like a tool. The worker adds CONVENIENCE +
//     STABILITY only: async spawns default their `cwd` to the session working dir
//     when unspecified, and every async child is tracked + SIGKILLed on
//     terminate-on-timeout (a child outliving its worker would leak). NO
//     binary/argv restriction, NO sync denial, NO cwd containment.
//   - `fs`      → `fs`/`fs/promises` are fully un-gated with NO path containment;
//     the trusted pack may read/write anywhere the gateway process can. The worker
//     adds CONVENIENCE only: a LEADING bare-relative path argument is rebased onto
//     the session working dir (worker threads cannot `chdir()`, so the shim
//     `cwd()` alone does not redirect libuv's real cwd). NO rejection of absolute /
//     out-of-tree / symlinked paths.
//   - `net`     → the outbound-network globals + network built-ins are KEPT.
//
// Bootstrap order:
//
//   1. Statically import `worker_threads` + `module` + the confinement hook
//      (`confinement-loader.ts`) + the pure `permission-grants` logic — so the
//      static-import phase creates NO `node:fs` ESM facade. Then, in
//      `confinementReady`, APPLY the per-grant module wraps FIRST (child-process
//      default-cwd + tracking / fs relative-path rebasing — CONVENIENCE, not a
//      boundary) so they are in place BEFORE the `node:fs` facade is created, and
//      only AFTER that dynamically import the shared `path-guard` helper (which
//      creates the now-wrapped facade) and inject its module-import containment
//      check into the confinement loader.
//   2. Install the module-load DENY+CONFINE hook (`confinement-loader.ts`) via the
//      IN-THREAD `module.registerHooks({ resolve })`, so the pack module graph
//      imported afterward cannot reach the (still-)denied built-ins, NOR
//      `import`/`require` any `file:` OUTSIDE its own pack root (relative `../`
//      walk, absolute path, symlink, or ancestor `node_modules`). Module-import
//      containment is a loader/stability concern, not an fs-access boundary.
//   3. Remove ambient web/process globals BEFORE any pack code runs (unless the
//      matching capability is enabled): delete the outbound-network globals and
//      REPLACE the ambient `process` global with a shim.
//   4. On an `invoke` message: dynamic-import the pack module at the SAME
//      epoch-cache-busted URL the dispatcher built, build a `ctx.host` PROXY whose
//      store/session calls are marshalled back to the parent over the MessagePort
//      (the worker has no ambient host access — host calls are AUTHORIZED in the
//      parent; those cross-pack/cross-session boundaries ARE enforced), invoke
//      `module[exportKind][member](ctx, arg)`, and post the result.

import { registerHooks, createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { configure as configureConfinement, resolve as confinementResolve } from "./confinement-loader.js";
import { keepNetworkGlobals, needsRealProcess, hasGrant } from "./permission-grants.js";

interface BootstrapData {
	/** First-path-segment deny-list forwarded to the confinement hook (already
	 *  relaxed by the parent per the enabled capability set). */
	denied: string[];
	/** The validated pack group root forwarded to the confinement hook so every
	 *  resolved `file:` URL in the pack module graph stays realpath-contained within
	 *  it (module-import containment — a loader/stability concern, NOT an fs boundary). */
	packRoot?: string;
	/** Slice C3 (declared-permission model) — the SERVER-RESOLVED enabled set
	 *  (`git`/`fs`/`net`). Empty ⇒ deny-all DEFAULT (the disclosure baseline). */
	permissions?: string[];
	/** Slice C3 — the session working dir; the process shim's `cwd()` when `git`/`fs`
	 *  is enabled, the default spawn `cwd`, and the rebase target for bare-relative
	 *  fs paths (CONVENIENCE only). */
	workingDir?: string;
}

// Capture the REAL `process` (Node-internal) BEFORE the pack-visible shim replaces
// the global, so the bootstrap can read PATH for the minimal shim env even after
// pack code only ever sees the inert/minimal shim.
const realProcess = (globalThis as unknown as { process?: NodeJS.Process }).process;

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
const data = (workerData ?? { denied: [] }) as BootstrapData;
const grants = Array.isArray(data.permissions) ? data.permissions : [];

// NOTE: `process.chdir()` is unsupported inside a worker thread, so the worker's
// REAL cwd stays at startup. The session working dir is surfaced two ways: the
// process SHIM's `cwd()` (set in removeAmbientGlobals) for any pack that reads it,
// AND — as a CONVENIENCE — the per-grant module wraps below default the async spawn
// `cwd` and rebase LEADING bare-relative fs paths onto it, so real fs/git resolution
// honors the session dir (the shim cwd() alone does NOT redirect libuv's real cwd).

// ── Confinement setup (ORDER MATTERS). The pack module graph must not run until
// this whole sequence completes; `confinementReady` gates `handleInvoke`.
//
//   (1) Apply the per-grant module wraps FIRST, BEFORE any `node:fs` ESM facade is
//       created (CONVENIENCE only — NOT a security boundary). A `git` grant adds an
//       async child-process default-cwd + tracking wrap (default cwd to the session
//       dir; report each spawned pid so the parent can SIGKILL a survivor on
//       terminate). An `fs` grant rebases LEADING bare-relative fs path arguments
//       onto the session dir. Patching the CJS builtins via createRequire BEFORE the
//       facade is built makes the pack's `node:fs`/`child_process` module objects
//       reflect the wrapped functions. This is why `path-guard` (which imports
//       `node:fs`) is loaded LATER, in step (2), not statically.
//   (2) Load the shared `path-guard` helper (creating the now-wrapped `node:fs`
//       facade) and INJECT its containment check into the confinement loader, then
//       install the module-load deny+confine hook so the pack graph is deny-listed +
//       pack-root-confined (module-IMPORT containment only).
//   (3) Remove ambient web/process globals (`net` keeps the network globals;
//       `git`/`fs` get a `cwd()` + minimal PATH env on the process shim).
const confinementReady: Promise<void> = (async () => {
	applyGrantedModuleWraps(grants, data.workingDir);
	const { isPackPathWithinGroup } = await import("./path-guard.js");
	configureConfinement({ denied: data.denied, packRoot: data.packRoot, isWithin: isPackPathWithinGroup });
	registerHooks({ resolve: confinementResolve });
	removeAmbientGlobals(grants, data.workingDir);
})();

/**
 * Strip the ambient capabilities a `worker_threads.Worker` inherits that the
 * module-load deny-hook does NOT cover (it denies `node:` IMPORTS, but these are
 * reachable as GLOBALS without an import). After this runs, the ONLY capability
 * pack code is handed (with no grants) is the host-API proxy over the parent
 * MessagePort.
 *
 *   (a) Outbound-network globals — `fetch` (SSRF / arbitrary egress) plus the
 *       WHATWG fetch types and the legacy `XMLHttpRequest`/`WebSocket`/
 *       `EventSource` surfaces — are deleted, UNLESS `net` is enabled (then they
 *       are KEPT so the pack can make outbound requests).
 *   (b) The ambient `process` global is REPLACED with a shim. With NO `git`/`fs`
 *       grant it is fully inert: empty frozen env (no host secrets/metadata),
 *       cwd()=>"/", no `exit`/`abort`/`kill`, no `binding`/`dlopen` (native
 *       escape), no `argv`/`execPath` leaking host data. With `git`/`fs` enabled it
 *       gains a `cwd()` (the session dir) + a MINIMAL env containing ONLY PATH (so
 *       the git binary resolves) — still no host secrets/token (a hygiene measure,
 *       not a claimed boundary). Node internals + the loader thread keep their OWN
 *       process reference, so only PACK code sees the shim.
 */
function removeAmbientGlobals(grants: readonly string[], workingDir?: string): void {
	const g = globalThis as unknown as Record<string, unknown>;
	// (a) Delete every outbound-network global — UNLESS `net` is enabled (keep them).
	if (!keepNetworkGlobals(grants)) {
		for (const key of ["fetch", "WebSocket", "XMLHttpRequest", "Request", "Response", "Headers", "EventSource", "sendBeacon", "navigator"]) {
			try {
				delete g[key];
			} catch {
				/* best effort */
			}
		}
	}
	// (b) Replace the ambient `process` global with a shim (inert, or fs/git-aware).
	const denied = (name: string) => () => {
		throw new Error(`[confinement] process.${name} is denied to pack server modules (Extension Host §9 isolation)`);
	};
	const realCwd = needsRealProcess(grants) && typeof workingDir === "string" && workingDir.length > 0;
	// Minimal env: ONLY PATH (read from the real process, which the parent seeded
	// with just PATH) when git/fs is enabled; otherwise empty — NEVER the host's full
	// env / gateway token / secret.
	const shimEnv = needsRealProcess(grants)
		? Object.freeze({ PATH: realProcess?.env?.PATH ?? "" })
		: Object.freeze({});
	const inert: Record<string, unknown> = {
		env: shimEnv,
		argv: Object.freeze([]),
		argv0: "",
		execArgv: Object.freeze([]),
		execPath: "",
		platform: "",
		arch: "",
		version: "",
		versions: Object.freeze({}),
		pid: 0,
		ppid: 0,
		title: "",
		cwd: realCwd ? () => workingDir as string : () => "/",
		nextTick: (cb: (...a: unknown[]) => void, ...args: unknown[]) => { queueMicrotask(() => cb(...args)); },
		exit: denied("exit"),
		abort: denied("abort"),
		kill: denied("kill"),
		// NOTE: `binding`/`_linkedBinding`/`dlopen` (native-module escape vectors) are
		// intentionally ABSENT (undefined), not stubbed — there is no such member to call.
		// Inert EventEmitter-ish surface so a defensive `process.on(...)` is a no-op,
		// never a throw (returns the shim for chaining).
		on: () => inert,
		once: () => inert,
		off: () => inert,
		addListener: () => inert,
		removeListener: () => inert,
		emit: () => false,
	};
	Object.freeze(inert);
	try {
		Object.defineProperty(g, "process", { value: inert, writable: false, configurable: false, enumerable: false });
	} catch {
		try { g.process = inert; } catch { /* best effort */ }
	}
}

/**
 * Slice C3 (declared-permission model) — apply the per-grant module wraps to the
 * CJS built-ins BEFORE any pack module imports them, so the pack's module object
 * reflects the wrapped functions. These wraps are CONVENIENCE + STABILITY, NOT a
 * security boundary against the trusted pack:
 *   - `git` → async child-process default-cwd + spawned-child tracking
 *     (`installChildProcessTracking`). `child_process` is fully un-gated.
 *   - `fs`  → leading bare-relative fs path args rebased onto `workingDir`
 *     (`installFsRebase`). `fs`/`fs/promises` are fully un-gated (no containment).
 */
function applyGrantedModuleWraps(grants: readonly string[], workingDir?: string): void {
	const dir = typeof workingDir === "string" && workingDir.length > 0 ? workingDir : undefined;
	if (hasGrant(grants, "git")) {
		try {
			installChildProcessTracking(dir);
		} catch {
			/* best effort — if wrapping fails the child-kill safety net is reduced, but
			   the wall-time terminate still bounds the worker thread itself */
		}
	}
	if (hasGrant(grants, "fs") && dir) {
		try {
			installFsRebase(dir);
		} catch {
			/* best effort — without rebasing, relative reads resolve against the
			   worker's startup cwd (a convenience regression, not a security one) */
		}
	}
}

/** Build a spawn/exec/execFile/fork argument list with a DEFAULTED `cwd` (the
 *  session working dir) when none was supplied — a CONVENIENCE so a `git`-granted
 *  pack's relative spawns resolve under the session worktree (worker threads cannot
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
 * Slice C3 (declared-permission `git`) — `child_process` is fully un-gated (a
 * trusted pack may run ANY command, sync or async, exactly like a tool). This wrap
 * adds CONVENIENCE + STABILITY only to the ASYNC spawners (`spawn`/`exec`/
 * `execFile`/`fork`, which return a `ChildProcess`):
 *   - default the spawn `cwd` to the session working dir when unspecified, so a
 *     relative spawn resolves under the session worktree (workers cannot `chdir()`);
 *   - report each spawned child's pid (spawn + exit) to the parent so it SIGKILLs
 *     any survivor on terminate-on-timeout — `worker.terminate()` reaps the THREAD,
 *     not the spawned OS child (a child of the MAIN process).
 *
 * Synchronous APIs (`spawnSync`/`execSync`/`execFileSync`) are intentionally LEFT
 * UNTOUCHED — they are permitted (trusted code) and complete before returning, so
 * there is nothing to track.
 *
 * Patching the CJS builtin via `createRequire` BEFORE the pack imports it makes the
 * pack's module facade reflect the wrapped functions.
 */
function installChildProcessTracking(dir?: string): void {
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
	for (const name of ["spawn", "exec", "execFile", "fork"]) {
		const orig = cp[name];
		if (typeof orig !== "function") continue;
		cp[name] = function (this: unknown, ...args: unknown[]): unknown {
			const child = (orig as (...a: unknown[]) => unknown).apply(this, withDefaultCwd(args, dir));
			report(child);
			return child;
		};
	}
}

/**
 * Slice C3 (declared-permission `fs`) — `fs`/`fs/promises` are fully un-gated with
 * NO path containment (a trusted pack may read/write anywhere the gateway process
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
	// passes through UNTOUCHED. No rejection — fs is fully un-gated for trusted code.
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
		// ── (4) Dynamic-import the pack module through the deny-hook. ──
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
		};
		const result = await (fn as (c: unknown, a: unknown) => unknown)(ctx, msg.arg);
		port!.postMessage({ kind: "result", ok: true, value: result });
	} catch (err) {
		port!.postMessage({ kind: "result", ok: false, error: err instanceof Error ? err.message : String(err) });
	}
}

port.on("message", (msg: ParentMessage) => {
	if (msg.kind === "invoke") {
		// Wait for the confinement setup (module wraps + deny hook + global strip) to
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
