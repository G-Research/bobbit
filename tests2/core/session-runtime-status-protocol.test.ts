import { describe, expect, it } from "vitest";
import { broadcastStatus, buildSessionStatusFrame } from "../../src/server/agent/session-status.ts";

describe("session runtime status protocol", () => {
	it("derives runtime for transition frames from the server-owned session identity", () => {
		const sent: unknown[] = [];
		const session: any = {
			status: "idle",
			statusVersion: 4,
			runtime: "claude-agent-sdk",
			clients: new Set([{ readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) }]),
		};

		broadcastStatus(session, "streaming", { streamingStartedAt: 123 });

		expect(sent).toEqual([{
			type: "session_status",
			status: "streaming",
			statusVersion: 5,
			runtime: "claude-agent-sdk",
			streamingStartedAt: 123,
		}]);
	});

	it("projects an archived or heartbeat status with its persisted provider runtime", () => {
		const frame = buildSessionStatusFrame({
			status: "archived",
			statusVersion: 9,
			modelProvider: "claude-agent-sdk",
			clients: new Set(),
		});

		expect(frame).toMatchObject({
			type: "session_status",
			status: "archived",
			statusVersion: 9,
			runtime: "claude-agent-sdk",
		});
	});
});
