import { beforeAll } from "vitest";
import { syncCustomElements } from "./_setup/custom-elements.ts";
beforeAll(() => syncCustomElements());

import { afterEach, describe, expect, it } from "vitest";
import { RemoteAgent } from "../../src/app/remote-agent.ts";
import { state } from "../../src/app/state.ts";

afterEach(() => {
	state.gatewaySessions = [];
	state.archivedSessions = [];
});

describe("RemoteAgent runtime status protocol", () => {
	it("applies explicit runtime identity independently of status-version dedupe", async () => {
		const agent = new RemoteAgent();
		(agent as any)._sessionId = "runtime-session";
		state.gatewaySessions = [{ id: "runtime-session", title: "Runtime", cwd: ".", status: "idle", createdAt: 0, lastActivity: 0, clientCount: 0 }];

		await (agent as any).handleServerMessage({
			type: "session_status",
			status: "streaming",
			statusVersion: 2,
			runtime: "claude-agent-sdk",
		});
		// A heartbeat must not reapply status, but its explicit runtime identity is
		// still accepted so status ordering cannot suppress runtime hydration.
		await (agent as any).handleServerMessage({
			type: "session_status",
			status: "idle",
			statusVersion: 2,
			runtime: "claude-agent-sdk",
		});

		expect(agent.state.status).toBe("streaming");
		expect((agent.state as any).runtime).toBe("claude-agent-sdk");
		expect(state.gatewaySessions[0].runtime).toBe("claude-agent-sdk");
	});

	it("accepts model availability only from a server state projection", async () => {
		const agent = new RemoteAgent();
		(agent as any)._sessionId = "archived-runtime";
		state.archivedSessions = [{ id: "archived-runtime", title: "Archived", cwd: ".", status: "archived", archived: true, createdAt: 0, lastActivity: 0, clientCount: 0 }];

		await (agent as any).handleServerMessage({
			type: "state",
			data: { archived: true, status: "archived", statusVersion: 0, runtime: "claude-agent-sdk", modelAvailable: false },
		});

		expect((agent.state as any).runtime).toBe("claude-agent-sdk");
		expect((agent.state as any).modelAvailable).toBe(false);
		expect(state.archivedSessions[0]).toMatchObject({ runtime: "claude-agent-sdk", modelAvailable: false });
	});
});
