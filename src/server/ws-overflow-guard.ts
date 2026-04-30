/**
 * Decision logic for the WebSocket buffer-overflow guard used by
 * `broadcast()` in `src/server/agent/session-manager.ts`.
 *
 * The production guard terminates a client once `bufferedAmount` exceeds a
 * 4 MiB threshold. Empirically (Windows + Playwright workers=3) the kernel
 * TCP send buffer occasionally spikes past that ceiling during a tool burst
 * and then drains within ~10 ms. Terminating immediately on a transient
 * spike turned those moments into spurious WS reconnects (the ST-DEDUP-01
 * flake family).
 *
 * `decideOverflowAction` separates the policy (yield once, re-check, then
 * terminate) from the broadcast loop so it can be unit-tested without
 * spinning up a real WebSocket server.
 */

export type OverflowAction =
	| { kind: "send" }
	| { kind: "send-and-defer-check" }
	| { kind: "terminate" };

export interface OverflowGuardConfig {
	overflowBytes: number;
	warnBytes: number;
}

export const DEFAULT_OVERFLOW_GUARD: OverflowGuardConfig = {
	overflowBytes: 4 * 1024 * 1024,
	warnBytes: 1 * 1024 * 1024,
};

/**
 * Returns the action `broadcast()` should take given the current
 * `bufferedAmount` and whether a deferred re-check is already in flight.
 *
 * - `send`             — buffer is fine; just send.
 * - `send-and-defer-check` — buffer is over threshold and no deferred
 *                        re-check is pending yet. Caller schedules a
 *                        re-check in ~10 ms but still attempts the send
 *                        so a transient spike doesn't lose a frame.
 * - `terminate`        — buffer is over threshold during a deferred
 *                        re-check (i.e. the spike persisted). Caller
 *                        terminates the client.
 */
export function decideOverflowAction(
	bufferedAmount: number,
	isDeferredRecheck: boolean,
	cfg: OverflowGuardConfig = DEFAULT_OVERFLOW_GUARD,
): OverflowAction {
	if (bufferedAmount <= cfg.overflowBytes) return { kind: "send" };
	if (isDeferredRecheck) return { kind: "terminate" };
	return { kind: "send-and-defer-check" };
}
