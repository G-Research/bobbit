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
//   1. Import `worker_threads` + `module` + the confinement hook (and its shared
//      `path-guard` dep) — done at the top, BEFORE the hook is installed, so the
//      deny-list never blocks the confinement plumbing's own imports.
//   2. Install the module-load DENY+CONFINE hook (`confinement-loader.ts`) via the
//      IN-THREAD `module.registerHooks({ resolve })`, so the pack module graph
//      imported afterward cannot reach `node:fs`/`child_process`/network/`process`/
//      `worker_threads`/etc., NOR `import`/`require` any `file:` OUTSIDE its own
//      pack root (relative `../` walk, absolute path, symlink, or ancestor
//      `node_modules`). In-thread (synchronous) hooks run in THIS worker thread, so
//      the hook can call the shared `path-guard` helper directly — no separate
//      hooks thread, no cross-thread marshalling, no `.ts`/`.js` resolution gap.
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

// NOTE: `process.chdir()` is unsupported inside a worker thread, so the worker's
// REAL cwd stays at startup. The session working dir is instead surfaced through
// the process SHIM's `cwd()` (set in removeAmbientGlobals) — a `git`/`fs`-granted
// pack reads `process.cwd()` and passes it explicitly to `spawn(..., { cwd })` /
// fs path joins. The git BINARY itself resolves via PATH in the worker's real env
// (seeded by the parent), independent of cwd.

// ── (2) Install the module-load deny+confine hook BEFORE any pack module is
// imported. The hook + its shared `path-guard` dep are STATICALLY imported above
// (resolved by THIS worker thread's loader), so `configure` + `resolve` are
// already loaded; `registerHooks` installs the synchronous in-thread hook so the
// pack graph imported afterward is both deny-listed and pack-root-confined.
configureConfinement({ denied: data.denied, packRoot: data.packRoot });
registerHooks({ resolve: confinementResolve });

// ── (3) Remove ambient web/process globals BEFORE any pack module is imported. ──
// Slice C3: granted capabilities are skipped here (`net` keeps the network
// globals; `git`/`fs` get a REAL cwd + minimal PATH env on the process shim).
removeAmbientGlobals(grants, data.workingDir);

// ── (3b) Slice C3: when `git` is granted, `child_process` is un-denied so the
// pack can spawn the git binary. Spawned children are children of the MAIN
// process (worker.terminate() does NOT reap them), so we WRAP the spawn surface
// to report each child's pid (spawn + exit) to the parent over the MessagePort;
// the parent kills any still-running child on terminate-on-timeout. Patch the CJS
// builtin via createRequire BEFORE the pack imports it, so the ESM facade the pack
// receives reflects the wrapped functions (Node creates the facade lazily from
// the current CJS exports). createRequire is statically imported above (before the
// hook), and `child_process` is un-denied under this grant, so this resolves.
if (hasGrant(grants, "git")) {
	try {
		wrapChildProcessSpawnSurface();
	} catch {
		/* best effort — if wrapping fails the child-kill safety net is reduced, but
		   the wall-time terminate still bounds the worker thread itself */
	}
}

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
 * Slice C3 (declared-permission `git`) — wrap the async `child_process` spawn
 * surface so every spawned child's pid is reported to the parent (spawn + exit)
 * over the MessagePort. The parent kills any child still running when it
 * terminates the worker on timeout, so a runaway git cannot outlive the wall-time
 * cap (worker.terminate() reaps only the THREAD, not the spawned OS child).
 *
 * Patching the CJS builtin via `createRequire` BEFORE the pack imports it makes
 * the pack's ESM facade (`import { spawn } from "node:child_process"`, default,
 * and namespace forms) reflect the wrapped functions — Node builds the facade
 * lazily from the current CJS exports. Only the ASYNC surface is wrapped; the
 * synchronous `spawnSync`/`execSync` block the worker thread and are reaped by
 * terminate directly.
 */
function wrapChildProcessSpawnSurface(): void {
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
			const child = (orig as (...a: unknown[]) => unknown).apply(this, args);
			report(child);
			return child;
		};
	}
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
		session: {
			readTranscript: (opts?: unknown) => callHost(["session", "readTranscript"], [opts]),
			readToolCall: (toolUseId: string) => callHost(["session", "readToolCall"], [toolUseId]),
			postMessage: (msg: unknown) => callHost(["session", "postMessage"], [msg]),
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
		void handleInvoke(msg);
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
