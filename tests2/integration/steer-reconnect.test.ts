import { test, expect } from "./_e2e/in-process-harness.js";
import { createSession, deleteSession, connectWs, statusPredicate } from "./_e2e/e2e-setup.js";

function injectAgentClock(gateway: any, sessionId: string): void {
	const session = gateway.sessionManager.getSession(sessionId);
	const bridge = session?.rpcClient;
	if (typeof bridge?.setSleep !== "function") throw new Error("in-process mock bridge does not support injected sleep");
	bridge.setSleep((ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
		let settled = false;
		let timer: any;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) gateway.clock.clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		if (signal?.aborted) {
			finish();
			return;
		}
		timer = gateway.clock.setTimeout(finish, Math.max(0, ms));
		signal?.addEventListener("abort", finish, { once: true });
	}));
}

async function advanceUntilSettled<T>(clock: any, promise: Promise<T>, maxVirtualMs: number): Promise<T> {
	let settled = false;
	let value: T | undefined;
	let failure: unknown;
	void promise.then(
		(result) => { settled = true; value = result; },
		(error) => { settled = true; failure = error; },
	);
	for (let advanced = 0; !settled && advanced < maxVirtualMs; advanced += 100) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		clock.advance(Math.min(100, maxVirtualMs - advanced));
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
	if (failure) throw failure;
	if (!settled) throw new Error(`condition did not settle after advancing virtual clock ${maxVirtualMs}ms`);
	return value as T;
}

test.setTimeout(30_000);

test.describe("Steer + WS reconnect (AC §2)", () => {
	test("steer survives WS reconnect mid-flight without duplication", async ({ gateway }) => {
		const sessionId = await createSession();
		injectAgentClock(gateway, sessionId);
		let conn = await connectWs(sessionId);
		try {
			await conn.waitFor((m) => m.type === "queue_update");
			conn.send({ type: "prompt", text: "STAY_BUSY:5000 long task" });
			await advanceUntilSettled(gateway.clock, conn.waitFor(statusPredicate("streaming")), 1_000);
			conn.send({ type: "steer", text: "RECONNECT_STEER_TEXT" });
			// Wait for the server to ack the steer via a queue_update before closing
			// the WS, so the steer is guaranteed to have been processed server-side.
			await conn.waitFor(
				(m) =>
					(m.type === "queue_update" && (m.queue || []).some((q: any) => q.isSteered)) ||
					(m.type === "event" &&
						m.data?.type === "message_end" &&
						m.data?.message?.role === "user" &&
						((m.data?.message?.content?.[0]?.text) || "").includes("RECONNECT_STEER_TEXT")),
				5000,
			);
			conn.close();
			conn = await connectWs(sessionId);
			await conn.waitFor((m) => m.type === "queue_update", 5000);
			await advanceUntilSettled(gateway.clock, conn.waitFor(statusPredicate("idle"), 5000), 6_000);

			// Assert on the DURABLE transcript, not a live broadcast. Counting live
			// `message_end` frames on the reconnected socket is racy: under load the
			// steered turn can be echoed during the close→reconnect gap. Reaching idle
			// guarantees the virtual-time turn has committed before this snapshot.
			const cursor = conn.messageCount();
			conn.send({ type: "get_messages" });
			const resp = await conn.waitForFrom(cursor, (m) => m.type === "messages", 10_000);
			const messages = Array.isArray((resp as any).data)
				? (resp as any).data
				: ((resp as any).data?.messages || []);
			const count = messages
				.filter((m: any) => m.role === "user")
				.reduce(
					(n: number, m: any) => n + (String(m.content?.[0]?.text || "").split("RECONNECT_STEER_TEXT").length - 1),
					0,
				);
			expect(count).toBe(1);
		} finally {
			conn.close();
			await deleteSession(sessionId);
		}
	});
});
