/**
 * Per-request error backstop for the gateway HTTP handler.
 *
 * Motivation
 * ----------
 * `handleApiRoute` is a ~5k-line dispatcher; an unhandled rejection inside any
 * branch (e.g. a `TypeError: gateDef.dependsOn is not iterable` from a stale
 * persisted gate) crashes the request handler without flushing a response.
 * The client (curl, an MCP tool, the UI) then waits the full socket timeout
 * (60s) before seeing a generic `fetch failed`. This backstop catches any
 * such throw, writes a structured 500, and logs the full error + stack so
 * server-side debugging is possible.
 *
 * This module is deliberately tiny and pure: it knows nothing about HTTP
 * implementation details beyond the minimal `ApiErrorRes` shape, which keeps
 * unit tests trivial (no real `http.ServerResponse` or socket needed).
 *
 * Caveats
 * -------
 * - When `res.headersSent` is already `true` the route has begun streaming a
 *   response; we cannot recover (writing again would crash the response on
 *   a duplicate `writeHead`). We log and bail.
 * - We use `err.message` rather than `String(err)` to avoid the
 *   `Error: <msg>` double-wrap pattern (cf. the prior `String(err)` cleanup
 *   in `format-gateway-error.ts`).
 * - Callers MUST swallow any throw from this helper; the backstop's whole
 *   point is to keep the request handler from propagating.
 */

/** Minimal subset of `http.ServerResponse` we need. */
export interface ApiErrorRes {
	headersSent: boolean;
	writeHead(status: number, headers?: Record<string, string>): void;
	end(body?: string): void;
}

/** Body shape clients receive on an unhandled-error 500. */
export interface ApiErrorBody {
	error: string;
	reason: "unhandled-error";
	path: string;
}

/**
 * Write a structured 500 to `res` if headers haven't been sent yet, and
 * always log the full error + stack to `console.error`.
 *
 * Returns `void`. Never throws — callers can trust the backstop pattern
 * `try { await handleApiRoute(...) } catch (err) { handleApiError(err, res, path); }`
 * to be safe.
 */
export function handleApiError(err: unknown, res: ApiErrorRes, pathname: string): void {
	// Always log first — even when we can't recover the response, server-side
	// debugging needs the stack.
	const stack = err instanceof Error ? (err.stack || err.message) : String(err);
	console.error(`[api-error-backstop] unhandled error on ${pathname}:`, stack);

	if (res.headersSent) {
		// Route already started writing — can't write a 500 on top of a partial
		// response. The client will see whatever bytes the route wrote plus a
		// truncated stream when the socket eventually closes.
		return;
	}

	const message = err instanceof Error ? err.message : String(err);
	const body: ApiErrorBody = {
		error: message,
		reason: "unhandled-error",
		path: pathname,
	};

	try {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	} catch (writeErr) {
		// If even writeHead/end throws (e.g. socket already closed), swallow —
		// the connection is gone, there's nothing left to do.
		console.error(`[api-error-backstop] failed to write 500 response for ${pathname}:`, writeErr);
	}
}
