import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SessionManager } from "../../../src/server/agent/session-manager.js";
import type { CommandRunner } from "../../../src/server/gateway-deps.js";

type NetworkCreateOutcome = "created" | "already-exists";
type NetworkRemoveOutcome = "removed" | "failed";

type DockerCall = {
	file: string;
	args: string[];
};

type RecordingRunnerOptions = {
	createOutcomes?: NetworkCreateOutcome[];
	removeOutcome?: NetworkRemoveOutcome;
};

function recordingRunner(options: RecordingRunnerOptions = {}): {
	runner: CommandRunner;
	calls: DockerCall[];
} {
	const calls: DockerCall[] = [];
	const createOutcomes = options.createOutcomes ?? ["created"];
	let createCallIndex = 0;
	const runner: CommandRunner = {
		async execFile(file, args) {
			calls.push({ file, args: [...args] });
			if (args[0] === "network" && args[1] === "create") {
				const outcome = createOutcomes[createCallIndex++] ?? createOutcomes.at(-1) ?? "created";
				if (outcome === "already-exists") {
					throw Object.assign(new Error("network with name bobbit-sandbox-net already exists"), {
						stderr: "network with name bobbit-sandbox-net already exists",
					});
				}
			}
			if (args[0] === "network" && args[1] === "rm" && options.removeOutcome === "failed") {
				throw new Error("network has active endpoints");
			}
			return { stdout: "", stderr: "" };
		},
	};
	return { runner, calls };
}

function networkOperations(calls: DockerCall[]): string[] {
	return calls.map(({ args }) => args.slice(0, 2).join(" "));
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
		const { runner, calls } = recordingRunner({ createOutcomes: ["already-exists"] });
		const manager = managerWith(runner);

		await manager.ensureSandboxNetwork();
		await manager.cleanupSandboxNetwork();

		assert.deepEqual(
			networkOperations(calls),
			["network create"],
			"a manager that observes an existing network must not remove it",
		);
	});

	it("removes exactly once across repeated sequential cleanup", async () => {
		const { runner, calls } = recordingRunner();
		const manager = managerWith(runner);

		await manager.ensureSandboxNetwork();
		await manager.cleanupSandboxNetwork();
		await manager.cleanupSandboxNetwork();

		assert.deepEqual(networkOperations(calls), ["network create", "network rm"]);
	});

	it("removes exactly once across concurrent cleanup", async () => {
		const { runner, calls } = recordingRunner();
		const manager = managerWith(runner);

		await manager.ensureSandboxNetwork();
		await Promise.all([
			manager.cleanupSandboxNetwork(),
			manager.cleanupSandboxNetwork(),
			manager.cleanupSandboxNetwork(),
		]);

		assert.deepEqual(networkOperations(calls), ["network create", "network rm"]);
	});

	it("preserves creation ownership across repeated ensure calls", async () => {
		const { runner, calls } = recordingRunner({ createOutcomes: ["created", "already-exists"] });
		const manager = managerWith(runner);

		await manager.ensureSandboxNetwork();
		await manager.ensureSandboxNetwork();
		await manager.cleanupSandboxNetwork();

		assert.deepEqual(
			networkOperations(calls),
			["network create", "network create", "network rm"],
		);
	});

	it("can reacquire ownership after cleanup consumes the previous grant", async () => {
		const { runner, calls } = recordingRunner({ createOutcomes: ["created", "created"] });
		const manager = managerWith(runner);

		await manager.ensureSandboxNetwork();
		await manager.cleanupSandboxNetwork();
		await manager.ensureSandboxNetwork();
		await manager.cleanupSandboxNetwork();

		assert.deepEqual(
			networkOperations(calls),
			["network create", "network rm", "network create", "network rm"],
		);
	});

	it("only lets the creating manager remove a shared network", async () => {
		const { runner, calls } = recordingRunner({ createOutcomes: ["created", "already-exists"] });
		const creator = managerWith(runner);
		const observer = managerWith(runner);

		await creator.ensureSandboxNetwork();
		await observer.ensureSandboxNetwork();
		await observer.cleanupSandboxNetwork();
		await creator.cleanupSandboxNetwork();

		assert.deepEqual(
			networkOperations(calls),
			["network create", "network create", "network rm"],
		);
	});

	it("consumes ownership after a non-fatal removal failure", async () => {
		const { runner, calls } = recordingRunner({ removeOutcome: "failed" });
		const manager = managerWith(runner);

		await manager.ensureSandboxNetwork();
		await manager.cleanupSandboxNetwork();
		await manager.cleanupSandboxNetwork();

		assert.deepEqual(networkOperations(calls), ["network create", "network rm"]);
	});
});
