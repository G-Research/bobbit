/**
 * Shared route helpers for the per-domain HTTP route modules.
 * Created during the server.ts → routes/ split.
 */
import http from "node:http";

/**
 * Parse a JSON request body. Returns `null` on malformed JSON.
 *
 * The null-on-error contract is load-bearing: many existing route handlers
 * test `if (!body)` to reject malformed input. Do not change this.
 */
export function readBody(req: http.IncomingMessage): Promise<any> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString()));
			} catch {
				resolve(null);
			}
		});
	});
}

/** Standard JSON response. */
export function json(res: http.ServerResponse, body: unknown, status = 200): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

/** Standard error response. Every route handler MUST go through this for errors. */
export function jsonError(
	res: http.ServerResponse,
	status: number,
	err: unknown,
	extra?: Record<string, unknown>,
): void {
	const e = err instanceof Error ? err : new Error(String(err));
	json(res, { error: e.message, stack: e.stack, ...extra }, status);
}
