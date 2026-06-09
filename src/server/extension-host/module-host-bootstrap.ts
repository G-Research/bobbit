// src/server/extension-host/module-host-bootstrap.ts
//
// Slice C3 — the WORKER ENTRY for server-module confinement (Extension Host
// Phase 2, design docs/design/extension-host-phase2.md §9 / C3.2).
//
// This module is the `Worker` entry spawned by `ModuleHost.invoke`
// (module-host-worker.ts). It runs in a confined worker thread whose env is empty
// (no gateway token / secret — set by the parent via `new Worker(..., { env: {} })`)
// and whose memory is capped by `resourceLimits`. Its job, in order:
//
//   1. Statically import `worker_threads` + `module` + the confinement hook
//      (`confinement-loader.ts`, which now imports NO `node:fs`) + the pure
//      `permission-grants` logic — so the static-import phase creates NO `node:fs`
//      ESM facade. Then, in the `confinementReady` setup, APPLY the per-grant
//      module wraps FIRST (constrained git runner / fs relative-path rebasing) so
//      they are in place BEFORE the `node:fs` facade is created, and only AFTER
//      that dynamically import the shared `path-guard` helper (which creates the
//      now-wrapped facade) and inject it into the confinement loader.
//   2. Install the module-load DENY+CONFINE hook (`confinement-loader.ts`) via the
//      IN-THREAD `module.registerHooks({ resolve })`, so the pack module graph
//      imported afterward cannot reach `node:fs`/`child_process`/network/`process`/
//      `worker_threads`/etc., NOR `import`/`require` any `file:` OUTSIDE its own
//      pack root (relative `../` walk, absolute path, symlink, or ancestor
//      `node_modules`). In-thread (synchronous) hooks run in THIS worker thread, so
//      the injected `path-guard` helper runs directly — no separate hooks thread,
//      no cross-thread marshalling, no `.ts`/`.js` resolution gap.
//   3. Remove ambient web/process globals BEFORE any pack code runs: delete the
//      outbound-network globals (`fetch`/`WebSocket`/`XMLHttpRequest`/`Request`/
//      `Response`/`Headers`/…) and REPLACE the ambient `process` global with an
//      inert shim (no env/exit/binding/argv/cwd). The host-API proxy over the
//      parent MessagePort is then the ONLY capability pack code can reach.
//   4. On an `invoke` message: dynamic-import the pack module at the SAME
//      epoch-cache-busted URL the dispatcher built, build a `ctx.host` PROXY whose
//      store/session calls are marshalled back to the parent over the MessagePort
//      (the worker has no ambient access — host calls are authorized in the
//      parent), invoke `module[exportKind][member](ctx, arg)`, and post the result.
//
// The ONLY capability pack code receives is the host-API proxy. Everything else
// (fs/network/process/exec) is denied in-thread; CPU/wall-time is bounded by the
// parent terminating this worker on timeout (design §9 — terminate-on-timeout IS
// the CPU control).

import { registerHooks, createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { configure as configureConfinement, resolve as confinementResolve } from "./confinement-loader.js";
import { keepNetworkGlobals, needsRealProcess, hasGrant } from "./permission-grants.js";

interface BootstrapData {
	/** First-path-segment deny-list forwarded to the confinement hook (already
	 *  relaxed by the parent per the granted permission set). */
	denied: string[];
	/** The validated pack group root forwarded to the confinement hook so every
	 *  resolved `file:` URL in the pack module graph stays realpath-contained within
	 *  it (no `../`/absolute/symlink/node_modules escape outside the pack). */
	packRoot?: string;
	/** Slice C3 (declared-permission model) — the SERVER-RESOLVED grant set
	 *  (`git`/`fs`/`net`). Empty ⇒ deny-all (today's confinement). */
	permissions?: string[];
	/** Slice C3 — the session working dir; the process shim's REAL cwd() when
	 *  `git`/`fs` is granted (and the worker's actual cwd, so spawned git + relative
	 *  reads resolve there). */
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

// Slice C3 (defense-in-depth — confine git/fs to the session working dir). The
// shared pack-path containment helper (`path-guard`) is loaded in `confinementReady`
// step (2); the per-grant module wraps applied in step (1) consult it — plus the
// REAL (unwrapped) `realpathSync` captured BEFORE the fs-rebase wrap — only when the
// pack actually calls fs/git, by which time `confinementReady` (and thus the
// path-guard import) has completed. Capturing the unwrapped `realpathSync` keeps the
// containment check from recursing through the pack-facing fs wrap.
let sessionContainment: ((groupAbs: string, fileAbs: string) => boolean) | undefined;
let realRealpathSync: ((p: string) => string) | undefined;

// NOTE: `process.chdir()` is unsupported inside a worker thread, so the worker's
// REAL cwd stays at startup. The session working dir is surfaced two ways: the
// process SHIM's `cwd()` (set in removeAmbientGlobals) for any pack that reads it,
// AND — crucially — the per-grant module wraps below default the spawn `cwd` and
// rebase relative fs paths onto it, so real fs/git resolution actually honors the
// session dir (the shim cwd() alone does NOT redirect libuv's real cwd). The git
// BINARY itself resolves via PATH in the worker's real env (seeded by the parent),
// independent of cwd.

// ── Confinement setup (ORDER MATTERS). The pack module graph must not run until
// this whole sequence completes; `confinementReady` gates `handleInvoke`.
//
//   (1) Apply the per-grant module wraps FIRST, BEFORE any `node:fs` ESM facade is
//       created. A `git` grant means "run git", NOT "run any command" — so we
//       expose a CONSTRAINED, TRACKED, ASYNC-ONLY git runner (only an async
//       spawn/execFile of the `git` binary; sync child-process APIs + non-git
//       commands rejected; cwd defaults to the session dir; children tracked +
//       SIGKILLed on terminate). An `fs` grant rebases LEADING RELATIVE fs path
//       arguments onto the session dir. Patching the CJS builtins via createRequire
//       BEFORE the facade is built makes the pack's `node:fs`/`child_process`
//       module objects reflect the wrapped functions. This is why `path-guard`
//       (which imports `node:fs`) is loaded LATER, in step (2), not statically.
//   (2) Load the shared `path-guard` helper (creating the now-wrapped `node:fs`
//       facade) and INJECT it into the confinement loader, then install the
//       module-load deny+confine hook so the pack graph is deny-listed +
//       pack-root-confined.
//   (3) Remove ambient web/process globals (`net` keeps the network globals;
//       `git`/`fs` get a REAL cwd + minimal PATH env on the process shim).
const confinementReady: Promise<void> = (async () => {
	captureRealFs();
	applyGrantedModuleWraps(grants, data.workingDir);
	const { isPackPathWithinGroup, isPackPathWithinGroupStrict } = await import("./path-guard.js");
	// fs/git ops use the WRITE/CREATE-SAFE strict variant (resolves a symlinked
	// ancestor even when the leaf does not exist — closes the ENOENT-through-symlink
	// bypass). Module-import containment keeps the lenient ENOENT-tolerant helper
	// (existing-file resolution; its other callers rely on the ENOENT-true contract).
	sessionContainment = isPackPathWithinGroupStrict;
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
 *       `EventSource` surfaces — are deleted, UNLESS `net` is granted (then they
 *       are KEPT so the pack can make outbound requests).
 *   (b) The ambient `process` global is REPLACED with a shim. With NO `git`/`fs`
 *       grant it is fully inert: empty frozen env (no host secrets/metadata),
 *       cwd()=>"/", no `exit`/`abort`/`kill`, no `binding`/`dlopen` (native
 *       escape), no `argv`/`execPath` leaking host data. With `git`/`fs` granted
 *       it gains a REAL cwd() (the session dir) + a MINIMAL env containing ONLY
 *       PATH (so the git binary resolves) — still no host secrets/token. Node
 *       internals + the loader thread keep their OWN process reference (via the
 *       internal binding / require('process')), so only PACK code sees the shim.
 */
function removeAmbientGlobals(grants: readonly string[], workingDir?: string): void {
	const g = globalThis as unknown as Record<string, unknown>;
	// (a) Delete every outbound-network global — UNLESS `net` is granted (keep them).
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
	// with just PATH) when git/fs is granted; otherwise empty — NEVER the host's full
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
 * reflects the wrapped functions. Each grant un-gates exactly one narrow, audited
 * capability:
 *   - `git` → a constrained, tracked, async-only git runner (`installGitRunner`).
 *   - `fs`  → leading-relative fs path args rebased onto `workingDir`
 *     (`installFsRebase`).
 */
function applyGrantedModuleWraps(grants: readonly string[], workingDir?: string): void {
	const dir = typeof workingDir === "string" && workingDir.length > 0 ? workingDir : undefined;
	if (hasGrant(grants, "git")) {
		try {
			installGitRunner(dir);
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
			   worker's startup cwd (no security regression — fs is still pack-import
			   contained and the env carries no secret) */
		}
	}
}

/** Capture the REAL (unwrapped) `node:fs.realpathSync` BEFORE `installFsRebase`
 *  wraps it, so the session-containment equality check (which must resolve
 *  symlinks) never recurses through the pack-facing fs wrap. */
function captureRealFs(): void {
	try {
		const require = createRequire(import.meta.url);
		const fsMod = require("node:fs") as { realpathSync: (p: string) => string };
		const orig = fsMod.realpathSync;
		realRealpathSync = (p: string) => orig.call(fsMod, p);
	} catch {
		/* best effort — without it `withinSession` falls back to the path-guard helper
		   alone (still rejects out-of-tree paths; only the working-dir-ROOT equality
		   allowance is lost) */
	}
}

/** Slice C3 — true iff `target` (an ABSOLUTE path) is the session working dir
 *  ITSELF or realpath-contained beneath it. Reuses the WRITE/CREATE-SAFE strict
 *  `path-guard` helper (`isPackPathWithinGroupStrict` — resolves a symlinked
 *  ancestor even when the leaf does not yet exist, so a create-through-symlink is
 *  rejected) and adds the working-dir-ROOT equality allowance the helper omits by
 *  design (it rejects `group === target`, yet the working dir itself is a
 *  legitimate `cwd` / `readdir` target). */
function withinSession(workingDir: string, target: string): boolean {
	if (sessionContainment?.(workingDir, target)) return true;
	if (!realRealpathSync) return false;
	try {
		return realRealpathSync(workingDir) === realRealpathSync(target);
	} catch {
		return false;
	}
}

/** True iff `command` names the `git` binary (basename `git`/`git.exe`, any dir). */
function isGitBinary(command: unknown): boolean {
	if (typeof command !== "string" || command.length === 0) return false;
	const base = (command.split(/[\\/]/).pop() ?? command).toLowerCase();
	const noExe = base.endsWith(".exe") ? base.slice(0, -4) : base;
	return noExe === "git";
}

/** Build the spawn/execFile argument list with a SESSION-CONFINED `cwd`. A `git`
 *  grant means "run git in the session working dir", so the effective cwd — whether
 *  DEFAULTED (none supplied) or EXPLICIT — must realpath-resolve to the working dir
 *  or beneath it; an escape (out-of-tree `cwd`, `../` walk, symlink) THROWS. Only
 *  the `cwd` ARGUMENT is constrained: git's own internal file access (worktree
 *  `.git` links legitimately point outside the working dir) is the OS child's
 *  concern, not subject to this JS wrapper. Handles the optional positional
 *  `options` object (absent, after an `args` array, before a trailing `execFile`
 *  callback). */
function applyGitCwd(args: unknown[], dir?: string): unknown[] {
	if (!dir) return args;
	let optsIdx = -1;
	for (let i = 1; i < args.length; i++) {
		const a = args[i];
		if (a && typeof a === "object" && !Array.isArray(a)) { optsIdx = i; break; }
	}
	const explicit = optsIdx >= 0 ? (args[optsIdx] as Record<string, unknown>).cwd : undefined;
	const cwd = confineCwd(explicit, dir); // throws on escape
	if (optsIdx >= 0) {
		const copy = args.slice();
		copy[optsIdx] = { ...(args[optsIdx] as Record<string, unknown>), cwd };
		return copy;
	}
	const out = args.slice();
	if (out.length > 0 && typeof out[out.length - 1] === "function") {
		out.splice(out.length - 1, 0, { cwd });
	} else {
		out.push({ cwd });
	}
	return out;
}

/** Resolve a git spawn's effective `cwd` (explicit string/URL or defaulted to the
 *  session dir) to an absolute path UNDER `dir`, throwing if it escapes. */
function confineCwd(explicit: unknown, dir: string): string {
	const require = createRequire(import.meta.url);
	const pathMod = require("node:path") as { isAbsolute: (p: string) => boolean; resolve: (...s: string[]) => string };
	let cwd: string;
	if (typeof explicit === "string" && explicit.length > 0) {
		cwd = pathMod.isAbsolute(explicit) ? explicit : pathMod.resolve(dir, explicit);
	} else if (explicit && typeof explicit === "object") {
		// `spawn`/`execFile` accept a URL cwd — convert it to a path before checking.
		try {
			const { fileURLToPath } = require("node:url") as { fileURLToPath: (u: unknown) => string };
			cwd = fileURLToPath(explicit);
		} catch {
			throw new Error("[confinement] the 'git' grant could not validate the supplied cwd (Extension Host §9 isolation)");
		}
	} else {
		cwd = dir; // no cwd supplied → default to the session working dir
	}
	if (!withinSession(dir, cwd)) {
		throw new Error(`[confinement] the 'git' grant restricts the spawn cwd to the session working directory; "${String(explicit ?? cwd)}" escapes it (Extension Host §9 isolation)`);
	}
	return cwd;
}

function denyChildProc(what: string): () => never {
	return () => {
		throw new Error(`[confinement] ${what} (Extension Host §9 isolation)`);
	};
}

/**
 * Slice C3 (declared-permission `git`) — expose a CONSTRAINED, TRACKED, ASYNC-ONLY
 * git runner. The `git` grant un-denies `child_process`, but a `git` grant means
 * "run git", NOT "run any command":
 *   - EVERY synchronous child-process API (`spawnSync`/`execSync`/`execFileSync`/…)
 *     is denied — a sync spawn blocks the worker thread and its OS child (a child
 *     of the MAIN process) cannot be tracked or SIGKILLed on terminate, so it would
 *     outlive the wall-time cap.
 *   - `exec` (runs a SHELL — argv[0] is the shell, not git) and `fork` (spawns a
 *     Node child) are denied — neither is "run git".
 *   - the async binary spawners (`spawn`/`execFile`) are constrained to the `git`
 *     binary, default their `cwd` to the session working dir, and report each
 *     spawned child's pid (spawn + exit) to the parent so it SIGKILLs any survivor
 *     on terminate-on-timeout (worker.terminate() reaps only the THREAD, not the
 *     spawned OS child).
 *
 * Patching the CJS builtin via `createRequire` BEFORE the pack imports it makes the
 * pack's module facade reflect the wrapped functions (Node builds the facade from
 * the current CJS exports; the live default/namespace object reflects in-place
 * mutation). `child_process` is un-denied under this grant, so this resolves.
 */
function installGitRunner(dir?: string): void {
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
	// Deny EVERY synchronous child-process API (untrackable → could outlive the cap).
	for (const key of Object.keys(cp)) {
		if (key.endsWith("Sync") && typeof cp[key] === "function") {
			cp[key] = denyChildProc(`${key} is denied — synchronous child-process APIs cannot be tracked/cancelled`);
		}
	}
	// Deny the async non-git spawners: `exec` runs a shell, `fork` spawns Node.
	for (const key of ["exec", "fork"]) {
		if (typeof cp[key] === "function") {
			cp[key] = denyChildProc(`child_process.${key} is not permitted by the 'git' grant — only the git binary may be spawned`);
		}
	}
	// Constrain the async binary spawners to the `git` binary + default cwd + track.
	for (const name of ["spawn", "execFile"]) {
		const orig = cp[name];
		if (typeof orig !== "function") continue;
		cp[name] = function (this: unknown, ...args: unknown[]): unknown {
			if (!isGitBinary(args[0])) {
				throw new Error(`[confinement] the 'git' permission only permits spawning the git binary, not "${String(args[0])}" (Extension Host §9 isolation)`);
			}
			const child = (orig as (...a: unknown[]) => unknown).apply(this, applyGitCwd(args, dir));
			report(child);
			return child;
		};
	}
}

/**
 * Slice C3 (declared-permission `fs`) — wrap the `fs`/`fs/promises` modules so a
 * LEADING RELATIVE path argument resolves under the session working dir. Worker
 * threads cannot `process.chdir()`, so a real `fs.readFileSync("rel")` would
 * otherwise resolve against the worker's STARTUP cwd, breaking the design's "real
 * cwd for fs" contract. Absolute paths (and URL/Buffer args) pass through
 * unchanged. The wrap is applied in-place on the CJS exports BEFORE the pack
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
	const urlMod = require("node:url") as { fileURLToPath: (u: unknown) => string };

	// Normalize ANY Node `PathLike` (string, Buffer, or `file:` URL object) to a
	// decoded string path; returns `undefined` for a non-path argument (an fd
	// number, an options object, a callback) which must pass through UNTOUCHED.
	// THROWS on a non-`file:` URL scheme — a pack must not address other protocols.
	// Validating ONLY string paths (the prior behavior) was a bypass: a `Buffer`
	// path or a `new URL("file:///etc/passwd")` skipped containment entirely and
	// reached the real fs method unchecked.
	const normalizeToPath = (p: unknown): string | undefined => {
		if (typeof p === "string") return p.length === 0 ? undefined : p;
		if (Buffer.isBuffer(p)) {
			const s = (p as Buffer).toString("utf8");
			return s.length === 0 ? undefined : s;
		}
		const isUrlLike =
			p instanceof URL ||
			(p !== null && typeof p === "object" &&
				typeof (p as { href?: unknown }).href === "string" &&
				typeof (p as { protocol?: unknown }).protocol === "string");
		if (isUrlLike) {
			const proto = String((p as URL).protocol).toLowerCase();
			if (proto !== "file:") {
				throw new Error(`[confinement] the 'fs' grant rejects the non-file URL scheme "${proto}" (Extension Host §9 isolation)`);
			}
			return urlMod.fileURLToPath(p as URL);
		}
		return undefined; // fd / options / callback → not a path-like argument
	};

	// Resolve a path arg to an ABSOLUTE path under `dir` (leading-relative rebased
	// onto the session dir; absolute kept) and, when `check`, REJECT any path that
	// escapes the session working dir (`../` walk, absolute-outside, symlink escape,
	// OR a not-yet-existent leaf reached THROUGH a symlinked ancestor — all caught
	// by the write/create-safe `withinSession` → strict containment helper). The
	// NORMALIZED string is what we hand the real fs method, so a Buffer / file-URL
	// arg is validated AND rewritten to the contained absolute path.
	// `realpath`/`realpathSync` are normalized + rebased but NOT containment-checked:
	// they merely RESOLVE a path (the actual read/write goes through a checked
	// method), AND the shared `path-guard` helper reuses this same wrapped fs to
	// realpath the (out-of-tree) PACK ROOT — throwing there would break module
	// containment and recurse through `withinSession`.
	const confine = (p: unknown, check: boolean): unknown => {
		const str = normalizeToPath(p); // throws on a non-file: URL scheme
		if (str === undefined) return p; // fd / options / callback → leave untouched
		const abs = pathMod.isAbsolute(str) ? str : pathMod.resolve(dir, str);
		// Gate the containment THROW on the path-guard helper being loaded: it is set
		// at the END of `confinementReady`, and PACK code runs only AFTER that. The
		// few fs calls made WHILE it is unset are the host's own setup machinery (the
		// `path-guard` dynamic import — and, under the tsx unit loader, its transpile
		// cache reads) — never pack code — so they must not be confined. Once it is
		// set, every pack fs call is checked (and the loader's own reads of the pack
		// source / cache resolve as in-bounds or ENOENT-tolerated, so they pass).
		if (check && sessionContainment && !withinSession(dir, abs)) {
			throw new Error(`[confinement] the 'fs' grant restricts paths to the session working directory; "${str}" escapes it (Extension Host §9 isolation)`);
		}
		return abs;
	};
	// `glob`/`globSync` ALSO honor an `options.cwd` that resolves the pattern — an
	// unchecked `cwd` would leak directory LISTINGS outside the working dir (the
	// pattern arg alone is not the whole story). Containment-check + rebase any
	// supplied `cwd` (mirrors the `git` runner's `applyGitCwd`).
	const confineGlobCwd = (args: unknown[]): void => {
		for (let i = 1; i < args.length; i++) {
			const a = args[i];
			if (a && typeof a === "object" && !Array.isArray(a) && typeof a === "object" && "cwd" in (a as Record<string, unknown>) && (a as Record<string, unknown>).cwd !== undefined) {
				args[i] = { ...(a as Record<string, unknown>), cwd: confine((a as Record<string, unknown>).cwd, true) };
			}
		}
	};
	const wrap = (mod: Record<string, unknown>): void => {
		for (const name of Object.keys(mod)) {
			if (!pathArgSet.has(name)) continue;
			const fn = mod[name];
			if (typeof fn !== "function") continue;
			const twoPath = twoPathSet.has(name);
			const globLike = name === "glob" || name === "globSync";
			// `realpath`/`realpathSync` only RESOLVE (do not disclose content) and the
			// shared path-guard helper reuses this same wrap to realpath the
			// out-of-tree PACK ROOT — so they are NOT containment-checked (their copied
			// `.native` sub-fn is consistently resolve-only too).
			const check = name !== "realpath" && name !== "realpathSync";
			const wrapped = function (this: unknown, ...args: unknown[]): unknown {
				if (args.length > 0) args[0] = confine(args[0], check);
				if (twoPath && args.length > 1) args[1] = confine(args[1], check);
				if (globLike) confineGlobCwd(args);
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
 *  marshalled to the parent (authorized there); identity + flags are local. */
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
