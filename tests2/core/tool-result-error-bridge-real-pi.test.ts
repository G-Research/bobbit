import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	AgentSession,
	ExtensionRunner,
	SessionManager,
	SettingsManager,
	type LoadExtensionsResult,
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

interface StreamToolCall {
	name: string;
	arguments: Record<string, unknown>;
	id: string;
}

function makeSequenceStream(calls: StreamToolCall[]) {
	let index = 0;
	return () => {
		const stream = createAssistantMessageEventStream();
		const next = calls[index++];
		const message = next
			? {
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: next.id, name: next.name, arguments: next.arguments }],
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

function makeStream(toolName: string, args: Record<string, unknown>, toolCallId?: string) {
	return makeSequenceStream([{ name: toolName, arguments: args, id: toolCallId ?? "call-1" }]);
}

function resourceLoader(loaded: LoadExtensionsResult): any {
	return {
		getExtensions: () => loaded,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		extendResources: () => undefined,
		reload: async () => undefined,
	};
}

let lifecycleCounter = 0;

function createLifecycleSession(
	loaded: LoadExtensionsResult,
	root: string,
	args: Record<string, unknown>,
	toolName = "read_session",
	toolCallId?: string,
	streamFn = makeStream(toolName, args, toolCallId),
): AgentSession {
	const sessionManager = SessionManager.create(root, path.join(root, `lifecycle-${++lifecycleCounter}`));
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false, maxRetries: 0 },
	});
	const agent = new Agent({
		initialState: {
			systemPrompt: "test",
			model: model(),
			tools: [],
		},
		streamFn,
	});
	return new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: root,
		resourceLoader: resourceLoader(loaded),
		modelRuntime: {} as never,
		baseToolsOverride: {},
		initialActiveToolNames: [],
	});
}

async function runLifecycle(session: AgentSession, label: string): Promise<any[]> {
	const events: any[] = [];
	session.subscribe((event) => { events.push(event); });
	await (session as any)._runAgentPrompt({
		role: "user",
		content: [{ type: "text", text: label }],
		timestamp: Date.now(),
	});
	return events;
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

function persistOutcome(session: AgentSession) {
	const sessionFile = session.sessionManager.getSessionFile();
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
      late_phase_attack: Type.Optional(Type.String()),
      post_chain_accessor_attack: Type.Optional(Type.String()),
      snapshot_attack: Type.Optional(Type.String()),
      frozen_target_attack: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      if (params.snapshot_attack === "deep" || params.snapshot_attack === "error_deep") {
        let value = { leaf: "bounded" };
        for (let index = 0; index < 50_000; index++) value = { child: value };
        if (params.snapshot_attack === "error_deep") value.isError = true;
        return value;
      }
      if (params.snapshot_attack === "sparse") {
        const sparse = [];
        sparse.length = 0xffffffff;
        return { content: sparse, details: { session_id: params.session_id } };
      }
      if (params.snapshot_attack === "cycle") {
        const cycle = { label: "cycle" };
        cycle.self = cycle;
        return { cycle };
      }
      if (params.snapshot_attack === "dag") {
        let value = { leaf: "bounded" };
        for (let index = 0; index < 40; index++) value = { left: value, right: value };
        return { value };
      }
      if (params.snapshot_attack === "nonplain") {
        const value = { when: new Date(0) };
        Object.defineProperty(value, "providerBlob", {
          enumerable: true,
          get() { return "ACCESSOR_PROVIDER_DATA".repeat(100_000); },
        });
        return { value };
      }
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
const invocations = new Map();
const frozenTargetCounterSymbol = Symbol.for("bobbit.test.frozen-target-counter");
const frozenTargetCounters = globalThis[frozenTargetCounterSymbol]
  || (globalThis[frozenTargetCounterSymbol] = { getter: 0, toJSON: 0 });
const postChainAccessorCounterSymbol = Symbol.for("bobbit.test.post-chain-accessor-counter");
const postChainAccessorCounter = globalThis[postChainAccessorCounterSymbol]
  || (globalThis[postChainAccessorCounterSymbol] = { installed: 0, reads: 0 });

function installThrowingAccessors(target, fields, label) {
  for (const field of fields) {
    postChainAccessorCounter.installed += 1;
    Object.defineProperty(target, field, {
      configurable: true,
      enumerable: true,
      get() {
        postChainAccessorCounter.reads += 1;
        throw new Error(label + " " + field + " getter must never run");
      },
    });
  }
  return target;
}

function hostileResult(label) {
  return installThrowingAccessors({}, ["content", "details", "usage", "isError"], label);
}

function mutableMessage(message) {
  return {
    role: "toolResult",
    toolCallId: message.toolCallId,
    toolName: "read_session",
    content: [],
    details: {},
    usage: {},
    isError: false,
    timestamp: 0,
  };
}

function hostileMessage(message, label) {
  return installThrowingAccessors(mutableMessage(message),
    ["content", "details", "usage", "isError", "timestamp"], label);
}

export default function (pi) {
  pi.on("tool_execution_end", (event) => {
    if (String(event.toolName || "").toLowerCase() !== "read_session") return;
    const params = invocations.get(event.toolCallId) || {};
    if (params.frozen_target_attack === "getter") {
      const hostile = {};
      Object.defineProperty(hostile, "content", {
        enumerable: true,
        get() {
          frozenTargetCounters.getter += 1;
          throw new Error("frozen result getter must never run");
        },
      });
      event.result = Object.freeze(hostile);
      return undefined;
    }
    if (params.frozen_target_attack === "toJSON") {
      const hostile = {};
      Object.defineProperty(hostile, "toJSON", {
        enumerable: true,
        value() {
          frozenTargetCounters.toJSON += 1;
          throw new Error("frozen result toJSON must never run");
        },
      });
      event.result = Object.freeze(hostile);
      return undefined;
    }
    const malicious = {
      content: [{ type: "text", text: "TOOL_END_PROVIDER_DATA".repeat(100_000) }],
      details: { thinkingSignature: "TOOL_END_PROVIDER_SIGNATURE" },
      usage: { providerMetadata: "TOOL_END_USAGE".repeat(100_000) },
    };
    if (params.post_chain_accessor_attack === "tool_return") {
      return { result: hostileResult("returned tool result") };
    }
    if (params.post_chain_accessor_attack === "tool_in_place") {
      event.result = { content: [], details: {}, usage: {}, isError: false };
      return undefined;
    }
    if (params.late_phase_attack === "return") return { result: malicious };
    if (params.late_phase_attack === "mutate") {
      event.result.content = malicious.content;
      event.result.details = malicious.details;
    }
    if (params.late_phase_attack === "mutate_throw") {
      event.result = malicious;
      throw new Error("tool_execution_end mutation regression");
    }
  });

  pi.on("tool_execution_end", (event) => {
    const params = invocations.get(event.toolCallId) || {};
    if (params.post_chain_accessor_attack !== "tool_in_place") return;
    installThrowingAccessors(event.result, ["content", "details", "usage", "isError"], "in-place tool result");
    Object.defineProperty(event, "isError", {
      configurable: true,
      enumerable: true,
      get() {
        postChainAccessorCounter.reads += 1;
        throw new Error("in-place tool event isError getter must never run");
      },
    });
  });

  pi.on("message_end", (event) => {
    if (event.message?.role !== "toolResult") return;
    const params = invocations.get(event.message.toolCallId) || {};
    const malicious = {
      ...event.message,
      content: [{ type: "text", text: "MESSAGE_END_PROVIDER_DATA".repeat(100_000) }],
      details: { textSignature: "MESSAGE_END_PROVIDER_SIGNATURE" },
      usage: { providerMetadata: "MESSAGE_END_USAGE".repeat(100_000) },
    };
    if (params.post_chain_accessor_attack === "message_return") {
      return { message: hostileMessage(event.message, "returned message") };
    }
    if (params.post_chain_accessor_attack === "message_in_place") {
      return { message: mutableMessage(event.message) };
    }
    if (params.late_phase_attack === "return") return { message: malicious };
    if (params.late_phase_attack === "mutate") {
      event.message.content = malicious.content;
      event.message.details = malicious.details;
      event.message.usage = malicious.usage;
    }
    if (params.late_phase_attack === "mutate_throw") {
      event.message.content = malicious.content;
      event.message.details = malicious.details;
      throw new Error("message_end mutation regression");
    }
  });

  pi.on("message_end", (event) => {
    const params = invocations.get(event.message.toolCallId) || {};
    if (params.post_chain_accessor_attack !== "message_in_place") return;
    installThrowingAccessors(event.message,
      ["content", "details", "usage", "isError", "timestamp"], "in-place message");
  });

  pi.on("tool_result", (event) => {
    if (String(event.toolName || "").toLowerCase() !== "read_session") return;
    invocations.set(event.toolCallId, event.input || {});
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

		const frozenTargetCounterSymbol = Symbol.for("bobbit.test.frozen-target-counter");
		const frozenTargetCounters = { getter: 0, toJSON: 0 };
		(globalThis as any)[frozenTargetCounterSymbol] = frozenTargetCounters;
		const postChainAccessorCounterSymbol = Symbol.for("bobbit.test.post-chain-accessor-counter");
		const postChainAccessorCounter = { installed: 0, reads: 0 };
		(globalThis as any)[postChainAccessorCounterSymbol] = postChainAccessorCounter;
		const loaded = await loadExtensions([boundaryPath, overridePath, inPlaceMutatorPath], root);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 3);
		assert.notEqual(loaded.extensions[0], loaded.extensions[1], "Pi must load extensions into separate private maps");
		assert.equal(loaded.extensions[0].tools.size, 0);
		assert.equal(loaded.extensions[1].tools.has("read_session"), true);
		assert.equal(loaded.extensions[2].handlers.get("tool_result")?.length, 1);

		const success = createLifecycleSession(loaded, root, {
			session_id: "target",
			include_tool_results: true,
			limit: 1,
		});
		const successEvents = await runLifecycle(success, "read it");
		assert.equal(success.getActiveToolNames().includes("read_session"), true);

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

		const successStored = persistOutcome(success);
		const { roundTrip: persistedRoundTrip, sessionFile } = successStored;
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

		const mutationThenThrow = createLifecycleSession(loaded, root, {
			session_id: "target",
			include_tool_results: true,
			limit: 1,
			throw_after_mutation: true,
		});
		const mutationThenThrowEvents = await runLifecycle(mutationThenThrow, "read it after a throwing mutator");
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

		const throwStored = persistOutcome(mutationThenThrow);
		const throwSessionFile = throwStored.sessionFile;
		const throwPersistedRoundTrip = throwStored.roundTrip;
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

		for (const latePhaseAttack of ["return", "mutate", "mutate_throw"] as const) {
			const lateSession = createLifecycleSession(loaded, root, {
				session_id: "target",
				include_tool_results: true,
				limit: 1,
				late_phase_attack: latePhaseAttack,
			});
			const lateEvents = await runLifecycle(lateSession, `late ${latePhaseAttack}`);
			const { emitted: lateEnd, persisted: lateMessage } = toolOutcome(lateEvents);
			const lateStored = persistOutcome(lateSession);
			const stateMessage = lateSession.state.messages.find((message) => message.role === "toolResult") as any;
			assert.ok(stateMessage);
			assert.ok(bytes(lateEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(lateMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(Buffer.byteLength(lateStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.deepEqual(stateMessage.content, lateStored.roundTrip.content);
			for (const sentinel of [
				"TOOL_END_PROVIDER_DATA",
				"TOOL_END_PROVIDER_SIGNATURE",
				"TOOL_END_USAGE",
				"MESSAGE_END_PROVIDER_DATA",
				"MESSAGE_END_PROVIDER_SIGNATURE",
				"MESSAGE_END_USAGE",
			]) {
				assert.equal(JSON.stringify(lateEnd.result).includes(sentinel), false);
				assert.equal(JSON.stringify(stateMessage).includes(sentinel), false);
				assert.equal(lateStored.line.includes(sentinel), false);
			}
		}

		for (const accessorAttack of ["tool_return", "tool_in_place", "message_return", "message_in_place"] as const) {
			const accessorSession = createLifecycleSession(loaded, root, {
				session_id: "target",
				include_tool_results: true,
				limit: 1,
				post_chain_accessor_attack: accessorAttack,
			});
			const accessorEvents = await runLifecycle(accessorSession, `post-chain accessor ${accessorAttack}`);
			const { emitted: accessorEnd, persisted: accessorMessage } = toolOutcome(accessorEvents);
			const accessorStored = persistOutcome(accessorSession);
			const stateMessage = accessorSession.state.messages.find((message) => message.role === "toolResult") as any;
			assert.ok(stateMessage, "the bounded result must remain in Agent state");
			assert.ok(accessorSession.state.messages.some((message) =>
				message.role === "assistant" && (message as any).stopReason === "stop"), "the turn must complete");
			assert.ok(bytes(accessorEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(accessorMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(stateMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(Buffer.byteLength(accessorStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.deepEqual(stateMessage.content, accessorStored.roundTrip.content);
			assert.equal(accessorStored.roundTrip.toolName, "read_session");
		}
		assert.equal(postChainAccessorCounter.installed, 18,
			"each returned and in-place accessor scenario must reach its real Pi listener");
		assert.equal(postChainAccessorCounter.reads, 0,
			"post-chain returned and in-place accessors must never execute outside Pi's listener try/catch");

		for (const snapshotAttack of ["deep", "error_deep", "sparse", "cycle", "dag", "nonplain"] as const) {
			const hostileSession = createLifecycleSession(loaded, root, {
				session_id: "target",
				snapshot_attack: snapshotAttack,
			});
			const hostileEvents = await runLifecycle(hostileSession, `snapshot ${snapshotAttack}`);
			const { emitted: hostileEnd } = toolOutcome(hostileEvents);
			const hostileStored = persistOutcome(hostileSession);
			assert.ok(bytes(hostileEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(Buffer.byteLength(hostileStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			const fallback = JSON.parse(hostileStored.roundTrip.content[0].text);
			if (snapshotAttack === "error_deep") {
				assert.equal(hostileStored.roundTrip.isError, true);
				assert.equal(fallback.error, "read_session_failed");
			} else {
				assert.equal(fallback.truncatedBy, "extension_return_unrecognized");
			}
			assert.equal(hostileStored.line.includes("ACCESSOR_PROVIDER_DATA"), false);
		}

		for (const frozenTargetAttack of ["getter", "toJSON"] as const) {
			const frozenSession = createLifecycleSession(loaded, root, {
				session_id: "target",
				frozen_target_attack: frozenTargetAttack,
			});
			const frozenEvents = await runLifecycle(frozenSession, `frozen target ${frozenTargetAttack}`);
			const { emitted: frozenEnd, persisted: frozenMessage } = toolOutcome(frozenEvents);
			const frozenStored = persistOutcome(frozenSession);
			assert.ok(bytes(frozenEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(frozenMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(Buffer.byteLength(frozenStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(JSON.parse(frozenStored.roundTrip.content[0].text).messages[0].index, 7,
				"the safe pre-listener snapshot must remain authoritative");
		}
		assert.deepEqual(frozenTargetCounters, { getter: 0, toJSON: 0 },
			"frozen listener-controlled accessors and serializers must never execute");

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
			const agent = createLifecycleSession(loaded, root, scenario.params);
			const events = await runLifecycle(agent, scenario.label);
			const { emitted: failedEnd, persisted: failedMessage } = toolOutcome(events);
			assert.equal(failedEnd.isError, true);
			assert.equal(failedMessage.isError, true);
			assert.ok(bytes(failedEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(failedMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.deepEqual(failedEnd.result.details, { code: scenario.code, status: scenario.status });
			const errorPayload = JSON.parse(failedMessage.content[0].text);
			assert.equal(errorPayload.code, scenario.code);
			assert.equal(errorPayload.status, scenario.status);
			const stored = persistOutcome(agent);
			assert.ok(Buffer.byteLength(stored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(stored.roundTrip.isError, true);
			for (const sentinel of scenario.forbidden) {
				assert.equal(JSON.stringify(failedEnd.result).includes(sentinel), false);
				assert.equal(stored.line.includes(sentinel), false);
			}
		}

		const providerOnlyError = createLifecycleSession(loaded, root, { session_id: "target", provider_only_fail: true });
		const providerOnlyEvents = await runLifecycle(providerOnlyError, "provider-only error");
		const { emitted: providerOnlyEnd } = toolOutcome(providerOnlyEvents);
		const providerOnlyStored = persistOutcome(providerOnlyError);
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
			const agent = createLifecycleSession(loaded, root, scenario.params);
			const events = await runLifecycle(agent, scenario.label);
			const { emitted: safeEnd, persisted: safeMessage } = toolOutcome(events);
			assert.equal(safeEnd.isError, false);
			assert.equal(safeMessage.isError, false);
			assert.ok(bytes(safeEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(JSON.stringify(safeEnd.result).includes(scenario.forbidden), false);
			assert.equal(Object.prototype.hasOwnProperty.call(safeEnd.result.details, "toJSON"), false);
			const stored = persistOutcome(agent);
			assert.ok(Buffer.byteLength(stored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.equal(stored.line.includes(scenario.forbidden), false);
		}

		const nearCeiling = createLifecycleSession(loaded, root, {
			session_id: "target",
			verbose: true,
			near_ceiling: true,
		});
		const nearCeilingEvents = await runLifecycle(nearCeiling, "near ceiling");
		const { emitted: ceilingEnd, persisted: ceilingMessage } = toolOutcome(nearCeilingEvents);
		const ceilingStored = persistOutcome(nearCeiling);
		assert.ok(bytes(ceilingEnd.result) > 40 * 1024, "the fitter should preserve useful near-ceiling capacity");
		assert.ok(bytes(ceilingEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.ok(bytes(ceilingMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.ok(Buffer.byteLength(ceilingStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
		assert.deepEqual(ceilingStored.roundTrip.content, ceilingEnd.result.content);
		assert.deepEqual(ceilingStored.roundTrip.details, ceilingEnd.result.details);

		for (const correlation of [
			{ label: "boundary", source: "b".repeat(128), hashed: false },
			{ label: "over-boundary", source: "o".repeat(129), hashed: true },
			{ label: "oversized", source: "z".repeat(100_000), hashed: true },
			{ label: "snapshot-limit-plus-one", source: "j".repeat(2 * 1024 * 1024 + 1), hashed: true },
			{ label: "far-over-snapshot-limit", source: "f".repeat(8 * 1024 * 1024 + 17), hashed: true },
		] as const) {
			const correlationSession = createLifecycleSession(loaded, root, {
				session_id: "target",
				limit: 1,
			}, "read_session", correlation.source);
			const correlationEvents = await runLifecycle(correlationSession, correlation.label);
			const assistant = correlationSession.state.messages.find((message) =>
				message.role === "assistant" && message.stopReason === "toolUse") as any;
			const result = correlationSession.state.messages.find((message) => message.role === "toolResult") as any;
			assert.ok(assistant);
			assert.ok(result);
			const normalizedId = assistant.content.find((block: any) => block.type === "toolCall")?.id;
			assert.equal(typeof normalizedId, "string");
			assert.equal(result.toolCallId, normalizedId);
			assert.equal(correlationEvents.find((event) => event.type === "tool_execution_start")?.toolCallId, normalizedId);
			assert.equal(correlationEvents.find((event) => event.type === "tool_execution_end")?.toolCallId, normalizedId);
			if (correlation.hashed) {
				assert.match(normalizedId, /^brs1:[0-9a-f]{40}$/);
				assert.notEqual(normalizedId, correlation.source);
			} else {
				assert.equal(normalizedId, correlation.source);
			}
			const stored = persistOutcome(correlationSession);
			for (const line of fs.readFileSync(stored.sessionFile, "utf8").split(/\r?\n/).filter(Boolean)) {
				if (line.includes('"role":"assistant"') || line.includes('"role":"toolResult"')) {
					assert.ok(Buffer.byteLength(line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
				}
			}
			assert.equal(stored.roundTrip.toolCallId, normalizedId);
		}
	});

	it("does not let cached IDs capture an explicitly named non-read tool", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-real-pi-result-collision-"));
		roots.push(root);
		const boundaryPath = path.join(root, "boundary.ts");
		const toolsPath = path.join(root, "tools.ts");
		fs.writeFileSync(boundaryPath, generateToolResultErrorBridgeExtension(), "utf8");
		fs.writeFileSync(toolsPath, `
import { Type } from "typebox";

export default function (pi) {
  pi.registerTool({
    name: "read_session",
    label: "Read session",
    description: "Collision setup",
    parameters: Type.Object({ session_id: Type.String() }),
    async execute() {
      const envelope = {
        total: 1,
        returned: 1,
        offsetStart: 0,
        offsetEnd: 0,
        messages: [{ index: 0, role: "assistant", text: "bounded read" }],
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
    },
  });
  pi.registerTool({
    name: "collision_probe",
    label: "Collision probe",
    description: "Must remain ordinary tool output",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "NON_READ_COLLISION_PASSTHROUGH" }],
        details: { providerMetadata: "NON_READ_COLLISION_DETAILS" },
        usage: { providerMetadata: "NON_READ_COLLISION_USAGE" },
      };
    },
  });
}
`, "utf8");

		const loaded = await loadExtensions([boundaryPath, toolsPath], root);
		assert.deepEqual(loaded.errors, []);
		const collisionId = "shared-provider-call-id";
		const streamFn = makeSequenceStream([
			{ name: "read_session", arguments: { session_id: "target" }, id: collisionId },
			{ name: "collision_probe", arguments: {}, id: collisionId },
		]);
		const session = createLifecycleSession(
			loaded,
			root,
			{ session_id: "target" },
			"read_session",
			collisionId,
			streamFn,
		);
		const events = await runLifecycle(session, "run colliding tools");
		const emitted = events.find((event) =>
			event.type === "tool_execution_end" && event.toolName === "collision_probe");
		assert.ok(emitted);
		assert.equal(emitted.result.content[0].text, "NON_READ_COLLISION_PASSTHROUGH");
		assert.deepEqual(emitted.result.details, { providerMetadata: "NON_READ_COLLISION_DETAILS" });
		assert.deepEqual(emitted.result.usage, { providerMetadata: "NON_READ_COLLISION_USAGE" });

		const stateResult = session.state.messages.find((message) =>
			message.role === "toolResult" && (message as any).toolName === "collision_probe") as any;
		assert.ok(stateResult, "the non-read result must reach AgentSession state");
		assert.equal(stateResult.toolCallId, collisionId);
		assert.equal(stateResult.content[0].text, "NON_READ_COLLISION_PASSTHROUGH");
		assert.deepEqual(stateResult.details, { providerMetadata: "NON_READ_COLLISION_DETAILS" });

		const sessionFile = session.sessionManager.getSessionFile();
		assert.ok(sessionFile);
		const persistedLine = fs.readFileSync(sessionFile, "utf8")
			.split(/\r?\n/)
			.find((line) => line.includes('"toolName":"collision_probe"'));
		assert.ok(persistedLine, "the non-read result must be persisted");
		assert.equal(persistedLine.includes("NON_READ_COLLISION_PASSTHROUGH"), true);
		assert.equal(persistedLine.includes("NON_READ_COLLISION_DETAILS"), true);
	});

	it("retains only fixed-bounded digests for many oversized provider call IDs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-real-pi-result-call-map-"));
		roots.push(root);
		const boundaryPath = path.join(root, "boundary.ts");
		fs.writeFileSync(boundaryPath, generateToolResultErrorBridgeExtension(), "utf8");
		const loaded = await loadExtensions([boundaryPath], root);
		assert.deepEqual(loaded.errors, []);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, {} as never, {} as never);
		const diagnosticsSymbol = Symbol.for("bobbit.tool-result.read-session-call-map-diagnostics.v1");
		let lastNormalizedId = "";

		for (let index = 0; index < 16; index++) {
			const prefix = `${index}:`;
			const providerId = prefix + "x".repeat(2 * 1024 * 1024 - prefix.length);
			const normalized = await runner.emitMessageEnd({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						id: providerId,
						name: "read_session",
						arguments: { session_id: `target-${index}` },
					}],
				},
			} as never) as any;
			lastNormalizedId = normalized.content[0].id;
			assert.match(lastNormalizedId, /^brs1:[0-9a-f]{40}$/);
			assert.notEqual(lastNormalizedId, providerId);
		}

		const envelope = {
			total: 1,
			returned: 1,
			offsetStart: 0,
			offsetEnd: 0,
			messages: [{ index: 0, role: "assistant", text: "correlated" }],
		};
		const correlated = await runner.emitToolResult({
			type: "tool_result",
			toolCallId: lastNormalizedId,
			content: [{ type: "text", text: JSON.stringify(envelope) }],
			isError: false,
		} as never) as any;
		assert.equal(JSON.parse(correlated.content[0].text).messages[0].text, "correlated",
			"the normalized ID must still resolve the correct read_session parameters");

		for (let index = 0; index < 300; index++) {
			await runner.emitMessageEnd({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						id: `small-${index}`,
						name: "read_session",
						arguments: { session_id: `target-${index}` },
					}],
				},
			} as never);
		}

		const inspect = (runner as any)[diagnosticsSymbol];
		assert.equal(typeof inspect, "function");
		const diagnostics = inspect.call(runner);
		assert.deepEqual(
			{
				entries: diagnostics.entries,
				maxEntries: diagnostics.maxEntries,
				correlationKeyUnits: diagnostics.correlationKeyUnits,
				maxKeyUnits: diagnostics.maxKeyUnits,
			},
			{ entries: 256, maxEntries: 256, correlationKeyUnits: 45, maxKeyUnits: 45 },
		);
		assert.ok(diagnostics.maxValueStringUnits <= 128);
		assert.ok(diagnostics.totalRetainedStringUnits <= 256 * (45 + 128 + 64 + 64),
			"all retained map keys and string values must have a fixed aggregate bound");
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
