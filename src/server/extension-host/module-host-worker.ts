// src/server/extension-host/module-host-worker.ts
//
// Slice C3 — server-module isolation (Extension Host Phase 2, design
// docs/design/extension-host-phase2.md §9). Runs a pack server module member (an
// `actions`/`routes` handler) in a confined, terminate-able `worker_threads`
// Worker with resource caps, behind a request/response message protocol whose
// ONLY granted capability is the host-API proxy.
//
// This is the execution strategy the dispatchers' SINGLE invocation seam swaps
// onto (action-dispatcher.ts / route-dispatcher.ts): `ModuleHost.invoke(...)`
// replaces the in-process `handler(ctx, args)` call WITHOUT touching callers. The
// dispatcher keeps its blast-radius controls (per-session rate limit, global
// concurrency cap, permit-held-until-the-work-settles, bounded reload retry); the
// worker adds what Phase 1 could not — TRUE termination of a runaway handler.
//
// **Confinement (design §9 — three layers, not "a bare worker is a sandbox"):**
//   1. Empty env: `new Worker(..., { env: {} })` — the worker holds NO gateway
//      token / secret (those live only in the parent process env).
//   2. Module-load deny-hook: the bootstrap (`module-host-bootstrap.ts`) installs
//      `confinement-loader.ts` BEFORE importing pack code, denying fs/network/
//      child_process/process/worker_threads/etc. to the pack module graph.
//   3. Terminate-on-timeout (also the CPU control — worker_threads has no per-core
//      throttle) + `resourceLimits` memory caps. The parent races a timer; on
//      timeout it calls `worker.terminate()` (true cancellation) and rejects 504.
//
// **Isolation is UNCONDITIONAL.** There is NO config flag, env var, or runtime
// toggle that runs a pack server module in-process in any shippable/packaged/CI
// build (design §9). The dispatchers ALWAYS route their seam through
// `ModuleHost.invoke`; there is no in-process fallback to gate, so the shipped
// configuration can never disable isolation.

import { Worker } from "node:worker_threads";
import { ActionError, type ActionHandlerCtx } from "./action-dispatcher.js";

/** First-path-segment deny-list handed to the confinement loader (design §9). The
 *  pack module graph cannot import any built-in whose first segment is in this set
 *  (so `node:fs/promises` and `node:http2` are denied via `fs` / `http2`). The
 *  bootstrap imports its OWN `worker_threads`/`module` plumbing BEFORE registering
 *  the hook, so these denials never block the confinement machinery itself. */
export const DENIED_BUILTINS: readonly string[] = [
	"fs",
	"child_process",
	"net",
	"http",
	"https",
	"http2",
	"dns",
	"tls",
	"dgram",
	"cluster",
	"worker_threads",
	"module",
	"process",
	"inspector",
	"v8",
	"vm",
	"repl",
	"sea",
	"trace_events",
];

export interface ModuleHostOptions {
	/** Default per-invoke wall-time before terminate-on-timeout (ms). A per-call
	 *  override is passed by the dispatcher (its own `timeoutMs`). Default 30_000. */
	timeoutMs?: number;
	/** Worker old-generation heap cap (MB) — the memory blast-radius bound. Default 256. */
	maxOldGenerationSizeMb?: number;
	/** Worker stack cap (MB). Default 4. */
	stackSizeMb?: number;
}

export interface InvokeRequest {
	/** The epoch-cache-busted file URL the dispatcher resolved + validated; the
	 *  worker dynamic-imports THIS exact URL (design §9 — same URL the dispatcher
	 *  builds). */
	url: string;
	/** Snapshot of the dispatcher epoch at resolution (carried for audit/debug). */
	epoch: number;
	/** Which export group on the pack module holds the member. */
	exportKind: "actions" | "routes";
	/** The member (action/route name) to invoke — pre-validated by the dispatcher. */
	member: string;
	/** The FULL handler context. Its `host` (a live ServerHostApi) stays in the
	 *  parent and services the worker's proxied store/session calls; only the
	 *  identity + capability flags cross the MessagePort. */
	ctx: ActionHandlerCtx;
	/** The handler argument (args for an action, RouteRequest for a route). */
	arg: unknown;
}

/** Flag NAMES safe to forward to a `worker_threads.Worker` execArgv. Node rejects
 *  most process-level flags (e.g. `--use-largepages`, `--v8-pool-size`, the
 *  node:test runner's internal flags) when starting a Worker; only a small set
 *  (the module loader / require / conditions flags) is permitted. We forward ONLY
 *  these so the worker inherits the TS loader (tsx) under the unit runner while
 *  dropping the unsupported flags that would otherwise make `new Worker` throw. */
const WORKER_SAFE_EXEC_FLAGS = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader", "--conditions", "-C"]);

/** Filter `process.execArgv` down to the Worker-safe loader flags (handling both
 *  `--flag=value` and `--flag value` forms). In production (plain node, no
 *  loaders) this is empty; under the tsx unit runner it keeps `--require`/`--import`
 *  so the worker can transpile the `.ts` bootstrap + pack module. */
function workerSafeExecArgv(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.indexOf("=");
		const name = eq >= 0 ? a.slice(0, eq) : a;
		if (!WORKER_SAFE_EXEC_FLAGS.has(name)) continue;
		out.push(a);
		// Two-token form: keep the following value token (not another flag).
		if (eq < 0 && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
			out.push(argv[++i]);
		}
	}
	return out;
}

/** Methods the worker is permitted to proxy back to the parent host. A worker can
 *  ONLY drive these exact `host.<ns>.<method>` calls — never arbitrary property
 *  access on the live host object (no `constructor`, no prototype walk). */
const PROXYABLE: Record<string, Set<string>> = {
	store: new Set(["get", "put", "list"]),
	session: new Set(["readTranscript", "readToolCall", "postMessage"]),
};

/** Invoke a proxied host method on the PARENT's live host, enforcing the
 *  allowlist. The worker has no ambient access; this is the single sanctioned
 *  worker→parent capability channel (host calls are authorized here). */
async function invokeHostMethod(host: unknown, path: unknown, args: unknown[]): Promise<unknown> {
	if (!Array.isArray(path) || path.length !== 2 || typeof path[0] !== "string" || typeof path[1] !== "string") {
		throw new Error("invalid host-call path");
	}
	const [ns, method] = path as [string, string];
	if (!PROXYABLE[ns]?.has(method)) {
		throw new Error(`host.${ns}.${method} is not a permitted proxied capability`);
	}
	const target = (host as Record<string, Record<string, unknown>> | undefined)?.[ns];
	const fn = target?.[method];
	if (typeof fn !== "function") {
		throw new Error(`host.${ns}.${method} is unavailable`);
	}
	return await (fn as (...a: unknown[]) => unknown).apply(target, args);
}

/**
 * Runs pack server module members in confined workers. ONE instance is shared by
 * the action + route dispatchers for the gateway process lifetime (constructed in
 * server.ts). Each `invoke` spawns a FRESH worker (clean module registry → crash
 * isolation + true terminate), services its proxied host calls, and tears it down
 * when the call settles or times out.
 */
export class ModuleHost {
	private readonly defaultTimeoutMs: number;
	private readonly maxOldGenerationSizeMb: number;
	private readonly stackSizeMb: number;
	/** Live workers, so `dispose()` can terminate any still-running on shutdown. */
	private readonly live = new Set<Worker>();
	private disposed = false;

	constructor(opts: ModuleHostOptions = {}) {
		this.defaultTimeoutMs = opts.timeoutMs ?? 30_000;
		this.maxOldGenerationSizeMb = opts.maxOldGenerationSizeMb ?? 256;
		this.stackSizeMb = opts.stackSizeMb ?? 4;
	}

	/** Resolve the worker bootstrap sibling with the SAME extension as THIS module
	 *  (`.js` compiled in dist; `.ts` under the tsx unit runner). */
	private bootstrapUrl(): URL {
		const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
		return new URL(`./module-host-bootstrap${ext}`, import.meta.url);
	}

	/**
	 * Run `req.member` in a confined worker; resolve with its result, or reject
	 * `ActionError`:
	 *   - handler throw → 500 (message preserved); crash/OOM/exit → 500;
	 *   - timeout → 504 after `worker.terminate()` (true cancellation — the CPU /
	 *     runaway control). `timeoutMs` overrides the constructor default (the
	 *     dispatcher passes its own per-call timeout).
	 * The worker is ALWAYS terminated before this settles (no zombie threads).
	 */
	invoke(req: InvokeRequest, timeoutMs?: number): Promise<unknown> {
		if (this.disposed) return Promise.reject(new ActionError(500, "module host disposed"));
		const limit = timeoutMs ?? this.defaultTimeoutMs;
		const host = (req.ctx as { host?: unknown } | undefined)?.host;
		const capSrc = (host as { capabilities?: Record<string, unknown> } | undefined)?.capabilities;
		const serCtx = {
			sessionId: req.ctx?.sessionId,
			toolUseId: req.ctx?.toolUseId,
			tool: req.ctx?.tool,
			hostVersion: (host as { version?: number } | undefined)?.version,
			hostContractVersion: (host as { contractVersion?: number } | undefined)?.contractVersion,
			capabilities: {
				callRoute: capSrc?.callRoute === true,
				session: capSrc?.session === true,
				store: capSrc?.store === true,
			},
		};

		const worker = new Worker(this.bootstrapUrl(), {
			// Layer 1 — empty env: the worker holds no gateway token / secret.
			env: {},
			workerData: { denied: [...DENIED_BUILTINS] },
			// Layer 3 — memory caps.
			resourceLimits: {
				maxOldGenerationSizeMb: this.maxOldGenerationSizeMb,
				stackSizeMb: this.stackSizeMb,
			},
			// Forward ONLY the Worker-safe loader flags (drops node:test / process-level
			// flags that `new Worker` rejects) so the worker transpiles TS under the tsx
			// unit runner; empty in production (no loaders).
			execArgv: workerSafeExecArgv(process.execArgv),
		});
		this.live.add(worker);

		return new Promise<unknown>((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.live.delete(worker);
				// Layer 3 — true terminate-on-timeout (and unconditional teardown so a
				// completed worker never lingers). terminate() is fire-and-forget.
				void worker.terminate();
				fn();
			};
			// Layer 3 — wall-time termination IS the CPU-exhaustion control (a runaway
			// while(1) is KILLED here; worker_threads has no per-core throttle).
			const timer = setTimeout(() => {
				finish(() => reject(new ActionError(504, "pack server module timed out")));
			}, limit);

			worker.on("message", (msg: { kind?: string; ok?: boolean; value?: unknown; status?: number; error?: string; id?: number; path?: unknown; args?: unknown[] }) => {
				if (msg?.kind === "result") {
					if (msg.ok) finish(() => resolve(msg.value));
					else finish(() => reject(new ActionError(typeof msg.status === "number" ? msg.status : 500, msg.error ?? "pack server module failed")));
					return;
				}
				if (msg?.kind === "host-call") {
					// Service the proxied host call on the parent's LIVE host, then
					// reply over the same channel. Errors are surfaced to the worker's
					// awaiting proxy (never crash the parent).
					void invokeHostMethod(host, msg.path, Array.isArray(msg.args) ? msg.args : []).then(
						(value) => { if (!settled) worker.postMessage({ kind: "host-reply", id: msg.id, ok: true, value }); },
						(err: unknown) => { if (!settled) worker.postMessage({ kind: "host-reply", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }); },
					);
					return;
				}
			});
			// Crash isolation: an uncaught worker error (incl. OOM "reached memory
			// limit") or premature exit becomes an ActionError, never process death.
			worker.on("error", (err) => {
				finish(() => reject(new ActionError(500, err instanceof Error ? err.message : String(err))));
			});
			worker.on("exit", (code) => {
				finish(() => reject(new ActionError(500, `pack server module worker exited (code ${code}) before producing a result`)));
			});

			try {
				worker.postMessage({ kind: "invoke", url: req.url, epoch: req.epoch, exportKind: req.exportKind, member: req.member, ctx: serCtx, arg: req.arg });
			} catch (err) {
				finish(() => reject(new ActionError(500, `failed to dispatch to worker: ${err instanceof Error ? err.message : String(err)}`)));
			}
		});
	}

	/** Terminate any live workers (gateway shutdown / test teardown). */
	dispose(): void {
		this.disposed = true;
		for (const w of this.live) void w.terminate();
		this.live.clear();
	}
}
