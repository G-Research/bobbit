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
	return {
		timeoutMs: Number(process.env.BOBBIT_LLM_STREAM_TIMEOUT_MS ?? 30_000),
		maxRetries: Number(process.env.BOBBIT_LLM_STREAM_MAX_RETRIES ?? 2),
	};
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
	consecutiveErrorTurns?: number;
	lastTurnErrored?: boolean;
	lastTurnErrorMessage?: string;
	lastPromptText?: string;
	lastPromptImages?: any;
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
			return;
		case "agent_end":
			session.awaitingLlmFrame = false;
			// Preserve the retry counter across the abort+reprompt cycle that
			// the watchdog drives. On a clean (non-watchdog-driven) agent_end
			// the counter is reset.
			if (!session.suppressNextDrainForStallRetry) {
				session.streamStallRetries = 0;
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
	isAlive: IsAliveFn,
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
		// Surface to user. Bump consecutiveErrorTurns by exactly 1 so the
		// existing implicit-unstick path keeps its semantics (3 surfaced
		// stalls in a row → next user message is parked).
		session.streamStallRetries = 0;
		session.consecutiveErrorTurns = (session.consecutiveErrorTurns ?? 0) + 1;
		session.lastTurnErrored = true;
		session.lastTurnErrorMessage =
			`Model stream stalled — no frames for ${Math.round(ageMs / 1000)}s ` +
			`(attempted ${cfg.maxRetries + 1}× before giving up).`;
		try { await session.rpcClient.abort(); } catch { /* best-effort */ }
		return;
	}

	// Silent retry: increment counter, abort the underlying request, then
	// re-issue the same prompt on the next tick. Status stays "streaming"
	// throughout the retry; the `agent_end` consumer of
	// `suppressNextDrainForStallRetry` short-circuits the idle-broadcast
	// + queue-drain so the watchdog is the sole re-dispatcher.
	session.streamStallRetries = attempt;
	console.log(
		`[stream-watchdog] session=${session.id} silent-retry ${attempt}/${cfg.maxRetries}`,
	);
	session.suppressNextDrainForStallRetry = true;
	try { await session.rpcClient.abort(); } catch { /* best-effort */ }
	setTimeout(() => {
		if (!isAlive(session.id)) return;
		const text = session.lastPromptText ?? "";
		void session.rpcClient.prompt(text, session.lastPromptImages).catch(() => { /* next stall will surface */ });
		session.lastLlmFrameAt = Date.now();
		session.awaitingLlmFrame = true;
		ensureTimer(session, cfg, isAlive);
	}, 0);
}

/** Clear the timer and reset the awaiting flag. Idempotent. */
export function disposeStreamWatchdog(session: WatchdogSession): void {
	if (session.streamWatchdogTimer) {
		clearInterval(session.streamWatchdogTimer);
		session.streamWatchdogTimer = undefined;
	}
	session.awaitingLlmFrame = false;
}
