// src/server/extension-host/module-host-worker.ts
//
// Server-module RESOURCE + CRASH isolation. Runs a pack server module member (an
// `actions`/`routes` handler) in a terminate-able `worker_threads` Worker with
// resource caps, behind a request/response message protocol whose only proxied
// capability back to the parent is the host-API proxy.
//
// Pack SERVER code is TRUSTED — the same tier as a tool or MCP server the user
// chose to install — so it runs with FULL ambient parity: normal `node:` built-ins,
// normal network globals, the normal `process` (full env). There is NO capability
// sandbox; a per-capability sandbox over trusted in-process code is false security
// (a native `.node` addon or the shared process trivially defeats it). The ONLY
// isolation kept is the kind that is genuine:
//
//   - **Resource/crash isolation:** terminate-on-timeout (also the CPU control —
//     worker_threads has no per-core throttle), `resourceLimits` memory/stack caps,
//     and SIGKILL of any spawned OS child on terminate. The parent races a timer; on
//     timeout it calls `worker.terminate()` (true cancellation) + kills tracked
//     children and rejects 504.
//   - **Module-import containment** (in `module-host-bootstrap.ts` /
//     `confinement-loader.ts`): the pack module graph can only resolve `file:` URLs
//     within the pack root. This is cheap loader/stability hygiene, NOT a security
//     boundary (fs is ambient now).
//
// This is the execution strategy the dispatchers' SINGLE invocation seam swaps
// onto (action-dispatcher.ts / route-dispatcher.ts): `ModuleHost.invoke(...)`
// replaces the in-process `handler(ctx, args)` call WITHOUT touching callers. The
// dispatcher keeps its blast-radius controls (per-session rate limit, global
// concurrency cap, permit-held-until-the-work-settles, bounded reload retry); the
// worker adds what Phase 1 could not — TRUE termination of a runaway handler.
//
// **Isolation is UNCONDITIONAL.** There is NO config flag, env var, or runtime
// toggle that runs a pack server module in-process in any shippable/packaged/CI
// build. The dispatchers ALWAYS route their seam through `ModuleHost.invoke`; there
// is no in-process fallback to gate, so the shipped configuration can never disable
// the resource/crash isolation.

import { Worker } from "node:worker_threads";
import { ActionError, type ActionHandlerCtx } from "./action-dispatcher.js";

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
	 *  worker dynamic-imports THIS exact URL (same URL the dispatcher builds). */
	url: string;
	/** The validated pack group root (the dispatcher's `groupDir`) the entry module
	 *  was loaded from. Forwarded into the worker's module-import containment loader
	 *  so EVERY resolved `file:` URL in the pack module graph must stay realpath-
	 *  contained within it — a pack module cannot `import`/`require` a file OUTSIDE
	 *  its own pack root (relative `../` walk, absolute path, symlink, or ancestor
	 *  `node_modules`). This is loader/stability hygiene, not a security boundary. */
	packRoot: string;
	/** Snapshot of the dispatcher epoch at resolution (carried for audit/debug). */
	epoch: number;
	/** Which export group on the pack module holds the member. */
	exportKind: "actions" | "routes" | "providers";
	/** The member (action/route name) to invoke — pre-validated by the dispatcher. */
	member: string;
	/** The FULL handler context. Its `host` (a live ServerHostApi) stays in the
	 *  parent and services the worker's proxied store/session calls; only the
	 *  identity + capability flags cross the MessagePort. */
	ctx: ActionHandlerCtx;
	/** The handler argument (args for an action, RouteRequest for a route). */
	arg: unknown;
	/** The session working directory — the worker's `process.cwd()` for tool parity
	 *  (a tool/MCP server runs rooted at the session worktree; worker threads can't
	 *  `chdir`, so the bootstrap overrides `process.cwd` to this). Relative spawns +
	 *  bare-relative fs paths resolve under it. Absent ⇒ the worker's real cwd. */
	workingDir?: string;
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
	// `session` is READ-ONLY for server modules. `postMessage` is intentionally
	// EXCLUDED: the parent `ServerHostApi` omits it (server modules have no user
	// gesture), so proxying it would always throw — authors get reads only.
	session: new Set(["readTranscript", "readToolCall"]),
	// SUB-GOAL C: the ambient `host.agents` capability. A pack handler drives child
	// agents through these six poll-based verbs ONLY (no blocking `wait`); the live
	// `ServerHostApi` with the bound owner/source scoping stays in the PARENT and
	// services the proxied calls over the same channel.
	agents: new Set(["spawn", "prompt", "dismiss", "list", "read", "status"]),
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
	/** Live workers → the OS child PIDs each spawned. `dispose()` terminates any
	 *  still-running worker AND kills its tracked children; the per-invoke
	 *  terminate-on-timeout path does the same so a runaway spawned child cannot
	 *  outlive the wall-time cap. */
	private readonly live = new Map<Worker, Set<number>>();
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
		const providerCtx = req.ctx as unknown as Record<string, unknown>;
		const serCtx = req.exportKind === "providers"
			? {
				...providerCtx,
				workingDir: providerCtx.workingDir ?? req.workingDir,
				capabilities: { callRoute: false, session: false, store: false, agents: false },
			}
			: {
				sessionId: req.ctx?.sessionId,
				toolUseId: req.ctx?.toolUseId,
				tool: req.ctx?.tool,
				workingDir: req.ctx?.workingDir,
				hostVersion: (host as { version?: number } | undefined)?.version,
				hostContractVersion: (host as { contractVersion?: number } | undefined)?.contractVersion,
				capabilities: {
					callRoute: capSrc?.callRoute === true,
					session: capSrc?.session === true,
					store: capSrc?.store === true,
					agents: capSrc?.agents === true,
				},
			};

		const worker = new Worker(this.bootstrapUrl(), {
			// No `env` option: the worker inherits a full copy of the gateway env
			// (full-env parity — trusted pack code is the tool/MCP tier).
			//
			// `wallCapMs` lets the bootstrap bound a SYNCHRONOUS child's injected
			// `timeout` BELOW this cap: a blocking sync call (`spawnSync`/`execSync`/
			// `execFileSync`) cannot report its pid to the kill-set (the worker thread is
			// frozen for the call's whole duration), so Node's own timeout must SIGKILL
			// the child before this terminate-on-timeout reaps the (blocked) thread —
			// otherwise the OS child (a child of the MAIN process) orphans past the cap.
			workerData: { packRoot: req.packRoot, workingDir: req.workingDir, wallCapMs: limit },
			// Memory caps.
			resourceLimits: {
				maxOldGenerationSizeMb: this.maxOldGenerationSizeMb,
				stackSizeMb: this.stackSizeMb,
			},
			// Forward ONLY the Worker-safe loader flags (drops node:test / process-level
			// flags that `new Worker` rejects) so the worker transpiles TS under the tsx
			// unit runner; empty in production (no loaders).
			execArgv: workerSafeExecArgv(process.execArgv),
		});
		const children = new Set<number>();
		this.live.set(worker, children);

		return new Promise<unknown>((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.live.delete(worker);
				// True terminate-on-timeout (and unconditional teardown so a completed
				// worker never lingers). terminate() is fire-and-forget.
				void worker.terminate();
				// A child process spawned by a handler is a child of the MAIN gateway
				// process — worker.terminate() does NOT reap it. Kill any still-running
				// tracked child so a runaway spawn cannot outlive the cap.
				killChildren(children);
				fn();
			};
			// Wall-time termination IS the CPU-exhaustion control (a runaway
			// while(1) is KILLED here; worker_threads has no per-core throttle).
			const timer = setTimeout(() => {
				finish(() => reject(new ActionError(504, "pack server module timed out")));
			}, limit);

			worker.on("message", (msg: { kind?: string; ok?: boolean; value?: unknown; status?: number; error?: string; id?: number; path?: unknown; args?: unknown[]; pid?: number }) => {
				if (msg?.kind === "result") {
					if (msg.ok) finish(() => resolve(msg.value));
					else finish(() => reject(new ActionError(typeof msg.status === "number" ? msg.status : 500, msg.error ?? "pack server module failed")));
					return;
				}
				if (msg?.kind === "child-spawn") {
					if (typeof msg.pid === "number") children.add(msg.pid);
					return;
				}
				if (msg?.kind === "child-exit") {
					if (typeof msg.pid === "number") children.delete(msg.pid);
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

	/** Terminate any live workers + kill their tracked children (gateway shutdown /
	 *  test teardown) so no spawned child survives the host. */
	dispose(): void {
		this.disposed = true;
		for (const [w, children] of this.live) {
			void w.terminate();
			killChildren(children);
		}
		this.live.clear();
	}
}

/** SIGKILL every still-running tracked child PID (best-effort; an already-exited
 *  pid throws ESRCH which we swallow). This is the parent-side half of the
 *  spawned-child blast-radius control — spawned children are children of the MAIN
 *  process, so worker.terminate() alone leaves them running. */
function killChildren(children: Set<number>): void {
	for (const pid of children) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already exited / not permitted — best effort */
		}
	}
	children.clear();
}
