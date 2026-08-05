import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import {
	GATE_STORE_HOT_SIGNAL_LIMIT,
	GATE_STORE_ORDINARY_BYTES_LIMIT,
	GATE_STORE_ORDINARY_SIGNAL_LIMIT,
	enforceOrdinaryRetention,
	gateStoreV2Root,
	goalRecordPath,
	type GateStoreV2GoalRecord,
} from "../../src/server/agent/gate-store-v2-persistence.js";
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
