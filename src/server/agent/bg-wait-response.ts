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
 * Header flush is LAZY — driven by the first heartbeat tick — rather than
 * eager. This is deliberate: `waitForExit` returns `null` synchronously (on the
 * first microtask) for an unknown process id, which resolves long before the
 * first heartbeat fires. By deferring the head until that first tick we can
 * still send a genuine `404` for the not-found case (no bytes written yet),
 * while a real pending wait flushes a `200`/chunked head on the first heartbeat
 * — well inside undici's ~300s `headersTimeout`, so it can never trip.
 */
export async function streamBgWaitResponse(
	res: ServerResponse,
	waitForExit: () => Promise<BgWaitResult>,
	opts?: { heartbeatMs?: number },
): Promise<void> {
	const heartbeatMs = opts?.heartbeatMs ?? 60_000;
	let headWritten = false;
	const ensureHead = (): void => {
		if (headWritten) return;
		headWritten = true;
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Transfer-Encoding": "chunked",
			"Cache-Control": "no-cache",
		});
	};

	// Heartbeat newline keeps the long-poll connection alive past undici's
	// default headersTimeout. The first tick also flushes the chunked head.
	const heartbeat = setInterval(() => {
		try {
			ensureHead();
			res.write("\n");
		} catch { /* ignore — connection may already be torn down */ }
	}, heartbeatMs);

	try {
		const result = await waitForExit();
		if (!result) {
			if (!headWritten) {
				// No bytes written yet → safe to emit a real 404, preserving the
				// original not-found contract.
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Process not found" }));
				return;
			}
			// Head already flushed (200/chunked) — can't change status now, so put
			// the error in the body, mirroring the session /wait endpoint.
			res.end(JSON.stringify({ error: "Process not found" }));
			return;
		}
		ensureHead();
		res.end(JSON.stringify(result));
	} finally {
		clearInterval(heartbeat);
	}
}
