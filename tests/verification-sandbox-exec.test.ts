/**
 * Unit tests for sandbox verification command execution.
 *
 * Tests that `runCommandStep` in VerificationHarness:
 * 1. Uses `docker exec` when a containerId is provided (sandboxed goal)
 * 2. Falls back to host shell when sandboxed but no container available
 * 3. Uses host shell as normal for non-sandboxed goals
 *
 * Also tests the call-site container resolution logic in verifyGateSignal,
 * which now uses SandboxManager → ProjectSandbox.getContainerId() instead
 * of looking up the team lead session's containerId.
 */
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated temp dir for harness persistence
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-sandbox-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });
process.env.BOBBIT_DIR = TEST_DIR;

const { VerificationHarness } = await import("../dist/server/agent/verification-harness.js");

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockGateStore() {
	return {
		getGate: () => ({ signals: [] }),
		updateSignalVerification: mock.fn(() => {}),
		updateGateStatus: mock.fn(() => {}),
	};
}

function createMockGoalStore(opts: { sandboxed?: boolean; branch?: string } = {}) {
	return {
		get: (_id: string) => ({
			id: _id,
			sandboxed: opts.sandboxed ?? false,
			branch: opts.branch,
			enabledOptionalSteps: [],
		}),
	};
}

function createMockProjectContextManager(opts: { sandboxed?: boolean; projectId?: string; branch?: string } = {}) {
	const gateStore = createMockGateStore();
	const goalStore = createMockGoalStore(opts);
	const pId = opts.projectId ?? "test-project-id";
	return {
		getContextForGoal: (_goalId: string) => ({
			goalStore,
			gateStore,
			project: { id: pId },
		}),
		_gateStore: gateStore,
		_goalStore: goalStore,
		_projectId: pId,
	};
}

function createMockTeamManager(opts: { teamLeadSessionId?: string } = {}) {
	return {
		getTeamState: (_goalId: string) =>
			opts.teamLeadSessionId
				? { teamLeadSessionId: opts.teamLeadSessionId, agents: [], maxConcurrent: 3 }
				: undefined,
		unregisterReviewerSession: mock.fn(async () => {}),
	};
}

/**
 * Create a mock SandboxManager that returns a ProjectSandbox with the given containerId.
 */
function createMockSandboxManager(opts: { containerId?: string; projectId?: string } = {}) {
	const pId = opts.projectId ?? "test-project-id";
	const projectSandbox = opts.containerId
		? {
			getContainerId: async () => opts.containerId!,
			getStatus: () => ({ containerId: opts.containerId, status: "ready", projectId: pId }),
		}
		: undefined;

	return {
		get: (requestedProjectId: string) =>
			requestedProjectId === pId ? projectSandbox : undefined,
	};
}

function createMockSessionManager(opts: {
	containerId?: string;
	projectId?: string;
} = {}) {
	const sandboxMgr = createMockSandboxManager(opts);
	return {
		getSandboxManager: () => sandboxMgr,
		terminateSession: mock.fn(async () => true),
	};
}

function createMockRoleStore() {
	return {
		get: () => null,
		getAll: () => [],
	};
}

function createHarness(opts: {
	sandboxed?: boolean;
	teamLeadSessionId?: string;
	containerId?: string;
	projectId?: string;
	branch?: string;
} = {}) {
	const broadcastCalls: Array<{ goalId: string; event: any }> = [];
	const broadcastFn = (goalId: string, event: any) => {
		broadcastCalls.push({ goalId, event });
	};

	const pId = opts.projectId ?? "test-project-id";
	const pcm = createMockProjectContextManager({ sandboxed: opts.sandboxed, projectId: pId, branch: opts.branch });

	const harness = new VerificationHarness(
		path.join(TEST_DIR, "state"),
		pcm._gateStore as any, // fallback gateStore
		broadcastFn,
		createMockRoleStore() as any,
		undefined, // preferencesStore
		createMockSessionManager({
			containerId: opts.containerId,
			projectId: pId,
		}) as any,
		createMockTeamManager({
			teamLeadSessionId: opts.teamLeadSessionId,
		}) as any,
		undefined, // projectConfigStore
		pcm as any,
	);

	return { harness, broadcastCalls, pcm };
}

// ---------------------------------------------------------------------------
// Tests: runCommandStep spawn behavior (direct private method invocation)
// ---------------------------------------------------------------------------

describe("runCommandStep spawn behavior", () => {
	it("runs on host shell when no containerId is provided", async () => {
		const { harness } = createHarness();
		const result = await (harness as any).runCommandStep(
			"echo host-shell-test-marker",
			os.tmpdir(),
			10,
			false,
			undefined,
			undefined,
			undefined, // no containerId
		);
		assert.ok(result.passed, `Expected command to pass, got: ${result.output}`);
		assert.ok(
			result.output.includes("host-shell-test-marker"),
			`Expected output to contain marker, got: ${result.output}`,
		);
	});

	it("spawns docker exec when containerId is provided", async () => {
		const { harness } = createHarness();
		const result = await (harness as any).runCommandStep(
			"echo docker-test",
			os.tmpdir(),
			10,
			false,
			undefined,
			undefined,
			"nonexistent-container-abc123", // containerId
		);
		// docker exec will fail — either Docker not installed (ENOENT) or container not found
		assert.ok(!result.passed, "Expected command to fail with nonexistent container");
		// On systems with Docker: error about container
		// On systems without Docker: ENOENT or "not found"
		assert.ok(result.output.length > 0, "Should have some error output");
	});

	it("streams output via broadcastFn for docker exec path", async () => {
		const { harness, broadcastCalls } = createHarness();
		const streamCtx = {
			goalId: "goal-1",
			gateId: "gate-1",
			signalId: "sig-1",
			stepIndex: 0,
		};
		await (harness as any).runCommandStep(
			"echo streamed-marker",
			os.tmpdir(),
			10,
			false,
			streamCtx,
			undefined,
			undefined, // host path — more reliable for streaming test
		);
		// Should have broadcast stdout data
		const outputEvents = broadcastCalls.filter(
			c => c.event.type === "gate_verification_step_output" && c.event.stream === "stdout",
		);
		assert.ok(outputEvents.length > 0, "Should broadcast stdout output");
		const allText = outputEvents.map(e => e.event.text).join("");
		assert.ok(allText.includes("streamed-marker"), `Expected streamed output to include marker, got: ${allText}`);
	});
});

// ---------------------------------------------------------------------------
// Tests: Container resolution via SandboxManager → ProjectSandbox
// ---------------------------------------------------------------------------

describe("container resolution in verifyGateSignal", () => {
	// Capture the containerId and cwd arguments passed to runCommandStep by patching the prototype
	let capturedContainerIds: Array<string | undefined>;
	let capturedCwds: Array<string>;
	let originalRunCommandStep: any;

	beforeEach(() => {
		capturedContainerIds = [];
		capturedCwds = [];
		originalRunCommandStep = (VerificationHarness.prototype as any).runCommandStep;
		(VerificationHarness.prototype as any).runCommandStep = function (
			_command: string,
			_cwd: string,
			_timeout: number,
			_expectFailure: boolean,
			_streamCtx: any,
			_errorPattern: any,
			containerId?: string,
		) {
			capturedContainerIds.push(containerId);
			capturedCwds.push(_cwd);
			return Promise.resolve({ passed: true, output: "mocked-ok" });
		};
	});

	afterEach(() => {
		(VerificationHarness.prototype as any).runCommandStep = originalRunCommandStep;
	});

	function makeSignal(goalId: string, gateId: string) {
		return {
			id: `signal-${Date.now()}`,
			goalId,
			gateId,
			content: "test content",
			metadata: {},
			createdAt: Date.now(),
		};
	}

	function makeGate(gateId: string): any {
		return {
			id: gateId,
			name: gateId,
			dependsOn: [],
			verify: [
				{
					name: "test-command",
					type: "command",
					run: "echo test",
					phase: 0,
				},
			],
		};
	}

	it("passes containerId and container worktree cwd when goal is sandboxed", async () => {
		const goalId = "goal-sandbox-1";
		const { harness } = createHarness({
			sandboxed: true,
			containerId: "docker-container-abc",
			branch: "goal/my-feature",
		});
		const signal = makeSignal(goalId, "test-gate");
		const gate = makeGate("test-gate");

		await harness.verifyGateSignal(signal, gate, os.tmpdir());

		assert.equal(capturedContainerIds.length, 1, "runCommandStep should be called once");
		assert.equal(
			capturedContainerIds[0],
			"docker-container-abc",
			"Should pass the project container's containerId",
		);
		assert.equal(
			capturedCwds[0],
			"/workspace-wt/goal/my-feature",
			"Should use the container worktree path, not the host cwd",
		);
	});

	it("falls back to /workspace when sandboxed goal has no branch", async () => {
		const goalId = "goal-sandbox-no-branch";
		const { harness } = createHarness({
			sandboxed: true,
			containerId: "docker-container-abc",
			// No branch specified
		});
		const signal = makeSignal(goalId, "test-gate");
		const gate = makeGate("test-gate");

		await harness.verifyGateSignal(signal, gate, os.tmpdir());

		assert.equal(capturedContainerIds[0], "docker-container-abc");
		assert.equal(capturedCwds[0], "/workspace", "Should fall back to /workspace when no branch");
	});

	it("falls back to host execution when sandboxed but no ProjectSandbox available", async () => {
		const goalId = "goal-sandbox-no-container";
		const { harness, broadcastCalls } = createHarness({
			sandboxed: true,
			// No containerId — ProjectSandbox not available for this project
		});
		const signal = makeSignal(goalId, "test-gate");
		const gate = makeGate("test-gate");

		// Capture console.warn
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: any[]) => { warnings.push(args.join(" ")); };

		try {
			await harness.verifyGateSignal(signal, gate, os.tmpdir());
		} finally {
			console.warn = originalWarn;
		}

		assert.equal(capturedContainerIds.length, 1, "runCommandStep should be called once");
		assert.equal(
			capturedContainerIds[0],
			undefined,
			"Should NOT pass containerId (fallback to host)",
		);

		// Verify warning was emitted
		const warnMsg = warnings.find(w => w.includes("no project container found") || w.includes("falling back to host"));
		assert.ok(warnMsg, `Expected a console.warn about missing container, got: ${JSON.stringify(warnings)}`);

		// Verify warning was broadcast via step output stream
		const stderrEvents = broadcastCalls.filter(
			c => c.event.type === "gate_verification_step_output" && c.event.stream === "stderr",
		);
		const warningBroadcast = stderrEvents.find(e =>
			e.event.text.includes("no project container found") || e.event.text.includes("falling back to host"),
		);
		assert.ok(warningBroadcast, "Warning should be broadcast as stderr output");
	});

	it("does not attempt docker exec for non-sandboxed goals", async () => {
		const goalId = "goal-non-sandbox";
		const { harness, broadcastCalls } = createHarness({
			sandboxed: false,
			containerId: "docker-container-xyz", // container exists but goal is not sandboxed
		});
		const signal = makeSignal(goalId, "test-gate");
		const gate = makeGate("test-gate");

		await harness.verifyGateSignal(signal, gate, os.tmpdir());

		assert.equal(capturedContainerIds.length, 1, "runCommandStep should be called once");
		assert.equal(
			capturedContainerIds[0],
			undefined,
			"Should NOT pass containerId for non-sandboxed goal",
		);

		// Should NOT have any sandbox-related warnings in broadcast
		const stderrEvents = broadcastCalls.filter(
			c => c.event.type === "gate_verification_step_output" && c.event.stream === "stderr",
		);
		const sandboxWarning = stderrEvents.find(e =>
			e.event.text.includes("Sandboxed goal"),
		);
		assert.equal(sandboxWarning, undefined, "Should not emit sandbox warnings for non-sandboxed goal");
	});
});

// Cleanup
import { after } from "node:test";
after(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
