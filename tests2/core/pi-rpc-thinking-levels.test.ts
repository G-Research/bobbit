import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "vitest";

import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { RpcBridge } from "../../src/server/agent/rpc-bridge.ts";

const AVAILABLE_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_COMMAND = { type: "get_available_thinking_levels" } satisfies RpcCommand;
const THINKING_RESPONSE = {
	type: "response",
	command: "get_available_thinking_levels",
	success: true,
	data: { levels: [...AVAILABLE_LEVELS] },
} satisfies RpcResponse;

interface FakeRpcChild extends EventEmitter {
	pid: number;
	stdin: EventEmitter & { write(data: string): boolean };
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill(signal?: string): boolean;
}

function makeReplyingChild(commands: Array<Record<string, unknown>>): FakeRpcChild {
	const child = new EventEmitter() as FakeRpcChild;
	child.pid = 81;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = Object.assign(new EventEmitter(), {
		write(data: string): boolean {
			const command = JSON.parse(data.trim()) as Record<string, unknown>;
			commands.push(command);

			let response: Record<string, unknown>;
			switch (command.type) {
				case "get_state": {
					const data = {
						thinkingLevel: "medium",
						isStreaming: false,
						isCompacting: false,
						steeringMode: "one-at-a-time",
						followUpMode: "one-at-a-time",
						sessionId: "rpc-audit",
						autoCompactionEnabled: true,
						messageCount: 3,
						pendingMessageCount: 0,
					} satisfies RpcSessionState;
					response = { type: "response", command: command.type, success: true, data, id: command.id };
					break;
				}
				case "set_model":
					response = {
						type: "response",
						command: command.type,
						success: true,
						data: { provider: command.provider, id: command.modelId },
						id: command.id,
					};
					break;
				case "set_thinking_level":
					response = { type: "response", command: command.type, success: true, id: command.id };
					break;
				case "get_available_thinking_levels":
					response = { ...THINKING_RESPONSE, id: command.id };
					break;
				default:
					throw new Error(`Unexpected command: ${String(command.type)}`);
			}

			queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${JSON.stringify(response)}\n`)));
			return true;
		},
	});
	child.kill = () => {
		queueMicrotask(() => child.emit("exit", 0, null));
		return true;
	};
	return child;
}

function attachFakeChild(bridge: RpcBridge, child: FakeRpcChild): void {
	const internals = bridge as unknown as {
		process: FakeRpcChild;
		_attachProcessHandlers(): void;
	};
	internals.process = child;
	internals._attachProcessHandlers();
}

describe("Pi 0.81 RPC thinking-level compatibility", () => {
	it("publishes the additive typed client request and restores the legacy stream fallback", async () => {
		const { RpcClient } = await import("@earendil-works/pi-coding-agent");
		const sent: RpcCommand[] = [];
		const client = new RpcClient();
		(client as unknown as { send(command: RpcCommand): Promise<RpcResponse> }).send = async (command) => {
			sent.push(command);
			return THINKING_RESPONSE;
		};

		assert.deepEqual(await client.getAvailableThinkingLevels(), [...AVAILABLE_LEVELS]);
		assert.deepEqual(sent, [THINKING_COMMAND]);

		// coding-agent's published shrinkwrap installs its own agent-core copy.
		// Resolve that exact runtime instance: sdk.js registers streamSimple on it
		// as the pre-0.81 fallback used by coding-agent extensions.
		const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const nestedCoreEntry = path.join(
			path.dirname(codingAgentEntry), "..", "node_modules",
			"@earendil-works", "pi-agent-core", "dist", "index.js",
		);
		const { Agent } = await import(pathToFileURL(nestedCoreEntry).href) as typeof import("@earendil-works/pi-agent-core");
		const legacyAgent = new Agent({} as never);
		assert.equal(typeof legacyAgent.streamFunction, "function");
	});

	it("forwards the additive command without changing established state/model/thinking helpers", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const bridge = new RpcBridge({});
		attachFakeChild(bridge, makeReplyingChild(commands));
		let eventCount = 0;
		const unsubscribe = bridge.onEvent(() => eventCount++);

		try {
			const stateResponse = await bridge.getState();
			const modelResponse = await bridge.setModel("anthropic", "claude-opus-4-8");
			const setThinkingResponse = await bridge.setThinkingLevel("xhigh");
			const levelsResponse = await bridge.sendCommand(THINKING_COMMAND);

			assert.equal(stateResponse.data.sessionId, "rpc-audit");
			assert.deepEqual(modelResponse.data, { provider: "anthropic", id: "claude-opus-4-8" });
			assert.equal(setThinkingResponse.success, true);
			assert.deepEqual(levelsResponse.data.levels, [...AVAILABLE_LEVELS]);
			assert.equal(eventCount, 0, "correlated responses must not leak into the event stream");

			assert.deepEqual(
				commands.map(({ id: _id, ...command }) => command),
				[
					{ type: "get_state" },
					{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-8" },
					{ type: "set_thinking_level", level: "xhigh" },
					THINKING_COMMAND,
				],
			);
			assert.deepEqual(
				commands.map((command) => command.id),
				["req_1", "req_2", "req_3", "req_4"],
				"the additive command must use the existing request correlation path",
			);
		} finally {
			unsubscribe();
			await bridge.stop();
		}
	});
});
