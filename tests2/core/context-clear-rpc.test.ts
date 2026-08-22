import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import { RpcBridge, type IRpcBridge } from "../../src/server/agent/rpc-bridge.ts";

interface FakeRpcChild extends EventEmitter {
	pid: number;
	stdin: EventEmitter & { write(data: string): boolean };
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill(signal?: string): boolean;
}

function attachFakeChild(bridge: RpcBridge, child: FakeRpcChild): void {
	const internals = bridge as unknown as {
		process: FakeRpcChild;
		_attachProcessHandlers(): void;
	};
	internals.process = child;
	internals._attachProcessHandlers();
}

function replyingChild(
	commands: Array<Record<string, unknown>>,
	cancelled: boolean,
	responsePatch: Record<string, unknown> = {},
): FakeRpcChild {
	const child = new EventEmitter() as FakeRpcChild;
	child.pid = 84;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = Object.assign(new EventEmitter(), {
		write(data: string): boolean {
			const command = JSON.parse(data.trim()) as Record<string, unknown>;
			commands.push(command);
			assert.equal(
				command.type,
				"new_session",
				"CONTEXT_CLEAR_RPC_WRONG_COMMAND: clear must invoke Pi new_session rather than compact/switch_session",
			);
			const response = {
				type: "response",
				command: "new_session",
				success: true,
				data: { cancelled },
				...responsePatch,
				id: command.id,
			};
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

describe("clear-context Pi RPC bridge", () => {
	it("publishes new_session on the typed bridge contract", () => {
		const command = { type: "new_session" } satisfies RpcCommand;
		expect(command).toEqual({ type: "new_session" });

		const bridge = new RpcBridge({});
		const typedBridgeMethod: IRpcBridge["newSession"] = bridge.newSession.bind(bridge);
		expect(typeof typedBridgeMethod, "CONTEXT_CLEAR_RPC_METHOD_MISSING: IRpcBridge must expose newSession").toBe("function");
	});

	it("sends only the exact new_session command with the established 120 second default timeout", async () => {
		const bridge = new RpcBridge({});
		const sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({
			type: "response",
			command: "new_session",
			success: true,
			data: { cancelled: false },
		});

		const response = await bridge.newSession();

		expect(sendCommand).toHaveBeenCalledExactlyOnceWith({ type: "new_session" }, 120_000);
		expect(sendCommand.mock.calls[0][0]).not.toHaveProperty("parentSession");
		expect(response).toMatchObject({ success: true, data: { cancelled: false } });
	});

	it.each([
		["a wrong command", { command: "compact", data: { cancelled: false } }],
		["a missing cancellation boolean", { data: {} }],
	] as const)("returns %s response unchanged for lifecycle validation", async (_label, responsePatch) => {
		const commands: Array<Record<string, unknown>> = [];
		const bridge = new RpcBridge({});
		attachFakeChild(bridge, replyingChild(commands, false, responsePatch));

		try {
			const response = await bridge.newSession(7_654);
			expect(response).toMatchObject(responsePatch);
			expect(commands).toHaveLength(1);
			expect(commands[0]).toMatchObject({ type: "new_session", id: "req_1" });
		} finally {
			await bridge.stop();
		}
	});

	it("preserves a caller timeout and Pi's cancellation result without issuing a follow-up command", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const bridge = new RpcBridge({});
		attachFakeChild(bridge, replyingChild(commands, true));
		let eventCount = 0;
		const unsubscribe = bridge.onEvent(() => eventCount++);

		try {
			const response = await bridge.newSession(7_654);
			expect(response, "CONTEXT_CLEAR_RPC_CANCELLATION_LOST: Pi cancellation must reach the lifecycle owner").toMatchObject({
				type: "response",
				command: "new_session",
				success: true,
				data: { cancelled: true },
			});
			expect(commands).toHaveLength(1);
			expect(commands[0]).toMatchObject({ type: "new_session", id: "req_1" });
			expect(commands[0]).not.toHaveProperty("parentSession");
			expect(eventCount).toBe(0);
		} finally {
			unsubscribe();
			await bridge.stop();
		}
	});
});
