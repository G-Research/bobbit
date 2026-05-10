/**
 * LLM stream-inactivity watchdog.
 *
 * Lives in its own module (mirroring `session-status.ts` and
 * `splice-inflight-message.ts`) so unit tests can exercise the behaviour
 * without dragging in the full `SessionManager` dependency graph (flexsearch,
 * sandbox manager, mcp, …).
 *
 * Problem (recap): the upstream model provider's streaming HTTP response can
 * go silent (TLS half-close, NAT keep-alive death, provider hiccup). The
 * agent's `await reader.read()` then never resolves and never rejects, leaving
 * the session wedged in `status: "streaming"` forever.
 *
 * Solution: a frame-inactivity timer per session. We arm the watchdog only
 * while the agent is waiting on the LLM (not while a tool is executing). On
 * stall we abort the turn and silently re-prompt up to `maxRetries` times;
 * after that we surface a stalled-stream error to the user.
 *
 * Design: docs/design — "LLM Stream Watchdog" (goal-llm-stream-305c45a1).
 */

export interface WatchdogConfig {
	/** Inactivity threshold in ms; <= 0 disables the watchdog. */
	timeoutMs: number;
	/** Number of silent retries before surfacing the stall to the user. */
	maxRetries: number;
}

/**
 * Resolve the watchdog config from env vars. Re-read on every call so tests
 * (and operators) can flip the threshold without a restart — the cost is a
 * couple of `Number()` calls per agent event, negligible vs. the agent loop.
 *
 * `BOBBIT_LLM_STREAM_TIMEOUT_MS` defaults to 30000; `0` disables the watchdog.
 * `BOBBIT_LLM_STREAM_MAX_RETRIES` defaults to 2.
 */
export function resolveWatchdogConfigFromEnv(): WatchdogConfig {
	// NaN guard: if the env var is set but non-numeric (e.g. empty string,
	// `"foo"`, garbage from a misconfigured shell) `Number()` returns NaN,
	// which would `<= 0`-disable the watchdog silently. Fall back to defaults.
	const rawMs = Number(process.env.BOBBIT_LLM_STREAM_TIMEOUT_MS);
	const timeoutMs = Number.isFinite(rawMs) ? rawMs : 30_000;
	const rawMax = Number(process.env.BOBBIT_LLM_STREAM_MAX_RETRIES);
	const maxRetries = Number.isFinite(rawMax) ? rawMax : 2;
	return { timeoutMs, maxRetries };
}

/** Subset of `SessionInfo` the watchdog touches. */
export interface WatchdogSession {
	id: string;
	rpcClient: {
		abort(): Promise<any>;
		prompt(text: string, images?: any): Promise<any>;
	};
	streamWatchdogTimer?: ReturnType<typeof setInterval>;
	lastLlmFrameAt?: number;
	awaitingLlmFrame?: boolean;
	streamStallRetries?: number;
	suppressNextDrainForStallRetry?: boolean;
	/** One-shot: tells the SessionManager `message_end` handler to skip its
	 *  normal lastTurnErrored/consecutiveErrorTurns bookkeeping for the next
	 *  assistant `message_end`. Set by the watchdog before initiating an
	 *  abort, since the real agent emits a `message_end{stopReason:"error",
	 *  errorMessage:"Request aborted"}` after every abort.
	 *   - Silent retry: prevents the abort's error frame from advancing
	 *     `consecutiveErrorTurns` (silent retries MUST NOT bump the counter).
	 *   - Surfaced stall: the watchdog has already set state to its preferred
	 *     values (and emitted a synthetic stalled-stream `message_end`); the
	 *     abort's "Request aborted" frame must not clobber them. */
	suppressNextErrorMessageEnd?: boolean;
	/** One-shot: drop the next user-role `message_end` from the WS broadcast.
	 *  Set by the watchdog before each silent-retry `rpcClient.prompt(...)` so
	 *  the agent SDK's user-echo of the re-issued prompt does NOT render as a
	 *  duplicate user message in the chat transcript. Consumed exactly once by
	 *  the SessionManager's `handleAgentLifecycle` user-echo path. */
	suppressNextUserEcho?: boolean;
	/** One-shot: drop the next assistant `message_end{stopReason:"error"}`
	 *  frame from the WS broadcast (the abort's "Request aborted" frame).
	 *  Independent from `suppressNextErrorMessageEnd` (which only suppresses
	 *  internal bookkeeping). Both flags are set together for silent retries
	 *  AND for the surfaced-stall path (where the synthetic stalled-stream
	 *  frame is emitted manually and the abort's real error frame would
	 *  otherwise duplicate "Request aborted" on screen). Consumed exactly
	 *  once by `handleAgentLifecycle`. */
	suppressNextAbortMessageEnd?: boolean;
	consecutiveErrorTurns?: number;
	lastTurnErrored?: boolean;
	lastTurnErrorMessage?: string;
	lastPromptText?: string;
	lastPromptImages?: any;
	/** Stashed by the silent-retry branch of `handleStreamStall` and consumed
	 *  by the SessionManager's `agent_end` handler. The handler dispatches the
	 *  re-prompt only AFTER the agent has fully wound down (i.e. emitted
	 *  `agent_end` for the aborted turn) — this avoids the production race
	 *  where `setTimeout(0)` schedules the re-prompt before the agent finishes
	 *  tearing down and `prompt()` rejects with "Agent is already processing".
	 *  See docs/llm-stream-watchdog.md (Bug 1 hardening). */
	pendingStallRetry?: { text: string; images?: any; attempt: number; total: number };
	/** Set by the SessionManager after a successful re-prompt dispatch; logged
	 *  on the next clean (non-errored) `agent_end` so successful silent
	 *  recoveries are greppable in the server log. Cleared after logging. */
	silentRetrySuccessLogPending?: { attempt: number; total: number };
	/** Broadcast a synthetic agent event to the session's WS clients. Wired
	 *  by `SessionManager.handleAgentLifecycle` (delegates to `emitSessionEvent`).
	 *  Used for the surfaced-stall `message_end` so the UI's transcript renders
	 *  the stalled-stream error text — the UI reads `errorMessage` from this
	 *  frame, which is why we can't rely on `lastTurnErrorMessage` alone. */
	emitSyntheticEvent?: (event: any) => void;
}

/** Callback that returns true if the session is still alive (in the manager's map). */
export type IsAliveFn = (sessionId: string) => boolean;

/**
 * Per-event arming/disarming. Call from `handleAgentLifecycle` BEFORE any
 * other handling so an event mid-tear-down can't sneak past while the timer
 * is already firing.
 */
export function onAgentEvent(
	session: WatchdogSession,
	event: any,
	cfg: WatchdogConfig,
	isAlive: IsAliveFn,
): void {
	if (cfg.timeoutMs <= 0) return;
	const now = Date.now();
	switch (event?.type) {
		case "agent_start":
			session.awaitingLlmFrame = true;
			session.lastLlmFrameAt = now;
			ensureTimer(session, cfg, isAlive);
			return;
		case "message_update":
		case "message_end":
			// Any frame counts as activity. tool_use blocks arrive in a
			// `message_update` BEFORE `tool_execution_start`, so updating the
			// timestamp here is safe.
			session.lastLlmFrameAt = now;
			return;
		case "tool_execution_start":
			session.awaitingLlmFrame = false;
			return;
		case "tool_execution_end":
			session.awaitingLlmFrame = true;
			session.lastLlmFrameAt = now;
			// Symmetry with `agent_start` / silent-retry re-arm: a session that
			// only ever runs tools (e.g. tool-loop turns where `agent_start`
			// preceded the watchdog's first arming opportunity) still needs a
			// timer once the tool finishes and we go back to waiting on the LLM.
			ensureTimer(session, cfg, isAlive);
			return;
		case "agent_end":
			session.awaitingLlmFrame = false;
			// Preserve the retry counter across the abort+reprompt cycle that
			// the watchdog drives. On a clean (non-watchdog-driven) agent_end
			// the counter is reset.
			if (!session.suppressNextDrainForStallRetry) {
				session.streamStallRetries = 0;
				// If a previous silent retry re-dispatched successfully and this
				// agent_end represents a clean (non-suppressed, non-errored)
				// turn, log the recovery so successful self-heals are greppable.
				const pending = session.silentRetrySuccessLogPending;
				if (pending && !session.lastTurnErrored) {
					console.log(
						`[stream-watchdog] session=${session.id} silent-retry ${pending.attempt}/${pending.total} succeeded`,
					);
					session.silentRetrySuccessLogPending = undefined;
				}
			}
			return;
		case "process_exit":
			disposeStreamWatchdog(session);
			return;
	}
}

function ensureTimer(
	session: WatchdogSession,
	cfg: WatchdogConfig,
	isAlive: IsAliveFn,
): void {
	if (cfg.timeoutMs <= 0) return;
	if (session.streamWatchdogTimer) return;
	const tickMs = Math.max(50, Math.floor(cfg.timeoutMs / 2));
	const timer = setInterval(() => {
		if (!isAlive(session.id)) {
			disposeStreamWatchdog(session);
			return;
		}
		if (!session.awaitingLlmFrame) return;
		const last = session.lastLlmFrameAt ?? 0;
		if (Date.now() - last < cfg.timeoutMs) return;
		void handleStreamStall(session, cfg, isAlive).catch(() => { /* logged inside */ });
	}, tickMs);
	(timer as any).unref?.();
	session.streamWatchdogTimer = timer;
}

/**
 * Stall handler. Aborts the in-flight turn, then either silently re-prompts
 * (`attempt <= maxRetries`) or surfaces a stalled-stream error to the user
 * (final attempt). Silent retries do NOT advance `consecutiveErrorTurns`;
 * only the surfaced failure does, by exactly 1.
 *
 * Exported for unit tests. Production callers reach this via the `setInterval`
 * tick set up in `onAgentEvent`.
 */
export async function handleStreamStall(
	session: WatchdogSession,
	cfg: WatchdogConfig,
	_isAlive: IsAliveFn,
): Promise<void> {
	const lastFrame = session.lastLlmFrameAt ?? 0;
	const ageMs = Date.now() - lastFrame;
	const attempt = (session.streamStallRetries ?? 0) + 1;
	// `process` is the child-process handle on the production RpcBridge
	// (private but accessible via cast); the in-process mock has no analogue.
	// Best-effort for telemetry only.
	const pid = (session.rpcClient as any)?.process?.pid ?? "?";
	console.warn(
		`[stream-watchdog] session=${session.id} pid=${pid} last-frame-age=${ageMs}ms ` +
		`attempt=${attempt}/${cfg.maxRetries + 1} — aborting turn`,
	);

	// Disarm immediately — the upcoming abort will fire agent_end and we
	// don't want a re-tick mid-tear-down.
	session.awaitingLlmFrame = false;

	if (attempt > cfg.maxRetries) {
		await surfaceStallNow(session, cfg, ageMs);
		return;
	}

	// Empty-prompt guard: re-issuing "" is worse than a stall (the agent has
	// nothing to retry against). Surface immediately instead of looping over
	// empty prompts.
	if (!session.lastPromptText || session.lastPromptText.length === 0) {
		await surfaceStallNow(session, cfg, ageMs);
		return;
	}

	// Silent retry: increment counter, set suppression flags, abort the
	// underlying request, and STASH the retry parameters in
	// `pendingStallRetry`. The SessionManager's `agent_end` handler dispatches
	// the re-prompt AFTER the agent has fully wound down — this avoids the
	// production race where a `setTimeout(0)`-scheduled prompt lands inside
	// the abort handshake's "Agent is already processing" window and rejects
	// silently. Status stays "streaming" throughout the retry; the `agent_end`
	// consumer of `suppressNextDrainForStallRetry` short-circuits the
	// idle-broadcast + queue-drain so the watchdog is the sole re-dispatcher.
	session.streamStallRetries = attempt;
	console.log(
		`[stream-watchdog] session=${session.id} silent-retry ${attempt}/${cfg.maxRetries}`,
	);
	session.suppressNextDrainForStallRetry = true;
	// In production the real agent emits `message_end{stopReason:"error",
	// errorMessage:"Request aborted"}` on every abort, including silent-retry
	// aborts. Without this flag the SessionManager's message_end handler
	// would bump `consecutiveErrorTurns` on each silent retry, violating the
	// design invariant that only the SURFACED failure advances the counter.
	session.suppressNextErrorMessageEnd = true;
	// Also drop both user-echo and abort-error frames from the WS broadcast.
	// The user sent ONE prompt; silent retries are silent on-wire as well as
	// on-screen — they must not produce duplicate user rows or visible
	// "Request aborted" rows in the chat transcript.
	session.suppressNextUserEcho = true;
	session.suppressNextAbortMessageEnd = true;
	session.pendingStallRetry = {
		text: session.lastPromptText,
		images: session.lastPromptImages,
		attempt,
		total: cfg.maxRetries,
	};
	try { await session.rpcClient.abort(); } catch { /* best-effort */ }
}

/**
 * Surface a stalled-stream error to the user. Sets the watchdog-owned state
 * (lastTurnErrored, lastTurnErrorMessage, consecutiveErrorTurns +1), arms the
 * suppression flags so the abort's "Request aborted" frame is dropped from
 * both bookkeeping and broadcast, emits the synthetic `message_end` carrying
 * the user-visible text, and aborts the in-flight request.
 *
 * Exported so the SessionManager's retry-dispatch fast-path can re-use it
 * when `prompt()` rejects (production race: agent still mid-abort).
 */
export async function surfaceStallNow(
	session: WatchdogSession,
	cfg: WatchdogConfig,
	ageMs: number,
): Promise<void> {
	session.streamStallRetries = 0;
	session.consecutiveErrorTurns = (session.consecutiveErrorTurns ?? 0) + 1;
	session.lastTurnErrored = true;
	const errorMessage =
		`Model stream stalled — no frames for ${Math.round(ageMs / 1000)}s ` +
		`(attempted ${cfg.maxRetries + 1}× before giving up).`;
	session.lastTurnErrorMessage = errorMessage;
	session.suppressNextErrorMessageEnd = true;
	session.suppressNextAbortMessageEnd = true;
	// Stable id on the synthetic frame so the UI's MessageList can reliably
	// identify this as the last assistant message and render the Retry button.
	const syntheticId = `stalled-stream-${Date.now()}-${session.id.slice(0, 8)}`;
	try {
		session.emitSyntheticEvent?.({
			type: "message_end",
			message: {
				id: syntheticId,
				role: "assistant",
				// Populate `content` with the error text so the assistant-message
				// renderer's error-block branch lights up (it is gated on
				// `stopReason === "error" && errorMessage`, but an empty content
				// array can cause the surrounding row to render no children, hiding
				// the error block in some layouts). One text chunk keeps the diff
				// minimal vs. lifting the gate in Messages.ts.
				content: [{ type: "text", text: errorMessage }],
				stopReason: "error",
				errorMessage,
			},
		});
	} catch { /* best-effort: telemetry only, never block abort */ }
	try { await session.rpcClient.abort(); } catch { /* best-effort */ }
}

/**
 * Helper for `SessionManager._dispatchPendingStallRetry`. Re-arms the watchdog
 * after a successful silent-retry re-prompt: refreshes the frame timestamp,
 * sets `awaitingLlmFrame`, and ensures the timer is alive. Mirrors the path
 * `agent_start` would take when the new turn's first frame arrives, but lets
 * the SessionManager call it synchronously after `prompt()` resolves so the
 * watchdog never observes a gap.
 */
export function armWatchdogAfterRetry(
	session: WatchdogSession,
	cfg: WatchdogConfig,
	isAlive: IsAliveFn,
): void {
	session.lastLlmFrameAt = Date.now();
	session.awaitingLlmFrame = true;
	ensureTimer(session, cfg, isAlive);
}

/**
 * Helper for the `agent_end` branch in `SessionManager.handleAgentLifecycle`.
 * Decides whether the silent-retry suppression should short-circuit the
 * idle-broadcast/drain. A concurrent user Stop must always win — when the
 * session has already transitioned to `aborting`, we clear the flag and let
 * the standard `wasAborting` cleanup proceed (which broadcasts idle).
 *
 * Returns `true` iff the caller should short-circuit. The flag is consumed
 * (cleared) on every call regardless.
 */
export function shouldSuppressDrainForStallRetry(
	session: WatchdogSession,
	isAborting: boolean,
): boolean {
	if (!session.suppressNextDrainForStallRetry) return false;
	session.suppressNextDrainForStallRetry = false;
	return !isAborting;
}

/**
 * Helper for the `message_end` branch in `SessionManager.handleAgentLifecycle`.
 * Returns `true` iff the next assistant `message_end` should skip the standard
 * lastTurnErrored / consecutiveErrorTurns bookkeeping. Consumed exactly once.
 */
export function shouldSkipErrorMessageEnd(session: WatchdogSession): boolean {
	if (!session.suppressNextErrorMessageEnd) return false;
	session.suppressNextErrorMessageEnd = false;
	return true;
}

/**
 * Helper for the WS-broadcast gate in `SessionManager.handleAgentLifecycle`.
 * Returns `true` iff the next user-role `message_end` should be dropped from
 * the broadcast (silent-retry user echo). Consumed exactly once.
 *
 * The flag is one-shot regardless of body match: `lastPromptText` is set
 * right before each silent-retry `prompt()` call, so by construction the
 * very next user `message_end` IS the re-issued prompt's echo.
 */
export function shouldSuppressUserEchoBroadcast(session: WatchdogSession): boolean {
	if (!session.suppressNextUserEcho) return false;
	session.suppressNextUserEcho = false;
	return true;
}

/**
 * Helper for the WS-broadcast gate in `SessionManager.handleAgentLifecycle`.
 * Returns `true` iff the next assistant error `message_end` should be
 * dropped from the broadcast (the abort's "Request aborted" frame).
 * Consumed exactly once.
 */
export function shouldSuppressAbortBroadcast(session: WatchdogSession): boolean {
	if (!session.suppressNextAbortMessageEnd) return false;
	session.suppressNextAbortMessageEnd = false;
	return true;
}

/** Clear the timer and reset the awaiting flag. Idempotent. */
export function disposeStreamWatchdog(session: WatchdogSession): void {
	if (session.streamWatchdogTimer) {
		clearInterval(session.streamWatchdogTimer);
		session.streamWatchdogTimer = undefined;
	}
	session.awaitingLlmFrame = false;
}
