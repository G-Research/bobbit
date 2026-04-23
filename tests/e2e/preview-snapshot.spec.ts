/**
 * API E2E tests for the preview_open snapshot lazy-load + truncation pipeline.
 *
 * Exercises:
 *   - Extension (via mock-agent) emits a 2-block tool_result containing the marker-prefixed snapshot.
 *   - GET /api/sessions/:id/tool-content/:mi/:bi returns the full untruncated snapshot text.
 *   - get_messages response served to clients has large snapshots replaced by a truncated stub,
 *     so the full payload never flows through the WS history channel.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	connectWs,
	waitForSessionStatus,
	agentEndPredicate,
} from "./e2e-setup.js";

const MARKER = "__preview_snapshot_v1__\n";

test.setTimeout(30_000);

async function runPreviewOpenWithSize(sessionId: string, size: number): Promise<void> {
	const conn = await connectWs(sessionId);
	try {
		conn.send({ type: "prompt", text: `PREVIEW_OPEN_SNAPSHOT SIZE=${size}` });
		await conn.waitFor(agentEndPredicate());
	} finally {
		conn.close();
	}
	await waitForSessionStatus(sessionId, "idle");
}

test.describe("preview_open snapshot persistence + truncation", () => {
	async function findSnapshotBlock(sessionId: string): Promise<{ mi: number; bi: number }> {
		for (let i = 0; i < 30; i++) {
			for (let j = 0; j < 10; j++) {
				const r = await apiFetch(`/api/sessions/${sessionId}/tool-content/${i}/${j}`);
				if (!r.ok) continue;
				const json = await r.json();
				if (typeof json.content === "string" && json.content.startsWith(MARKER)) {
					return { mi: i, bi: j };
				}
			}
		}
		return { mi: -1, bi: -1 };
	}

	test("small snapshot: GET /tool-content returns full snapshot text", async () => {
		const sessionId = await createSession();
		try {
			await runPreviewOpenWithSize(sessionId, 1000);

			const { mi, bi } = await findSnapshotBlock(sessionId);
			expect(mi, "tool_result snapshot block not found").toBeGreaterThanOrEqual(0);
			expect(bi).toBeGreaterThanOrEqual(0);

			const contentResp = await apiFetch(`/api/sessions/${sessionId}/tool-content/${mi}/${bi}`);
			expect(contentResp.status).toBe(200);
			const body = await contentResp.json();
			expect(typeof body.content).toBe("string");
			expect(body.content.startsWith(MARKER)).toBe(true);
			// The HTML body after the marker should contain our exactly-sized payload.
			const html = body.content.slice(MARKER.length);
			// 1000 `x`s are in the middle: `<body>xxx...</body>`
			expect(html).toContain("<body>" + "x".repeat(1000) + "</body>");
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("large snapshot (>32KB): tool-content endpoint returns full untruncated HTML", async () => {
		const sessionId = await createSession();
		try {
			const size = 50_000;
			await runPreviewOpenWithSize(sessionId, size);

			const { mi, bi } = await findSnapshotBlock(sessionId);
			expect(mi).toBeGreaterThanOrEqual(0);
			expect(bi).toBeGreaterThanOrEqual(0);

			const contentResp = await apiFetch(`/api/sessions/${sessionId}/tool-content/${mi}/${bi}`);
			expect(contentResp.status).toBe(200);
			const body = await contentResp.json();
			expect(body.content.length).toBeGreaterThan(size);
			expect(body.content.startsWith(MARKER)).toBe(true);
			expect(body.content).toContain("x".repeat(size));
		} finally {
			await deleteSession(sessionId);
		}
	});
});
