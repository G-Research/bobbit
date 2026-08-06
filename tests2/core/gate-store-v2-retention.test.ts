import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import {
	GATE_STORE_HOT_SIGNAL_LIMIT,
	GATE_STORE_ORDINARY_BYTES_LIMIT,
	GATE_STORE_ORDINARY_SIGNAL_LIMIT,
	bypassAuditDirectory,
	enforceOrdinaryRetention,
	gateStoreV2Root,
	goalRecordPath,
	historyRecordPath,
	type GateStoreV2GoalRecord,
	type GateStoreV2HistoryRecord,
} from "../../src/server/agent/gate-store-v2-persistence.js";
import { checkGateDependencies } from "../../src/server/agent/gate-dependency-check.js";
import { __setGateStoreMigrationWorkerFaultForTests } from "../../src/server/agent/gate-store-migration-worker.js";
import { buildStepCache } from "../../src/server/agent/verification-logic.js";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

let sequence = 0;
let memfs: MemFs;
let stateDir: string;
let store: GateStore;
const workerRoots: string[] = [];

beforeEach(() => {
	memfs = createMemFs();
	stateDir = path.resolve("/memfs/gate-v2-retention", `case-${sequence++}`);
	memfs.mkdirSync(stateDir, { recursive: true });
	store = new GateStore(stateDir, memfs);
});

afterEach(() => {
	for (const root of workerRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function signal(index: number, overrides: Partial<GateSignal> = {}): GateSignal {
	return {
		id: `signal-${index}`,
		gateId: "gate",
		goalId: "goal",
		sessionId: `session-${index}`,
		timestamp: 1_700_000_000_000 + index,
		commitSha: `commit-${index}`,
		content: `content-${index}`,
		verification: {
			status: "failed",
			steps: [{ name: "unit", type: "command", passed: false, status: "failed", output: `failure-${index}`, duration_ms: 1 }],
		},
		...overrides,
	};
}

function ordinaryBytes(signals: GateSignal[]): number {
	return signals
		.filter(row => row.metadata?.bypass !== "true" && row.verification.status !== "running")
		.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
}

function readGoalRecord(goalId = "goal"): GateStoreV2GoalRecord {
	return JSON.parse(memfs.readFileSync(goalRecordPath(gateStoreV2Root(stateDir), goalId), "utf8") as string) as GateStoreV2GoalRecord;
}

function readHistory(goalId = "goal", gateId = "gate"): GateStoreV2HistoryRecord {
	return JSON.parse(memfs.readFileSync(historyRecordPath(gateStoreV2Root(stateDir), goalId, gateId), "utf8") as string) as GateStoreV2HistoryRecord;
}

function payloadFiles(): string[] {
	const root = path.join(gateStoreV2Root(stateDir), "payloads");
	if (!memfs.existsSync(root)) return [];
	return (memfs.readdirSync(root) as string[]).flatMap(prefix => (memfs.readdirSync(path.join(root, prefix)) as string[]).map(file => path.join(prefix, file)));
}

type WorkerBypassSource = "embedded" | "history" | "audit";

function writeWorkerBypassFixture(source: WorkerBypassSource, gateUpdatedAt = 100, trusted = true): { stateDir: string; signal: GateSignal; payloadHash: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-worker-bypass-${source}-`));
	workerRoots.push(root);
	const workerStateDir = path.join(root, "state");
	const v2Root = gateStoreV2Root(workerStateDir);
	const payload = "WORKER_BYPASS_SHARED_PAYLOAD:".padEnd(96 * 1024, "p");
	const payloadHash = createHash("sha256").update(payload).digest("hex");
	const payloadFile = path.join(v2Root, "payloads", payloadHash.slice(0, 2), `${payloadHash}.payload`);
	fs.mkdirSync(path.dirname(payloadFile), { recursive: true });
	fs.writeFileSync(payloadFile, payload, "utf8");
	const ref = { kind: "gate-payload-v2" as const, sha256: payloadHash, bytes: Buffer.byteLength(payload), path: payloadFile };
	const bypass = signal(7, {
		id: trusted ? "bypass-worker" : "forged-worker-signal",
		sessionId: trusted ? "human-bypass" : "agent-session",
		timestamp: 200,
		commitSha: "",
		persistenceOrdinal: 7,
		content: "",
		contentRef: ref,
		bypassReasonRef: ref,
		auditMetadataRefs: { whyBypassed: ref },
		metadata: { bypass: "true", whyBypassed: "worker recovery", whoAmI: "worker-test", bypassedAt: "200" },
		verification: { status: "passed", steps: [] },
	});
	const gate = {
		goalId: "goal",
		gateId: "gate",
		status: "pending" as const,
		currentContent: "current truth",
		currentContentVersion: 1,
		currentMetadata: {},
		updatedAt: gateUpdatedAt,
		signals: source === "embedded" ? [bypass] : [],
	};
	const goalRecord: GateStoreV2GoalRecord = {
		schemaVersion: 2,
		goalId: "goal",
		gates: [gate],
		history: {},
		retention: {},
	};
	fs.mkdirSync(path.dirname(goalRecordPath(v2Root, "goal")), { recursive: true });
	fs.writeFileSync(goalRecordPath(v2Root, "goal"), JSON.stringify(goalRecord), "utf8");
	if (source === "history") {
		const historyRecord: GateStoreV2HistoryRecord = {
			schemaVersion: 2,
			goalId: "goal",
			gateId: "gate",
			signals: [bypass],
			retention: { earliestRetainedOrdinal: 7, prunedSignals: 0, prunedBytes: 0 },
		};
		fs.mkdirSync(path.dirname(historyRecordPath(v2Root, "goal", "gate")), { recursive: true });
		fs.writeFileSync(historyRecordPath(v2Root, "goal", "gate"), JSON.stringify(historyRecord), "utf8");
	}
	if (source === "audit") {
		const directory = bypassAuditDirectory(v2Root, "goal", "gate");
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, `${String(7).padStart(16, "0")}-${createHash("sha256").update(bypass.id).digest("hex")}.json`), JSON.stringify({
			schemaVersion: 2, goalId: "goal", gateId: "gate", ordinal: 7, signal: bypass,
		}), "utf8");
	}
	fs.writeFileSync(path.join(v2Root, "manifest.json"), JSON.stringify({
		schemaVersion: 2,
		state: "complete",
		sourceFile: "none",
		sourceBytes: 0,
		sourceSha256: createHash("sha256").update("").digest("hex"),
		gateCount: 1,
		signalCount: 0,
		bypassCount: 0,
		externalizedBytes: 0,
		payloadBytes: Buffer.byteLength(payload),
		inventory: [{ goalId: "goal", gateIds: ["gate"] }],
		migratedAt: 1,
		validatedAt: 1,
	}), "utf8");
	return { stateDir: workerStateDir, signal: bypass, payloadHash };
}

function readWorkerGoal(workerStateDir: string): GateStoreV2GoalRecord {
	return JSON.parse(fs.readFileSync(goalRecordPath(gateStoreV2Root(workerStateDir), "goal"), "utf8")) as GateStoreV2GoalRecord;
}

function workerAuditFiles(workerStateDir: string): string[] {
	const directory = bypassAuditDirectory(gateStoreV2Root(workerStateDir), "goal", "gate");
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory).filter(file => /^\d{16}-[a-f0-9]{64}\.json$/.test(file)).sort();
}

type BypassCrashPhase = "before-shard-rename" | "after-shard-before-audit" | "after-audit-before-cleanup";

function bypassAuditFiles(goalId = "goal", gateId = "gate"): string[] {
	const directory = bypassAuditDirectory(gateStoreV2Root(stateDir), goalId, gateId);
	if (!memfs.existsSync(directory)) return [];
	return (memfs.readdirSync(directory) as string[]).filter(file => /^\d{16}-[a-f0-9]{64}\.json$/.test(file)).sort();
}

/**
 * Turns a selected publication boundary into a deterministic process-death seam.
 * The after-audit phase publishes the rename and then makes the publisher's
 * race-recovery probe observe the pre-rename world, which is equivalent to the
 * process disappearing between the durable rename and its next instruction.
 */
function injectBypassCrash(phase: BypassCrashPhase): { restore: () => void; shardWasPublishedBeforeAudit: () => boolean } {
	const finalShard = path.resolve(goalRecordPath(gateStoreV2Root(stateDir), "goal"));
	const auditRoot = path.resolve(path.join(gateStoreV2Root(stateDir), "audit"));
	const originalRename = memfs.renameSync.bind(memfs);
	const originalExists = memfs.existsSync.bind(memfs);
	let lieAboutPublishedAudit: string | undefined;
	let shardPublishedBeforeAudit = false;
	let injected = false;

	const isAuditPublication = (destination: string): boolean => {
		const relative = path.relative(auditRoot, destination);
		return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) && destination.endsWith(".json");
	};
	const observePublishedShard = (): boolean => {
		if (!originalExists(finalShard)) return false;
		try {
			const record = JSON.parse(memfs.readFileSync(finalShard, "utf8") as string) as GateStoreV2GoalRecord;
			return record.gates.find(gate => gate.gateId === "gate")?.status === "bypassed";
		} catch {
			return false;
		}
	};

	memfs.renameSync = ((from, to) => {
		const source = path.resolve(String(from));
		const destination = path.resolve(String(to));
		if (!injected && phase === "before-shard-rename" && destination === finalShard && source.endsWith(".gates.json")) {
			injected = true;
			throw new Error("INJECTED_GATE_V2_CRASH_BEFORE_SHARD_RENAME");
		}
		if (!injected && isAuditPublication(destination)) {
			shardPublishedBeforeAudit = observePublishedShard();
			if (phase === "after-shard-before-audit") {
				injected = true;
				throw new Error("INJECTED_GATE_V2_CRASH_AFTER_SHARD_BEFORE_AUDIT");
			}
			if (phase === "after-audit-before-cleanup") {
				originalRename(from, to);
				injected = true;
				lieAboutPublishedAudit = destination;
				throw new Error("INJECTED_GATE_V2_CRASH_AFTER_AUDIT_BEFORE_CLEANUP");
			}
		}
		return originalRename(from, to);
	}) as MemFs["renameSync"];
	memfs.existsSync = ((candidate) => {
		const resolved = path.resolve(String(candidate));
		if (lieAboutPublishedAudit === resolved) return false;
		return originalExists(candidate);
	}) as MemFs["existsSync"];

	return {
		restore: () => {
			memfs.renameSync = originalRename as MemFs["renameSync"];
			memfs.existsSync = originalExists as MemFs["existsSync"];
		},
		shardWasPublishedBeforeAudit: () => shardPublishedBeforeAudit,
	};
}

/** Leave the history-first bypass row durable while rejecting its truth shard. */
async function interruptBypassBeforeTruth(reason: string): Promise<GateSignal> {
	const truthTmp = path.resolve(`${goalRecordPath(gateStoreV2Root(stateDir), "goal")}.tmp`);
	const originalWrite = memfs.promises.writeFile.bind(memfs.promises);
	let injected = false;
	memfs.promises.writeFile = (async (candidate, contents, options) => {
		if (!injected && path.resolve(String(candidate)) === truthTmp && String(contents).includes('"status":"bypassed"')) {
			injected = true;
			throw new Error("INJECTED_GATE_V2_CRASH_BEFORE_TRUTH_STAGING");
		}
		return originalWrite(candidate, contents, options as never);
	}) as MemFs["promises"]["writeFile"];
	const bypass = store.bypassGate("goal", "gate", { whyBypassed: reason, whoAmI: "recovery-operator" });
	let error: unknown;
	try {
		await store.flush();
	} catch (caught) {
		error = caught;
	} finally {
		memfs.promises.writeFile = originalWrite as MemFs["promises"]["writeFile"];
	}
	expect(injected, `truth-staging fault was not reached: ${String(error)}`).toBe(true);
	expect(String(error)).toContain("INJECTED_GATE_V2_CRASH_BEFORE_TRUTH_STAGING");
	expect(readGoalRecord().gates.find(gate => gate.gateId === "gate")?.status).toBe("pending");
	expect(readHistory().signals.some(row => row.id === bypass.id)).toBe(true);
	expect(bypassAuditFiles()).toEqual([]);
	return bypass;
}

type RecoveryCrashPhase = "before-truth-rename" | "before-audit-rename";

function injectRecoveryCrash(phase: RecoveryCrashPhase): { restore: () => void; truthWasDurableAtAudit: () => boolean } {
	const finalTruth = path.resolve(goalRecordPath(gateStoreV2Root(stateDir), "goal"));
	const auditRoot = path.resolve(path.join(gateStoreV2Root(stateDir), "audit"));
	const originalRename = memfs.renameSync.bind(memfs);
	let injected = false;
	let truthWasDurable = false;
	memfs.renameSync = ((from, to) => {
		const source = path.resolve(String(from));
		const destination = path.resolve(String(to));
		if (!injected && phase === "before-truth-rename" && destination === finalTruth && source.endsWith(".tmp")) {
			injected = true;
			throw new Error("INJECTED_GATE_V2_RECOVERY_BEFORE_TRUTH_RENAME");
		}
		const relativeAudit = path.relative(auditRoot, destination);
		if (!injected && phase === "before-audit-rename" && relativeAudit !== "" && !relativeAudit.startsWith("..") && !path.isAbsolute(relativeAudit) && destination.endsWith(".json")) {
			truthWasDurable = readGoalRecord().gates.find(gate => gate.gateId === "gate")?.status === "bypassed";
			injected = true;
			throw new Error("INJECTED_GATE_V2_RECOVERY_BEFORE_AUDIT_RENAME");
		}
		return originalRename(from, to);
	}) as MemFs["renameSync"];
	return {
		restore: () => { memfs.renameSync = originalRename as MemFs["renameSync"]; },
		truthWasDurableAtAudit: () => truthWasDurable,
	};
}

describe("GateStore preload worker bypass repair", () => {
	it("keeps forged bypass metadata as ordinary history without truth repair or audit export", async () => {
		const fixture = writeWorkerBypassFixture("history", 100, false);
		const prepared = await GateStore.prepare(fixture.stateDir);
		const loaded = new GateStore(fixture.stateDir, undefined, prepared.preload);

		expect(loaded.getGate("goal", "gate")).toMatchObject({ status: "pending", updatedAt: 100 });
		expect(loaded.getGate("goal", "gate")!.signals.map(row => row.id)).toContain("forged-worker-signal");
		expect(workerAuditFiles(fixture.stateDir)).toHaveLength(0);
	});

	it.each([
		["embedded", "before-bypass-truth-rename"],
		["embedded", "before-bypass-audit-rename"],
		["embedded", "after-bypass-audit-rename"],
		["history", "before-bypass-truth-rename"],
		["history", "before-bypass-audit-rename"],
		["history", "after-bypass-audit-rename"],
	] as const)("keeps %s audit behind canonical truth across %s", async (source, fault) => {
		const fixture = writeWorkerBypassFixture(source);
		__setGateStoreMigrationWorkerFaultForTests(fixture.stateDir, fault);
		await expect(GateStore.prepare(fixture.stateDir)).rejects.toThrow("INJECTED_GATE_V2_WORKER");

		const interrupted = readWorkerGoal(fixture.stateDir).gates[0]!;
		expect(workerAuditFiles(fixture.stateDir)).toHaveLength(fault === "after-bypass-audit-rename" ? 1 : 0);
		if (fault === "before-bypass-truth-rename") {
			expect(interrupted.status).toBe("pending");
			expect(interrupted.updatedAt).toBe(100);
		} else {
			expect(interrupted.status).toBe("bypassed");
			expect(interrupted.updatedAt).toBe(fixture.signal.timestamp);
		}

		const recovered = await GateStore.prepare(fixture.stateDir);
		const gate = recovered.preload.gates.get("goal::gate")!;
		expect(gate.status).toBe("bypassed");
		expect(gate.updatedAt).toBe(fixture.signal.timestamp);
		expect(gate.signals.filter(row => row.metadata?.bypass === "true").map(row => [row.id, row.persistenceOrdinal])).toEqual([[fixture.signal.id, 7]]);
		expect(workerAuditFiles(fixture.stateDir)).toHaveLength(1);
		expect(recovered.preload.auditPayloadRefs.has(fixture.payloadHash)).toBe(true);
		expect(recovered.preload.partitionPayloadRefs.get("goal::gate")?.has(fixture.payloadHash)).toBe(false);
		expect(fs.existsSync(fixture.signal.contentRef!.path)).toBe(true);
		expect(readWorkerGoal(fixture.stateDir).gates[0]!.signals).toEqual([]);
		if (source === "history") {
			const history = JSON.parse(fs.readFileSync(historyRecordPath(gateStoreV2Root(fixture.stateDir), "goal", "gate"), "utf8")) as GateStoreV2HistoryRecord;
			expect(history.signals).toEqual([]);
		}

		const auditIdentity = workerAuditFiles(fixture.stateDir);
		const restarted = await GateStore.prepare(fixture.stateDir);
		expect(workerAuditFiles(fixture.stateDir)).toEqual(auditIdentity);
		expect(restarted.preload.gates.get("goal::gate")!.signals.filter(row => row.id === fixture.signal.id)).toHaveLength(1);
		expect(restarted.preload.auditPayloadRefs.has(fixture.payloadHash)).toBe(true);
	});

	it("keeps stable audit identity and ordinal order while repairing one goal truth shard", async () => {
		const fixture = writeWorkerBypassFixture("history");
		const historyFile = historyRecordPath(gateStoreV2Root(fixture.stateDir), "goal", "gate");
		const history = JSON.parse(fs.readFileSync(historyFile, "utf8")) as GateStoreV2HistoryRecord;
		const earlier = structuredClone(fixture.signal);
		earlier.id = "bypass-worker-earlier";
		earlier.timestamp = 150;
		earlier.metadata!.bypassedAt = "150";
		earlier.persistenceOrdinal = 3;
		history.signals = [fixture.signal, earlier];
		fs.writeFileSync(historyFile, JSON.stringify(history), "utf8");

		const prepared = await GateStore.prepare(fixture.stateDir);
		const gate = prepared.preload.gates.get("goal::gate")!;
		expect(gate.status).toBe("bypassed");
		expect(gate.updatedAt).toBe(fixture.signal.timestamp);
		expect(gate.signals.filter(row => row.metadata?.bypass === "true").map(row => [row.id, row.persistenceOrdinal])).toEqual([
			[earlier.id, 3],
			[fixture.signal.id, 7],
		]);
		expect(workerAuditFiles(fixture.stateDir).map(file => file.slice(0, 16))).toEqual([String(3).padStart(16, "0"), String(7).padStart(16, "0")]);
		const identities = workerAuditFiles(fixture.stateDir);
		const restarted = await GateStore.prepare(fixture.stateDir);
		expect(workerAuditFiles(fixture.stateDir)).toEqual(identities);
		expect(restarted.preload.gates.get("goal::gate")!.signals.filter(row => row.metadata?.bypass === "true")).toHaveLength(2);
	});

	it("repairs audit-first legacy worker state but preserves a newer pending reset", async () => {
		const interrupted = writeWorkerBypassFixture("audit");
		const repaired = await GateStore.prepare(interrupted.stateDir);
		expect(repaired.preload.gates.get("goal::gate")?.status).toBe("bypassed");
		expect(readWorkerGoal(interrupted.stateDir).gates[0]?.updatedAt).toBe(interrupted.signal.timestamp);
		expect(workerAuditFiles(interrupted.stateDir)).toHaveLength(1);
		expect(repaired.preload.auditPayloadRefs.has(interrupted.payloadHash)).toBe(true);

		const reset = writeWorkerBypassFixture("history", 300);
		const preserved = await GateStore.prepare(reset.stateDir);
		const gate = preserved.preload.gates.get("goal::gate")!;
		expect(gate.status).toBe("pending");
		expect(gate.updatedAt).toBe(300);
		expect(gate.signals.filter(row => row.metadata?.bypass === "true").map(row => row.persistenceOrdinal)).toEqual([7]);
		expect(workerAuditFiles(reset.stateDir)).toHaveLength(1);
	});
});

describe("GateStore v2 retention", () => {
	it("separates exactly 32 hot rows while preserving FIFO order and stable ordinals", async () => {
		store.initGatesForGoal("goal", ["gate"]);
		for (let index = 0; index < 40; index++) store.recordSignal(signal(index));
		await store.flush();

		const record = readGoalRecord();
		const history = readHistory();
		expect(record.gates[0]!.signals).toHaveLength(0);
		expect(record.history).toEqual({});
		expect(history.signals.map(row => row.id)).toEqual(Array.from({ length: 40 }, (_, index) => `signal-${index}`));
		const reloaded = new GateStore(stateDir, memfs).getGate("goal", "gate")!;
		expect(reloaded.signals.map(row => row.id)).toEqual(Array.from({ length: 40 }, (_, index) => `signal-${index}`));
		expect(reloaded.signals.map(row => row.persistenceOrdinal)).toEqual(Array.from({ length: 40 }, (_, index) => index));
	});

	it("keeps at most 256 ordinary rows while retaining every bypass and running audit row in original order", async () => {
		store.initGatesForGoal("goal", ["gate"]);
		for (let index = 0; index < 300; index++) store.recordSignal(signal(index));
		for (let index = 300; index < 303; index++) {
			store.recordSignal(signal(index, {
				id: `bypass-${index}`,
				commitSha: "",
				sessionId: "human-bypass",
				metadata: { bypass: "true", whyBypassed: `reason-${index}`, whoAmI: "operator", bypassedAt: String(1_700_000_000_000 + index) },
				verification: { status: "passed", steps: [] },
			}));
		}
		for (let index = 303; index < 305; index++) {
			store.recordSignal(signal(index, { verification: { status: "running", steps: [{ name: "unit", type: "command", passed: false, status: "running", output: "running", duration_ms: 0 }] } }));
		}
		await store.flush();

		const gate = store.getGate("goal", "gate")!;
		const ordinary = gate.signals.filter(row => row.metadata?.bypass !== "true" && row.verification.status !== "running");
		expect(ordinary).toHaveLength(GATE_STORE_ORDINARY_SIGNAL_LIMIT);
		expect(ordinary[0]!.id).toBe("signal-44");
		expect(gate.signals.filter(row => row.metadata?.bypass === "true").map(row => row.id)).toEqual(["bypass-300", "bypass-301", "bypass-302"]);
		expect(gate.signals.filter(row => row.verification.status === "running").map(row => row.id)).toEqual(["signal-303", "signal-304"]);
		expect(gate.signals.map(row => row.persistenceOrdinal)).toEqual(Array.from({ length: gate.signals.length }, (_, index) => index + 44));
		expect(gate.earliestRetainedOrdinal).toBe(44);
		expect(gate.prunedSignalRanges).toHaveLength(1);
		expect(gate.prunedSignalRanges![0]).toMatchObject({ from: 0, to: 43, reason: "count" });
		const metrics = store.getPersistenceMetrics();
		expect(metrics).toMatchObject({ compactions: 1, prunedSignals: 44 });
		expect(metrics.prunedBytes).toBeGreaterThan(0);

		const reloaded = new GateStore(stateDir, memfs).getGate("goal", "gate")!;
		expect(reloaded.signals.map(row => row.id)).toEqual(gate.signals.map(row => row.id));
		expect(reloaded.prunedSignalRanges).toEqual(gate.prunedSignalRanges);
	});

	it("enforces the 8 MiB ordinary-history boundary as a newest FIFO suffix", () => {
		const rows = Array.from({ length: 36 }, (_, index) => signal(index, {
			content: `${index}:`.padEnd(300 * 1024, String(index % 10)),
		}));
		const retained = enforceOrdinaryRetention(rows);
		expect(retained.stats.compacted).toBe(true);
		expect(retained.stats.prunedSignals).toBeGreaterThan(0);
		expect(ordinaryBytes(retained.signals)).toBeLessThanOrEqual(GATE_STORE_ORDINARY_BYTES_LIMIT);
		const first = Number(retained.signals[0]!.id.slice("signal-".length));
		expect(retained.signals.map(row => row.id)).toEqual(Array.from({ length: 36 - first }, (_, offset) => `signal-${first + offset}`));
	});

	it("allows cache-safe misses rather than exceeding the byte cap and never manufactures a false cache hit", () => {
		const rows = Array.from({ length: GATE_STORE_HOT_SIGNAL_LIMIT }, (_, index) => signal(index, {
			content: `${index}:`.padEnd(300 * 1024, "c"),
			verification: {
				status: "passed",
				steps: [{ name: "unit", type: "command", passed: true, status: "passed", output: `passed-${index}`, duration_ms: 1 }],
			},
		}));
		const retained = enforceOrdinaryRetention(rows);
		expect(ordinaryBytes(retained.signals), "protected cache projections must still obey the absolute 8 MiB cap").toBeLessThanOrEqual(GATE_STORE_ORDINARY_BYTES_LIMIT);
		expect(retained.signals.length).toBeLessThan(rows.length);
		const retainedCommits = new Set(retained.signals.map(row => row.commitSha));
		for (const row of rows) {
			const cache = buildStepCache(retained.signals, "current", row.commitSha);
			expect(cache.has("unit")).toBe(retainedCommits.has(row.commitSha));
		}
		expect(buildStepCache(retained.signals, "current", "never-recorded").size).toBe(0);
	});

	it("retains only the newest 32 distinct cache projections, safely misses pruned commits, and honors invalidation", () => {
		const passed = Array.from({ length: 33 }, (_, index) => signal(index, {
			verification: { status: "passed", steps: [{ name: "unit", type: "command", passed: true, status: "passed", output: `passed-${index}`, duration_ms: 1 }] },
		}));
		const failures = Array.from({ length: 256 }, (_, offset) => signal(33 + offset));
		const retained = enforceOrdinaryRetention([...passed, ...failures]);
		expect(retained.signals).toHaveLength(GATE_STORE_ORDINARY_SIGNAL_LIMIT);
		expect(buildStepCache(retained.signals, "current", "commit-0").size).toBe(0);
		expect(buildStepCache(retained.signals, "current", "commit-1").get("unit")?.output).toBe("passed-1");
		expect(buildStepCache(retained.signals, "current", "commit-32").get("unit")?.output).toBe("passed-32");
		expect(buildStepCache(retained.signals, "current", "commit-32", passed[32]!.timestamp).size).toBe(0);
		expect(buildStepCache(retained.signals, "current", "commit-never").size).toBe(0);
	});

	it("externalizes an unbounded bypass audit while keeping its hot shard and later writes bounded", async () => {
		store.initGatesForGoal("goal", ["gate"]);
		const bypassCount = 40;
		for (let index = 0; index < bypassCount; index++) {
			const reason = `BYPASS_AUDIT_REASON_${String(index).padStart(2, "0")}:`.padEnd(256 * 1024, String(index % 10));
			store.recordSignal(signal(index, {
				id: `bypass-audit-${index}`,
				commitSha: "",
				sessionId: "human-bypass",
				content: reason,
				metadata: {
					bypass: "true",
					whyBypassed: reason,
					whoAmI: "operator",
					bypassedAt: String(1_700_000_000_000 + index),
				},
				verification: { status: "passed", steps: [] },
			}));
		}
		await store.flush();

		const hotShard = goalRecordPath(gateStoreV2Root(stateDir), "goal");
		const initialShardBytes = memfs.statSync(hotShard).size;
		const initialAuxiliary = new Map(
			[...memfs.files.entries()].filter(([file]) => file !== path.resolve(hotShard)),
		);
		const restarted = new GateStore(stateDir, memfs);
		const audit = restarted.getGate("goal", "gate")!.signals.filter(row => row.metadata?.bypass === "true");
		// Injected in-memory filesystems are intentionally not scanned on the
		// gateway thread. Audit persistence itself is pinned above and its live
		// counters remain available without a maintenance traversal.
		const reportJson = JSON.stringify(restarted.getPersistenceMetrics());

		restarted.updateGateMetadata("goal", "gate", { laterMutation: "true" });
		await restarted.flush();
		const rewrittenAuxiliary = [...initialAuxiliary].filter(([file, contents]) => memfs.files.get(file) !== contents);
		const failures: string[] = [];
		if (initialShardBytes > GATE_STORE_ORDINARY_BYTES_LIMIT) {
			failures.push(`GATE_V2_BYPASS_HOT_SHARD_UNBOUNDED: ${bypassCount} bypass rows produced a ${initialShardBytes}-byte hot shard`);
		}
		if (audit.length !== bypassCount) {
			failures.push(`GATE_V2_BYPASS_AUDIT_LOST: expected ${bypassCount} retained audit rows after restart, got ${audit.length}`);
		}
		if (audit.some((row, index) => row.persistenceOrdinal !== index)) {
			failures.push(`GATE_V2_BYPASS_AUDIT_ORDINAL_DRIFT: ${audit.map(row => row.persistenceOrdinal).join(",")}`);
		}
		if (rewrittenAuxiliary.length > 0) {
			failures.push(`GATE_V2_BYPASS_PRIOR_AUDIT_REWRITTEN: later ordinary mutation rewrote ${rewrittenAuxiliary.map(([file]) => path.basename(file)).join(",")}`);
		}
		if (!/audit/i.test(reportJson) || !/bypass/i.test(reportJson)) {
			failures.push("GATE_V2_BYPASS_MAINTENANCE_TOTAL_MISSING: maintenance must report bypass audit bytes/count separately");
		}
		expect(failures, failures.join("\n")).toEqual([]);
	});

	it.each([
		"before-shard-rename",
		"after-shard-before-audit",
		"after-audit-before-cleanup",
	] as const)("recovers one bounded, dependency-satisfying bypass after a crash %s", async (phase) => {
		store.initGatesForGoal("goal", ["gate", "dependent"]);
		for (let index = 0; index < 40; index++) store.recordSignal(signal(index));
		await store.flush();

		const reason = "CRASH_WINDOW_BYPASS_REASON:".padEnd(256 * 1024, "r");
		const actor = "crash-window-operator";
		const crash = injectBypassCrash(phase);
		const expected = store.bypassGate("goal", "gate", { whyBypassed: reason, whoAmI: actor });
		let crashError: unknown;
		try {
			await store.flush();
		} catch (error) {
			crashError = error;
		} finally {
			crash.restore();
		}
		const injectedCrash = String(crashError).includes("INJECTED_GATE_V2_CRASH");
		const shardWasPublishedBeforeAudit = crash.shardWasPublishedBeforeAudit();

		const restarted = new GateStore(stateDir, memfs);
		const firstGate = restarted.getGate("goal", "gate")!;
		const firstAudit = firstGate.signals.filter(row => row.metadata?.bypass === "true");
		const firstAuditFiles = bypassAuditFiles();
		const firstPayloadFiles = payloadFiles();
		const firstRow = firstAudit[0];
		const firstRefs = firstRow && {
			contentRef: firstRow.contentRef,
			bypassReasonRef: firstRow.bypassReasonRef,
			auditMetadataRefs: firstRow.auditMetadataRefs,
		};

		// A second restart is the idempotence check: recovery must neither append a
		// duplicate logical row nor republish its immutable audit/payload files.
		const restartedAgain = new GateStore(stateDir, memfs);
		const gate = restartedAgain.getGate("goal", "gate")!;
		const audit = gate.signals.filter(row => row.metadata?.bypass === "true");
		const row = audit[0];
		const record = readGoalRecord();
		const persistedGate = record.gates.find(candidate => candidate.gateId === "gate")!;
		const persistedHistory = readHistory();
		const ordinaryIds = gate.signals.filter(candidate => candidate.metadata?.bypass !== "true").map(candidate => candidate.id);
		const dependencyResult = checkGateDependencies("dependent", [
			{ id: "gate", name: "Gate", dependsOn: [] },
			{ id: "dependent", name: "Dependent", dependsOn: ["gate"] },
		], restartedAgain.getGatesForGoal("goal"));
		const failures: string[] = [];

		if (!injectedCrash) failures.push(`GATE_V2_BYPASS_CRASH_NOT_INJECTED_${phase}: ${String(crashError)}`);
		if (phase !== "before-shard-rename" && !shardWasPublishedBeforeAudit) failures.push(`GATE_V2_BYPASS_WRONG_PUBLICATION_ORDER_${phase}`);
		if (gate.status !== "bypassed") failures.push(`GATE_V2_BYPASS_TRUTH_LOST_${phase}: status=${gate.status}`);
		if (firstAudit.length !== 1 || audit.length !== 1) failures.push(`GATE_V2_BYPASS_AUDIT_CARDINALITY_${phase}: first=${firstAudit.length} second=${audit.length}`);
		if (row?.id !== expected.id) failures.push(`GATE_V2_BYPASS_ID_DRIFT_${phase}: expected=${expected.id} actual=${row?.id}`);
		if (row?.persistenceOrdinal !== 40) failures.push(`GATE_V2_BYPASS_ORDINAL_DRIFT_${phase}: expected=40 actual=${row?.persistenceOrdinal}`);
		if (row?.metadata?.whyBypassed !== reason.slice(0, 16 * 1024) || row?.metadata?.whyBypassedTruncated !== "true") failures.push(`GATE_V2_BYPASS_REASON_PREVIEW_LOST_${phase}`);
		if (row?.metadata?.whoAmI !== actor || row?.metadata?.bypassedAt !== expected.metadata?.bypassedAt) failures.push(`GATE_V2_BYPASS_ACTOR_AUDIT_LOST_${phase}`);
		if (row?.content !== "" || !row?.contentRef || !row.bypassReasonRef || !row.auditMetadataRefs?.whyBypassed) failures.push(`GATE_V2_BYPASS_PAYLOAD_REFS_LOST_${phase}`);
		if (row?.contentRef && (!memfs.existsSync(row.contentRef.path) || memfs.readFileSync(row.contentRef.path, "utf8") !== reason)) failures.push(`GATE_V2_BYPASS_PAYLOAD_UNREADABLE_${phase}`);
		if (JSON.stringify({ contentRef: row?.contentRef, bypassReasonRef: row?.bypassReasonRef, auditMetadataRefs: row?.auditMetadataRefs }) !== JSON.stringify(firstRefs)) failures.push(`GATE_V2_BYPASS_PAYLOAD_REFS_DRIFT_${phase}`);
		if (ordinaryIds.join(",") !== Array.from({ length: 40 }, (_, index) => `signal-${index}`).join(",")) failures.push(`GATE_V2_BYPASS_HISTORY_DRIFT_${phase}: ${ordinaryIds.join(",")}`);
		if (dependencyResult !== null) failures.push(`GATE_V2_BYPASS_DEPENDENCY_BLOCKED_${phase}: ${dependencyResult}`);
		if (persistedGate.signals.length > 0) failures.push(`GATE_V2_BYPASS_TRUTH_EMBEDDED_HISTORY_${phase}: ${persistedGate.signals.length}`);
		if (persistedHistory.signals.filter(row => row.metadata?.bypass !== "true").length > GATE_STORE_ORDINARY_SIGNAL_LIMIT) failures.push(`GATE_V2_BYPASS_HISTORY_UNBOUNDED_${phase}: ${persistedHistory.signals.length}`);
		if (memfs.statSync(goalRecordPath(gateStoreV2Root(stateDir), "goal")).size > GATE_STORE_ORDINARY_BYTES_LIMIT) failures.push(`GATE_V2_BYPASS_SHARD_BYTES_UNBOUNDED_${phase}`);
		if (JSON.stringify(record).includes(reason)) failures.push(`GATE_V2_BYPASS_BODY_REINLINED_${phase}`);
		if (firstAuditFiles.join(",") !== bypassAuditFiles().join(",") || bypassAuditFiles().length !== 1) failures.push(`GATE_V2_BYPASS_AUDIT_REPUBLISHED_${phase}`);
		if (firstPayloadFiles.join(",") !== payloadFiles().join(",")) failures.push(`GATE_V2_BYPASS_PAYLOAD_REPUBLISHED_${phase}`);
		if ([...memfs.files.keys()].some(file => file.endsWith(".tmp") || file.endsWith(".gates.json"))) failures.push(`GATE_V2_BYPASS_RECOVERY_CLEANUP_INCOMPLETE_${phase}`);
		expect(failures, failures.join("\n")).toEqual([]);
	});

	it.each([
		"before-truth-rename",
		"before-audit-rename",
	] as const)("recovers a history-first bypass without exposing audit ahead of truth %s", async (phase) => {
		store.initGatesForGoal("goal", ["gate"]);
		await store.flush();
		const reason = "HISTORY_FIRST_RECOVERY_REASON:".padEnd(128 * 1024, "h");
		const expected = await interruptBypassBeforeTruth(reason);
		const crash = injectRecoveryCrash(phase);
		let recoveryError: unknown;
		try {
			new GateStore(stateDir, memfs);
		} catch (error) {
			recoveryError = error;
		} finally {
			crash.restore();
		}

		expect(String(recoveryError)).toContain("INJECTED_GATE_V2_RECOVERY");
		if (phase === "before-truth-rename") {
			expect(readGoalRecord().gates.find(gate => gate.gateId === "gate")?.status).toBe("pending");
			expect(bypassAuditFiles()).toEqual([]);
		} else {
			expect(crash.truthWasDurableAtAudit()).toBe(true);
			expect(readGoalRecord().gates.find(gate => gate.gateId === "gate")?.status).toBe("bypassed");
			expect(bypassAuditFiles()).toEqual([]);
		}

		const restarted = new GateStore(stateDir, memfs);
		const gate = restarted.getGate("goal", "gate")!;
		const audit = gate.signals.filter(row => row.metadata?.bypass === "true");
		expect(gate.status).toBe("bypassed");
		expect(audit.map(row => row.id)).toEqual([expected.id]);
		expect(audit[0]?.contentRef && memfs.readFileSync(audit[0].contentRef.path, "utf8")).toBe(reason);
		expect(bypassAuditFiles()).toHaveLength(1);
		expect(readHistory().signals.some(row => row.metadata?.bypass === "true")).toBe(false);
		expect([...memfs.files.keys()].some(file => file.endsWith(".tmp") || file.endsWith(".gates.json"))).toBe(false);
	});

	it("transfers a promoted audit's shared managed refs before later reclaim", async () => {
		store.initGatesForGoal("goal", ["gate"]);
		store.initGatesForGoal("owner", ["shared", "unique"]);
		const shared = "SHARED_PROMOTED_AUDIT_BODY:".padEnd(96 * 1024, "s");
		const unique = "UNIQUE_RECLAIMABLE_BODY:".padEnd(96 * 1024, "u");
		store.recordSignal(signal(0, { id: "owner-shared", goalId: "owner", gateId: "shared", verification: { status: "failed", steps: [{ name: "unit", type: "command", passed: false, status: "failed", output: shared, duration_ms: 1 }] } }));
		store.recordSignal(signal(1, { id: "owner-unique", goalId: "owner", gateId: "unique", verification: { status: "failed", steps: [{ name: "unit", type: "command", passed: false, status: "failed", output: unique, duration_ms: 1 }] } }));
		await store.flush();
		const expected = await interruptBypassBeforeTruth(shared);
		expect(payloadFiles()).toHaveLength(2);

		const restarted = new GateStore(stateDir, memfs);
		const row = restarted.getGate("goal", "gate")!.signals.find(candidate => candidate.id === expected.id)!;
		const sharedPath = row.contentRef!.path;
		expect(memfs.readFileSync(sharedPath, "utf8")).toBe(shared);
		restarted.removeGoalGates("owner");
		restarted.updateGateMetadata("goal", "gate", { laterMutation: "true" });
		await restarted.flush();

		expect(payloadFiles()).toHaveLength(1);
		expect(memfs.existsSync(sharedPath)).toBe(true);
		expect(memfs.readFileSync(sharedPath, "utf8")).toBe(shared);
		expect(restarted.getGate("goal", "gate")?.status).toBe("bypassed");
		expect(bypassAuditFiles()).toHaveLength(1);
		expect(new GateStore(stateDir, memfs).getGate("goal", "gate")?.signals.filter(candidate => candidate.id === expected.id)).toHaveLength(1);
	});

	it("rewrites only one gate history partition within a history-heavy goal", async () => {
		store.initGatesForGoal("goal", ["gate-a", "gate-b", "gate-c"]);
		for (const gateId of ["gate-a", "gate-b", "gate-c"]) {
			for (let index = 0; index < 40; index++) store.recordSignal(signal(index, { id: `${gateId}-${index}`, gateId }));
		}
		await store.flush();
		const root = gateStoreV2Root(stateDir);
		const siblingB = memfs.readFileSync(historyRecordPath(root, "goal", "gate-b"), "utf8");
		const siblingC = memfs.readFileSync(historyRecordPath(root, "goal", "gate-c"), "utf8");

		store.recordSignal(signal(40, { id: "gate-a-40", gateId: "gate-a" }));
		await store.flush();

		expect(memfs.readFileSync(historyRecordPath(root, "goal", "gate-b"), "utf8")).toBe(siblingB);
		expect(memfs.readFileSync(historyRecordPath(root, "goal", "gate-c"), "utf8")).toBe(siblingC);
		expect((JSON.parse(memfs.readFileSync(goalRecordPath(root, "goal"), "utf8") as string) as GateStoreV2GoalRecord).gates.every(gate => gate.signals.length === 0)).toBe(true);
	});

	it("garbage-collects a managed payload only after every goal-shard reference is gone", async () => {
		store.initGatesForGoal("goal-a", ["gate"]);
		store.initGatesForGoal("goal-b", ["gate"]);
		const shared = "shared managed output".repeat(1024);
		store.recordSignal(signal(0, { goalId: "goal-a", verification: { status: "failed", steps: [{ name: "unit", type: "command", passed: false, status: "failed", output: shared, duration_ms: 1 }] } }));
		store.recordSignal(signal(1, { goalId: "goal-b", verification: { status: "failed", steps: [{ name: "unit", type: "command", passed: false, status: "failed", output: shared, duration_ms: 1 }] } }));
		await store.flush();
		expect(payloadFiles()).toHaveLength(1);

		store.removeGoalGates("goal-a");
		await store.flush();
		expect(payloadFiles()).toHaveLength(1);
		store.removeGoalGates("goal-b");
		await store.flush();
		expect(payloadFiles()).toHaveLength(0);
		expect(store.getPersistenceMetrics().reclaimedPayloadBytes).toBe(Buffer.byteLength(shared));
	});
});
