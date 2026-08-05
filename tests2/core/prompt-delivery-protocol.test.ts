import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { afterEach, describe, it, vi } from "vitest";

import promptDeliveryExtension from "../../defaults/tools/_prompt-delivery/extension.ts";
import {
	PromptDeliveryProtocolError,
	RpcBridge,
	frameIdempotentPrompt,
} from "../../src/server/agent/rpc-bridge.ts";
import { SANDBOX_STATE_MOUNTS } from "../../src/server/agent/docker-args.ts";

const ACK_TYPE = "bobbit:prompt-delivery-ack-v1";
const MARKER_TYPE = "bobbit:prompt-delivery-v1";
const capability = {
	type: "bobbit_prompt_delivery_capability",
	protocolVersion: 1,
	extensionVersion: "1.0.0",
};

function sha(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function fakePi() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const branch: any[] = [];
	const pi = {
		on(type: string, handler: (event: any, ctx: any) => any) { handlers.set(type, handler); },
		appendEntry(customType: string, data: any) {
			branch.push({ type: "custom", customType, data });
		},
	};
	const ctx = { sessionManager: { getBranch: () => branch } };
	return { pi, handlers, branch, ctx };
}

function captureControlEvents() {
	const lines: any[] = [];
	const spy = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, chunk: any) => {
		assert.equal(fd, 1);
		const text = String(chunk);
		for (const line of text.trim().split("\n")) {
			if (line) lines.push(JSON.parse(line));
		}
		return Buffer.byteLength(text);
	}) as any);
	return { lines, spy };
}

type FakeChild = EventEmitter & {
	stdin: EventEmitter & { write(data: string): boolean };
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill(signal?: string): boolean;
};

function attachFakeChild(bridge: RpcBridge, onCommand: (command: any, child: FakeChild) => void): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = Object.assign(new EventEmitter(), {
		write(data: string) {
			onCommand(JSON.parse(data.trim()), child);
			return true;
		},
	});
	child.kill = () => true;
	(bridge as any).process = child;
	(bridge as any)._attachProcessHandlers();
	return child;
}

afterEach(() => vi.restoreAllMocks());

describe("versioned downstream prompt protocol", () => {
	it("handshakes, strips frames, and ACKs every id only after its user entry is committed", () => {
		const controls = captureControlEvents();
		const { pi, handlers, branch, ctx } = fakePi();
		promptDeliveryExtension(pi as any);
		assert.deepEqual(controls.lines, [capability]);

		for (const [id, body] of [["p-1", "first"], ["p-2", "second"]] as const) {
			const result = handlers.get("input")!({ text: frameIdempotentPrompt(body, id), images: [] }, ctx);
			assert.deepEqual(result, { action: "transform", text: body, images: [] });
			assert.equal(branch.at(-1).customType, MARKER_TYPE);
			branch.push({ type: "message", message: { role: "user", content: body } });
		}
		assert.equal(branch.some((entry) => entry.customType === ACK_TYPE), false, "message acceptance is not persistence ACK");

		handlers.get("agent_end")!({}, ctx);
		const acks = branch.filter((entry) => entry.customType === ACK_TYPE);
		assert.deepEqual(acks.map((entry) => entry.data.promptId), ["p-1", "p-2"]);
		assert.deepEqual(acks.map((entry) => entry.data.protocolVersion), [1, 1]);

		const duplicate = handlers.get("input")!({ text: frameIdempotentPrompt("first", "p-1") }, ctx);
		assert.deepEqual(duplicate, { action: "handled" }, "committed duplicate must not create another model turn");
		assert.equal(branch.filter((entry) => entry.customType === MARKER_TYPE && entry.data.promptId === "p-1").length, 1);
		assert.equal(branch.filter((entry) => entry.customType === ACK_TYPE && entry.data.promptId === "p-1").length, 2);
	});

	it("fails reservation and identity collision closed without returning framed text", () => {
		const controls = captureControlEvents();
		const reserved = fakePi();
		promptDeliveryExtension(reserved.pi as any);
		(reserved.pi as any).appendEntry = () => { throw new Error("disk full"); };
		const failed = reserved.handlers.get("input")!({ text: frameIdempotentPrompt("private", "p-fail") }, reserved.ctx);
		assert.deepEqual(failed, { action: "handled" });
		assert.equal(controls.lines.at(-1).code, "reservation-failed");

		const collision = fakePi();
		promptDeliveryExtension(collision.pi as any);
		collision.branch.push({ type: "custom", customType: MARKER_TYPE, data: { promptId: "same", digest: sha("old") } });
		const collided = collision.handlers.get("input")!({ text: frameIdempotentPrompt("new", "same") }, collision.ctx);
		assert.deepEqual(collided, { action: "handled" });
		assert.equal(controls.lines.at(-1).code, "identity-collision");
	});

	it("remaps the exact extension into Docker without a project-wide delivery ledger mount", () => {
		const builtinToolsDir = path.resolve("defaults/tools");
		const bridge = new RpcBridge({
			containerId: "prompt-protocol-container",
			toolManager: { getBuiltinToolsDir: () => builtinToolsDir } as any,
		});
		const remapped = (bridge as any).remapArgsForContainer([
			"--extension",
			path.join(builtinToolsDir, "_prompt-delivery", "extension.ts"),
		]);
		assert.deepEqual(remapped, ["--extension", "/tools-builtin/_prompt-delivery/extension.ts"]);
		assert.equal(SANDBOX_STATE_MOUNTS.some((mount) => mount.sub === "prompt-delivery"), false);
	});

	it("uses frames only after the exact handshake and rejects extension failure for the matching RPC", async () => {
		const commands: any[] = [];
		const bridge = new RpcBridge({});
		const child = attachFakeChild(bridge, (command) => commands.push(command));

		await assert.rejects(
			bridge.promptWithId("must stay raw", "p-no-cap"),
			(error: any) => error instanceof PromptDeliveryProtocolError && error.code === "capability-unavailable",
		);
		const raw = bridge.prompt("legacy raw");
		assert.equal(commands.at(-1).message, "legacy raw");
		child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "response", id: commands.at(-1).id, success: true })}\n`));
		await raw;

		child.stdout.emit("data", Buffer.from(`${JSON.stringify(capability)}\n`));
		assert.equal(bridge.promptDeliveryProtocol, "v1");
		const framed = bridge.promptWithId("model body", "p-stable");
		assert.match(commands.at(-1).message, /^\u001eBOBBIT_PROMPT_V1:/);
		child.stdout.emit("data", Buffer.from(`${JSON.stringify({
			type: "bobbit_prompt_delivery_failure",
			protocolVersion: 1,
			promptId: "p-stable",
			code: "reservation-failed",
		})}\n`));
		await assert.rejects(framed, (error: any) => error instanceof PromptDeliveryProtocolError && error.retryable === true);
	});
});
