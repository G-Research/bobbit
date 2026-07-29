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


export {
	ExtensionRunner,
	generateToolResultErrorBridgeExtension,
	loadExtensions,
	READ_SESSION_FINAL_RESULT_MAX_BYTES,
};
