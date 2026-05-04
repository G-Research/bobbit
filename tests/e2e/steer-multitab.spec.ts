import { test, expect } from "./in-process-harness.js";
import {
	createSession,
	deleteSession,
	connectWs,
	statusPredicate,
	queueLenPredicate,
} from "./e2e-setup.js";

test.setTimeout(60_000);

test.describe("Steer multi-tab convergence (AC §4)", () => {
	test("two clients converge under concurrent reorder + steer_queued", async () => {
		const sessionId = await createSession();
		const A = await connectWs(sessionId);
		const B = await connectWs(sessionId);
		try {
			await A.waitFor((m: any) => m.type === "queue_update");
			await B.waitFor((m: any) => m.type === "queue_update");
			A.send({ type: "prompt", text: "STAY_BUSY:3000 task" });
			await A.waitFor(statusPredicate("streaming"));
			A.send({ type: "prompt", text: "M1" });
			await A.waitFor(queueLenPredicate(1));
			A.send({ type: "prompt", text: "M2" });
			await A.waitFor(queueLenPredicate(2));
			A.send({ type: "prompt", text: "M3" });
			const q3 = await A.waitFor(queueLenPredicate(3));
			const m2Id = q3.queue!.find((m: any) => m.text === "M2")!.id;
			// Stale reorder from B + steer from A concurrently
			B.send({ type: "reorder_queue", messageIds: ["bogus-id-1", "bogus-id-2"] });
			A.send({ type: "steer_queued", messageId: m2Id });
			// Drive both clients to idle so each has received the full event stream.
			// Poll for steady-state convergence: latest queue_update on each client
			// is empty and status is idle. Up to 30 s wall-time for the agent to
			// drain M1/M2/M3 sequentially.
			const latestQueueLen = (msgs: any[]): number => {
				const last = [...msgs].reverse().find((m) => m.type === "queue_update");
				return last?.queue?.length ?? -1;
			};
			const latestStatus = (msgs: any[]): string | undefined => {
				const last = [...msgs].reverse().find((m) => m.type === "session_status");
				return last?.status;
			};
			await expect.poll(
				() =>
					latestStatus(A.messages) === "idle" &&
					latestStatus(B.messages) === "idle" &&
					latestQueueLen(A.messages) === 0 &&
					latestQueueLen(B.messages) === 0,
				{ timeout: 30_000, intervals: [200, 500, 1000] },
			).toBe(true);
			expect(latestQueueLen(A.messages)).toBe(latestQueueLen(B.messages));
			// Each of M1/M2/M3 appears as a user message exactly once on A.
			for (const text of ["M1", "M2", "M3"]) {
				const userMsgs = A.messages.filter(
					(m: any) =>
						m.type === "event" &&
						m.data?.type === "message_end" &&
						m.data?.message?.role === "user" &&
						((m.data?.message?.content?.[0]?.text) || "").includes(text),
				);
				expect(userMsgs.length, `${text} should appear exactly once`).toBe(1);
			}
		} finally {
			A.close();
			B.close();
			await deleteSession(sessionId);
		}
	});
});
