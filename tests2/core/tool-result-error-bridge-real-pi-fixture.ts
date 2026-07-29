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

import {
	generateToolResultErrorBridgeExtension,
	READ_SESSION_FINAL_RESULT_MAX_BYTES,
} from "../../src/server/agent/tool-result-error-bridge-extension.js";

const roots: string[] = [];

export function makeRealPiRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

export function cleanupRealPiRoots(): void {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

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

export function makeSequenceStream(calls: StreamToolCall[]) {
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

export function createLifecycleSession(
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

export async function runLifecycle(session: AgentSession, label: string): Promise<any[]> {
	const events: any[] = [];
	session.subscribe((event) => { events.push(event); });
	await (session as any)._runAgentPrompt({
		role: "user",
		content: [{ type: "text", text: label }],
		timestamp: Date.now(),
	});
	return events;
}

export function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function toolOutcome(events: any[]) {
	const emitted = events.find((event) => event.type === "tool_execution_end");
	const persisted = events.find((event) => event.type === "message_end" && event.message.role === "toolResult")?.message;
	assert.ok(emitted);
	assert.ok(persisted);
	return { emitted, persisted };
}

export function persistOutcome(session: AgentSession) {
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

export function resultValueFromMessage(message: any): Record<string, unknown> {
	const value: Record<string, unknown> = {};
	for (const key of ["content", "details", "isError"] as const) {
		if (Object.prototype.hasOwnProperty.call(message, key)) value[key] = message[key];
	}
	return value;
}

export async function loadRealPiLifecycleBoundaryFixture() {
	const root = makeRealPiRoot("bobbit-real-pi-result-boundary-");
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
      projection_flags: Type.Optional(Type.Boolean()),
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
      const selectedEnvelope = params.projection_flags ? {
        total: 2,
        returned: 2,
        offsetStart: 0,
        offsetEnd: 1,
        messages: [{
          index: 0,
          role: "r".repeat(40),
          roleTruncated: true,
          ts: "t".repeat(80),
          tsTruncated: true,
        }, {
          index: 1,
          role: "assistant",
          ts: null,
          tsInvalid: true,
        }],
      } : params.near_ceiling ? {
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

	return { root, loaded, frozenTargetCounters, postChainAccessorCounter };
}


export {
	ExtensionRunner,
	generateToolResultErrorBridgeExtension,
	loadExtensions,
	READ_SESSION_FINAL_RESULT_MAX_BYTES,
};
