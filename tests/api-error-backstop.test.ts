/**
 * Unit tests for the per-request error backstop in
 * `src/server/api-error-handler.ts`.
 *
 * Pinned regression: an unhandled rejection inside `handleApiRoute` (e.g.
 * `TypeError: gateDef.dependsOn is not iterable` from a stale persisted
 * gate) used to crash the request handler without flushing a response.
 * Clients (curl / MCP / the UI) waited the full ~60s socket timeout before
 * seeing a generic `fetch failed`, hiding the actionable detail.
 *
 * The backstop catches any throw from the dispatcher and either:
 *   - writes a structured 500 (when `res.headersSent === false`), OR
 *   - logs and bails (when headers are already on the wire — writing again
 *     would crash the response).
 *
 * Either way it always logs the full error + stack to `console.error`.
 *
 * See:
 *   - src/server/api-error-handler.ts::handleApiError
 *   - src/server/server.ts::requestHandler (call site)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleApiError, type ApiErrorRes, type ApiErrorBody } from "../src/server/api-error-handler.ts";

/** Spy stand-in for `http.ServerResponse`. Captures every interaction so tests
 *  can assert on the exact wire bytes written. */
interface SpyRes extends ApiErrorRes {
	calls: {
		writeHead?: { status: number; headers?: Record<string, string> };
		end?: { body?: string };
	};
}

function makeSpyRes(headersSent = false): SpyRes {
	const calls: SpyRes["calls"] = {};
	return {
		headersSent,
		writeHead(status, headers) {
			calls.writeHead = { status, headers };
		},
		end(body) {
			calls.end = { body };
		},
		calls,
	};
}

/** Capture `console.error` while running `fn`. Returns `[result, errorCalls]`.
 *  We restore the original `console.error` on both success and throw paths. */
function captureConsoleError<T>(fn: () => T): { result: T; errors: unknown[][] } {
	const errors: unknown[][] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		const result = fn();
		return { result, errors };
	} finally {
		console.error = original;
	}
}

describe("handleApiError", () => {
	describe("when headers have not been sent", () => {
		it("writes a 500 with {error, reason, path} JSON body", () => {
			const res = makeSpyRes(false);
			const err = new TypeError("gateDef.dependsOn is not iterable");
			captureConsoleError(() => handleApiError(err, res, "/api/goals/g1/gates"));

			assert.equal(res.calls.writeHead?.status, 500);
			assert.deepEqual(res.calls.writeHead?.headers, { "Content-Type": "application/json" });
			assert.ok(res.calls.end?.body, "expected end() to be called with a body");
			const parsed = JSON.parse(res.calls.end!.body!) as ApiErrorBody;
			assert.equal(parsed.error, "gateDef.dependsOn is not iterable");
			assert.equal(parsed.reason, "unhandled-error");
			assert.equal(parsed.path, "/api/goals/g1/gates");
		});

		it("uses err.message rather than String(err) — no `Error: <msg>` double-wrap", () => {
			const res = makeSpyRes(false);
			const err = new Error("boom");
			captureConsoleError(() => handleApiError(err, res, "/api/x"));
			const parsed = JSON.parse(res.calls.end!.body!) as ApiErrorBody;
			// String(err) would produce "Error: boom" — we explicitly want "boom".
			assert.equal(parsed.error, "boom");
			assert.notEqual(parsed.error, "Error: boom");
		});

		it("falls back to String(err) for non-Error throws (e.g. a thrown string)", () => {
			const res = makeSpyRes(false);
			captureConsoleError(() => handleApiError("plain string", res, "/api/y"));
			const parsed = JSON.parse(res.calls.end!.body!) as ApiErrorBody;
			assert.equal(parsed.error, "plain string");
		});

		it("logs the full stack to console.error", () => {
			const res = makeSpyRes(false);
			const err = new Error("logged");
			const { errors } = captureConsoleError(() => handleApiError(err, res, "/api/z"));
			assert.equal(errors.length, 1);
			// First arg is the prefix string mentioning the path; the second is the stack.
			const prefix = String(errors[0][0]);
			assert.ok(prefix.includes("[api-error-backstop]"), `prefix: ${prefix}`);
			assert.ok(prefix.includes("/api/z"), `prefix: ${prefix}`);
			const stack = String(errors[0][1]);
			assert.ok(stack.includes("logged"), `stack: ${stack}`);
		});

		it("does not throw when given a valid res + Error", () => {
			const res = makeSpyRes(false);
			assert.doesNotThrow(() => {
				captureConsoleError(() => handleApiError(new Error("x"), res, "/api/x"));
			});
		});
	});

	describe("when headers have already been sent", () => {
		it("does NOT call writeHead or end — would crash the partial response", () => {
			const res = makeSpyRes(true);
			const err = new Error("late failure mid-stream");
			captureConsoleError(() => handleApiError(err, res, "/api/big-stream"));

			assert.equal(res.calls.writeHead, undefined, "writeHead must not be called when headersSent");
			assert.equal(res.calls.end, undefined, "end must not be called when headersSent");
		});

		it("still logs the error to console.error so server-side debugging works", () => {
			const res = makeSpyRes(true);
			const err = new Error("late failure");
			const { errors } = captureConsoleError(() => handleApiError(err, res, "/api/big-stream"));
			assert.equal(errors.length, 1);
			assert.ok(String(errors[0][0]).includes("/api/big-stream"));
		});

		it("does not throw even though the response is unrecoverable", () => {
			const res = makeSpyRes(true);
			assert.doesNotThrow(() => {
				captureConsoleError(() => handleApiError(new Error("x"), res, "/api/x"));
			});
		});
	});

	describe("write-side failures (defence in depth)", () => {
		it("swallows a throw from writeHead/end so the request handler keeps going", () => {
			const res: SpyRes = {
				headersSent: false,
				writeHead() { throw new Error("socket gone"); },
				end() { /* never reached */ },
				calls: {},
			};
			assert.doesNotThrow(() => {
				captureConsoleError(() => handleApiError(new Error("orig"), res, "/api/x"));
			});
		});
	});
});
