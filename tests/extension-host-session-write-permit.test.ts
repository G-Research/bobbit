/**
 * Unit tests for the server-minted, one-time, content-bound WRITE PERMIT
 * (src/server/extension-host/session-write-permit.ts) — the fix that closes the
 * same-realm forge/replay vector the WS-only session-write move left open (design
 * docs/design/extension-host-phase2.md §8 C2.1).
 *
 * Pins:
 *   - a freshly minted permit consumes ONCE with a fully-matching binding;
 *   - reuse (replay) of a consumed permit is rejected;
 *   - any binding mismatch (sessionId / packId / tool / contentHash) is rejected
 *     AND does not consume the legitimate permit;
 *   - an expired permit (past TTL) is rejected;
 *   - an unknown / empty nonce is rejected;
 *   - computeContentHash is sha256 hex of `role + "\n" + text`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mintWritePermit,
	consumeWritePermit,
	computeContentHash,
	_resetWritePermits,
	_livePermitCount,
	type WritePermitBinding,
} from "../src/server/extension-host/session-write-permit.ts";

const BINDING: WritePermitBinding = {
	sessionId: "sess-1",
	packId: "my-pack",
	tool: "sample_action",
	contentHash: computeContentHash("user", "hello agent"),
};

beforeEach(() => _resetWritePermits());

describe("computeContentHash", () => {
	it("is sha256 hex of `role + \\n + text`", () => {
		const expected = createHash("sha256").update("user\nhello agent", "utf8").digest("hex");
		assert.equal(computeContentHash("user", "hello agent"), expected);
		assert.equal(computeContentHash("user", "hello agent").length, 64);
	});

	it("differs when role or text differ (binding is content-specific)", () => {
		assert.notEqual(computeContentHash("user", "a"), computeContentHash("system", "a"));
		assert.notEqual(computeContentHash("user", "a"), computeContentHash("user", "b"));
	});
});

describe("mint + consume happy path", () => {
	it("consumes ONCE with a fully-matching binding, then is dead (single-use)", () => {
		const nonce = mintWritePermit(BINDING);
		assert.equal(typeof nonce, "string");
		assert.ok(nonce.length >= 16);
		assert.equal(consumeWritePermit(nonce, BINDING), true);
		// Replay: already consumed → rejected.
		assert.equal(consumeWritePermit(nonce, BINDING), false);
	});

	it("each mint yields a distinct unguessable nonce", () => {
		const a = mintWritePermit(BINDING);
		const b = mintWritePermit(BINDING);
		assert.notEqual(a, b);
	});
});

describe("rejections", () => {
	it("unknown / empty nonce → false", () => {
		assert.equal(consumeWritePermit("does-not-exist", BINDING), false);
		assert.equal(consumeWritePermit("", BINDING), false);
		assert.equal(consumeWritePermit(undefined as unknown as string, BINDING), false);
	});

	it("binding mismatch → false, and the legitimate permit is NOT consumed", () => {
		for (const bad of [
			{ ...BINDING, sessionId: "other" },
			{ ...BINDING, packId: "other-pack" },
			{ ...BINDING, tool: "other_tool" },
			{ ...BINDING, contentHash: computeContentHash("user", "tampered") },
		] as WritePermitBinding[]) {
			_resetWritePermits();
			const nonce = mintWritePermit(BINDING);
			assert.equal(consumeWritePermit(nonce, bad), false);
			// The real binding can still consume it within TTL (mismatch didn't burn it).
			assert.equal(consumeWritePermit(nonce, BINDING), true);
		}
	});

	it("expired permit (past TTL) → false", () => {
		let t = 1_000;
		const now = () => t;
		const nonce = mintWritePermit(BINDING, { ttlMs: 5_000, now });
		t = 1_000 + 5_001; // advance past expiry
		assert.equal(consumeWritePermit(nonce, BINDING, { now }), false);
	});

	it("a permit valid within TTL still consumes", () => {
		let t = 1_000;
		const now = () => t;
		const nonce = mintWritePermit(BINDING, { ttlMs: 5_000, now });
		t = 1_000 + 4_999;
		assert.equal(consumeWritePermit(nonce, BINDING, { now }), true);
	});
});

describe("map bounding", () => {
	it("consuming removes the permit (no leak)", () => {
		_resetWritePermits();
		const nonce = mintWritePermit(BINDING);
		assert.equal(_livePermitCount(), 1);
		consumeWritePermit(nonce, BINDING);
		assert.equal(_livePermitCount(), 0);
	});
});
