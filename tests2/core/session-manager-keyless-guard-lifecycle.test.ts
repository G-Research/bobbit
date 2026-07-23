import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

const {
	SessionManager,
	dispatchTrackedPrompt,
	prepareVisibleAgentEvent,
} = await import("../../src/server/agent/session-manager.ts");
const {
	appendPromptAuthorDispatch,
	digestPromptModelText,
	initAuthorSidecarDir,
	readAuthorSidecar,
} = await import("../../src/server/agent/author-sidecar.ts");

const userAuthor = { kind: "user", id: "user:local", label: "User" } as const;
const agentAuthor = { kind: "agent", id: "session:caller", label: "Caller" } as const;
const text = "concurrent duplicate bytes";
const agentPrefix = "[Caller (caller)]: ";
const agentPiText = `${agentPrefix}${text}`;

function session(overrides: Record<string, unknown> = {}): any {
	return {
		id: "keyless-guard-session",
		title: "Guard lifecycle agent",
		pendingPromptAuthors: [],
		promptAuthorMessageBindings: new Map(),
		inFlightSteerTexts: [],
		rpcClient: { prompt: vi.fn(async () => ({ success: true })) },
		...overrides,
	};
}

function userEnd(rawModelText = text): any {
	return { type: "message_end", message: { role: "user", content: rawModelText } };
}

function consumeSteerEcho(target: any, event: any): void {
	(SessionManager.prototype as any)._consumeSteerEcho.call({
		persistInFlightSteerLedger: vi.fn(),
	}, target, event);
}

let stateDir = "";

beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-keyless-guard-"));
	initAuthorSidecarDir(stateDir, {
		secretsDir: stateDir,
		hmacKey: Buffer.alloc(32, 0x4b),
	});
});

afterEach(() => {
	fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("SessionManager keyless terminal guard lifecycle", () => {
	it("keeps p2 pending across p1 duplicate replay after assistant updates, then settles p2 once", () => {
		appendPromptAuthorDispatch("keyless-guard-session", {
			promptId: "p1", dispatchedAt: 1, modelText: text, source: "user", author: userAuthor,
		});
		appendPromptAuthorDispatch("keyless-guard-session", {
			promptId: "p2", dispatchedAt: 2, modelText: agentPiText, modelPrefix: agentPrefix,
			source: "agent", author: agentAuthor,
		});
		const agentModelTextDigest = digestPromptModelText(agentPiText);
		const target = session({
			pendingPromptAuthors: [
				{ promptId: "p1", dispatchedAt: 1, modelText: text, source: "user", author: userAuthor },
				{
					promptId: "p2", dispatchedAt: 2, modelText: agentPiText,
					modelTextDigest: agentModelTextDigest, modelPrefix: agentPrefix,
					source: "agent", author: agentAuthor,
				},
			],
			inFlightSteerTexts: [
				{ text, promptId: "p2", source: "agent", author: agentAuthor },
			],
		});

		const p1Terminal: any = prepareVisibleAgentEvent(target, userEnd());
		consumeSteerEcho(target, p1Terminal);
		assert.deepEqual(p1Terminal.message.author, userAuthor);
		assert.deepEqual(target.pendingPromptAuthors.map((row: any) => row.promptId), ["p2"]);
		assert.deepEqual(target.inFlightSteerTexts.map((row: any) => row.promptId), ["p2"]);

		const assistantUpdate: any = prepareVisibleAgentEvent(target, {
			type: "message_update",
			message: { role: "assistant", content: "working" },
		});
		const assistantEnd: any = prepareVisibleAgentEvent(target, {
			type: "message_end",
			message: { role: "assistant", content: "done" },
		});
		assert.equal(assistantUpdate.message.role, "assistant");
		assert.equal(assistantUpdate.message.content, "working");
		assert.equal(assistantEnd.message.role, "assistant");
		assert.equal(assistantEnd.message.content, "done");

		const duplicateP1: any = prepareVisibleAgentEvent(target, userEnd());
		consumeSteerEcho(target, duplicateP1);
		assert.deepEqual(duplicateP1.message.author, userAuthor, "duplicate p1 keeps p1 author");
		assert.equal(duplicateP1.message.role, "user");
		assert.equal(duplicateP1.message.content, text);
		assert.deepEqual(target.pendingPromptAuthors.map((row: any) => row.promptId), ["p2"]);
		assert.deepEqual(target.inFlightSteerTexts.map((row: any) => row.promptId), ["p2"], "duplicate p1 cannot consume p2 steer");

		const p2Terminal: any = prepareVisibleAgentEvent(target, userEnd(agentPiText));
		consumeSteerEcho(target, p2Terminal);
		assert.deepEqual(p2Terminal.message.author, agentAuthor, "p2 real echo keeps p2 author");
		assert.equal(p2Terminal.message.role, "user");
		assert.equal(p2Terminal.message.content, text);
		assert.deepEqual(target.pendingPromptAuthors, []);
		assert.deepEqual(target.inFlightSteerTexts, []);

		const settlements = readAuthorSidecar(target.id);
		assert.equal(settlements.find((row) => row.promptId === "p1")?.settlement?.outcome, "echoed");
		assert.equal(settlements.find((row) => row.promptId === "p2")?.settlement?.outcome, "echoed");
	});

	it("lets a genuinely new same-text dispatch supersede a settled live guard", async () => {
		appendPromptAuthorDispatch("keyless-guard-session", {
			promptId: "p1", dispatchedAt: 1, modelText: text, source: "user", author: userAuthor,
		});
		const prompt = vi.fn(async () => ({ success: true }));
		const target = session({
			rpcClient: { prompt },
			pendingPromptAuthors: [
				{ promptId: "p1", dispatchedAt: 1, modelText: text, source: "user", author: userAuthor },
			],
		});
		prepareVisibleAgentEvent(target, userEnd());
		assert.equal(target.lastKeylessPromptAuthorEnd?.promptId, "p1");

		await dispatchTrackedPrompt(target, text, {
			source: "agent",
			author: agentAuthor,
			now: () => 2,
		});
		assert.deepEqual(prompt.mock.calls, [[agentPiText]], "Pi receives the accountable prefixed text");
		const p2 = target.pendingPromptAuthors[0];
		assert.ok(p2?.promptId);
		assert.equal(p2.modelText, agentPiText);
		assert.equal(p2.modelPrefix, agentPrefix);
		assert.equal(target.lastKeylessPromptAuthorEnd, undefined, "new acceptance supersedes p1 guard");

		const p2Terminal: any = prepareVisibleAgentEvent(target, userEnd(agentPiText));
		assert.deepEqual(p2Terminal.message.author, agentAuthor);
		assert.equal(p2Terminal.message.role, "user");
		assert.equal(p2Terminal.message.content, text);
		assert.deepEqual(target.pendingPromptAuthors, []);
		const p2Settlement = readAuthorSidecar(target.id)
			.find((row) => row.promptId === p2.promptId)?.settlement;
		assert.equal(p2Settlement?.outcome, "echoed");
	});
});
