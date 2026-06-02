import type { ServerResponse } from "node:http";
import type { BgProcessInfo } from "./bg-process-manager.js";

/** Result shape produced by `BgProcessManager.waitForExit`. */
export type BgWaitResult = { info: BgProcessInfo; timedOut: boolean; aborted: boolean } | null;

/**
 * Stream the bg-process `wait` long-poll response.
 *
 * The long-poll can stay open for the full configurable wait timeout (default
 * 300s). The HTTP client (undici) enforces a default `headersTimeout` of ~300s
 * — if the server writes no bytes to the socket before that elapses, the
 * client throws `fetch failed`. The fix (mirroring the session `/wait`
 * endpoint) flushes headers immediately with `Transfer-Encoding: chunked` and
 * writes a heartbeat newline on `heartbeatMs` ticks while the wait is pending,
 * then ends with the final JSON payload.
 *
 * NOTE: this is the behaviour-preserving extraction step — it still replicates
 * the CURRENT broken behaviour (await the result first, then write headers +
 * body in one shot). The `heartbeatMs` seam exists but is unused here; the fix
 * lands in a later step.
 */
export async function streamBgWaitResponse(
	res: ServerResponse,
	waitForExit: () => Promise<BgWaitResult>,
	_opts?: { heartbeatMs?: number },
): Promise<void> {
	const result = await waitForExit();
	if (!result) {
		const body = JSON.stringify({ error: "Process not found" });
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(body);
		return;
	}
	const body = JSON.stringify(result);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(body);
}
