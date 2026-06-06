/**
 * Sec-2 — global request-body size cap.
 *
 * `readBody()` must reject oversized payloads BEFORE `Buffer.concat()` /
 * `JSON.parse()` so a single huge body can never be fully materialised in
 * memory or handed to the JSON parser. The request handler additionally
 * refuses a too-large declared Content-Length up front with a 413 via the
 * pure `bodyLimitExceeded()` header check.
 *
 * These tests pin both the header precheck and the streaming cap.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";

import {
	MAX_REQUEST_BODY_BYTES,
	bodyLimitExceeded,
	readBody,
} from "../src/server/server.ts";

/**
 * Minimal IncomingMessage stand-in: an EventEmitter with a `destroy()` spy so
 * we can assert the stream is torn down when the cap is exceeded.
 */
function fakeReq(): http.IncomingMessage & { destroyed: boolean } {
	const emitter = new EventEmitter() as unknown as http.IncomingMessage & { destroyed: boolean };
	emitter.destroyed = false;
	(emitter as unknown as { destroy: () => void }).destroy = () => { (emitter as { destroyed: boolean }).destroyed = true; };
	return emitter;
}

describe("bodyLimitExceeded (Content-Length precheck)", () => {
	it("returns false when no Content-Length header is present", () => {
		assert.equal(bodyLimitExceeded(undefined), false);
	});

	it("returns false at exactly the cap", () => {
		assert.equal(bodyLimitExceeded(String(MAX_REQUEST_BODY_BYTES)), false);
	});

	it("returns true one byte over the cap", () => {
		assert.equal(bodyLimitExceeded(String(MAX_REQUEST_BODY_BYTES + 1)), true);
	});

	it("handles an array header value (uses the first element)", () => {
		assert.equal(bodyLimitExceeded([String(MAX_REQUEST_BODY_BYTES + 1)]), true);
		assert.equal(bodyLimitExceeded([String(MAX_REQUEST_BODY_BYTES)]), false);
	});

	it("ignores a non-numeric Content-Length (cannot trust it; streaming cap covers it)", () => {
		assert.equal(bodyLimitExceeded("not-a-number"), false);
	});

	it("respects a custom maxBytes argument", () => {
		assert.equal(bodyLimitExceeded("11", 10), true);
		assert.equal(bodyLimitExceeded("10", 10), false);
	});
});

describe("readBody (streaming cap)", () => {
	it("parses a normal JSON body", async () => {
		const req = fakeReq();
		const p = readBody(req);
		req.emit("data", Buffer.from(JSON.stringify({ hello: "world" })));
		req.emit("end");
		assert.deepEqual(await p, { hello: "world" });
	});

	it("resolves null and destroys the stream when the body exceeds the cap BEFORE parsing", async () => {
		const req = fakeReq();
		const cap = 1024;
		const p = readBody(req, cap);
		// Emit chunks that together exceed the cap. The parser must never see
		// the full body — resolution is null and the stream is destroyed.
		req.emit("data", Buffer.alloc(cap)); // exactly at cap — still buffered
		req.emit("data", Buffer.alloc(1));   // one byte over — trips the cap
		// A late 'end' must not flip the already-settled null result.
		req.emit("end");
		const result = await p;
		assert.equal(result, null);
		assert.equal(req.destroyed, true);
	});

	it("accepts a body exactly at the cap", async () => {
		const req = fakeReq();
		const json = JSON.stringify({ a: "x".repeat(50) });
		const cap = Buffer.byteLength(json);
		const p = readBody(req, cap);
		req.emit("data", Buffer.from(json));
		req.emit("end");
		assert.deepEqual(await p, { a: "x".repeat(50) });
	});

	it("rejects an oversized body delivered in many small chunks (cumulative cap)", async () => {
		const req = fakeReq();
		const cap = 100;
		const p = readBody(req, cap);
		for (let i = 0; i < 20; i++) req.emit("data", Buffer.alloc(10)); // 200 bytes total
		req.emit("end");
		assert.equal(await p, null);
		assert.equal(req.destroyed, true);
	});

	it("resolves null on malformed JSON within the cap (existing contract)", async () => {
		const req = fakeReq();
		const p = readBody(req);
		req.emit("data", Buffer.from("{not json"));
		req.emit("end");
		assert.equal(await p, null);
	});

	it("resolves null on a stream error", async () => {
		const req = fakeReq();
		const p = readBody(req);
		req.emit("error", new Error("boom"));
		assert.equal(await p, null);
	});
});
