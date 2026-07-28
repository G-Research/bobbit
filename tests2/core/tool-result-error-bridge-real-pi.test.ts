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

function toolOutcome(events: any[]) {
	const emitted = events.find((event) => event.type === "tool_execution_end");
	const persisted = events.find((event) => event.type === "message_end" && event.message.role === "toolResult")?.message;
	assert.ok(emitted);
	assert.ok(persisted);
	return { emitted, persisted };
}

function persistOutcome(root: string, label: string, events: any[]) {
	const invokingAssistant = events.find((event) =>
		event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "toolUse")?.message;
	const { persisted } = toolOutcome(events);
	assert.ok(invokingAssistant);
	const manager = SessionManager.create(root, path.join(root, `${label}-sessions`));
	manager.appendMessage(invokingAssistant);
	manager.appendMessage(persisted);
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	const roundTrip = (SessionManager.open(sessionFile).getEntries()
		.find((entry) => entry.type === "message" && entry.message.role === "toolResult") as any)?.message;
	assert.ok(roundTrip);
	const line = fs.readFileSync(sessionFile, "utf8")
		.split(/\r?\n/)
		.find((candidate) => candidate.includes('"role":"toolResult"'));
	assert.ok(line);
	return { roundTrip, line, sessionFile };
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
    parameters: Type.Object({
      session_id: Type.String(),
      include_tool_results: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer()),
      verbose: Type.Optional(Type.Boolean()),
      fail: Type.Optional(Type.Boolean()),
      provider_only_fail: Type.Optional(Type.Boolean()),
      late_fail: Type.Optional(Type.Boolean()),
      accessor_attack: Type.Optional(Type.Boolean()),
      hostile_to_json: Type.Optional(Type.Boolean()),
      near_ceiling: Type.Optional(Type.Boolean()),
      throw_after_mutation: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      if (params.fail) return {
        content: [{ type: "text", text: JSON.stringify({
          error: "transcript_unavailable",
          code: "STALE_READ_FAILED",
          status: 503,
          detail: "INITIAL_ERROR_BODY".repeat(10_000),
          thinkingSignature: "INITIAL_ERROR_SIGNATURE",
        }) }],
        details: {
          code: "STALE_READ_FAILED",
          status: 503,
          thinkingSignature: "INITIAL_ERROR_DETAILS_SIGNATURE",
          extra: "INITIAL_ERROR_DETAILS".repeat(10_000),
        },
        isError: true,
      };
      if (params.provider_only_fail) return {
        content: [{ type: "text", text: JSON.stringify({
          thinkingSignature: "PROVIDER_ONLY_ERROR_SIGNATURE",
          textSignature: "PROVIDER_ONLY_TEXT_SIGNATURE",
        }) }],
        details: { encryptedContent: "PROVIDER_ONLY_ENCRYPTED_DETAILS" },
        isError: true,
      };
      const selectedEnvelope = params.near_ceiling ? {
        total: 10,
        returned: 10,
        offsetStart: 0,
        offsetEnd: 9,
        messages: Array.from({ length: 10 }, (_, index) => ({
          index,
          role: "assistant",
          text: "p".repeat(4096),
          toolCalls: [{
            ref: "t" + (index + 1),
            name: "near_ceiling_tool",
            argumentsPreview: "a".repeat(512),
            argumentsTruncated: true,
          }],
        })),
      } : envelope;
      return {
        content: [
          { type: "text", text: JSON.stringify(selectedEnvelope) },
          { type: "text", text: "WRAPPER_ONLY_PROVIDER_DATA".repeat(10_000) },
        ],
        details: {
          session_id: params.session_id,
          envelope: selectedEnvelope,
          messages: selectedEnvelope.messages,
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
        details: {
          ...event.details,
          downstreamErrorObserved: true,
          thinkingSignature: "DOWNSTREAM_ERROR_SIGNATURE",
          extra: "DOWNSTREAM_ERROR_DETAILS".repeat(10_000),
        },
        isError: true,
      };
    }
    if (event.input.late_fail) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          error: "transcript_unavailable",
          code: "LATE_READ_FAILED",
          status: 429,
          detail: "LATE_ERROR_BODY".repeat(10_000),
          textSignature: "LATE_ERROR_SIGNATURE",
        }) }],
        details: {
          code: "LATE_READ_FAILED",
          status: 429,
          encryptedContent: "LATE_ERROR_ENCRYPTED",
          extra: "LATE_ERROR_DETAILS".repeat(10_000),
        },
        isError: true,
        usage: { providerMetadata: "LATE_USAGE_PROVIDER_DATA".repeat(10_000) },
      };
    }
    if (event.input.accessor_attack) {
      const safeText = event.content[0].text;
      let reads = 0;
      Object.defineProperty(event.content[0], "text", {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? safeText : "ACCESSOR_HUGE_PROVIDER_DATA".repeat(10_000);
        },
      });
      return undefined;
    }
    if (event.input.hostile_to_json) {
      event.details.toJSON = () => ({
        thinkingSignature: "HOSTILE_TO_JSON_SIGNATURE",
        extra: "HOSTILE_TO_JSON_DATA".repeat(10_000),
      });
      return undefined;
    }
    if (event.input.near_ceiling) return undefined;
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
		assert.deepEqual(emitted.result.usage, {}, "provider usage metadata must be cleared at the final seam");
		assert.equal(Object.isFrozen(emitted.result.content), true,
			"the final listener-controlled value must be an immutable plain snapshot");

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

		const adversarialCases = [
			{
				label: "initial-error",
				params: { session_id: "target", fail: true },
				code: "STALE_READ_FAILED",
				status: 503,
				forbidden: ["INITIAL_ERROR_SIGNATURE", "INITIAL_ERROR_DETAILS_SIGNATURE", "DOWNSTREAM_ERROR_SIGNATURE", "INITIAL_ERROR_DETAILS"],
			},
			{
				label: "late-error",
				params: { session_id: "target", late_fail: true },
				code: "LATE_READ_FAILED",
				status: 429,
				forbidden: ["LATE_ERROR_SIGNATURE", "LATE_ERROR_ENCRYPTED", "LATE_USAGE_PROVIDER_DATA", "LATE_ERROR_DETAILS"],
			},
		] as const;
		for (const scenario of adversarialCases) {
			const agent = createAgent(runner, registered, scenario.params);
			const events: any[] = [];
			agent.subscribe((event) => { events.push(event); });
			await agent.prompt(scenario.label);
			const { emitted: failedEnd, persisted: failedMessage } = toolOutcome(events);
			assert.equal(failedEnd.isError, true);
			assert.equal(failedMessage.isError, true);
			assert.ok(bytes(failedEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(failedMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.deepEqual(failedEnd.result.details, { code: scenario.code, status: scenario.status });
			const errorPayload = JSON.parse(failedMessage.content[0].text);
			assert.equal(errorPayload.code, scenario.code);
			assert.equal(errorPayload.status, scenario.status);
			const stored = persistOutcome(root, scenario.label, events);
			assert.ok(Buffer.byteLength(stored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(stored.roundTrip.isError, true);
			for (const sentinel of scenario.forbidden) {
				assert.equal(JSON.stringify(failedEnd.result).includes(sentinel), false);
				assert.equal(stored.line.includes(sentinel), false);
			}
		}

		const providerOnlyError = createAgent(runner, registered, { session_id: "target", provider_only_fail: true });
		const providerOnlyEvents: any[] = [];
		providerOnlyError.subscribe((event) => { providerOnlyEvents.push(event); });
		await providerOnlyError.prompt("provider-only error");
		const { emitted: providerOnlyEnd } = toolOutcome(providerOnlyEvents);
		const providerOnlyStored = persistOutcome(root, "provider-only-error", providerOnlyEvents);
		assert.equal(providerOnlyEnd.isError, true);
		assert.deepEqual(JSON.parse(providerOnlyEnd.result.content[0].text), { error: "read_session_failed" });
		for (const sentinel of [
			"PROVIDER_ONLY_ERROR_SIGNATURE",
			"PROVIDER_ONLY_TEXT_SIGNATURE",
			"PROVIDER_ONLY_ENCRYPTED_DETAILS",
		]) {
			assert.equal(JSON.stringify(providerOnlyEnd.result).includes(sentinel), false);
			assert.equal(providerOnlyStored.line.includes(sentinel), false);
		}

		for (const scenario of [
			{ label: "accessor", params: { session_id: "target", accessor_attack: true }, forbidden: "ACCESSOR_HUGE_PROVIDER_DATA" },
			{ label: "to-json", params: { session_id: "target", hostile_to_json: true }, forbidden: "HOSTILE_TO_JSON_DATA" },
		] as const) {
			const agent = createAgent(runner, registered, scenario.params);
			const events: any[] = [];
			agent.subscribe((event) => { events.push(event); });
			await agent.prompt(scenario.label);
			const { emitted: safeEnd, persisted: safeMessage } = toolOutcome(events);
			assert.equal(safeEnd.isError, false);
			assert.equal(safeMessage.isError, false);
			assert.ok(bytes(safeEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(JSON.stringify(safeEnd.result).includes(scenario.forbidden), false);
			assert.equal(Object.prototype.hasOwnProperty.call(safeEnd.result.details, "toJSON"), false);
			const stored = persistOutcome(root, scenario.label, events);
			assert.ok(Buffer.byteLength(stored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(stored.line.includes(scenario.forbidden), false);
		}

		const nearCeiling = createAgent(runner, registered, {
			session_id: "target",
			verbose: true,
			near_ceiling: true,
		});
		const nearCeilingEvents: any[] = [];
		nearCeiling.subscribe((event) => { nearCeilingEvents.push(event); });
		await nearCeiling.prompt("near ceiling");
		const { emitted: ceilingEnd, persisted: ceilingMessage } = toolOutcome(nearCeilingEvents);
		const ceilingStored = persistOutcome(root, "near-ceiling", nearCeilingEvents);
		assert.ok(bytes(ceilingEnd.result) > 40 * 1024, "the fitter should preserve useful near-ceiling capacity");
		assert.ok(bytes(ceilingEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.ok(bytes(ceilingMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.ok(Buffer.byteLength(ceilingStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.deepEqual(ceilingStored.roundTrip.content, ceilingEnd.result.content);
		assert.deepEqual(ceilingStored.roundTrip.details, ceilingEnd.result.details);
	});

	it("always snapshots an unchanged result after the complete listener chain", async () => {
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
		assert.equal(Object.getOwnPropertySymbols(executed.details as object).length, 0,
			"no digest or marker supplied by a mutable result may be trusted");

		const replacement = await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "read_session",
			input,
			content: executed.content,
			details: executed.details,
			isError: false,
		});

		assert.ok(replacement, "the final seam must always return its own canonical snapshot");
		assert.equal(verboseReads, 2, "the final seam independently snapshots invocation policy inputs");
		assert.notEqual(replacement, executed);
		assert.equal(Object.isFrozen(replacement), true);
		assert.equal(Object.isFrozen(replacement.content), true);
		assert.equal(Object.getOwnPropertySymbols(replacement.details as object).length, 0);
	});
});
