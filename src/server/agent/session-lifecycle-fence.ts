/**
 * Session lifecycle fencing — cohort 3 of the SessionManager decomposition
 * (docs/design/session-manager-decomposition.md, cluster A/B sub-slice).
 * Extracted mechanically from session-manager.ts: owns the per-session
 * restore/respawn coordinator and monotonic generation state that prevent
 * concurrent restores from splitting clients across stale SessionInfo objects.
 *
 * DOC DRIFT vs. the design doc's cohort-3 inventory: the live file had two
 * direct state reads outside the listed methods (`enqueuePrompt` checks/joins
 * `_restoreCoordinators`, and `restoreSession` stamps the current generation).
 * SessionManager keeps same-named delegating accessors for those state maps so
 * those call sites and existing tests keep the same surface.
 *
 * TEST-SEAM HAZARD: tests/missing-live-messages-repro.test.ts writes
 * `sessionManager._sessionRespawnGenerations` directly on a SessionManager
 * instance. SessionManager therefore exposes accessor wrappers backed by this
 * class's real maps, mirroring mcp-wiring.ts's data-accessor pattern.
 */

export interface LifecycleFenceSession {
	id: string;
	lifecycleFenced?: boolean;
	lifecycleGeneration?: number;
	dormant?: boolean;
	status?: string;
	clients: { clear(): void };
}

export type RestoreCoordinator<TSession> = {
	generation: number;
	promise: Promise<TSession | undefined>;
};

export interface SessionLifecycleFenceDeps<TSession extends LifecycleFenceSession> {
	getCanonicalSession(sessionId: string): TSession | undefined;
	cancelPendingAutoRetry(session: TSession, reason: "terminated"): void;
	untrackConnectedSession(session: TSession): void;
}

export class SessionLifecycleFence<TSession extends LifecycleFenceSession> {
	/** Per-session restore/respawn mutex. Concurrent revive triggers join this promise instead of replacing each other. */
	readonly restoreCoordinators = new Map<string, RestoreCoordinator<TSession>>();
	/** Latest lifecycle generation for each session; stale SessionInfo writers must no-op when behind this value. */
	readonly sessionRespawnGenerations = new Map<string, number>();

	constructor(private readonly deps: SessionLifecycleFenceDeps<TSession>) {}

	currentRespawnGeneration(sessionId: string): number {
		return this.sessionRespawnGenerations.get(sessionId) ?? 0;
	}

	nextRespawnGeneration(sessionId: string): number {
		const next = this.currentRespawnGeneration(sessionId) + 1;
		this.sessionRespawnGenerations.set(sessionId, next);
		return next;
	}

	sessionWriterIsCurrent(session: TSession): boolean {
		if (session.lifecycleFenced) return false;
		const canonical = this.deps.getCanonicalSession(session.id);
		if (canonical && canonical !== session) return false;
		return (session.lifecycleGeneration ?? 0) === this.currentRespawnGeneration(session.id);
	}

	fenceReplacedSession(session: TSession, replacingGeneration: number): void {
		session.lifecycleFenced = true;
		session.lifecycleGeneration = replacingGeneration - 1;
		session.dormant = true;
		session.status = "terminated";
		session.clients.clear();
		this.deps.cancelPendingAutoRetry(session, "terminated");
		this.deps.untrackConnectedSession(session);
	}

	coalesceRestore(
		sessionId: string,
		restore: (generation: number) => Promise<TSession | undefined>,
	): Promise<TSession | undefined> {
		const inFlight = this.restoreCoordinators.get(sessionId);
		if (inFlight) return inFlight.promise;

		const generation = this.nextRespawnGeneration(sessionId);
		const promise = (async () => restore(generation))()
			.finally(() => {
				const current = this.restoreCoordinators.get(sessionId);
				if (current?.generation === generation) this.restoreCoordinators.delete(sessionId);
			});
		this.restoreCoordinators.set(sessionId, { generation, promise });
		return promise;
	}
}
