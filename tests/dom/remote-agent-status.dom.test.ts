import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests/support/helpers/dom/setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/remote-agent-status.spec.ts (v2-dom tier).
//
// The legacy fixture hand-wrote a `FakeRemoteAgent` mirror of the canonical-
// status logic. This port drives the REAL RemoteAgent (from src/app/remote-agent.ts)
// directly: `handleServerMessage` for session_status/state/error frames and
// `handleAgentEvent` for agent_start/agent_end signals. It asserts the same
// divergence-impossibility invariant against the real getter/state:
//
//   agent.isStreaming ≡ (agent.state.status === "streaming")
//
// after every frame, plus statusVersion idempotency (`<=`), gap-resync (`>+1`),
// and the single-writer rule (agent_start/agent_end/error MUST NOT write status).
// See docs/design/unify-session-status.md §6.1.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteAgent } from "../../src/app/remote-agent.js";

let beepSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	// Intercept the audio side effect so agent_end doesn't touch AudioContext and
	// so we can count beeps faithfully (the real notification cue).
	beepSpy = vi.spyOn(RemoteAgent, "playNotificationBeep").mockImplementation(async () => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

interface Harness {
	a: RemoteAgent;
	sent: any[];
	statusChanges: string[];
}

function makeAgent(): Harness {
	const a = new RemoteAgent();
	(a as any)._sessionId = "sess-1";
	const sent: any[] = [];
	const statusChanges: string[] = [];
	(a as any).send = (m: any) => { sent.push(m); };
	a.onStatusChange = (s: string) => { statusChanges.push(s); };
	return { a, sent, statusChanges };
}

const status = (a: RemoteAgent) => (a as any)._state.status;
// `isStreaming` is a derived getter on the canonical `_state` object (exposed
// via `agent.state`), not a top-level property of the agent.
const streaming = (a: RemoteAgent) => (a.state as any).isStreaming;
const version = (a: RemoteAgent) => (a as any)._lastStatusVersion;
const beeps = () => beepSpy.mock.calls.length;

async function sessionStatus(a: RemoteAgent, s: string, statusVersion?: number) {
	await (a as any).handleServerMessage({ type: "session_status", status: s, statusVersion });
}
async function stateFrame(a: RemoteAgent, data: any) {
	await (a as any).handleServerMessage({ type: "state", data });
}
async function errorFrame(a: RemoteAgent) {
	await (a as any).handleServerMessage({ type: "error", message: "fail", code: "X" });
}
function agentEvent(a: RemoteAgent, type: string) {
	(a as any).handleAgentEvent({ type });
}

/** Divergence-impossibility invariant: the streaming getter is exactly the
 *  canonical status test — they can never disagree. */
function expectInvariant(a: RemoteAgent) {
	expect(streaming(a)).toBe(status(a) === "streaming");
}

describe("RemoteAgent canonical-status / version / heartbeat / gap-resync", () => {
	it("happy path — full lifecycle", async () => {
		const { a } = makeAgent();
		await sessionStatus(a, "idle", 1);
		expectInvariant(a);
		agentEvent(a, "agent_start");
		expectInvariant(a);
		await sessionStatus(a, "streaming", 2);
		expectInvariant(a);
		agentEvent(a, "agent_end");
		expectInvariant(a);
		await sessionStatus(a, "idle", 3);
		expectInvariant(a);
		expect(status(a)).toBe("idle");
		expect(version(a)).toBe(3);
		expect(streaming(a)).toBe(false);
		expect(beeps()).toBe(1); // agent_end fired beep exactly once
	});

	it("missed agent_end — session_status drives convergence", async () => {
		const { a } = makeAgent();
		await sessionStatus(a, "idle", 1);
		await sessionStatus(a, "streaming", 2);
		// agent_end DROPPED.
		await sessionStatus(a, "idle", 3);
		expect(streaming(a)).toBe(false);
		expect(beeps()).toBe(0); // no beep — no agent_end fired
		expectInvariant(a);
	});

	it("statusVersion gap triggers status_resync request", async () => {
		const { a, sent } = makeAgent();
		await sessionStatus(a, "idle", 1);
		await sessionStatus(a, "streaming", 2);
		sent.length = 0;
		// v=3 dropped. v=4 arrives.
		await sessionStatus(a, "idle", 4);
		expect(sent[0]).toEqual({ type: "status_resync" });
		expect(version(a)).toBe(4);
		expect(status(a)).toBe("idle");
		expectInvariant(a);
	});

	it("stale frame is dropped (idempotent on <=)", async () => {
		const { a, statusChanges } = makeAgent();
		await sessionStatus(a, "streaming", 5);
		await sessionStatus(a, "streaming", 10);
		const beforeStatus = status(a);
		statusChanges.length = 0;
		// Stale frame from a network reorder.
		await sessionStatus(a, "idle", 7);
		expect(status(a)).toBe(beforeStatus); // stale frame ignored
		expect(version(a)).toBe(10);
		expect(statusChanges).toEqual(["idle"]); // onStatusChange still fires
		expectInvariant(a);
	});

	it("heartbeat (same version) is idempotent", async () => {
		const { a, statusChanges } = makeAgent();
		await sessionStatus(a, "streaming", 5);
		statusChanges.length = 0;
		await sessionStatus(a, "streaming", 5);
		await sessionStatus(a, "streaming", 5);
		expect(version(a)).toBe(5); // version not bumped
		expect(status(a)).toBe("streaming");
		expect(statusChanges).toEqual(["streaming", "streaming"]);
		expectInvariant(a);
	});

	it("state snapshot primes _lastStatusVersion", async () => {
		const { a } = makeAgent();
		await stateFrame(a, { status: "streaming", statusVersion: 42 });
		expect(version(a)).toBe(42);
		expect(status(a)).toBe("streaming");
		await sessionStatus(a, "streaming", 41); // stale
		expect(version(a)).toBe(42); // stale post-snapshot frame ignored
		await sessionStatus(a, "idle", 43);
		expect(status(a)).toBe("idle");
		expectInvariant(a);
	});

	it("error frame is signal-only — no status mutation", async () => {
		const { a } = makeAgent();
		await sessionStatus(a, "streaming", 1);
		await errorFrame(a);
		expect(status(a)).toBe("streaming"); // status unchanged by error frame
		expect(streaming(a)).toBe(true);
		// Server's matching session_status arrives next:
		await sessionStatus(a, "idle", 2);
		expect(streaming(a)).toBe(false);
		expectInvariant(a);
	});

	it("heartbeat-driven recovery from stuck-streaming", async () => {
		const { a, sent } = makeAgent();
		// Drive into stuck state via a frame.
		await sessionStatus(a, "streaming", 5);
		expect(streaming(a)).toBe(true);
		// Server has actually transitioned to idle and is now sending heartbeats
		// at v=7 (it bumped to 6 on the unseen idle transition).
		await sessionStatus(a, "idle", 7);
		expect(sent.some((m) => m.type === "status_resync")).toBe(true);
		expect(status(a)).toBe("idle"); // client healed to idle
		expect(streaming(a)).toBe(false);
		expectInvariant(a);
	});
});

describe("RemoteAgent gateway availability frames", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses the same client-owned schedule for every pre-auth retry hint", async () => {
		vi.useFakeTimers();
		const originalWebSocket = globalThis.WebSocket;
		let frames: Array<Record<string, unknown>> = [];
		let sockets = 0;
		class MockWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = MockWebSocket.CONNECTING;
			onopen: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onclose: ((event: CloseEvent) => void) | null = null;
			constructor(_url: string) {
				sockets++;
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.onopen?.(new Event("open"));
				});
			}
			send(raw: string): void {
				if (JSON.parse(raw).type !== "auth") return;
				const frame = frames.shift();
				queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent));
			}
			close(): void {
				this.readyState = MockWebSocket.CLOSED;
				this.onclose?.({} as CloseEvent);
			}
		}
		(globalThis as any).WebSocket = MockWebSocket;
		try {
			for (const [code, retryAfterMs] of [
				["SERVER_STARTING", 1],
				["SERVER_SATURATED", 999],
				["SERVER_STARTING", Number.MAX_VALUE],
				["SERVER_SATURATED", undefined],
				["SERVER_STARTING", null],
				["SERVER_SATURATED", "invalid"],
				["SERVER_STARTING", {}],
			] as const) {
				sockets = 0;
				frames = [
					{ type: "error", code, retryAfterMs },
					{ type: "auth_ok" },
				];
				const agent = new RemoteAgent();
				try {
					const connected = agent.connect("https://gateway.test", "token", "session-1");
					await vi.advanceTimersByTimeAsync(0);
					await vi.advanceTimersByTimeAsync(999);
					expect(sockets).toBe(1);
					await vi.advanceTimersByTimeAsync(1);
					await connected;
					expect(sockets).toBe(2);
				} finally {
					agent.disconnect();
				}
			}
		} finally {
			(globalThis as any).WebSocket = originalWebSocket;
		}
	});

	it("keeps reconnect retries on the local capped exponential schedule", async () => {
		vi.useFakeTimers();
		const agent = new RemoteAgent();
		const reconnect = vi.fn().mockResolvedValue(undefined);
		(agent as any)._connectWs = reconnect;
		(agent as any)._reconnectAttempt = 2;
		(agent as any)._scheduleReconnect();

		await vi.advanceTimersByTimeAsync(3_999);
		expect(reconnect).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(reconnect).toHaveBeenCalledOnce();
		agent.disconnect();
	});

	it("keeps a human-visible starting state and retries SERVER_STARTING and SERVER_SATURATED frames before connecting", async () => {
		vi.useFakeTimers();
		const originalWebSocket = globalThis.WebSocket;
		const frames = [
			{ type: "error", code: "SERVER_STARTING", retryAfterMs: 250, message: "Gateway is starting. Retrying automatically…" },
			{ type: "error", code: "SERVER_SATURATED", retryAfterMs: 250, message: "Gateway is busy. Retrying automatically…" },
			{ type: "auth_ok" },
		];
		let sockets = 0;
		class MockWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			readyState = MockWebSocket.CONNECTING;
			onopen: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onclose: ((event: CloseEvent) => void) | null = null;
			constructor(_url: string) {
				sockets++;
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.onopen?.(new Event("open"));
				});
			}
			send(raw: string): void {
				if (JSON.parse(raw).type !== "auth") return;
				const frame = frames.shift();
				queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent));
			}
			close(): void {
				this.readyState = MockWebSocket.CLOSED;
				this.onclose?.({} as CloseEvent);
			}
		}
		(globalThis as any).WebSocket = MockWebSocket;
		const agent = new RemoteAgent();
		const states: string[] = [];
		agent.onConnectionStatusChange = state => states.push(state);
		try {
			const connected = agent.connect("https://gateway.test", "token", "session-1");
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(2_000);
			await connected;

			expect(sockets).toBe(3);
			expect(states).toContain("starting");
			expect(states.at(-1)).toBe("connected");
			expect((agent as any)._connectionStatus).toBe("connected");
		} finally {
			agent.disconnect();
			(globalThis as any).WebSocket = originalWebSocket;
		}
	});
});
