import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

const {
	SessionManager,
	prepareVisibleAgentEvent,
	restorePromptAuthorBindings,
} = await import("../../src/server/agent/session-manager.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	initAuthorSidecarDir,
	readAuthorSidecar,
} = await import("../../src/server/agent/author-sidecar.ts");

const userAuthor = { kind: "user", id: "user:local", label: "User" } as const;
const systemAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
const text = "same persisted keyless bytes";

let stateDir = "";

beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-keyless-replay-cursor-"));
	initAuthorSidecarDir(stateDir, {
		secretsDir: stateDir,
		hmacKey: Buffer.alloc(32, 0x5c),
	});
});

afterEach(() => {
	fs.rmSync(stateDir, { recursive: true, force: true });
});

function replayStart(target: any): void {
	prepareVisibleAgentEvent(target, {
		type: "message_start",
		message: { role: "user", content: text },
	});
}

function replayEnd(target: any): any {
	return prepareVisibleAgentEvent(target, {
		type: "message_end",
		message: { role: "user", content: text },
	});
}

function consumeSteerEcho(harness: any, target: any, event: any): void {
	(SessionManager.prototype as any)._consumeSteerEcho.call(harness, target, event);
}

function reconcile(harness: any, target: any, path: "cold restore" | "force abort"): void {
	harness._reconcileInFlightSteers = (session: any) =>
		(SessionManager.prototype as any)._reconcileInFlightSteers.call(harness, session);
	if (path === "cold restore") harness._reconcileInFlightSteers(target);
	else (SessionManager.prototype as any)._reconcileAfterAbort.call(harness, target);
}

describe("SessionManager keyless replay occurrence cursor", () => {
	it.each(["cold restore", "force abort"] as const)(
		"settles a crash-unsettled p2 from %s replay without requeueing it",
		(path) => {
			const sessionId = `keyless-replay-cursor-${path.replace(" ", "-")}`;
			appendPromptAuthorDispatch(sessionId, {
				promptId: "p1", dispatchedAt: 1, modelText: text, source: "user", author: userAuthor,
			});
			appendPromptAuthorSettlement(sessionId, {
				promptId: "p1", settledAt: 2, outcome: "echoed",
			});
			appendPromptAuthorDispatch(sessionId, {
				promptId: "p2", dispatchedAt: 3, modelText: text, source: "system", author: systemAuthor,
			});

			const target: any = {
				id: sessionId,
				title: "Replay cursor agent",
				promptQueue: new PromptQueue(),
				inFlightSteerTexts: [{ text, promptId: "p2", source: "system", author: systemAuthor }],
			};
			restorePromptAuthorBindings(target, readAuthorSidecar(sessionId));
			const harness: any = {
				persistInFlightSteerLedger: vi.fn(),
				cancelPromptAuthorDispatch: vi.fn(),
				broadcastQueue: vi.fn(),
			};

			replayStart(target);
			const p1 = replayEnd(target);
			consumeSteerEcho(harness, target, p1);
			assert.deepEqual(p1.message.author, userAuthor);
			assert.equal(p1.message.role, "user");
			assert.equal(p1.message.content, text);
			assert.deepEqual(target.promptAuthorReplayBindings.map((row: any) => row.promptId), ["p2"]);
			assert.deepEqual(target.inFlightSteerTexts.map((row: any) => row.promptId), ["p2"]);

			const duplicateP1 = replayEnd(target);
			consumeSteerEcho(harness, target, duplicateP1);
			assert.deepEqual(duplicateP1.message.author, userAuthor, "one occurrence's duplicate end reuses p1");
			assert.deepEqual(target.inFlightSteerTexts.map((row: any) => row.promptId), ["p2"]);

			replayStart(target);
			const p2 = replayEnd(target);
			consumeSteerEcho(harness, target, p2);
			assert.deepEqual(p2.message.author, systemAuthor, "the next replay occurrence advances to p2");
			assert.equal(p2.message.role, "user");
			assert.equal(p2.message.content, text);
			assert.deepEqual(target.pendingPromptAuthors, []);
			assert.deepEqual(target.inFlightSteerTexts, []);
			assert.deepEqual(target.promptAuthorReplayBindings, []);
			assert.equal(harness.persistInFlightSteerLedger.mock.calls.length, 1, "p2 is removed exactly once");

			const settled = readAuthorSidecar(sessionId);
			assert.equal(settled.find((row) => row.promptId === "p2")?.settlement?.outcome, "echoed");
			const duplicateP2 = replayEnd(target);
			consumeSteerEcho(harness, target, duplicateP2);
			assert.deepEqual(duplicateP2.message.author, systemAuthor);
			assert.deepEqual(readAuthorSidecar(sessionId), settled, "duplicate p2 end stays settlement-idempotent");

			target.promptAuthorReplayBindings = undefined;
			target.lastKeylessPromptAuthorEnd = undefined;
			reconcile(harness, target, path);
			assert.equal(target.promptQueue.length, 0, "an echo already persisted by Pi is never requeued");
			assert.equal(harness.cancelPromptAuthorDispatch.mock.calls.length, 0);
		},
	);
});
