import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	ExtensionRunner,
	SessionManager,
	type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
// Pi 0.81's runtime root accidentally omits this export although its declaration
// file includes it. Import the installed loader directly so this remains a real
// loader regression rather than another synthetic ExtensionAPI fixture.
import { loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { afterEach, describe, it } from "vitest";

import {
	generateToolResultErrorBridgeExtension,
	READ_SESSION_FINAL_RESULT_MAX_BYTES,
} from "../../src/server/agent/tool-result-error-bridge-extension.js";

const roots: string[] = [];
const RESULT_BOUNDARY_MARKER = Symbol.for("bobbit.read_session.result-boundary.v1");

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model() {
	return {
		id: "test-model",
		name: "Test model",
		api: "test",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1_000,
	} as any;
}

function makeStream(toolName: string, args: Record<string, unknown>) {
	let call = 0;
	return () => {
		const stream = createAssistantMessageEventStream();
		const message = call++ === 0
			? {
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: `call-${call}`, name: toolName, arguments: args }],
				api: "test",
				provider: "test",
				model: "test-model",
				usage,
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
			}
			: {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "done" }],
				api: "test",
				provider: "test",
				model: "test-model",
				usage,
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason, message });
		return stream;
	};
}

function asAgentTool(registered: RegisteredTool): any {
	const definition = registered.definition;
	return {
		...definition,
		execute: (toolCallId: string, args: unknown, signal: AbortSignal | undefined, onUpdate: unknown) =>
			definition.execute(toolCallId, args as never, signal, onUpdate as never, {} as never),
	};
}

function createAgent(runner: ExtensionRunner, registered: RegisteredTool, args: Record<string, unknown>) {
	return new Agent({
		initialState: {
			systemPrompt: "test",
			model: model(),
			tools: [asAgentTool(registered)],
		},
		streamFn: makeStream(registered.definition.name, args),
		afterToolCall: async ({ toolCall, args: input, result, isError }) => runner.emitToolResult({
			type: "tool_result",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			input: input as Record<string, unknown>,
			content: result.content,
			details: result.details,
			isError,
			usage: result.usage,
		}),
	});
}

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("tool result boundary through Pi's real extension runner", () => {
	it("bounds the winning cross-extension read_session result before emission and persistence", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-real-pi-result-boundary-"));
		roots.push(root);
		const boundaryPath = path.join(root, "boundary.ts");
		const overridePath = path.join(root, "override.ts");
		const laterMutatorPath = path.join(root, "later-mutator.ts");
		fs.writeFileSync(boundaryPath, generateToolResultErrorBridgeExtension(), "utf8");
		fs.writeFileSync(overridePath, `
import { Type } from "typebox";

const payload = "\\\"\\n😀".repeat(30_000);
const envelope = {
  total: 1,
  returned: 1,
  offsetStart: 7,
  offsetEnd: 7,
  messages: [{
    index: 7,
    role: "toolResult",
    thinkingSignature: "PROVIDER_SIGNATURE_MUST_NOT_SURVIVE",
    toolResults: [{
      ref: "r1",
      name: "read",
      toolName: "duplicate-name",
      status: "ok",
      isError: true,
      size: { type: "string", chars: payload.length, lines: 30_001, bytes: Buffer.byteLength(payload) },
      omitted: false,
      handle: "rs1:m7:b0:AAAAAAAAAAAAAAAAAAAAAAAAAAA",
      excerpt: { start: 0, end: payload.length, text: payload, nextCursor: null, complete: true },
    }],
  }],
};

export default function (pi) {
  pi.registerTool({
    name: "read_session",
    label: "Override read session",
    description: "Real Pi override fixture",
    parameters: Type.Object({ session_id: Type.String(), include_tool_results: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer()), fail: Type.Optional(Type.Boolean()) }),
    async execute(_toolCallId, params) {
      if (params.fail) return {
        content: [{ type: "text", text: "override returned failure" }],
        details: { ignored: true },
        isError: true,
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(envelope) },
          { type: "text", text: "WRAPPER_ONLY_PROVIDER_DATA".repeat(10_000) },
        ],
        details: {
          session_id: params.session_id,
          envelope,
          messages: envelope.messages,
          thinkingSignature: "WRAPPER_PROVIDER_SIGNATURE",
          extra: "WRAPPER_ONLY_PROVIDER_DATA".repeat(10_000),
        },
      };
    },
  });
}
`, "utf8");
		fs.writeFileSync(laterMutatorPath, `
const payload = "\\\"\\n😀".repeat(30_000);

export default function (pi) {
  pi.on("tool_result", (event) => {
    if (String(event.toolName || "").toLowerCase() !== "read_session") return;
    if (event.isError) {
      return {
        details: { ...event.details, downstreamErrorObserved: true },
        isError: true,
      };
    }
    const envelope = JSON.parse(event.content[0].text);
    envelope.messages[0].text = payload;
    envelope.messages[0].thinkingSignature = "LATER_MESSAGE_THINKING_SIGNATURE";
    envelope.messages[0].textSignature = "LATER_MESSAGE_TEXT_SIGNATURE";
    return {
      content: [
        { type: "text", text: JSON.stringify(envelope) },
        { type: "text", text: payload },
      ],
      details: {
        ...event.details,
        envelope,
        thinkingSignature: "LATER_DETAILS_THINKING_SIGNATURE",
        textSignature: "LATER_DETAILS_TEXT_SIGNATURE",
        encryptedContent: "LATER_ENCRYPTED_PROVIDER_BLOB",
        extra: payload,
      },
      isError: false,
    };
  });
}
`, "utf8");

		const loaded = await loadExtensions([boundaryPath, overridePath, laterMutatorPath], root);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 3);
		assert.notEqual(loaded.extensions[0], loaded.extensions[1], "Pi must load extensions into separate private maps");
		assert.equal(loaded.extensions[0].tools.size, 0);
		assert.equal(loaded.extensions[1].tools.has("read_session"), true);
		assert.equal(loaded.extensions[2].handlers.get("tool_result")?.length, 1);

		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, {} as never, {} as never);
		const registered = runner.getAllRegisteredTools().find((tool) => tool.definition.name === "read_session");
		assert.ok(registered);

		const success = createAgent(runner, registered, {
			session_id: "target",
			include_tool_results: true,
			limit: 1,
		});
		const successEvents: any[] = [];
		success.subscribe((event) => { successEvents.push(event); });
		await success.prompt("read it");

		const emitted = successEvents.find((event) => event.type === "tool_execution_end");
		const persisted = successEvents.find((event) => event.type === "message_end" && event.message.role === "toolResult")?.message;
		assert.ok(emitted);
		assert.ok(persisted);
		assert.equal(emitted.isError, false);
		assert.equal(persisted.isError, false);
		assert.ok(bytes(emitted.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.ok(bytes(persisted) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.deepEqual(persisted.content, emitted.result.content);
		assert.deepEqual(persisted.details, emitted.result.details);
		assert.equal(Object.getOwnPropertySymbols(persisted.details).includes(RESULT_BOUNDARY_MARKER), true,
			"the non-serialized marker proves the execution hook supplied the persisted replacement");

		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const invokingAssistant = successEvents.find((event) =>
			event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "toolUse")?.message;
		assert.ok(invokingAssistant);
		sessionManager.appendMessage(invokingAssistant);
		sessionManager.appendMessage(persisted);
		const sessionFile = sessionManager.getSessionFile();
		assert.ok(sessionFile);
		const persistedRoundTrip = (SessionManager.open(sessionFile).getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult") as any)?.message;
		assert.ok(persistedRoundTrip);
		assert.ok(bytes(persistedRoundTrip) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.deepEqual(persistedRoundTrip.content, persisted.content);
		assert.deepEqual(persistedRoundTrip.details, JSON.parse(JSON.stringify(persisted.details)));
		assert.equal(Object.getOwnPropertySymbols(persistedRoundTrip.details).length, 0,
			"the in-memory idempotence marker must not enter persisted JSONL");

		const projected = JSON.parse(persistedRoundTrip.content[0].text);
		assert.equal(JSON.stringify(projected).includes("PROVIDER_SIGNATURE_MUST_NOT_SURVIVE"), false);
		assert.equal(JSON.stringify(persisted).includes("WRAPPER_PROVIDER_SIGNATURE"), false);
		assert.equal(JSON.stringify(persisted).includes("WRAPPER_ONLY_PROVIDER_DATA"), false);
		for (const downstreamProviderData of [
			"LATER_MESSAGE_THINKING_SIGNATURE",
			"LATER_MESSAGE_TEXT_SIGNATURE",
			"LATER_DETAILS_THINKING_SIGNATURE",
			"LATER_DETAILS_TEXT_SIGNATURE",
			"LATER_ENCRYPTED_PROVIDER_BLOB",
		]) {
			assert.equal(JSON.stringify(emitted.result).includes(downstreamProviderData), false);
			assert.equal(JSON.stringify(persistedRoundTrip).includes(downstreamProviderData), false);
		}
		assert.equal(persistedRoundTrip.content.length, 1,
			"the final runner seam must discard downstream wrapper content");
		assert.deepEqual(Object.keys(projected.messages[0].toolResults[0]).sort(),
			["excerpt", "handle", "name", "omitted", "ref", "size", "status"].sort());
		assert.equal(projected.messages[0].toolResults[0].name, "read");
		assert.equal(projected.messages[0].toolResults[0].status, "ok");

		const failed = createAgent(runner, registered, { session_id: "target", fail: true });
		const failedEvents: any[] = [];
		failed.subscribe((event) => { failedEvents.push(event); });
		await failed.prompt("fail it");
		const failedEnd = failedEvents.find((event) => event.type === "tool_execution_end");
		const failedMessage = failedEvents.find((event) => event.type === "message_end" && event.message.role === "toolResult")?.message;
		assert.equal(failedEnd?.isError, true);
		assert.equal(failedMessage?.isError, true);
		assert.match(failedMessage.content[0].text, /override returned failure/);
		assert.equal(failedEnd?.result.details.downstreamErrorObserved, true,
			"the final success boundary must not replace an errored post-chain result");
		assert.equal(failedMessage?.details.downstreamErrorObserved, true);
	});

	it("marks a result so duplicate boundary handlers do not process it twice", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-real-pi-result-boundary-dedup-"));
		roots.push(root);
		const boundaryPath = path.join(root, "boundary.ts");
		fs.writeFileSync(boundaryPath, generateToolResultErrorBridgeExtension(), "utf8");
		const loaded = await loadExtensions([boundaryPath, boundaryPath], root);
		assert.deepEqual(loaded.errors, []);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, {} as never, {} as never);
		let verboseReads = 0;
		const input = { session_id: "target" } as Record<string, unknown>;
		Object.defineProperty(input, "verbose", {
			get() {
				verboseReads++;
				return false;
			},
		});
		const envelope = {
			total: 1,
			returned: 1,
			offsetStart: 0,
			offsetEnd: 0,
			messages: [{ index: 0, role: "assistant", text: "bounded once" }],
		};
		const replacement = await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "read_session",
			input,
			content: [{ type: "text", text: JSON.stringify(envelope) }],
			details: { session_id: "target", envelope },
			isError: false,
		});

		assert.ok(replacement);
		assert.equal(verboseReads, 1, "only the first cross-extension boundary may inspect the request");
		assert.equal((replacement.details as any)[RESULT_BOUNDARY_MARKER], true);
		assert.equal(JSON.stringify(replacement).includes("result-boundary"), false,
			"the idempotence marker must never enter Pi's serialized result");
	});
});
