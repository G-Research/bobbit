/**
 * Pinning tests for `applyPiOfflineEnv()` in aigw-manager.
 *
 * Contract:
 *   1. hasInternet === false + PI_OFFLINE unset → PI_OFFLINE="1".
 *   2. hasInternet === true + PI_OFFLINE unset → PI_OFFLINE stays unset.
 *   3. PI_OFFLINE pre-set by user → preserved verbatim regardless of hasInternet.
 *   4. Idempotent — calling twice with hasInternet=false yields the same state.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { applyPiOfflineEnv } = await import("../src/server/agent/aigw-manager.js");

let saved: string | undefined;

beforeEach(() => {
	saved = process.env.PI_OFFLINE;
	delete process.env.PI_OFFLINE;
});

afterEach(() => {
	if (saved === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = saved;
});

describe("applyPiOfflineEnv", () => {
	it("sets PI_OFFLINE=1 when offline and var was unset", () => {
		applyPiOfflineEnv(false);
		assert.equal(process.env.PI_OFFLINE, "1");
	});

	it("does NOT set PI_OFFLINE when online", () => {
		applyPiOfflineEnv(true);
		assert.equal(process.env.PI_OFFLINE, undefined);
	});

	it("preserves a user-supplied PI_OFFLINE value when offline", () => {
		process.env.PI_OFFLINE = "user-value";
		applyPiOfflineEnv(false);
		assert.equal(process.env.PI_OFFLINE, "user-value");
	});

	it("preserves a user-supplied PI_OFFLINE value when online", () => {
		process.env.PI_OFFLINE = "user-value";
		applyPiOfflineEnv(true);
		assert.equal(process.env.PI_OFFLINE, "user-value");
	});

	it("treats empty string as unset and writes '1' when offline", () => {
		process.env.PI_OFFLINE = "";
		applyPiOfflineEnv(false);
		assert.equal(process.env.PI_OFFLINE, "1");
	});

	it("is idempotent across repeated offline calls", () => {
		applyPiOfflineEnv(false);
		applyPiOfflineEnv(false);
		applyPiOfflineEnv(false);
		assert.equal(process.env.PI_OFFLINE, "1");
	});

	it("does not clear PI_OFFLINE that this function set earlier, when called again with online=true", () => {
		// The function never CLEARS PI_OFFLINE — once set (by user or this
		// function), the value persists. This is the intentional semantics:
		// online detection is one-shot at startup; we don't introduce
		// transitions later.
		applyPiOfflineEnv(false);
		assert.equal(process.env.PI_OFFLINE, "1");
		applyPiOfflineEnv(true);
		assert.equal(process.env.PI_OFFLINE, "1");
	});
});
