import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SessionManager } from "../../src/server/agent/session-manager.js";
import type { CommandRunner } from "../../src/server/gateway-deps.js";

type NetworkCreateOutcome = "created" | "already-exists";

type DockerCall = {
	file: string;
	args: string[];
};

function recordingRunner(createOutcome: NetworkCreateOutcome = "created"): {
	runner: CommandRunner;
	calls: DockerCall[];
} {
	const calls: DockerCall[] = [];
	const runner: CommandRunner = {
		async execFile(file, args) {
			calls.push({ file, args: [...args] });
			if (args[0] === "network" && args[1] === "create" && createOutcome === "already-exists") {
				throw Object.assign(new Error("network with name bobbit-sandbox-net already exists"), {
					stderr: "network with name bobbit-sandbox-net already exists",
				});
			}
			return { stdout: "", stderr: "" };
		},
	};
	return { runner, calls };
}

function managerWith(runner: CommandRunner): SessionManager {
	return new SessionManager({
		commandRunner: runner,
		// Avoid constructing unrelated durable stores; these lifecycle methods do
		// not consult project context.
		projectContextManager: {} as any,
	});
}

describe("SessionManager sandbox network ownership", () => {
	it("does not invoke Docker when cleanup runs before ensure", async () => {
		const { runner, calls } = recordingRunner();
		const manager = managerWith(runner);

		await manager.cleanupSandboxNetwork();

		assert.deepEqual(calls, [], "cleanup before ensure must not invoke Docker");
	});

	it("does not remove a network that another manager already created", async () => {
		const { runner, calls } = recordingRunner("already-exists");
		const manager = managerWith(runner);

		await manager.ensureSandboxNetwork();
		await manager.cleanupSandboxNetwork();

		assert.deepEqual(
			calls.map(({ args }) => args.slice(0, 2)),
			[["network", "create"]],
			"a manager that observes an existing network must not remove it",
		);
	});

	it("removes exactly once when this manager created the network", async () => {
		const { runner, calls } = recordingRunner();
		const manager = managerWith(runner);

		await manager.ensureSandboxNetwork();
		await manager.cleanupSandboxNetwork();

		assert.equal(
			calls.filter(({ args }) => args[0] === "network" && args[1] === "rm").length,
			1,
			"the creating manager must remove its network exactly once",
		);
	});
});
