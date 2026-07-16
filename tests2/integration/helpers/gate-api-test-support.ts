import { EventEmitter } from "node:events";
import type { VerificationCommandRunner, VerificationCommandSpawnSpec } from "../../../src/server/agent/verification-command-runner.js";
import type { TrackedChild } from "../../../src/server/agent/spawn-tree.js";
import type { ManualClock } from "../../harness/clock.js";
import { interpretFakeCommand } from "../../harness/fake-verification-command-runner.js";
import { test } from "../_e2e/in-process-harness.js";
import { apiFetch, ensureGateway, type WsConnection } from "../_e2e/e2e-setup.js";

// Ensure a gateway booted after this module is collected gets the non-spawning
// runner. The hooks below also replace the runner on an already-booted gateway,
// so collection/import order cannot select the production process runner.
(globalThis as { __BOBBIT_V2_FAKE_CMD_STEP__?: boolean }).__BOBBIT_V2_FAKE_CMD_STEP__ = true;

class FakeChild extends EventEmitter {
	readonly stdout = Object.assign(new EventEmitter(), { destroy() {} });
	readonly stderr = Object.assign(new EventEmitter(), { destroy() {} });
	readonly pid: number;

	constructor(pid: number) {
		super();
		this.pid = pid;
	}

	unref(): void {}
	kill(): boolean { return true; }
}

interface ResettableVerificationRunner extends VerificationCommandRunner {
	reset(): void;
}

let fakePid = 950_000;

function createManualVerificationRunner(clock: ManualClock): ResettableVerificationRunner {
	const live = new Set<TrackedChild>();

	const runner: ResettableVerificationRunner = {
		nonDurable: true,
		spawn(spec: VerificationCommandSpawnSpec): TrackedChild {
			const child = new FakeChild(++fakePid);
			const scripted = interpretFakeCommand(spec.command);
			let closed = false;
			let killed = false;
			let timedOut = false;
			let completionTimer: ReturnType<ManualClock["setTimeout"]> | undefined;
			let timeoutTimer: ReturnType<ManualClock["setTimeout"]> | undefined;

			const emitOutput = (): void => {
				if (scripted.initialStdout) child.stdout.emit("data", Buffer.from(scripted.initialStdout));
				if (scripted.initialStderr) child.stderr.emit("data", Buffer.from(scripted.initialStderr));
				if (scripted.stdout) child.stdout.emit("data", Buffer.from(scripted.stdout));
				if (scripted.stderr) child.stderr.emit("data", Buffer.from(scripted.stderr));
			};
			const clearTimers = (): void => {
				if (completionTimer !== undefined) clock.clearTimeout(completionTimer);
				if (timeoutTimer !== undefined) clock.clearTimeout(timeoutTimer);
				completionTimer = undefined;
				timeoutTimer = undefined;
			};
			const emitClose = (code: number | null, signal: NodeJS.Signals | null): void => {
				if (closed) return;
				closed = true;
				clearTimers();
				live.delete(tracked);
				child.emit("exit", code, signal);
				child.emit("close", code, signal);
			};

			const tracked: TrackedChild & { _timedOut?: boolean } = {
				child: child as unknown as TrackedChild["child"],
				killed: () => killed,
				timedOut: () => timedOut || !!tracked._timedOut,
				markSurvival: () => {},
				killTree: () => {
					if (closed) return;
					killed = true;
					emitClose(null, "SIGTERM");
				},
			};
			live.add(tracked);

			if (Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 && scripted.delayMs > spec.timeoutMs) {
				timeoutTimer = clock.setTimeout(() => {
					if (closed || killed) return;
					timedOut = true;
					emitOutput();
					emitClose(null, "SIGTERM");
				}, spec.timeoutMs);
			} else {
				completionTimer = clock.setTimeout(() => {
					if (closed || killed) return;
					emitOutput();
					emitClose(scripted.exitCode, null);
				}, scripted.delayMs);
			}
			return tracked;
		},
		reset(): void {
			for (const child of [...live]) child.killTree("SIGTERM", 0);
			live.clear();
		},
	};
	return runner;
}

interface ProcessGateApiState {
	runners: WeakMap<ManualClock, ResettableVerificationRunner>;
	connections: Set<WsConnection>;
	workflowBaseline?: Map<string, unknown>;
}

const STATE_KEY = Symbol.for("bobbit.tests2.gateApiTestSupport");
const processState = globalThis as typeof globalThis & { [STATE_KEY]?: ProcessGateApiState };
const state = processState[STATE_KEY] ??= {
	runners: new WeakMap(),
	connections: new Set(),
};

function runnerFor(clock: ManualClock): ResettableVerificationRunner {
	let runner = state.runners.get(clock);
	if (!runner) {
		runner = createManualVerificationRunner(clock);
		state.runners.set(clock, runner);
	}
	return runner;
}

function defaultWorkflowStore(gateway: any): any {
	return gateway.projectContextManager.getOrCreate(gateway.defaultProjectId)?.workflowStore;
}

function snapshotWorkflows(gateway: any): Map<string, unknown> {
	const workflows = defaultWorkflowStore(gateway)?.getAllLocal?.() ?? defaultWorkflowStore(gateway)?.getAll?.() ?? [];
	return new Map(workflows.map((workflow: any) => [workflow.id, structuredClone(workflow)]));
}

function restoreWorkflowSnapshot(gateway: any, baseline: Map<string, unknown> | undefined): void {
	if (!baseline) return;
	const store = defaultWorkflowStore(gateway);
	if (!store) return;
	const current = store.getAllLocal?.() ?? store.getAll?.() ?? [];
	for (const workflow of current) {
		if (!baseline.has(workflow.id)) store.remove(workflow.id);
	}
	for (const [id, workflow] of baseline) {
		const existing = store.get(id);
		if (JSON.stringify(existing) !== JSON.stringify(workflow)) store.put(structuredClone(workflow));
	}
}

async function resetVerificationState(gateway: any): Promise<void> {
	for (const connection of state.connections) connection.close();
	state.connections.clear();

	const harness = gateway.teamManager.verificationHarness as any;
	const runner = runnerFor(gateway.clock);
	for (const active of harness?.getActiveVerifications?.() ?? []) {
		await harness.cancelAllVerifications(active.goalId);
	}
	runner.reset();
	gateway.clock.advance(0);
	await new Promise<void>(resolve => setImmediate(resolve));
	if (harness) harness.commandStepRunner = runner;
}

/** Install deterministic runner and fork-local store/event cleanup for a suite. */
export function useGateApiTestSupport(): void {
	test.beforeEach(async ({ gateway }) => {
		await resetVerificationState(gateway);
		state.workflowBaseline = snapshotWorkflows(gateway);
	});
	test.afterEach(async ({ gateway }) => {
		await resetVerificationState(gateway);
		restoreWorkflowSnapshot(gateway, state.workflowBaseline);
		state.workflowBaseline = undefined;
	});
}

export function trackGateApiConnection(connection: WsConnection): WsConnection {
	state.connections.add(connection);
	return connection;
}

export async function waitForAuthoredGateStatus(
	goalId: string,
	gateId: string,
	targetStatus: string,
	maxTurns = 200,
): Promise<any> {
	const gateway = await ensureGateway();
	let last: any;
	for (let turn = 0; turn < maxTurns; turn++) {
		await new Promise<void>(resolve => setImmediate(resolve));
		gateway.clock.advance(25);
		await new Promise<void>(resolve => setImmediate(resolve));
		const response = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		if (response.ok) {
			last = await response.json();
			if (last.status === targetStatus) return last;
		}
	}
	throw new Error(`gate ${goalId}/${gateId} did not reach ${targetStatus}; last=${JSON.stringify(last)}`);
}

export async function signalAndWaitForAuthoredGate(
	_goalConnection: WsConnection,
	goalId: string,
	gateId: string,
	body: Record<string, unknown>,
	targetStatus: string,
): Promise<any> {
	const response = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	if (response.status !== 201) {
		throw new Error(`signal ${goalId}/${gateId} failed: ${response.status} ${await response.text()}`);
	}
	return waitForAuthoredGateStatus(goalId, gateId, targetStatus);
}
