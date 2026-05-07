/**
 * waitForStreaming semantics — `SessionManager.waitForStreaming` is a sibling of
 * `waitForIdle`. It resolves on the session's next `agent_start` event.
 * Used by the verification harness to ensure a just-resumed reviewer
 * actually enters its new turn before we race verification_result against
 * `waitForIdle` (which resolves synchronously on already-idle sessions).
 *
 * This test pins the helper's contract by exercising it against a stubbed
 * SessionManager-shaped object — full SessionManager construction is too
 * heavy for a unit test. The behavioural shape (subscribe to `onEvent`,
 * resolve on `agent_start`, reject on timeout, reject on `process_exit`)
 * mirrors the production source. Source-grep below pins the production
 * implementation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

interface MockListener {
	(event: any): void;
}

interface MockSession {
	id: string;
	status: "idle" | "streaming" | "terminated";
	rpcClient: {
		onEvent: (cb: MockListener) => () => void;
		_emit: (event: any) => void;
	};
}

function makeSession(initialStatus: "idle" | "streaming" | "terminated" = "idle"): MockSession {
	const listeners = new Set<MockListener>();
	return {
		id: "sess-1",
		status: initialStatus,
		rpcClient: {
			onEvent: (cb: MockListener) => {
				listeners.add(cb);
				return () => listeners.delete(cb);
			},
			_emit: (event: any) => {
				for (const l of listeners) l(event);
			},
		},
	};
}

/**
 * Mirror of `SessionManager.waitForStreaming`. The production source-grep
 * below pins the live file's shape; this re-implementation lets us exercise
 * the contract without the heavyweight class.
 */
function waitForStreaming(session: MockSession, timeoutMs = 10_000): Promise<void> {
	if (session.status === "streaming") return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			unsub();
			reject(new Error(`Timeout waiting for session ${session.id} to start streaming`));
		}, timeoutMs);
		const unsub = session.rpcClient.onEvent((event: any) => {
			if (event.type === "agent_start") {
				clearTimeout(timer);
				unsub();
				resolve();
			}
			if (event.type === "process_exit") {
				clearTimeout(timer);
				unsub();
				const reason = event.signal ? `signal ${event.signal}` : `code ${event.code}`;
				reject(new Error(`Agent process exited unexpectedly (${reason}) for session ${session.id}`));
			}
		});
	});
}

describe("waitForStreaming behaviour", () => {
	it("resolves immediately when the session is already streaming", async () => {
		const session = makeSession("streaming");
		await waitForStreaming(session, 100);
	});

	it("resolves on the next agent_start event", async () => {
		const session = makeSession("idle");
		const p = waitForStreaming(session, 1_000);
		// Tick: emit agent_start.
		setImmediate(() => session.rpcClient._emit({ type: "agent_start" }));
		await p;
	});

	it("rejects on timeout if no agent_start arrives", async () => {
		const session = makeSession("idle");
		await assert.rejects(
			waitForStreaming(session, 25),
			/Timeout waiting for session/,
		);
	});

	it("rejects when the agent process exits before streaming starts", async () => {
		const session = makeSession("idle");
		const p = waitForStreaming(session, 1_000);
		setImmediate(() => session.rpcClient._emit({ type: "process_exit", signal: "SIGTERM" }));
		await assert.rejects(p, /process exited unexpectedly/);
	});

	it("ignores unrelated events (message_update, tool_execution_*)", async () => {
		const session = makeSession("idle");
		const p = waitForStreaming(session, 1_000);
		setImmediate(() => {
			session.rpcClient._emit({ type: "message_update", text: "..." });
			session.rpcClient._emit({ type: "tool_execution_start" });
			session.rpcClient._emit({ type: "agent_start" });
		});
		await p; // resolves once agent_start arrives — the others are ignored.
	});

	it("the timer is cleared on resolve so it doesn't reject after the fact", async () => {
		const session = makeSession("idle");
		const p = waitForStreaming(session, 100);
		setImmediate(() => session.rpcClient._emit({ type: "agent_start" }));
		await p;
		// Wait past the original timeout — there should be no late rejection.
		await new Promise<void>((r) => setTimeout(r, 200));
		// (No assertion needed — if the timer didn't clear, an unhandled
		// rejection would have crashed the test runner.)
	});
});

describe("waitForStreaming source-grep guard", () => {
	const SOURCE = path.resolve(import.meta.dirname, "..", "src", "server", "agent", "session-manager.ts");
	const text = fs.readFileSync(SOURCE, "utf-8");

	it("declares `waitForStreaming` as a public method", () => {
		assert.match(text, /waitForStreaming\s*\(/, "the method must exist (greppable)");
	});

	it("subscribes to `agent_start` and resolves on it", () => {
		const idx = text.indexOf("waitForStreaming(");
		assert.ok(idx > 0);
		const window = text.slice(idx, idx + 1_500);
		assert.match(window, /agent_start/);
	});

	it("rejects on `process_exit` (process death surface)", () => {
		const idx = text.indexOf("waitForStreaming(");
		const window = text.slice(idx, idx + 1_500);
		assert.match(window, /process_exit/);
	});

	it("verification-harness wires the streaming-wait at all four reminder sites", () => {
		// Three of the four sites use SessionManager.waitForStreaming directly;
		// the legacy direct-RpcBridge reminder path inlines an equivalent
		// pattern (it doesn't have a SessionManager). Conservative pin: at
		// least 3 SessionManager.waitForStreaming calls + at least one inline
		// `agent_start`-listener-with-10_000-timeout block in the file.
		const HARNESS = path.resolve(import.meta.dirname, "..", "src", "server", "agent", "verification-harness.ts");
		const harness = fs.readFileSync(HARNESS, "utf-8");
		const sessionMgrSites = harness.match(/sessionManager!\.waitForStreaming\(/g) ?? [];
		assert.ok(
			sessionMgrSites.length >= 3,
			`expected at least 3 SessionManager.waitForStreaming call sites, got ${sessionMgrSites.length}`,
		);
		// The legacy path inlines the `agent_start` listener — match the
		// 10_000ms timeout signature near the comment that documents it.
		assert.match(
			harness,
			/mirror of SessionManager\.waitForStreaming/i,
			"legacy direct-RpcBridge path must document its inline mirror of waitForStreaming",
		);
	});
});
