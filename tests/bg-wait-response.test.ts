/**
 * Unit tests for `streamBgWaitResponse` (src/server/agent/bg-wait-response.ts).
 *
 * These pin the DESIRED post-fix behaviour of the bg-process `wait` long-poll:
 * headers are flushed immediately (Transfer-Encoding: chunked) so undici's
 * default `headersTimeout` (~300s) can never fire, and a heartbeat newline is
 * written on `heartbeatMs` ticks while the wait is pending. The final JSON
 * payload is sent via `res.end(JSON.stringify(result))` and must parse even
 * with leading heartbeat newlines (valid JSON whitespace).
 *
 * Fully deterministic — millisecond timers only, no wall-clock sleeps.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { streamBgWaitResponse, type BgWaitResult } from "../src/server/agent/bg-wait-response.ts";
import type { BgProcessInfo } from "../src/server/agent/bg-process-manager.ts";

// --- Fake res -------------------------------------------------------------

interface FakeRes {
	headWritten: boolean;
	statusCode: number;
	headers: Record<string, string | number>;
	chunks: string[];
	ended: boolean;
	writeHead(status: number, headers?: Record<string, string | number>): FakeRes;
	write(chunk: unknown): boolean;
	end(chunk?: unknown): void;
}

function fakeRes(): FakeRes {
	const fr: FakeRes = {
		headWritten: false,
		statusCode: 0,
		headers: {},
		chunks: [],
		ended: false,
		writeHead(status, headers) {
			fr.headWritten = true;
			fr.statusCode = status;
			if (headers) for (const [k, v] of Object.entries(headers)) fr.headers[k.toLowerCase()] = v;
			return fr;
		},
		write(chunk) {
			fr.chunks.push(String(chunk));
			return true;
		},
		end(chunk) {
			if (chunk != null) fr.chunks.push(String(chunk));
			fr.ended = true;
		},
	};
	return fr;
}

/** A promise with an externally-controllable resolve. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

function sampleInfo(): BgProcessInfo {
	return {
		id: "bg-1",
		name: "sleeper",
		command: "sleep 600; echo done",
		pid: 4242,
		status: "exited",
		exitCode: 0,
		terminalReason: "normal",
		startTime: 1_000,
		endTime: 2_000,
	};
}

/** Concatenate everything written + ended, then JSON.parse (leading heartbeat
 * newlines are valid JSON whitespace). */
function parseBody(res: FakeRes): unknown {
	return JSON.parse(res.chunks.join(""));
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Tests ----------------------------------------------------------------

describe("streamBgWaitResponse", () => {
	it("A: flushes chunked headers immediately, before the wait resolves", async () => {
		const d = deferred<BgWaitResult>();
		const res = fakeRes();

		// Start the stream but DO NOT resolve the wait yet.
		const done = streamBgWaitResponse(res, () => d.promise, { heartbeatMs: 5 });

		// Let any synchronous/microtask work settle while the wait is pending.
		await tick(15);

		// Headers MUST already be flushed (so undici's headersTimeout can't fire)
		// even though the wait is still pending.
		assert.equal(res.headWritten, true, "writeHead must be called before the wait resolves");
		assert.equal(res.statusCode, 200, "status should be 200 while streaming");
		assert.equal(
			res.headers["transfer-encoding"],
			"chunked",
			"response must use Transfer-Encoding: chunked so headers flush immediately",
		);
		assert.equal(res.ended, false, "response must not be ended while the wait is pending");

		// Clean up: resolve and await.
		d.resolve({ info: sampleInfo(), timedOut: false, aborted: false });
		await done;
	});

	it("B: writes at least one heartbeat newline on tick while pending", async () => {
		const d = deferred<BgWaitResult>();
		const res = fakeRes();

		const done = streamBgWaitResponse(res, () => d.promise, { heartbeatMs: 5 });

		// Allow several heartbeat intervals to elapse while still pending.
		await tick(25);

		const wroteHeartbeat = res.chunks.some((c) => c.includes("\n"));
		assert.equal(wroteHeartbeat, true, "at least one heartbeat newline must be written while the wait is pending");
		assert.equal(res.ended, false, "response must not be ended while the wait is pending");

		d.resolve({ info: sampleInfo(), timedOut: false, aborted: false });
		await done;
	});

	it("C: final payload parses to the result (leading heartbeats tolerated)", async () => {
		const d = deferred<BgWaitResult>();
		const res = fakeRes();
		const result = { info: sampleInfo(), timedOut: false, aborted: false };

		const done = streamBgWaitResponse(res, () => d.promise, { heartbeatMs: 5 });
		// Let a heartbeat or two land before resolving, then resolve.
		await tick(12);
		d.resolve(result);
		await done;

		assert.equal(res.ended, true, "response must be ended after the wait resolves");
		assert.deepEqual(parseBody(res), result, "concatenated body must JSON.parse to the wait result");
	});

	it("C2: null result produces a 404 'Process not found' JSON body", async () => {
		const res = fakeRes();
		await streamBgWaitResponse(res, async () => null, { heartbeatMs: 5 });

		assert.equal(res.statusCode, 404, "unknown process must respond 404");
		assert.equal(res.ended, true);
		assert.deepEqual(parseBody(res), { error: "Process not found" });
	});
});
