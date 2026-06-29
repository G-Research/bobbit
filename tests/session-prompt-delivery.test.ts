import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { deliverSessionPrompt } = await import("../src/server/agent/session-prompt-delivery.ts");

type Call = { sessionId: string; message: string; opts?: Record<string, unknown> };

type MockSession = {
	id: string;
	status: string;
	nonInteractive?: boolean;
};

function session(overrides: Partial<MockSession> = {}): MockSession {
	return {
		id: "sess-1",
		status: "idle",
		...overrides,
	};
}

function deps(target?: MockSession) {
	const enqueueCalls: Call[] = [];
	const liveSteerCalls: Call[] = [];
	return {
		enqueueCalls,
		liveSteerCalls,
		api: {
			getSession(id: string) {
				return target && target.id === id ? target : undefined;
			},
			async enqueuePrompt(sessionId: string, message: string, opts?: Record<string, unknown>) {
				enqueueCalls.push({ sessionId, message, opts });
				return { status: "queued" as const };
			},
			async deliverLiveSteer(sessionId: string, message: string, opts?: Record<string, unknown>) {
				liveSteerCalls.push({ sessionId, message, opts });
				return { ok: true };
			},
		},
	};
}

function assertRejectsWithMessage(fn: () => Promise<unknown>, pattern: RegExp) {
	return assert.rejects(fn, (err) => {
		assert.ok(err instanceof Error, "expected an Error rejection");
		assert.match(err.message, pattern);
		return true;
	});
}

describe("deliverSessionPrompt", () => {
	it("prompt mode on an idle session enqueues a normal prompt without isSteered", async () => {
		const mock = deps(session({ status: "idle" }));

		const result = await deliverSessionPrompt(mock.api, "sess-1", "hello", {
			mode: "prompt",
			defaultMode: "steer",
			source: "agent",
		});

		assert.equal(result.ok, true);
		assert.equal(result.mode, "prompt");
		assert.equal(result.status, "queued");
		assert.deepEqual(mock.liveSteerCalls, []);
		assert.equal(mock.enqueueCalls.length, 1);
		assert.equal(mock.enqueueCalls[0].sessionId, "sess-1");
		assert.equal(mock.enqueueCalls[0].message, "hello");
		assert.equal(mock.enqueueCalls[0].opts?.source, "agent");
		assert.equal(mock.enqueueCalls[0].opts?.isSteered, undefined);
	});

	it("defaults to the supplied defaultMode", async () => {
		const mock = deps(session({ status: "idle" }));

		const result = await deliverSessionPrompt(mock.api, "sess-1", "nudge", {
			defaultMode: "steer",
		});

		assert.equal(result.mode, "steer");
		assert.equal(mock.enqueueCalls.length, 1);
		assert.equal(mock.enqueueCalls[0].opts?.isSteered, true);
	});

	it("steer mode on a streaming session uses the live-steer path", async () => {
		const mock = deps(session({ status: "streaming" }));

		const result = await deliverSessionPrompt(mock.api, "sess-1", "redirect now", {
			mode: "steer",
			defaultMode: "prompt",
			source: "agent",
		});

		assert.equal(result.ok, true);
		assert.equal(result.mode, "steer");
		assert.equal(result.dispatched, true);
		assert.deepEqual(mock.enqueueCalls, []);
		assert.deepEqual(mock.liveSteerCalls, [
			{ sessionId: "sess-1", message: "redirect now", opts: { source: "agent" } },
		]);
	});

	it("steer mode on an idle session enqueues a steered prompt", async () => {
		const mock = deps(session({ status: "idle" }));

		const result = await deliverSessionPrompt(mock.api, "sess-1", "next steer", {
			mode: "steer",
			defaultMode: "prompt",
		});

		assert.equal(result.ok, true);
		assert.equal(result.mode, "steer");
		assert.equal(result.status, "queued");
		assert.deepEqual(mock.liveSteerCalls, []);
		assert.equal(mock.enqueueCalls.length, 1);
		assert.equal(mock.enqueueCalls[0].sessionId, "sess-1");
		assert.equal(mock.enqueueCalls[0].message, "next steer");
		assert.equal(mock.enqueueCalls[0].opts?.isSteered, true);
	});

	it("rejects missing target sessions", async () => {
		const mock = deps(undefined);

		await assertRejectsWithMessage(
			() => deliverSessionPrompt(mock.api, "missing", "hello", { defaultMode: "prompt" }),
			/live|target|session|not found|missing/i,
		);
		assert.deepEqual(mock.enqueueCalls, []);
		assert.deepEqual(mock.liveSteerCalls, []);
	});

	it("rejects terminated target sessions", async () => {
		const mock = deps(session({ status: "terminated" }));

		await assertRejectsWithMessage(
			() => deliverSessionPrompt(mock.api, "sess-1", "hello", { defaultMode: "prompt" }),
			/terminated|archived|not live/i,
		);
		assert.deepEqual(mock.enqueueCalls, []);
		assert.deepEqual(mock.liveSteerCalls, []);
	});

	it("rejects normal prompts to non-interactive sessions by default", async () => {
		const mock = deps(session({ status: "idle", nonInteractive: true }));

		await assertRejectsWithMessage(
			() => deliverSessionPrompt(mock.api, "sess-1", "start work", { mode: "prompt", defaultMode: "prompt" }),
			/non[- ]?interactive|reviewer|normal prompt/i,
		);
		assert.deepEqual(mock.enqueueCalls, []);
		assert.deepEqual(mock.liveSteerCalls, []);
	});

	it("allows prompt mode for non-interactive sessions when explicitly requested by a scoped caller", async () => {
		const mock = deps(session({ status: "idle", nonInteractive: true }));

		const result = await deliverSessionPrompt(mock.api, "sess-1", "scoped prompt", {
			mode: "prompt",
			defaultMode: "prompt",
			allowPromptNonInteractive: true,
		});

		assert.equal(result.mode, "prompt");
		assert.equal(mock.enqueueCalls.length, 1);
		assert.equal(mock.enqueueCalls[0].opts?.isSteered, undefined);
		assert.deepEqual(mock.liveSteerCalls, []);
	});

	it("allows steer mode to redirect a streaming non-interactive session", async () => {
		const mock = deps(session({ status: "streaming", nonInteractive: true }));

		const result = await deliverSessionPrompt(mock.api, "sess-1", "review redirect", {
			mode: "steer",
			defaultMode: "prompt",
		});

		assert.equal(result.ok, true);
		assert.equal(result.mode, "steer");
		assert.equal(result.dispatched, true);
		assert.deepEqual(mock.enqueueCalls, []);
		assert.equal(mock.liveSteerCalls.length, 1);
		assert.equal(mock.liveSteerCalls[0].sessionId, "sess-1");
		assert.equal(mock.liveSteerCalls[0].message, "review redirect");
	});
});
