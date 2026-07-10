// Cooperative pacing for the BOBBIT_E2E-only replay-buffered-events endpoint.
// The production WS broadcast() in session-manager.ts force-terminates a client
// whose bufferedAmount crosses 4 MiB. The replay endpoint sends synchronously
// and can pile bytes faster than the kernel drains, tripping that guard mid-test
// (ST-DEDUP-01). This helper yields the event loop while bufferedAmount stays
// above a soft threshold, capped by a per-call deadline so a dead client
// cannot hang the endpoint.

export const PACE_THRESHOLD_BYTES = 256 * 1024;
export const PACE_TIMEOUT_MS = 2000;
export const RESUME_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
export const RESUME_REPLAY_DRAIN_TIMEOUT_MS = 250;

export interface PaceableClient {
	readyState: number;
	bufferedAmount: number;
	send(data: string): void;
}

export interface ReplayFrameBudget {
	bytes: number;
}

export type ResumeReplayDecision =
	| { kind: "replay"; bytes: number }
	| { kind: "resume_gap"; bytes: number; reason: "byte_budget" };

export function decideResumeReplay(frames: ReplayFrameBudget[], maxBytes: number = RESUME_REPLAY_MAX_BYTES): ResumeReplayDecision {
	let bytes = 0;
	for (const frame of frames) {
		bytes += frame.bytes;
		if (bytes > maxBytes) return { kind: "resume_gap", bytes, reason: "byte_budget" };
	}
	return { kind: "replay", bytes };
}

export async function waitForReplayDrain(
	client: Pick<PaceableClient, "readyState" | "bufferedAmount">,
	deadlineEpochMs: number,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
	while (client.readyState === 1 && client.bufferedAmount > PACE_THRESHOLD_BYTES && Date.now() < deadlineEpochMs) {
		await sleep(10);
	}
	return client.readyState === 1 && client.bufferedAmount <= PACE_THRESHOLD_BYTES;
}

export async function paceAndSend(
	client: PaceableClient,
	data: string,
	deadlineEpochMs: number,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
	if (client.readyState !== 1) return;
	while (client.bufferedAmount > PACE_THRESHOLD_BYTES && Date.now() < deadlineEpochMs) {
		await sleep(10);
	}
	client.send(data);
}
