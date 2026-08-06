/**
 * Side-effect opt-in plus shared lifecycle support for tier-1 specs that own
 * command-step bookkeeping rather than OS process fidelity. Import this module
 * before in-process-harness.ts so the fork-local flag is set before the gateway
 * singleton boots.
 */
import { EventEmitter } from "node:events";
import type { VerificationCommandRunner, VerificationCommandSpawnSpec } from "../../../src/server/agent/verification-command-runner.js";
import type { TrackedChild } from "../../../src/server/agent/spawn-tree.js";
import type { ManualClock } from "../../harness/clock.js";
import { interpretFakeCommand } from "../../harness/fake-verification-command-runner.js";
import type { WsConnection } from "./e2e-setup.js";

const FAKE_CMD_STEP_KEY = Symbol.for("bobbit.tests2.fakeCommandStepEnabled");
type FakeCommandStepGlobal = typeof globalThis & {
	__BOBBIT_V2_FAKE_CMD_STEP__?: boolean;
	[FAKE_CMD_STEP_KEY]?: true;
};
const fakeGlobal = globalThis as FakeCommandStepGlobal;
fakeGlobal.__BOBBIT_V2_FAKE_CMD_STEP__ = true;
fakeGlobal[FAKE_CMD_STEP_KEY] = true;

// Retained-log cap behavior does not need multi-megabyte subprocess output.
process.env.BOBBIT_RETAINED_LOG_MAX_BYTES ??= String(128 * 1024);

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

export interface FakeCommandSpawnBarrier {
	/** Resolves only after the armed command has actually been spawned. */
	readonly spawned: Promise<VerificationCommandSpawnSpec>;
	/** Resolves when that exact fake child emits its terminal close. */
	readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface ArmedFakeCommandSpawn extends FakeCommandSpawnBarrier {
	resolveSpawned(spec: VerificationCommandSpawnSpec): void;
	resolveClosed(result: { code: number | null; signal: NodeJS.Signals | null }): void;
}

interface ResettableVerificationRunner extends VerificationCommandRunner {
	armNextSpawn(): FakeCommandSpawnBarrier;
	reset(): void;
}

interface FakeCommandStepState {
	runners: WeakMap<ManualClock, ResettableVerificationRunner>;
	connections: Set<WsConnection>;
}

interface FakeCommandStepGateway {
	clock: ManualClock;
	teamManager: {
		verificationHarness?: {
			commandStepRunner: VerificationCommandRunner;
			getActiveVerifications?: () => Array<{ goalId: string }>;
			cancelAllVerifications: (goalId: string) => Promise<unknown>;
		};
	};
}

const STATE_KEY = Symbol.for("bobbit.tests2.fakeCommandStepState");
const processState = globalThis as typeof globalThis & { [STATE_KEY]?: FakeCommandStepState };
const state = processState[STATE_KEY] ??= {
	runners: new WeakMap(),
	connections: new Set(),
};

let fakePid = 950_000;

function createManualVerificationRunner(clock: ManualClock): ResettableVerificationRunner {
	const live = new Set<TrackedChild>();
	let armedNextSpawn: ArmedFakeCommandSpawn | undefined;

	const runner: ResettableVerificationRunner = {
		nonDurable: true,
		spawn(spec: VerificationCommandSpawnSpec): TrackedChild {
			const child = new FakeChild(++fakePid);
			const scripted = interpretFakeCommand(spec.command);
			const spawnBarrier = armedNextSpawn;
			armedNextSpawn = undefined;
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
				spawnBarrier?.resolveClosed({ code, signal });
			};

			const tracked: TrackedChild & { _timedOut?: boolean } = {
				child: child as unknown as TrackedChild["child"],
				ownershipReady: Promise.resolve(),
				waitForTreeExit: async () => closed,
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
			spawnBarrier?.resolveSpawned(spec);
			return tracked;
		},
		armNextSpawn(): FakeCommandSpawnBarrier {
			if (armedNextSpawn) {
				throw new Error("[fake-command-step] the next spawn already has an armed lifecycle barrier");
			}
			let resolveSpawned!: ArmedFakeCommandSpawn["resolveSpawned"];
			let resolveClosed!: ArmedFakeCommandSpawn["resolveClosed"];
			const spawned = new Promise<VerificationCommandSpawnSpec>(resolve => { resolveSpawned = resolve; });
			const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { resolveClosed = resolve; });
			armedNextSpawn = { spawned, closed, resolveSpawned, resolveClosed };
			return { spawned, closed };
		},
		reset(): void {
			for (const child of [...live]) child.killTree("SIGTERM", 0);
			live.clear();
			armedNextSpawn = undefined;
		},
	};
	return runner;
}

function runnerFor(clock: ManualClock): ResettableVerificationRunner {
	let runner = state.runners.get(clock);
	if (!runner) {
		runner = createManualVerificationRunner(clock);
		state.runners.set(clock, runner);
	}
	return runner;
}

/** Track a gate-test socket so retries and following files cannot inherit it. */
export function trackFakeCommandStepConnection(connection: WsConnection): WsConnection {
	state.connections.add(connection);
	return connection;
}

/**
 * Arm a one-shot lifecycle barrier on the installed manual runner. The spawn
 * and close promises retain their observations, so neither edge can be missed
 * when verification performs asynchronous setup before spawning.
 */
export function armNextFakeCommandStepSpawn(gateway: FakeCommandStepGateway): FakeCommandSpawnBarrier {
	const runner = runnerFor(gateway.clock);
	if (gateway.teamManager.verificationHarness?.commandStepRunner !== runner) {
		throw new Error("[fake-command-step] cannot arm spawn barrier before installing the manual runner");
	}
	return runner.armNextSpawn();
}

/**
 * Reset every process-global surface used by fake command-step suites, then
 * install the one deterministic manual-clock runner. Both gate fixture families
 * call this at every test boundary so file order cannot select runner behavior.
 */
export async function resetAndInstallFakeCommandStepTestState(gateway: FakeCommandStepGateway): Promise<void> {
	for (const connection of state.connections) connection.close();
	state.connections.clear();

	const harness = gateway.teamManager.verificationHarness;
	if (harness) {
		const goalIds = new Set((harness.getActiveVerifications?.() ?? []).map(active => active.goalId));
		for (const goalId of goalIds) await harness.cancelAllVerifications(goalId);
	}

	const runner = runnerFor(gateway.clock);
	runner.reset();
	gateway.clock.advance(0);
	await new Promise<void>(resolve => setImmediate(resolve));
	if (harness) harness.commandStepRunner = runner;
}
