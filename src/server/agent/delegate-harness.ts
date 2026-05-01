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
	private readonly broadcastFn: DelegateBroadcastFn | undefined;

	constructor(
		stateDir: string,
		sessionManager?: DelegateHarnessSessionManager,
		broadcastFn?: DelegateBroadcastFn,
	) {
		this.persistPath = path.join(stateDir, "active-delegates.json");
		this.broadcastFn = broadcastFn;
		this._loadFromDisk();
		// Constructor-tolerant registration: tests pass minimal stubs without
		// addTerminationListener; production wiring uses the full SessionManager.
		if (sessionManager && typeof sessionManager.addTerminationListener === "function") {
			sessionManager.addTerminationListener((sessionId, info) => {
				this._onSessionTerminated(sessionId, info);
			});
		}
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

		// Drain any latched result first — submit-before-register is supported
		// (and is the whole point of restart-survival). Clear any shell at the
		// same time: the latch is the result the shell was holding the slot for.
		const existingLatched = this.latched.get(key);
		if (existingLatched) {
			this.latched.delete(key);
			this.shells.delete(key);
			this._persist();
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
	 * Submit a terminal result. Returns `true` if a pending Promise was
	 * resolved; `false` if the result was latched for a future `register`
	 * (or if it duplicates an already-latched result — second-arrival is a
	 * no-op, mirroring `verification_result`'s idempotency contract).
	 */
	submit(parentSessionId: string, toolUseId: string, result: DelegateResultPayload): boolean {
		const key = delegateKey(parentSessionId, toolUseId);
		const entry = this.pending.get(key);
		if (entry) {
			this.pending.delete(key);
			this._persist();
			try { entry.resolve(result); } catch { /* swallow consumer errors */ }
			return true;
		}
		// If there's already a latched result, second submit is a no-op
		// (first-write-wins, matching the verification_result idempotency contract).
		if (this.latched.has(key)) return false;
		// Either a fresh submit-before-register, or a submit against a
		// post-restart shell with no live awaiter — either way, latch.
		this.latched.set(key, result);
		this._persist();
		return false;
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
			killed.push(entry.active.delegateSessionId);
			try { entry.reject(new Error(reason)); } catch { /* ignore */ }
		}
		for (const [key, active] of [...this.shells.entries()]) {
			if (active.parentSessionId !== parentSessionId) continue;
			this.shells.delete(key);
			killed.push(active.delegateSessionId);
		}
		for (const key of [...this.latched.keys()]) {
			if (key.startsWith(prefix)) this.latched.delete(key);
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

	private _onSessionTerminated(
		sessionId: string,
		info: { reason: "terminated" | "archived" | "purged" },
	): void {
		// Parent terminated/archived → reject all of its pending waits and drop
		// matching latched results. Cascade-termination of children is the
		// caller's responsibility (server.ts wires it via the returned list).
		const reason = info.reason === "archived" ? "Parent session archived" : "Parent session terminated";
		this.rejectAllForSession(sessionId, reason);
		// Note: when a *delegate* (child) session terminates, the live-path
		// completion listener installed by SessionManager submits the structured
		// result. We don't need to do anything here for the child case.
		void this.broadcastFn; // suppress unused warning when no broadcaster wired
	}

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
