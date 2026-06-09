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
//   1. Import `worker_threads` + `module` (the confinement plumbing) — done at the
//      top, BEFORE the deny-hook is installed, so the deny-list never blocks it.
//   2. Install the module-load DENY-HOOK (`confinement-loader.ts`) via
//      `module.register`, so the pack module graph imported afterward cannot reach
//      `node:fs`/`child_process`/network/`process`/`worker_threads`/etc.
//   3. Harden the global `process` defensively (env is already empty; remove the
//      native-binding escape vectors).
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

import { register } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

interface BootstrapData {
	/** First-path-segment deny-list forwarded to the confinement loader. */
	denied: string[];
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

// ── (2) Install the module-load deny-hook BEFORE any pack module is imported. ──
// Resolve the loader sibling with the SAME extension as THIS module so it works
// both compiled (`.js` in dist) and under the tsx unit runner (`.ts`).
const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
register(new URL(`./confinement-loader${ext}`, import.meta.url).href, {
	data: { denied: data.denied },
});

// ── (3) Defensive global hardening (env is already empty via `{ env: {} }`). ──
hardenGlobals();

function hardenGlobals(): void {
	try {
		// Empty + freeze env so even if something repopulated it, pack code cannot
		// read host secrets (the worker was started with `{ env: {} }`).
		Object.freeze((process as { env: Record<string, string> }).env);
	} catch {
		/* best effort */
	}
	// Remove the native-binding / dynamic-link escape vectors from the process
	// global (importing `node:process` is already denied by the loader; this closes
	// the AMBIENT `process` global path).
	for (const key of ["binding", "_linkedBinding", "dlopen", "kill", "abort", "exit"]) {
		try {
			delete (process as unknown as Record<string, unknown>)[key];
		} catch {
			/* best effort */
		}
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
		// Own-property + function check (mirrors the dispatcher's parent-side guard):
		// never invoke an INHERITED member (`constructor`, `toString`, …) even if this
		// worker is driven directly — defense-in-depth against a prototype-walk.
		const fn = group && Object.prototype.hasOwnProperty.call(group, msg.member) ? group[msg.member] : undefined;
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
