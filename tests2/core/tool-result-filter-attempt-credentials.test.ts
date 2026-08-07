import { describe, expect, it } from "vitest";
import {
	createToolResultFilterAttemptToken,
	ToolResultFilterAttemptCredentials,
} from "../../src/server/agent/tool-result-filter-attempt-credentials.js";
import { SessionManager } from "../../src/server/agent/session-manager.js";

const sessionId = "session-attempt";
const toolCallId = "tool-call-1";
const issuedAt = 1_700_000_000_000;

function setup() {
	const credentials = new ToolResultFilterAttemptCredentials();
	const runtime = credentials.beginRuntime(sessionId, 7);
	const token = createToolResultFilterAttemptToken(runtime, sessionId, toolCallId, "7d1d98f4-bdcb-40ee-b0e1-7ac99f2df8db", issuedAt);
	return { credentials, runtime, token };
}

describe("ToolResultFilterAttemptCredentials", () => {
	it("accepts exactly one current session/tool attempt before any asynchronous dispatch", () => {
		const { credentials, token } = setup();
		expect(credentials.consume(sessionId, toolCallId, token, issuedAt + 1)).toBe(true);
		expect(credentials.consume(sessionId, toolCallId, token, issuedAt + 2)).toBe(false);
	});

	it("rejects bearer-only, cross-session, cross-tool, malformed, and expired credentials", () => {
		const { credentials, token } = setup();
		expect(credentials.consume(sessionId, toolCallId, undefined, issuedAt + 1)).toBe(false);
		expect(credentials.consume("other-session", toolCallId, token, issuedAt + 1)).toBe(false);
		expect(credentials.consume(sessionId, "other-tool", token, issuedAt + 1)).toBe(false);
		expect(credentials.consume(sessionId, toolCallId, "v1.bad", issuedAt + 1)).toBe(false);
		expect(credentials.consume(sessionId, toolCallId, token, issuedAt + 10_001)).toBe(false);
	});

	it("does not revoke a live gate for a coordinator-only generation advance", () => {
		const manager: any = new SessionManager();
		const runtime = manager.toolResultFilterAttemptCredentials.beginRuntime(sessionId, 0);
		const token = createToolResultFilterAttemptToken(runtime, sessionId, toolCallId, "3f2d78f4-bdcb-40ee-b0e1-7ac99f2df8db", issuedAt);
		// poison-redrive obtains a lifecycle coordinator token but does not replace
		// the Pi process; its live private gate must stay usable.
		manager._nextRespawnGeneration(sessionId);
		expect(manager.toolResultFilterAttemptCredentials.consume(sessionId, toolCallId, token, issuedAt + 1)).toBe(true);
	});

	it("invalidates old attempts on runtime replacement and teardown", () => {
		const { credentials, token } = setup();
		const next = credentials.beginRuntime(sessionId, 8);
		expect(credentials.consume(sessionId, toolCallId, token, issuedAt + 1)).toBe(false);
		const current = createToolResultFilterAttemptToken(next, sessionId, toolCallId, "4c9189ab-003f-4b4a-a31a-8b64b3d71b11", issuedAt);
		credentials.invalidate(sessionId);
		expect(credentials.consume(sessionId, toolCallId, current, issuedAt + 1)).toBe(false);
	});

	it("allows concurrent distinct tool attempts but never cross-settles them", () => {
		const credentials = new ToolResultFilterAttemptCredentials();
		const runtime = credentials.beginRuntime(sessionId, 1);
		const first = createToolResultFilterAttemptToken(runtime, sessionId, "call-a", "11111111-1111-4111-8111-111111111111", issuedAt);
		const second = createToolResultFilterAttemptToken(runtime, sessionId, "call-b", "22222222-2222-4222-8222-222222222222", issuedAt);
		expect(credentials.consume(sessionId, "call-b", first, issuedAt + 1)).toBe(false);
		expect(credentials.consume(sessionId, "call-a", first, issuedAt + 1)).toBe(true);
		expect(credentials.consume(sessionId, "call-b", second, issuedAt + 1)).toBe(true);
	});
});
