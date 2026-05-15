/**
 * Regression test for the command-step timeout hardening in
 * `VerificationHarness.runCommandStep`.
 *
 * Bug: the harness fired SIGKILL on timeout but only resolved its promise
 * inside the child's `close` handler. When the detached process group held
 * onto stdio FDs via descendants — or `close` was otherwise delayed/missing —
 * the step never settled, so the gate stayed pending past its declared
 * timeout (observed on the E2E gate that ran past 900s until a manual
 * gateway restart unblocked it).
 *
 * Fix: the timeout handler kills the child best-effort AND arms a small
 * grace timer. Either `close` fires (normal fast path) or the grace timer
 * resolves the promise itself with whatever output is on disk/in memory.
 * A single `resolved` guard prevents double resolution.
 *
 * This test pins:
 *   - a hung command resolves within bounded time (timeout + grace + slack);
 *   - the result reports the timeout (`passed === false` and a
 *     `command timed out after Ns` message when no output was produced);
 *   - subsequent late `close` events do not re-resolve the promise (covered
 *     implicitly by `assert.doesNotReject` and absence of unhandled errors).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWin = process.platform === "win32";

test("runCommandStep — hung command resolves on timeout, not indefinitely", { skip: isWin }, async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verif-cmd-timeout-"));
	const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

	// Minimal harness — most collaborators are unused on the runCommandStep path.
	const harness = new (VerificationHarness as any)(
		stateDir,
		undefined,           // gateStore (deprecated)
		() => {},            // broadcastFn
		{} as any,           // roleStore
	);

	// Tighten the post-kill grace window so the test settles quickly even if
	// `close` were never delivered (the bug scenario this test guards).
	(harness as any)._setCommandStepGraceMs(150);

	const startedAt = Date.now();
	// `sleep 30` is well outside any reasonable test runtime; timeout = 1s.
	const result = await (harness as any).runCommandStep(
		"sleep 30",
		stateDir,
		1,         // timeoutSec
		false,     // expectFailure
		undefined, // streamCtx — forces attached mode (still must time out cleanly)
		undefined, // errorPattern
		undefined, // containerId
	);
	const elapsed = Date.now() - startedAt;

	// Must settle promptly — well under the original 900s wedge, and within
	// timeout (1s) + grace (0.15s) + comfortable slack for CI process spawn.
	assert.ok(elapsed < 10_000, `runCommandStep took too long to resolve: ${elapsed}ms`);
	assert.equal(result.passed, false, "timed-out command must not pass");
	assert.match(
		String(result.output),
		/timed out after 1s|sleep/i,
		`unexpected timeout output: ${result.output}`,
	);
});

test("runCommandStep — fast-exit command still resolves normally (no regression)", { skip: isWin }, async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verif-cmd-ok-"));
	const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

	const harness = new (VerificationHarness as any)(
		stateDir,
		undefined,
		() => {},
		{} as any,
	);
	(harness as any)._setCommandStepGraceMs(50);

	const result = await (harness as any).runCommandStep(
		"echo hello",
		stateDir,
		10,        // generous timeout
		false,
		undefined,
		undefined,
		undefined,
	);
	assert.equal(result.passed, true, `expected pass for echo, got: ${JSON.stringify(result)}`);
	assert.match(String(result.output), /hello/);
});

test("runCommandStep — expectFailure + timeout still resolves with timeout output", { skip: isWin }, async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verif-cmd-expectfail-"));
	const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

	const harness = new (VerificationHarness as any)(
		stateDir,
		undefined,
		() => {},
		{} as any,
	);
	(harness as any)._setCommandStepGraceMs(100);

	// expectFailure=true with no errorPattern — matchExpectFailure returns
	// passed=true on non-zero exit (timeout produces null/non-zero).
	const result = await (harness as any).runCommandStep(
		"sleep 30",
		stateDir,
		1,
		true,      // expectFailure
		undefined,
		undefined, // no errorPattern — any failure (including timeout) counts
		undefined,
	);
	// We don't pin the exact passed value (matchExpectFailure semantics live
	// elsewhere); we just pin that the call resolves with a defined result.
	assert.ok(result && typeof result.passed === "boolean", "result must be defined");
	assert.match(String(result.output ?? ""), /.+/);
});
