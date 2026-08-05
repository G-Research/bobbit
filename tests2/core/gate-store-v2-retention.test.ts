import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import {
	GATE_STORE_HOT_SIGNAL_LIMIT,
	GATE_STORE_ORDINARY_BYTES_LIMIT,
	GATE_STORE_ORDINARY_SIGNAL_LIMIT,
	bypassAuditDirectory,
	enforceOrdinaryRetention,
	gateStoreV2Root,
	goalRecordPath,
	type GateStoreV2GoalRecord,
} from "../../src/server/agent/gate-store-v2-persistence.js";
import { checkGateDependencies } from "../../src/server/agent/gate-dependency-check.js";
import { buildStepCache } from "../../src/server/agent/verification-logic.js";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

let sequence = 0;
let memfs: MemFs;
let stateDir: string;
let store: GateStore;

beforeEach(() => {
	memfs = createMemFs();
	stateDir = path.resolve("/memfs/gate-v2-retention", `case-${sequence++}`);
	memfs.mkdirSync(stateDir, { recursive: true });
	store = new GateStore(stateDir, memfs);
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

function payloadFiles(): string[] {
	const root = path.join(gateStoreV2Root(stateDir), "payloads");
	if (!memfs.existsSync(root)) return [];
	return (memfs.readdirSync(root) as string[]).flatMap(prefix => (memfs.readdirSync(path.join(root, prefix)) as string[]).map(file => path.join(prefix, file)));
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

describe("GateStore v2 retention", () => {
	it("separates exactly 32 hot rows while preserving FIFO order and stable ordinals", async () => {
		store.initGatesForGoal("goal", ["gate"]);
		for (let index = 0; index < 40; index++) store.recordSignal(signal(index));
		await store.flush();

		const record = readGoalRecord();
		expect(record.gates[0]!.signals).toHaveLength(GATE_STORE_HOT_SIGNAL_LIMIT);
		expect(record.gates[0]!.signals.map(row => row.id)).toEqual(Array.from({ length: 32 }, (_, offset) => `signal-${offset + 8}`));
		expect(record.history.gate.map(row => row.id)).toEqual(Array.from({ length: 8 }, (_, index) => `signal-${index}`));
		const reloaded = new GateStore(stateDir, memfs).getGate("goal", "gate")!;
		expect(reloaded.signals.map(row => row.id)).toEqual(Array.from({ length: 40 }, (_, index) => `signal-${index}`));
		expect(reloaded.signals.map(row => row.persistenceOrdinal)).toEqual(Array.from({ length: 40 }, (_, index) => index));
	});

	it("keeps at most 256 ordinary rows while retaining every bypass and running audit row in original order", async () => {
		store.initGatesForGoal("goal", ["gate"]);
		for (let index = 0; index < 300; index++) store.recordSignal(signal(index));
		for (let index = 300; index < 303; index++) {
			store.recordSignal(signal(index, {
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
		expect(gate.signals.filter(row => row.metadata?.bypass === "true").map(row => row.id)).toEqual(["signal-300", "signal-301", "signal-302"]);
		expect(gate.signals.filter(row => row.verification.status === "running").map(row => row.id)).toEqual(["signal-303", "signal-304"]);
		expect(gate.signals.map(row => row.persistenceOrdinal)).toEqual(gate.signals.map(row => Number(row.id.slice("signal-".length))));
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
		const report = restarted.getMaintenanceReport() as unknown as Record<string, unknown>;
		const reportJson = JSON.stringify(report);

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
		if (persistedGate.signals.length > GATE_STORE_HOT_SIGNAL_LIMIT) failures.push(`GATE_V2_BYPASS_HOT_HISTORY_UNBOUNDED_${phase}: ${persistedGate.signals.length}`);
		if ((record.history.gate?.length ?? 0) > GATE_STORE_ORDINARY_SIGNAL_LIMIT) failures.push(`GATE_V2_BYPASS_COLD_HISTORY_UNBOUNDED_${phase}: ${record.history.gate?.length}`);
		if (memfs.statSync(goalRecordPath(gateStoreV2Root(stateDir), "goal")).size > GATE_STORE_ORDINARY_BYTES_LIMIT) failures.push(`GATE_V2_BYPASS_SHARD_BYTES_UNBOUNDED_${phase}`);
		if (JSON.stringify(record).includes(reason)) failures.push(`GATE_V2_BYPASS_BODY_REINLINED_${phase}`);
		if (firstAuditFiles.join(",") !== bypassAuditFiles().join(",") || bypassAuditFiles().length !== 1) failures.push(`GATE_V2_BYPASS_AUDIT_REPUBLISHED_${phase}`);
		if (firstPayloadFiles.join(",") !== payloadFiles().join(",")) failures.push(`GATE_V2_BYPASS_PAYLOAD_REPUBLISHED_${phase}`);
		if ([...memfs.files.keys()].some(file => file.endsWith(".tmp") || file.endsWith(".gates.json"))) failures.push(`GATE_V2_BYPASS_RECOVERY_CLEANUP_INCOMPLETE_${phase}`);
		expect(failures, failures.join("\n")).toEqual([]);
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
