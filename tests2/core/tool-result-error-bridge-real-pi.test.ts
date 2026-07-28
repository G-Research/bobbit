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
	it("reprojects in-place post-listener mutations before emission and persistence", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-real-pi-result-boundary-"));
		roots.push(root);
		const boundaryPath = path.join(root, "boundary.ts");
		const overridePath = path.join(root, "override.ts");
		const inPlaceMutatorPath = path.join(root, "in-place-mutator.ts");
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
    parameters: Type.Object({ session_id: Type.String(), include_tool_results: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer()), fail: Type.Optional(Type.Boolean()), throw_after_mutation: Type.Optional(Type.Boolean()) }),
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
		fs.writeFileSync(inPlaceMutatorPath, `
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
    event.content[0].text = JSON.stringify(envelope);
    event.content.push({ type: "text", text: payload });
    event.details.envelope = envelope;
    event.details.thinkingSignature = "LATER_DETAILS_THINKING_SIGNATURE";
    event.details.textSignature = "LATER_DETAILS_TEXT_SIGNATURE";
    event.details.encryptedContent = "LATER_ENCRYPTED_PROVIDER_BLOB";
    event.details.extra = payload;
    if (event.input.throw_after_mutation) throw new Error("intentional mutation regression");
    return undefined;
  });
}
`, "utf8");

		const loaded = await loadExtensions([boundaryPath, overridePath, inPlaceMutatorPath], root);
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
		const downstreamProviderData = [
			"LATER_MESSAGE_THINKING_SIGNATURE",
			"LATER_MESSAGE_TEXT_SIGNATURE",
			"LATER_DETAILS_THINKING_SIGNATURE",
			"LATER_DETAILS_TEXT_SIGNATURE",
			"LATER_ENCRYPTED_PROVIDER_BLOB",
		];
		const persistedJsonlLine = fs.readFileSync(sessionFile, "utf8")
			.split(/\r?\n/)
			.find((line) => line.includes('"role":"toolResult"'));
		assert.ok(persistedJsonlLine);
		assert.ok(Buffer.byteLength(persistedJsonlLine, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		for (const sentinel of downstreamProviderData) {
			assert.equal(JSON.stringify(emitted.result).includes(sentinel), false);
			assert.equal(JSON.stringify(persistedRoundTrip).includes(sentinel), false);
			assert.equal(persistedJsonlLine.includes(sentinel), false);
		}
		assert.equal(persistedRoundTrip.content.length, 1,
			"the final runner seam must discard downstream wrapper content");
		assert.deepEqual(Object.keys(projected.messages[0].toolResults[0]).sort(),
			["excerpt", "handle", "name", "omitted", "ref", "size", "status"].sort());
		assert.equal(projected.messages[0].toolResults[0].name, "read");
		assert.equal(projected.messages[0].toolResults[0].status, "ok");

		const mutationThenThrow = createAgent(runner, registered, {
			session_id: "target",
			include_tool_results: true,
			limit: 1,
			throw_after_mutation: true,
		});
		const mutationThenThrowEvents: any[] = [];
		mutationThenThrow.subscribe((event) => { mutationThenThrowEvents.push(event); });
		await mutationThenThrow.prompt("read it after a throwing mutator");
		const throwEmitted = mutationThenThrowEvents.find((event) => event.type === "tool_execution_end");
		const throwPersisted = mutationThenThrowEvents.find((event) =>
			event.type === "message_end" && event.message.role === "toolResult")?.message;
		assert.ok(throwEmitted, "Pi must continue after reporting a tool_result listener error");
		assert.ok(throwPersisted);
		assert.equal(throwEmitted.isError, false);
		assert.equal(throwPersisted.isError, false);
		assert.ok(bytes(throwEmitted.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.ok(bytes(throwPersisted) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.deepEqual(throwPersisted.content, throwEmitted.result.content);
		assert.deepEqual(throwPersisted.details, throwEmitted.result.details);
		for (const sentinel of downstreamProviderData) {
			assert.equal(JSON.stringify(throwEmitted.result).includes(sentinel), false);
			assert.equal(JSON.stringify(throwPersisted).includes(sentinel), false);
		}

		const throwSessionManager = SessionManager.create(root, path.join(root, "throw-sessions"));
		const throwInvokingAssistant = mutationThenThrowEvents.find((event) =>
			event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "toolUse")?.message;
		assert.ok(throwInvokingAssistant);
		throwSessionManager.appendMessage(throwInvokingAssistant);
		throwSessionManager.appendMessage(throwPersisted);
		const throwSessionFile = throwSessionManager.getSessionFile();
		assert.ok(throwSessionFile);
		const throwPersistedRoundTrip = (SessionManager.open(throwSessionFile).getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult") as any)?.message;
		assert.ok(throwPersistedRoundTrip);
		assert.ok(bytes(throwPersistedRoundTrip) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.deepEqual(throwPersistedRoundTrip.content, throwPersisted.content);
		assert.deepEqual(throwPersistedRoundTrip.details, JSON.parse(JSON.stringify(throwPersisted.details)));
		assert.equal(throwPersistedRoundTrip.content.length, 1);
		const throwPersistedJsonlLine = fs.readFileSync(throwSessionFile, "utf8")
			.split(/\r?\n/)
			.find((line) => line.includes('"role":"toolResult"'));
		assert.ok(throwPersistedJsonlLine);
		assert.ok(Buffer.byteLength(throwPersistedJsonlLine, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		for (const sentinel of downstreamProviderData) {
			assert.equal(JSON.stringify(throwPersistedRoundTrip).includes(sentinel), false);
			assert.equal(throwPersistedJsonlLine.includes(sentinel), false);
		}

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

	it("keeps an unchanged marked result at exactly one projection", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-real-pi-result-boundary-dedup-"));
		roots.push(root);
		const boundaryPath = path.join(root, "boundary.ts");
		const toolPath = path.join(root, "tool.ts");
		fs.writeFileSync(boundaryPath, generateToolResultErrorBridgeExtension(), "utf8");
		fs.writeFileSync(toolPath, `
import { Type } from "typebox";

export default function (pi) {
  pi.registerTool({
    name: "read_session",
    label: "Read session",
    description: "Unchanged boundary fixture",
    parameters: Type.Object({ session_id: Type.String() }),
    async execute(_toolCallId, params) {
      const envelope = {
        total: 1,
        returned: 1,
        offsetStart: 0,
        offsetEnd: 0,
        messages: [{ index: 0, role: "assistant", text: "bounded once" }],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        details: { session_id: params.session_id, envelope },
      };
    },
  });
}
`, "utf8");
		const loaded = await loadExtensions([boundaryPath, boundaryPath, toolPath], root);
		assert.deepEqual(loaded.errors, []);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, {} as never, {} as never);
		const registered = runner.getAllRegisteredTools().find((tool) => tool.definition.name === "read_session");
		assert.ok(registered);
		let verboseReads = 0;
		const input = { session_id: "target" } as Record<string, unknown>;
		Object.defineProperty(input, "verbose", {
			get() {
				verboseReads++;
				return false;
			},
		});
		const executed = await registered.definition.execute(
			"call-1",
			input as never,
			undefined,
			undefined as never,
			{} as never,
		);
		assert.equal(verboseReads, 1);
		assert.match((executed.details as any)[RESULT_BOUNDARY_MARKER], /^[a-f0-9]{64}$/);

		const replacement = await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "read_session",
			input,
			content: executed.content,
			details: executed.details,
			isError: false,
		});

		assert.equal(replacement, undefined,
			"an unchanged digest must preserve Pi's original bounded execute result");
		assert.equal(verboseReads, 1, "the final seam must not reproject an unchanged marked result");
		assert.equal(JSON.stringify(executed).includes("result-boundary"), false,
			"the integrity marker must never enter Pi's serialized result");
	});
});
