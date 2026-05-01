/**
 * DelegateHarness — restart-resilient blocking-tool harness for the `delegate`
 * tool. Mirrors `VerificationHarness` and the pattern documented in
 * `docs/blocking-tools.md`. See `docs/design/delegate-restart-resilience.md`
 * for the full design.
 *
 * Keyed by `(parentSessionId, toolUseId)` so a single parent with N concurrent
 * `parallel:` delegates tracks each independently. Persisted to
 * `<stateDir>/active-delegates.json` on every mutation via atomic
 * write-then-rename, so a server restart while a delegate is in flight does
 * not lose the parent's parked Promise.
 *
 * Two complementary maps:
 *   - `pending`  — parked Promise resolvers keyed by `<parent>:<toolUseId>`.
 *   - `latched`  — terminal results that arrived before the parent
 *                  (re)registered. On register, we drain any matching latch.
 *
 * `submit` is idempotent (second call for the same key is a no-op) and
 * never blocks. `register` is idempotent across restart: a previously-latched
 * result drains immediately; a re-register against an existing pending entry
 * supersedes the prior resolver.
 */
import fs from "node:fs";
import path from "node:path";

/** Terminal result delivered back to the parent's `delegate` tool call. */
export interface DelegateResultPayload {
	status: "completed" | "failed" | "timeout" | "terminated";
	output: string;
	error?: string;
}

/**
 * Snapshot of an in-flight delegate persisted to `active-delegates.json`.
 * The in-memory resolver is intentionally not persisted — it cannot survive a
 * restart by definition. After restart, `_loadFromDisk` repopulates the
 * pending map with metadata only; a `submit` arriving before the parent
 * re-registers is latched, draining on the next `register` call.
 */
export interface ActiveDelegate {
	parentSessionId: string;
	/**
	 * Tool-use id of the parent's `delegate` call. For `parallel:` invocations
	 * the harness key is `${toolUseId}#${i}` so each parallel slot is tracked
	 * independently — callers must include the `#i` suffix here when
	 * registering parallel delegates.
	 */
	toolUseId: string;
	delegateSessionId: string;
	cwd: string;
	title?: string;
	sandboxed?: boolean;
	instructions: string;
	timeoutMs: number;
	createdAt: number;
}

interface PendingEntry {
	resolve: (r: DelegateResultPayload) => void;
	reject: (err: Error) => void;
	active: ActiveDelegate;
}

interface LatchedEntry {
	key: string;
	result: DelegateResultPayload;
}

interface PersistedShape {
	pending: ActiveDelegate[];
	latched: LatchedEntry[];
}

type DelegateKey = string;

function delegateKey(parentSessionId: string, toolUseId: string): DelegateKey {
	return `${parentSessionId}:${toolUseId}`;
}

/**
 * Minimal subset of `SessionManager` the harness depends on. Kept narrow so
 * unit tests can supply a stub or `undefined`.
 */
export interface DelegateHarnessSessionManager {
	addTerminationListener?(
		fn: (sessionId: string, info: { projectId?: string; reason: "terminated" | "archived" | "purged" }) => void,
	): void;
}

export type DelegateBroadcastFn = (sessionId: string, event: unknown) => void;

export class DelegateHarness {
	private pending = new Map<DelegateKey, PendingEntry>();
	private latched = new Map<DelegateKey, DelegateResultPayload>();
	/**
	 * Keys that have already had a terminal result delivered (resolved a
	 * pending awaiter). Subsequent `submit()` calls for the same key are
	 * dropped — first-write-wins idempotency. Bounded over time by
	 * `register()` clearing the entry when a key is recycled (i.e. a brand
	 * new tool_use_id is registered for the same parent + session).
	 */
	private completed = new Set<DelegateKey>();
	/**
	 * Persisted-but-no-awaiter entries reconstructed from disk on restart.
	 * The original `register()` closures (resolve/reject) lived in v8 heap and
	 * are gone, so calling resolve() on them after restart would dead-end. We
	 * keep them as metadata-only shells: `submit()` against a shell-only key
	 * latches the result instead of resolving (so the parent's next
	 * `register()` POST drains it). Cleared as soon as the parent
	 * (re-)registers a real resolver for the same key.
	 */
	private shells = new Map<DelegateKey, ActiveDelegate>();
	private readonly persistPath: string;

	constructor(
		stateDir: string,
		sessionManager?: DelegateHarnessSessionManager,
		broadcastFn?: DelegateBroadcastFn,
	) {
		this.persistPath = path.join(stateDir, "active-delegates.json");
		this._loadFromDisk();
		// Note: termination cascade is owned by `server.ts` so the caller can
		// also terminate child sessions with the killed-id list. We deliberately
		// do NOT auto-subscribe `addTerminationListener` here — doing both at the
		// harness level and the server level would race: the harness listener
		// would consume `pending`/`shells`/`latched` first, leaving the server
		// listener with an empty `killed` list and no children to terminate.
		// The `sessionManager` and `broadcastFn` parameters are preserved for
		// symmetry with VerificationHarness and to leave hooks for tests / future
		// telemetry without changing the signature.
		void sessionManager;
		void broadcastFn;
	}

	/**
	 * Persist metadata about an in-flight delegate WITHOUT creating a parked
	 * Promise. Used by the live path (`SessionManager.createDelegateSession`)
	 * so the on-disk state exists before the parent's `/wait` POST arrives.
	 *
	 * If a fast child completes via `submit()` before the parent registers,
	 * the harness sees no `pending` entry (only this shell), and `submit()`
	 * latches the result. The parent's later `register()` call drains the
	 * latch immediately. This avoids the live-path race where a
	 * pre-registered Promise would consume the result fire-and-forget,
	 * leaving the parent's real wait to hang.
	 *
	 * Idempotent: calling with an existing `(parent, toolUseId)` key is a
	 * no-op when the harness already has a real `pending` entry (parent
	 * already arrived). When the key is fresh, it adds a shell.
	 */
	recordActive(active: ActiveDelegate): void {
		const key = delegateKey(active.parentSessionId, active.toolUseId);
		if (this.pending.has(key)) return;
		if (this.shells.has(key)) return;
		// Recording a fresh delegate metadata clears any prior
		// idempotency mark for the key (a parent tool extension that
		// re-uses a tool_use_id legitimately wants a fresh lifecycle).
		this.completed.delete(key);
		this.shells.set(key, active);
		this._persist();
	}

	/**
	 * Register a parked Promise for the given delegate. Returns immediately
	 * with a resolved Promise if a result is already latched for the same key.
	 *
	 * If a pending entry already exists for the key (e.g. parent reconnected
	 * after a transient socket drop), the previous Promise is rejected with
	 * `"superseded"` and replaced.
	 */
	register(active: ActiveDelegate): Promise<DelegateResultPayload> {
		const key = delegateKey(active.parentSessionId, active.toolUseId);

		// Idempotency-after-ack: the key has already had its terminal result
		// delivered AND `acknowledge()`d, so there is nothing left to drain.
		// A retried `/wait` from a network-confused parent must not park a
		// fresh resolver — that would hang until timeout. Return a
		// structured "already-delivered" payload so the caller observes the
		// retry as a clean (idempotent) no-op rather than a wedge.
		// `completed` is wiped by `_loadFromDisk()` (so a real restart
		// re-opens the key) and by `recordActive()` when a fresh delegate
		// metadata is recorded for the same key (key recycle).
		if (this.completed.has(key) && !this.latched.has(key)) {
			return Promise.resolve({
				status: "completed",
				output: "",
				error: "delegate result already delivered (idempotent retry)",
			});
		}

		// Drain any latched result — submit-before-register is supported (and
		// is the whole point of restart-survival). Durability invariant: the
		// latch must NOT be deleted here, because the `/api/internal/delegate/wait`
		// handler acknowledges only AFTER `res.end()` flushes the body to the
		// parent. If we deleted the latch synchronously and the gateway
		// crashed between this return and the HTTP flush, the result would
		// be lost — a retried `/wait` would see no latch and park forever.
		// Instead we leave the latch in place; the matching `acknowledge()`
		// call from the handler clears it once the parent has demonstrably
		// received the bytes. The shell is cleared (it's purely metadata
		// for `getActiveDelegateSessionIds()` and not part of the durable
		// result record).
		const existingLatched = this.latched.get(key);
		if (existingLatched) {
			if (this.shells.delete(key)) this._persist();
			return Promise.resolve(existingLatched);
		}

		// Replace any shell with a live resolver.
		this.shells.delete(key);

		// Supersede any stale pending entry.
		const stale = this.pending.get(key);
		if (stale) {
			this.pending.delete(key);
			try { stale.reject(new Error("superseded")); } catch { /* ignore */ }
		}

		return new Promise<DelegateResultPayload>((resolve, reject) => {
			this.pending.set(key, { resolve, reject, active });
			this._persist();
		});
	}

	/**
	 * Cancel a single in-flight delegate. Used by:
	 *   - the `/api/internal/delegate/wait` hard-timeout path, and
	 *   - the `/api/internal/delegate/cancel` parent-abort endpoint.
	 *
	 * Resolves any pending awaiter with a structured `terminated` payload
	 * (so the parent's `/wait` HTTP handler observes the same shape it would
	 * for a normal terminal submit), then drops shell + latched state and
	 * marks the key completed so a racing submit is a no-op. Returns `true`
	 * if anything was cleaned up.
	 *
	 * This is the cleanup-friendly counterpart to `submit()`: submit against
	 * a shell-only key would *latch* the terminated result and leave the
	 * shell live, which is wrong for an abort because no parent will ever
	 * acknowledge the latch — it would persist in `active-delegates.json`
	 * indefinitely.
	 */
	cancel(parentSessionId: string, toolUseId: string, reason = "cancelled"): boolean {
		const key = delegateKey(parentSessionId, toolUseId);
		let found = false;
		const result: DelegateResultPayload = { status: "terminated", output: "", error: reason };
		const entry = this.pending.get(key);
		if (entry) {
			this.pending.delete(key);
			try { entry.resolve(result); } catch { /* ignore */ }
			found = true;
		}
		if (this.shells.delete(key)) found = true;
		if (this.latched.delete(key)) found = true;
		this.completed.add(key); // suppress any racing submit after cancel
		if (found) this._persist();
		return found;
	}

	/**
	 * Submit a terminal result. Returns `true` if a pending Promise was
	 * resolved; `false` if the result was latched (submit-before-register)
	 * OR if it was a no-op (duplicate against an already-completed key, or
	 * duplicate against an already-latched result — first-write-wins,
	 * mirroring `verification_result`'s idempotency contract).
	 *
	 * Idempotency contract: once a (parentSessionId, toolUseId) has
	 * received a terminal result — whether by resolving a pending awaiter,
	 * latching for a future register, or being explicitly cancelled — every
	 * subsequent submit for that key is a no-op for the lifetime of the
	 * harness instance. This prevents duplicate `agent_end`/`process_exit`
	 * events or a retried `/api/internal/delegate/submit` from poisoning
	 * `active-delegates.json` with a second result.
	 */
	submit(parentSessionId: string, toolUseId: string, result: DelegateResultPayload): boolean {
		const key = delegateKey(parentSessionId, toolUseId);
		// First-write-wins guard: if the key has already been resolved or
		// latched, drop subsequent arrivals on the floor. This matches the
		// verification_result idempotency contract and prevents resolved
		// pending entries from being re-latched (which would later overwrite
		// a freshly-registered awaiter with a stale result).
		if (this.completed.has(key) || this.latched.has(key)) return false;
		const entry = this.pending.get(key);
		if (entry) {
			// Durability: write the latch to disk BEFORE resolving the
			// awaiter, so a crash between `_persist()` and the parent's
			// HTTP-response-finished can be recovered — the on-disk latch
			// is the source of truth until the parent's `/wait` POST drains
			// it via `acknowledge()` (called from `register()` on a recycled
			// key, or from the `/wait` handler success path). Without this,
			// a delegate that completed during the restart window would be
			// lost (acceptance criterion AC2).
			this.pending.delete(key);
			this.latched.set(key, result);
			this._persist();
			try { entry.resolve(result); } catch { /* swallow consumer errors */ }
			return true;
		}
		// Either a fresh submit-before-register, or a submit against a
		// post-restart shell with no live awaiter — either way, latch.
		this.latched.set(key, result);
		this._persist();
		return false;
	}

	/**
	 * Confirm the parent has received the result for `(parentSessionId,
	 * toolUseId)`. Removes the latched entry from disk and marks the key
	 * as fully completed (any straggler `submit()` for the same key is a
	 * no-op). Idempotent.
	 *
	 * Called from the `/api/internal/delegate/wait` handler after the
	 * HTTP response has been written, and from `register()` on a recycled
	 * key (parent's tool extension reconnects with a fresh delegate).
	 */
	acknowledge(parentSessionId: string, toolUseId: string): boolean {
		const key = delegateKey(parentSessionId, toolUseId);
		const had = this.latched.delete(key);
		if (had) {
			this.completed.add(key);
			this._persist();
		}
		return had;
	}

	/**
	 * Reject every pending wait whose parent matches and drop matching latched
	 * entries. Returns the list of delegate session ids the caller should
	 * cascade-terminate.
	 */
	rejectAllForSession(parentSessionId: string, reason = "Parent session terminated"): string[] {
		const killed: string[] = [];
		const prefix = `${parentSessionId}:`;
		for (const [key, entry] of [...this.pending.entries()]) {
			if (entry.active.parentSessionId !== parentSessionId) continue;
			this.pending.delete(key);
			this.completed.add(key);
			killed.push(entry.active.delegateSessionId);
			try { entry.reject(new Error(reason)); } catch { /* ignore */ }
		}
		for (const [key, active] of [...this.shells.entries()]) {
			if (active.parentSessionId !== parentSessionId) continue;
			this.shells.delete(key);
			this.completed.add(key);
			killed.push(active.delegateSessionId);
		}
		for (const key of [...this.latched.keys()]) {
			if (key.startsWith(prefix)) {
				this.latched.delete(key);
				this.completed.add(key);
			}
		}
		this._persist();
		return killed;
	}

	/**
	 * Set of delegate session ids that have an in-flight (pending) wait. Used
	 * by `SessionManager.restoreSessions()` to decide which delegates to
	 * eager-restore after a server restart.
	 */
	getActiveDelegateSessionIds(): Set<string> {
		const out = new Set<string>();
		for (const entry of this.pending.values()) out.add(entry.active.delegateSessionId);
		for (const active of this.shells.values()) out.add(active.delegateSessionId);
		return out;
	}

	/** Snapshot of active delegates (live pending + post-restart shells). */
	getActiveDelegates(): ActiveDelegate[] {
		return [
			...[...this.pending.values()].map(p => p.active),
			...this.shells.values(),
		];
	}

	/**
	 * Re-load pending+latched state from disk. Public so the server-side
	 * resume path (`resumeInterruptedDelegates`, owned by a later task) can
	 * reconstruct the harness's view of the world after restart and decide
	 * which children to eager-restore vs. drain a synthetic failure for.
	 *
	 * For this task we only need the no-op return shape; later wiring will
	 * iterate the returned active list.
	 */
	resumeInterruptedDelegates(): ActiveDelegate[] {
		this._loadFromDisk();
		return this.getActiveDelegates();
	}

	// ---------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------

	/** Atomic write-then-rename. Recreates parent dir on demand. */
	private _persist(): void {
		try {
			const dir = path.dirname(this.persistPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const data: PersistedShape = {
				pending: [
					...[...this.pending.values()].map(p => p.active),
					...this.shells.values(),
				],
				latched: [...this.latched.entries()].map(([key, result]) => ({ key, result })),
			};
			const tmp = `${this.persistPath}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
			fs.renameSync(tmp, this.persistPath);
		} catch (err) {
			console.error("[delegate-harness] Failed to persist active delegates:", err);
		}
	}

	/**
	 * Tolerant load. Absent or malformed file → empty state. Pending entries
	 * are reconstructed with placeholder rejecting resolvers — the closures
	 * the original `register()` call held are gone, so the resurrected
	 * Promises would never resolve. Instead we treat persisted-pending as
	 * "shells" that the next `register()` from the parent supersedes (which
	 * also drains any latched result that arrived in the meantime).
	 */
	private _loadFromDisk(): void {
		this.pending.clear();
		this.shells.clear();
		this.latched.clear();
		// `completed` is in-memory-only first-write-wins dedup; a restart
		// (real or simulated) wipes it so post-restart submit-then-register
		// flows the same way as a fresh delegate.
		this.completed.clear();
		try {
			if (!fs.existsSync(this.persistPath)) return;
			const raw = fs.readFileSync(this.persistPath, "utf-8");
			const data = JSON.parse(raw) as Partial<PersistedShape>;
			if (Array.isArray(data.pending)) {
				for (const active of data.pending) {
					if (!active || typeof active.parentSessionId !== "string" || typeof active.toolUseId !== "string") continue;
					const key = delegateKey(active.parentSessionId, active.toolUseId);
					// Persisted entries become metadata-only "shells" — their
					// original resolvers were closures in the dead process. The
					// shell still counts as in-flight for
					// `getActiveDelegateSessionIds()` (so the eager-restore
					// branch in `restoreSessions` revives the child), but a
					// `submit()` against the key latches into `latched` instead
					// of routing to a dead resolver. The parent's next
					// `register()` drains the latch.
					this.shells.set(key, active);
				}
			}
			if (Array.isArray(data.latched)) {
				for (const entry of data.latched) {
					if (!entry || typeof entry.key !== "string" || !entry.result) continue;
					this.latched.set(entry.key, entry.result);
				}
			}
		} catch (err) {
			console.error("[delegate-harness] Failed to load persisted delegates (continuing with empty state):", err);
			this.pending.clear();
			this.shells.clear();
			this.latched.clear();
		}
	}

	/** Test-only: path of the persistence file. */
	get _persistPathForTest(): string {
		return this.persistPath;
	}
}

/**
 * Resolve the effective `kind` for a persisted session. Pre-`kind` records
 * (created before this discriminator existed) are inferred from `delegateOf`
 * — anything with a parent is a delegate, everything else defaults to
 * `"worker"`. Reviewer sessions set `kind` explicitly at creation time.
 *
 * Importable from anywhere — keeps the legacy fallback in one place so future
 * call sites don't reinvent it.
 */
export function resolveSessionKind(ps: { kind?: string; delegateOf?: string }): "delegate" | "worker" | "reviewer" {
	if (ps.kind === "delegate" || ps.kind === "worker" || ps.kind === "reviewer") return ps.kind;
	return ps.delegateOf ? "delegate" : "worker";
}
