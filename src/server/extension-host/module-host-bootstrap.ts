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

import { registerHooks } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { configure as configureConfinement, resolve as confinementResolve } from "./confinement-loader.js";

interface BootstrapData {
	/** First-path-segment deny-list forwarded to the confinement hook. */
	denied: string[];
	/** The validated pack group root forwarded to the confinement hook so every
	 *  resolved `file:` URL in the pack module graph stays realpath-contained within
	 *  it (no `../`/absolute/symlink/node_modules escape outside the pack). */
	packRoot?: string;
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

// ── (2) Install the module-load deny+confine hook BEFORE any pack module is
// imported. The hook + its shared `path-guard` dep are STATICALLY imported above
// (resolved by THIS worker thread's loader), so `configure` + `resolve` are
// already loaded; `registerHooks` installs the synchronous in-thread hook so the
// pack graph imported afterward is both deny-listed and pack-root-confined.
configureConfinement({ denied: data.denied, packRoot: data.packRoot });
registerHooks({ resolve: confinementResolve });

// ── (3) Remove ambient web/process globals BEFORE any pack module is imported. ──
removeAmbientGlobals();

/**
 * Strip the ambient capabilities a `worker_threads.Worker` inherits that the
 * module-load deny-hook does NOT cover (it denies `node:` IMPORTS, but these are
 * reachable as GLOBALS without an import). After this runs, the ONLY capability
 * pack code is handed is the host-API proxy over the parent MessagePort.
 *
 *   (a) Outbound-network globals — `fetch` (SSRF / arbitrary egress) plus the
 *       WHATWG fetch types and the legacy `XMLHttpRequest`/`WebSocket`/
 *       `EventSource` surfaces — are deleted.
 *   (b) The ambient `process` global is REPLACED with an inert shim: empty frozen
 *       env (no host secrets/metadata), no `exit`/`abort`/`kill`, no
 *       `binding`/`dlopen` (native escape), no `argv`/`cwd`/`execPath` leaking
 *       host data. `node:process` is already denied by the loader; this closes
 *       the ambient-global path. Node internals + the loader thread keep their
 *       OWN process reference (via the internal binding / require('process')), so
 *       only PACK code on this thread sees the shim.
 */
function removeAmbientGlobals(): void {
	const g = globalThis as unknown as Record<string, unknown>;
	// (a) Delete every outbound-network global — pack code's only egress is the host proxy.
	for (const key of ["fetch", "WebSocket", "XMLHttpRequest", "Request", "Response", "Headers", "EventSource", "sendBeacon", "navigator"]) {
		try {
			delete g[key];
		} catch {
			/* best effort */
		}
	}
	// (b) Replace the ambient `process` global with an inert shim.
	const denied = (name: string) => () => {
		throw new Error(`[confinement] process.${name} is denied to pack server modules (Extension Host §9 isolation)`);
	};
	const inert: Record<string, unknown> = {
		env: Object.freeze({}),
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
		cwd: () => "/",
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
