/**
 * Reproducing test (failing-first) — image/attachment-only prompt breaks the session.
 *
 * Issue: sending a prompt whose text body is empty (or whitespace-only) but
 * which carries an image is dispatched to the agent bridge with a BLANK
 * `message` text. The model API rejects a user ContentBlock with blank text
 * ("the text field in the ContentBlock … is blank"), the turn errors, and the
 * poisoned blank-text turn replays on every subsequent prompt/retry — a
 * permanent blocker.
 *
 * These tests assert the DESIRED (fixed) behaviour, so they FAIL on current
 * unfixed code:
 *   1. empty text + image  → bridge.prompt() receives NON-BLANK text ("Attachments:").
 *   2. whitespace text + image → bridge.prompt() receives NON-BLANK text.
 *   3. stuck-session recovery: after a blank-text validation error, retry must
 *      re-dispatch with NON-BLANK text AND preserve the image (current code
 *      replays blank / drops the image via the generic fallback branch).
 *
 * Harness mirrors tests/session-manager-force-abort-grace.test.ts (real
 * SessionManager, registerRpcBridgeFactory, manual session seeding) and the
 * dispatch-oriented assertions of tests/queue-dispatch.spec.ts.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "image-only-prompt-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");
const { registerRpcBridgeFactory } = await import("../src/server/agent/rpc-bridge.ts");

type RecordedPrompt = {
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

const FAKE_IMAGE = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

const managers: any[] = [];
afterEach(() => {
	registerRpcBridgeFactory(null);
	while (managers.length > 0) {
		const m = managers.pop();
		if (m._statusHeartbeatTimer) clearInterval(m._statusHeartbeatTimer);
		m.sessions?.clear();
	}
});

/**
 * Build a SessionManager with one idle session whose rpcClient is a fake bridge
 * that records every prompt(text, images) call. Returns the recorded-prompt
 * array so tests can inspect what reached the agent.
 */
function seedIdleSession(): { manager: any; sessionId: string; recorded: RecordedPrompt[] } {
	const recorded: RecordedPrompt[] = [];

	// Recording fake bridge — installed via the public factory so no real
	// child process is ever spawned (also used as session.rpcClient below).
	const fakeBridge: any = {
		running: true,
		async start() {},
		async stop() {},
		prompt(text: string, images?: RecordedPrompt["images"]) {
			recorded.push({ text, images });
			return Promise.resolve({ success: true });
		},
		steer() { return Promise.resolve({ success: true }); },
		abort() { return Promise.resolve({ success: true }); },
		getState() { return Promise.resolve({ success: true }); },
		getMessages() { return Promise.resolve({ success: true, data: { messages: [] } }); },
		setModel() { return Promise.resolve({ success: true }); },
		setThinkingLevel() { return Promise.resolve({ success: true }); },
		compact() { return Promise.resolve({ success: true }); },
		async waitForReady() {},
		sendCommand() { return Promise.resolve({ success: true }); },
		onEvent() { return () => {}; },
	};
	registerRpcBridgeFactory(() => fakeBridge);

	const manager: any = new SessionManager();
	manager._testStore = { update: () => {}, get: () => undefined };
	managers.push(manager);

	const sessionId = "s-image-only";
	const session: any = {
		id: sessionId,
		title: "Image only",
		titleGenerated: true, // skip fire-and-forget title generation (no network)
		cwd: tmpRoot,
		status: "idle",
		statusVersion: 1,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set(),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		inFlightSteerTexts: [],
		unsubscribe: () => {},
		rpcClient: fakeBridge,
	};
	manager.sessions.set(sessionId, session);

	return { manager, sessionId, recorded };
}

describe("image/attachment-only prompt dispatch (reproducing)", () => {
	it("dispatches NON-BLANK text when prompt has empty text + an image", async () => {
		const { manager, sessionId, recorded } = seedIdleSession();

		await manager.enqueuePrompt(sessionId, "", { images: [FAKE_IMAGE] });

		assert.equal(recorded.length, 1, "exactly one prompt should have been dispatched to the agent bridge");
		const dispatched = recorded[0];
		assert.notEqual(
			dispatched.text.trim(),
			"",
			`expected non-blank dispatched text for an image-only prompt, but the agent bridge received blank text (got ${JSON.stringify(dispatched.text)})`,
		);
		assert.equal(
			dispatched.text,
			"Attachments:",
			`expected synthetic "Attachments:" text for an image-only prompt, got ${JSON.stringify(dispatched.text)}`,
		);
	});

	it("dispatches NON-BLANK text when prompt has whitespace-only text + an image", async () => {
		const { manager, sessionId, recorded } = seedIdleSession();

		await manager.enqueuePrompt(sessionId, "   \n\t  ", { images: [FAKE_IMAGE] });

		assert.equal(recorded.length, 1, "exactly one prompt should have been dispatched to the agent bridge");
		const dispatched = recorded[0];
		assert.notEqual(
			dispatched.text.trim(),
			"",
			`expected non-blank dispatched text for a whitespace-only + image prompt, but the agent bridge received blank text (got ${JSON.stringify(dispatched.text)})`,
		);
		assert.equal(
			dispatched.text,
			"Attachments:",
			`expected synthetic "Attachments:" text for a whitespace-only + image prompt, got ${JSON.stringify(dispatched.text)}`,
		);
	});

	it("recovers a stuck session: retry after a blank-text error re-dispatches NON-BLANK text AND preserves the image", async () => {
		const { manager, sessionId, recorded } = seedIdleSession();
		const session = manager.sessions.get(sessionId);

		// First send: image-only prompt. (On current code this dispatches blank
		// text, which the model rejects.)
		await manager.enqueuePrompt(sessionId, "", { images: [FAKE_IMAGE] });

		// Simulate the turn ending with the blank-ContentBlock validation error,
		// leaving the session in the stuck error state.
		session.status = "idle";
		session.lastTurnErrored = true;
		session.lastTurnErrorMessage =
			"Validation error: the text field in the ContentBlock at messages.0.content.0 is blank. Add text to the text field and try again.";
		session.turnHadToolCalls = false;
		session.consecutiveErrorTurns = 1;

		// User clicks Retry — recovery MUST re-dispatch with valid (non-blank)
		// content and keep the image, instead of replaying blank text or
		// silently dropping the image via the generic fallback branch.
		await manager.retryLastPrompt(sessionId);

		const retryDispatch = recorded[recorded.length - 1];
		assert.notEqual(
			retryDispatch.text.trim(),
			"",
			`expected non-blank dispatched text on stuck-session retry, but the agent bridge received blank text (got ${JSON.stringify(retryDispatch.text)})`,
		);
		assert.ok(
			Array.isArray(retryDispatch.images) && retryDispatch.images.length === 1,
			`expected the image to be preserved on stuck-session retry, but images were ${JSON.stringify(retryDispatch.images)} (current code drops the image via the generic fallback branch)`,
		);
	});
});
