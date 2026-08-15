import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { describe, it } from "vitest";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { BgProcessManager } from "../../src/server/agent/bg-process-manager.ts";
import { broadcastStatus } from "../../src/server/agent/session-status.ts";
import { handleWebSocketConnection } from "../../src/server/ws/handler.ts";
import { isSocketSendable } from "../../src/server/ws/socket-sendability.ts";

class FakeWebSocket extends EventEmitter {
	readyState = 1;
	bufferedAmount = 0;
	streamBackpressureCutover?: boolean;
	readonly sent: any[] = [];

	send(data: string, callback?: (error?: Error) => void): void {
		this.sent.push(JSON.parse(data));
		callback?.();
	}

	terminate(): void {
		// Deliberately retain OPEN to model a delayed or failed transport close.
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.emit("close", code, reason);
	}
}

function makeSession() {
	return {
		id: "post-cutover-egress",
		projectId: "project-1",
		status: "idle",
		statusVersion: 0,
		title: "Session",
		clients: new Set<FakeWebSocket>(),
		eventBuffer: new EventBuffer(),
		promptQueue: { toArray: () => [] },
		cwd: process.cwd(),
		rpcClient: {},
	};
}

function makeSessionManager(session: ReturnType<typeof makeSession>) {
	return {
		getSession: (id: string) => id === session.id ? session : undefined,
		getArchivedSession: () => undefined,
		addClient: (_id: string, ws: FakeWebSocket) => {
			session.clients.add(ws);
			return true;
		},
		removeClient: (_id: string, ws: FakeWebSocket) => session.clients.delete(ws),
		getPersistedSession: () => undefined,
		getImageModelForSession: () => undefined,
		withSessionCostInState: (_id: string, data: unknown) => data,
		getSessionCostUpdate: () => undefined,
		getPendingToolPermission: () => undefined,
		getProjectContextManager: () => undefined,
	};
}

async function authenticate(session: ReturnType<typeof makeSession>): Promise<FakeWebSocket> {
	const ws = new FakeWebSocket();
	handleWebSocketConnection(
		ws as any,
		session.id,
		{ socket: { remoteAddress: "127.0.0.1" } } as any,
		makeSessionManager(session) as any,
		"token",
		{ isRateLimited: () => false, recordFailure: () => {} } as any,
		undefined,
		true,
		undefined,
		undefined,
		{} as any,
		undefined,
		undefined,
		undefined,
	);
	ws.emit("message", JSON.stringify({ type: "auth", token: "ignored", clientKind: "app" }));
	await Promise.resolve();
	return ws;
}

function functionBody(source: string, name: string): string {
	const start = source.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `missing ${name}`);
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let index = open; index < source.length; index++) {
		if (source[index] === "{") depth++;
		if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
	}
	throw new Error(`unterminated ${name}`);
}

describe("post-cutover WebSocket egress fence", () => {
	it("treats a cut-over OPEN socket as unsendable without affecting a healthy OPEN socket", () => {
		assert.equal(isSocketSendable({ readyState: 1 }), true);
		assert.equal(isSocketSendable({ readyState: 1, streamBackpressureCutover: false }), true);
		assert.equal(isSocketSendable({ readyState: 1, streamBackpressureCutover: true }), false);
		assert.equal(isSocketSendable({ readyState: 3 }), false);
	});

	it("fences status and background-output broadcasts while preserving healthy delivery", () => {
		const fenced = new FakeWebSocket();
		fenced.streamBackpressureCutover = true;
		const healthy = new FakeWebSocket();
		const clients = new Set([fenced, healthy]);
		const session: any = { status: "idle", statusVersion: 4, clients };

		broadcastStatus(session, "streaming", { streamingStartedAt: 123 });
		assert.equal(session.status, "streaming", "status mutation remains authoritative");
		assert.equal(session.statusVersion, 5, "status version still advances");
		assert.equal(fenced.sent.length, 0);
		assert.deepEqual(healthy.sent.at(-1), {
			type: "session_status",
			status: "streaming",
			statusVersion: 5,
			streamingStartedAt: 123,
		});

		const manager = new BgProcessManager(() => clients as any);
		(manager as any).broadcast("session-1", {
			type: "bg_process_output",
			processId: "bg-1",
			stream: "stdout",
			text: "healthy output",
			ts: 1,
		});
		assert.equal(fenced.sent.length, 0);
		assert.equal(healthy.sent.at(-1)?.type, "bg_process_output");
	});

	it("fences join and leave frames on delayed-close sockets while healthy peers converge", async () => {
		const session = makeSession();
		const fenced = await authenticate(session);
		const healthy = await authenticate(session);
		fenced.sent.length = 0;
		healthy.sent.length = 0;
		fenced.streamBackpressureCutover = true;

		const joining = await authenticate(session);
		assert.equal(fenced.sent.length, 0, "cut-over peer must not receive client_joined");
		assert.equal(healthy.sent.filter(message => message.type === "client_joined").length, 1);

		joining.close(1000, "done");
		assert.equal(fenced.sent.length, 0, "cut-over peer must not receive client_left");
		assert.equal(healthy.sent.filter(message => message.type === "client_left").length, 1);
	});

	it("uses the shared fence in every server broadcaster diagnostics branch", () => {
		const source = fs.readFileSync("src/server/server.ts", "utf8");
		const expectedUses: Record<string, number> = {
			broadcastToGoal: 2,
			broadcastToAll: 2,
			broadcastToUi: 1,
			broadcastToProject: 2,
			broadcastToSession: 2,
		};
		for (const [name, minimumUses] of Object.entries(expectedUses)) {
			const body = functionBody(source, name);
			assert.match(body, /if \(!cpuDiagnosticsEnabled\(\)\)/, `${name} must retain both diagnostics modes`);
			assert.ok(
				(body.match(/isSocketSendable\(/g) ?? []).length >= minimumUses,
				`${name} must fence both physical send branches`,
			);
			assert.doesNotMatch(body, /readyState\s*[!=]==?\s*1/, `${name} must not diverge from the shared predicate`);
		}
	});
});
