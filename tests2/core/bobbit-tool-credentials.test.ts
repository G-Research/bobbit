// v2-native — bobbit gateway tool suite. Listed in tests-map.json `v2Native`.
//
// Credential/URL resolution for the bobbit extension: env creds, state-file
// fallback, absent-creds (logs + no registration, no throw), and baseUrl
// trailing-slash trimming.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBobbitTools, stubFetch } from "./helpers/bobbit-harness.ts";

function clearCreds() {
	delete process.env.BOBBIT_TOKEN;
	delete process.env.BOBBIT_GATEWAY_URL;
	delete process.env.BOBBIT_DIR;
	delete process.env.BOBBIT_SESSION_SECRET;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("bobbit extension — credential resolution", () => {
	it("registers all three tools when env creds are present", () => {
		clearCreds();
		process.env.BOBBIT_TOKEN = "tok";
		process.env.BOBBIT_GATEWAY_URL = "https://gw.test";
		const tools = loadBobbitTools();
		expect([...tools.keys()].sort()).toEqual(["bobbit_admin", "bobbit_orchestrate", "bobbit_read"]);
	});

	it("falls back to state files when env creds are absent", () => {
		clearCreds();
		const dir = mkdtempSync(path.join(tmpdir(), "bobbit-creds-"));
		mkdirSync(path.join(dir, "state"), { recursive: true });
		writeFileSync(path.join(dir, "state", "token"), "file-token\n");
		writeFileSync(path.join(dir, "state", "gateway-url"), "https://gw.files\n");
		process.env.BOBBIT_DIR = dir;
		const tools = loadBobbitTools();
		expect(tools.size).toBe(3);
	});

	it("registers nothing and logs when creds cannot be resolved (no throw)", () => {
		clearCreds();
		const emptyDir = mkdtempSync(path.join(tmpdir(), "bobbit-nocreds-"));
		process.env.BOBBIT_DIR = emptyDir; // state/token does not exist
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		let tools: Map<string, unknown> | undefined;
		expect(() => {
			tools = loadBobbitTools();
		}).not.toThrow();
		expect(tools!.size).toBe(0);
		expect(errSpy).toHaveBeenCalledWith(
			"[bobbit-tools] Cannot read gateway credentials — tools not registered",
		);
	});

	it("trims trailing slashes from the gateway base URL", async () => {
		clearCreds();
		process.env.BOBBIT_TOKEN = "tok";
		process.env.BOBBIT_GATEWAY_URL = "https://gw.test///";
		const tools = loadBobbitTools();
		const calls = stubFetch();
		await tools.get("bobbit_read")!.execute("id", { operation: "health" });
		expect(calls[0].url).toBe("https://gw.test/api/health");
	});

	it("binds goal, task, gate, and settings mutations to the host-issued session secret", async () => {
		clearCreds();
		process.env.BOBBIT_TOKEN = "tok";
		process.env.BOBBIT_GATEWAY_URL = "https://gw.test";
		process.env.BOBBIT_SESSION_SECRET = "host-issued-secret";
		const tools = loadBobbitTools();
		const calls = stubFetch();
		for (const toolName of ["bobbit_orchestrate", "bobbit_admin"]) {
			const properties = tools.get(toolName)!.parameters?.properties ?? {};
			expect(properties).not.toHaveProperty("rootCorrelationId");
			expect(properties).not.toHaveProperty("causationDepth");
			expect(properties).not.toHaveProperty("correlationId");
		}
		const forgedControls = {
			rootCorrelationId: "caller-root",
			causationDepth: 999,
			correlationId: "caller-correlation",
		};

		await tools.get("bobbit_orchestrate")!.execute("id", {
			operation: "update_goal",
			goalId: "goal-1",
			body: { title: "Renamed" },
			...forgedControls,
		});
		await tools.get("bobbit_orchestrate")!.execute("id", {
			operation: "transition_task",
			taskId: "task-1",
			state: "complete",
			...forgedControls,
		});
		await tools.get("bobbit_orchestrate")!.execute("id", {
			operation: "signal_gate",
			goalId: "goal-1",
			gateId: "gate-1",
			body: { content: "ready" },
			...forgedControls,
		});
		await tools.get("bobbit_admin")!.execute("id", {
			operation: "update_project_config",
			projectId: "project-1",
			config: { sandbox: "docker" },
			...forgedControls,
		});

		expect(calls).toHaveLength(4);
		expect(calls.map((call) => call.body)).toEqual([
			{ title: "Renamed" },
			{ state: "complete" },
			{ content: "ready" },
			{ sandbox: "docker" },
		]);
		for (const call of calls) {
			expect(call.headers["X-Bobbit-Session-Secret"]).toBe("host-issued-secret");
			expect(call.headers).not.toHaveProperty("X-Bobbit-Correlation-Id");
			expect(call.headers).not.toHaveProperty("X-Bobbit-Causation-Depth");
			expect(call.headers).not.toHaveProperty("X-Bobbit-Causation-Root");
		}
	});

	it("preserves external no-secret requests without a session identity header", async () => {
		clearCreds();
		process.env.BOBBIT_TOKEN = "tok";
		process.env.BOBBIT_GATEWAY_URL = "https://gw.test";
		const tools = loadBobbitTools();
		const calls = stubFetch();

		await tools.get("bobbit_admin")!.execute("id", {
			operation: "update_project_config",
			projectId: "project-1",
			config: { sandbox: "docker" },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].headers).not.toHaveProperty("X-Bobbit-Session-Secret");
	});
});
