import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import {
	acquireGateStoreRootLease,
	canonicalGateStoreStateRoot,
} from "../../src/server/agent/gate-store-root-coordinator.js";
import { __setGatePayloadFinalizationPauseForTests } from "../../src/server/agent/gate-store-payload-worker.js";
import {
	gateStoreV2Root,
	goalRecordPath,
	historyRecordPath,
	payloadPath,
} from "../../src/server/agent/gate-store-v2-persistence.js";
import { createProjectPathIdentity } from "../../src/server/agent/project-registry.js";
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

	it("drains writes accepted before close and rejects mutations after close succeeds", async () => {
		const { stateDir } = stateFixture("close");
		const store = open(stateDir);
		store.initGatesForGoal("goal-close", ["verification"]);
		const output = "CLOSE_DRAIN_OUTPUT:".padEnd(40 * 1024, "d");
		store.recordSignal(signal("signal-close", "goal-close", output));

		const closing = store.close();
		expect(store.close()).toBe(closing);
		await closing;
		stores.delete(store);
		expect(() => store.recordSignal(signal("signal-too-late", "goal-close", "must not persist"))).toThrow(/GateStore is closed/);

		const reopened = open(stateDir);
		expect(reopened.getGate("goal-close", "verification")?.signals.map(row => row.id)).toEqual(["signal-close"]);
		expect(await inspectOutput(reopened, stateDir, "goal-close", "signal-close")).toBe(output);
	});

	it.each([
		{ phase: "history-write", method: "writeFile" as const },
		{ phase: "goal-rename", method: "rename" as const },
	])("retains the dirty close fence and retries after a $phase failure", async ({ phase, method }) => {
		const { stateDir, aliasStateDir } = stateFixture(`close-${phase}`);
		const store = open(stateDir);
		store.initGatesForGoal("goal-close-retry", ["verification"]);
		await store.flush();
		const output = `CLOSE_RETRY_${phase}:`.padEnd(36 * 1024, phase === "history-write" ? "h" : "g");
		store.recordSignal(signal(`signal-${phase}`, "goal-close-retry", output));

		const historyTmp = path.resolve(`${historyRecordPath(gateStoreV2Root(stateDir), "goal-close-retry", "verification")}.tmp`);
		const goalFile = path.resolve(goalRecordPath(gateStoreV2Root(stateDir), "goal-close-retry"));
		const originalWrite = fs.promises.writeFile.bind(fs.promises);
		const originalRename = fs.promises.rename.bind(fs.promises);
		let injected = false;
		if (method === "writeFile") {
			fs.promises.writeFile = (async (candidate, data, options) => {
				if (path.resolve(String(candidate)) === historyTmp) {
					injected = true;
					throw new Error("INJECTED_GATE_CLOSE_HISTORY_WRITE_FAILURE");
				}
				return originalWrite(candidate, data, options);
			}) as typeof fs.promises.writeFile;
		} else {
			fs.promises.rename = (async (from, to) => {
				if (path.resolve(String(to)) === goalFile && String(from).endsWith(".gates.json")) {
					injected = true;
					throw new Error("INJECTED_GATE_CLOSE_GOAL_RENAME_FAILURE");
				}
				return originalRename(from, to);
			}) as typeof fs.promises.rename;
		}

		const firstClose = store.close();
		try {
			await expect(firstClose).rejects.toThrow(method === "writeFile"
				? /INJECTED_GATE_CLOSE_HISTORY_WRITE_FAILURE/
				: /INJECTED_GATE_CLOSE_GOAL_RENAME_FAILURE/);
		} finally {
			fs.promises.writeFile = originalWrite as typeof fs.promises.writeFile;
			fs.promises.rename = originalRename as typeof fs.promises.rename;
		}
		expect(injected).toBe(true);
		expect(fs.existsSync(payloadPath(gateStoreV2Root(stateDir), createHash("sha256").update(output).digest("hex")))).toBe(true);
		expect(canonicalGateStoreStateRoot(aliasStateDir)).toBe(canonicalGateStoreStateRoot(stateDir));

		const retry = store.close();
		expect(retry).not.toBe(firstClose);
		await retry;
		stores.delete(store);
		expect(() => store.updateGateMetadata("goal-close-retry", "verification", { rejected: "closed" })).toThrow(/GateStore is closed/);

		const reopened = open(stateDir);
		expect(reopened.getGate("goal-close-retry", "verification")?.signals.map(row => row.id)).toEqual([`signal-${phase}`]);
		expect(await inspectOutput(reopened, stateDir, "goal-close-retry", `signal-${phase}`)).toBe(output);
	});

	it("keeps modeled Windows case-sensitive roots and real case-paired roots in separate preload and ledger domains", async () => {
		const modeledSensitiveWindows = createProjectPathIdentity({
			isNativePathApi: dialect => dialect === "win32",
			realpathSync: candidate => path.win32.resolve(candidate),
			isCaseInsensitiveAt: () => false,
		});
		const modeledInsensitiveWindows = createProjectPathIdentity({
			isNativePathApi: dialect => dialect === "win32",
			realpathSync: candidate => path.win32.resolve(candidate),
			isCaseInsensitiveAt: () => true,
		});
		const modeledUpper = "C:\\ModeledVolume\\Projects\\CaseRoot\\.bobbit\\state";
		const modeledLower = "C:\\ModeledVolume\\Projects\\caseroot\\.bobbit\\state";
		expect(modeledSensitiveWindows(modeledUpper)).not.toBe(modeledSensitiveWindows(modeledLower));
		expect(modeledInsensitiveWindows(modeledUpper)).toBe(modeledInsensitiveWindows(modeledLower));

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gate-case-pair-"));
		roots.push(root);
		const upperState = path.join(root, "CaseRoot", ".bobbit", "state");
		const lowerState = path.join(root, "caseroot", ".bobbit", "state");
		fs.mkdirSync(upperState, { recursive: true });
		fs.mkdirSync(lowerState, { recursive: true });
		const upperStat = fs.statSync(upperState);
		const lowerStat = fs.statSync(lowerState);
		if (upperStat.dev !== lowerStat.dev || upperStat.ino !== lowerStat.ino) {
			expect(canonicalGateStoreStateRoot(upperState)).not.toBe(canonicalGateStoreStateRoot(lowerState));
			const upperPreparation = GateStore.prepare(upperState);
			const lowerPreparation = GateStore.prepare(lowerState);
			expect(upperPreparation).not.toBe(lowerPreparation);
			const [upperPrepared, lowerPrepared] = await Promise.all([upperPreparation, lowerPreparation]);
			expect(() => new GateStore(lowerState, undefined, upperPrepared.preload)).toThrow(/different physical state root/);
			const upper = open(upperState, upperPrepared.preload);
			const lower = open(lowerState, lowerPrepared.preload);
			const upperLease = acquireGateStoreRootLease(upperState);
			const lowerLease = acquireGateStoreRootLease(lowerState);
			try {
				upperLease.seedReferences({ immutable: ["case-sensitive-hash"], partitions: [] });
				expect(upperLease.isReferenced("case-sensitive-hash")).toBe(true);
				expect(lowerLease.isReferenced("case-sensitive-hash")).toBe(false);
			} finally {
				upperLease.release();
				lowerLease.release();
			}
			await Promise.all([upper.close(), lower.close()]);
			stores.delete(upper);
			stores.delete(lower);
		}
	});

	it("shares payload ownership across physical, proven alias, and Windows case spellings of one root", async () => {
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
