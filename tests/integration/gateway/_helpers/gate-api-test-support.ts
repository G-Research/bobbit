import {
	armNextFakeCommandStepSpawn,
	resetAndInstallFakeCommandStepTestState,
	trackFakeCommandStepConnection,
} from "./e2e/fake-cmd-setup.js";
import { test } from "./e2e/in-process-harness.js";
import { apiFetch, ensureGateway, type WsConnection } from "./e2e/e2e-setup.js";

interface ProcessGateApiState {
	workflowBaseline?: Map<string, unknown>;
}

const STATE_KEY = Symbol.for("bobbit.tests2.gateApiTestSupport");
const processState = globalThis as typeof globalThis & { [STATE_KEY]?: ProcessGateApiState };
const state = processState[STATE_KEY] ??= {};

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

/** Install deterministic runner and fork-local store/event cleanup for a suite. */
export function useGateApiTestSupport(): void {
	test.beforeEach(async ({ gateway }) => {
		await resetAndInstallFakeCommandStepTestState(gateway);
		state.workflowBaseline = snapshotWorkflows(gateway);
	});
	test.afterEach(async ({ gateway }) => {
		await resetAndInstallFakeCommandStepTestState(gateway);
		restoreWorkflowSnapshot(gateway, state.workflowBaseline);
		state.workflowBaseline = undefined;
	});
}

export function trackGateApiConnection(connection: WsConnection): WsConnection {
	return trackFakeCommandStepConnection(connection);
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

/**
 * Drive one zero-delay fake command only after verification has actually
 * spawned it. This prevents rapid manual-clock polling from racing ahead of
 * asynchronous Git/setup work that precedes the spawn.
 */
export async function signalAndWaitForAuthoredGateWithFakeCommandBarrier(
	goalId: string,
	gateId: string,
	body: Record<string, unknown>,
	targetStatus: string,
): Promise<any> {
	const gateway = await ensureGateway();
	const lifecycle = armNextFakeCommandStepSpawn(gateway);
	const response = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	if (response.status !== 201) {
		throw new Error(`signal ${goalId}/${gateId} failed: ${response.status} ${await response.text()}`);
	}
	await lifecycle.spawned;
	gateway.clock.advance(0);
	await lifecycle.closed;
	await new Promise<void>(resolve => setImmediate(resolve));
	return waitForAuthoredGateStatus(goalId, gateId, targetStatus);
}
