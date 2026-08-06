import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import { canonicalGateStoreStateRoot } from "../../src/server/agent/gate-store-root-coordinator.js";
import { __setGatePayloadFinalizationPauseForTests } from "../../src/server/agent/gate-store-payload-worker.js";
import { gateStoreV2Root, payloadPath } from "../../src/server/agent/gate-store-v2-persistence.js";
import { buildGateVerificationInspectionSnapshot } from "../../src/server/gate-verification-snapshot.js";

const roots: string[] = [];
const stores = new Set<GateStore>();
let releasePayloadPause: (() => void) | undefined;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(settle => { resolve = settle; });
	return { promise, resolve };
}

function stateFixture(label: string): { stateDir: string; aliasStateDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-gate-root-${label}-`));
	roots.push(root);
	const projectRoot = path.join(root, "physical-project");
	const stateDir = path.join(projectRoot, ".bobbit", "state");
	fs.mkdirSync(stateDir, { recursive: true });
	const aliasRoot = path.join(root, "project-alias");
	fs.symlinkSync(projectRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
	const lexicalAlias = path.join(aliasRoot, ".bobbit", "state");
	return {
		stateDir,
		aliasStateDir: process.platform === "win32" ? lexicalAlias.toUpperCase() : lexicalAlias,
	};
}

function open(stateDir: string, preload?: Awaited<ReturnType<typeof GateStore.prepare>>["preload"]): GateStore {
	const store = new GateStore(stateDir, undefined, preload);
	stores.add(store);
	return store;
}

function signal(id: string, goalId: string, output: string): GateSignal {
	return {
		id,
		gateId: "verification",
		goalId,
		sessionId: `session-${id}`,
		timestamp: 1_700_000_000_000,
		commitSha: "commit-root-coordinator",
		content: `content-${id}`,
		verification: {
			status: "failed",
			steps: [{ name: "unit", type: "command", passed: false, status: "failed", output, duration_ms: 7 }],
		},
	};
}

async function inspectOutput(store: GateStore, stateDir: string, goalId: string, signalId: string): Promise<string | undefined> {
	const retained = store.getGate(goalId, "verification")?.signals.find(row => row.id === signalId);
	expect(retained, `missing retained signal ${goalId}/${signalId}`).toBeDefined();
	const snapshot = await buildGateVerificationInspectionSnapshot({
		goalId,
		gateId: "verification",
		signalId,
		verification: retained!.verification,
		selectionOptions: { mode: "full", includeDiagnostics: true },
		v2Root: gateStoreV2Root(stateDir),
	});
	return snapshot.steps[0]?.output;
}

afterEach(async () => {
	releasePayloadPause?.();
	releasePayloadPause = undefined;
	__setGatePayloadFinalizationPauseForTests();
	await Promise.allSettled([...stores].map(store => store.close()));
	stores.clear();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GateStore canonical-root coordination", () => {
	it("fences prepare/re-register behind payload finalization until the referencing shard is published", async () => {
		const { stateDir, aliasStateDir } = stateFixture("publication");
		expect(canonicalGateStoreStateRoot(aliasStateDir)).toBe(canonicalGateStoreStateRoot(stateDir));
		const store = open(stateDir);
		store.initGatesForGoal("goal-race", ["verification"]);
		await store.flush();
		const output = ["ROOT_COORDINATOR_FIRST_LINE", "x".repeat(32 * 1024), "ROOT_COORDINATOR_LAST_LINE"].join("\n");
		const expectedHash = createHash("sha256").update(output).digest("hex");
		store.recordSignal(signal("signal-race", "goal-race", output));

		const payloadFinalized = deferred();
		const allowShardPublication = deferred();
		releasePayloadPause = allowShardPublication.resolve;
		__setGatePayloadFinalizationPauseForTests(async () => {
			payloadFinalized.resolve();
			await allowShardPublication.promise;
		});

		const flush = store.flush();
		await payloadFinalized.promise;
		expect(fs.existsSync(payloadPath(gateStoreV2Root(stateDir), expectedHash))).toBe(true);

		let prepareSettled = false;
		const preparation = GateStore.prepare(aliasStateDir).then(result => {
			prepareSettled = true;
			return result;
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(prepareSettled, "prepare must not inventory/reclaim a finalized payload before its shard publication").toBe(false);

		allowShardPublication.resolve();
		releasePayloadPause = undefined;
		await flush;
		const prepared = await preparation;
		await store.close();
		stores.delete(store);

		const reopened = open(aliasStateDir, prepared.preload);
		expect(reopened.getGate("goal-race", "verification")?.signals.map(row => row.id)).toEqual(["signal-race"]);
		expect(fs.existsSync(payloadPath(gateStoreV2Root(aliasStateDir), expectedHash))).toBe(true);
		expect(await inspectOutput(reopened, aliasStateDir, "goal-race", "signal-race")).toBe(output);
		await reopened.flush();
	});

	it("drains writes accepted before close and rejects mutations once close starts", async () => {
		const { stateDir } = stateFixture("close");
		const store = open(stateDir);
		store.initGatesForGoal("goal-close", ["verification"]);
		const output = "CLOSE_DRAIN_OUTPUT:".padEnd(40 * 1024, "d");
		store.recordSignal(signal("signal-close", "goal-close", output));

		const closing = store.close();
		expect(store.close()).toBe(closing);
		expect(() => store.updateGateMetadata("goal-close", "verification", { rejected: "while-closing" })).toThrow(/GateStore is closing/);
		await closing;
		stores.delete(store);
		expect(() => store.recordSignal(signal("signal-too-late", "goal-close", "must not persist"))).toThrow(/GateStore is closed/);

		const reopened = open(stateDir);
		expect(reopened.getGate("goal-close", "verification")?.signals.map(row => row.id)).toEqual(["signal-close"]);
		expect(await inspectOutput(reopened, stateDir, "goal-close", "signal-close")).toBe(output);
	});

	it("shares payload ownership across physical, alias, and Windows case spellings of one root", async () => {
		const { stateDir, aliasStateDir } = stateFixture("aliases");
		expect(canonicalGateStoreStateRoot(aliasStateDir)).toBe(canonicalGateStoreStateRoot(stateDir));
		const shared = "CANONICAL_ROOT_SHARED_HASH:".padEnd(40 * 1024, "s");
		const hash = createHash("sha256").update(shared).digest("hex");
		const physical = open(stateDir);
		physical.initGatesForGoal("goal-physical", ["verification"]);
		physical.recordSignal(signal("signal-physical", "goal-physical", shared));
		await physical.flush();

		const aliased = open(aliasStateDir);
		aliased.initGatesForGoal("goal-aliased", ["verification"]);
		aliased.recordSignal(signal("signal-aliased", "goal-aliased", shared));
		await aliased.flush();
		const sharedPayload = payloadPath(gateStoreV2Root(stateDir), hash);
		expect(fs.existsSync(sharedPayload)).toBe(true);
		expect(await inspectOutput(physical, stateDir, "goal-physical", "signal-physical")).toBe(shared);
		expect(await inspectOutput(aliased, aliasStateDir, "goal-aliased", "signal-aliased")).toBe(shared);

		physical.removeGoalGates("goal-physical");
		await physical.flush();
		expect(fs.existsSync(sharedPayload), "the alias-owned partition still references the shared hash").toBe(true);
		expect(await inspectOutput(aliased, aliasStateDir, "goal-aliased", "signal-aliased")).toBe(shared);

		aliased.removeGoalGates("goal-aliased");
		await aliased.flush();
		expect(fs.existsSync(sharedPayload), "the shared hash is reclaimable only after the final canonical-root owner publishes removal").toBe(false);
	});
});
