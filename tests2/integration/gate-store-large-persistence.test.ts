import { afterEach, assert, describe, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

import { GateStore } from "../../src/server/agent/gate-store.js";
import { gateStoreV2Root, goalRecordPath } from "../../src/server/agent/gate-store-v2-persistence.js";
import { realFs, type FsLike } from "../../src/server/gateway-deps.js";

const MIB = 1024 * 1024;
const LEGACY_FIXTURE_MIN_BYTES = 280 * MIB;
const HEARTBEAT_INTERVAL_MS = 5;
const HEARTBEAT_WARMUP_MS = 100;
const MAX_EVENT_LOOP_LAG_MS = 75;
const TARGET_GOAL_ID = "large-store-target-goal";
const UNRELATED_GOAL_ID = "large-store-unrelated-goal";
const GATES_PER_GOAL = 4;
const SIGNALS_PER_GATE = 140;
const tempRoots: string[] = [];

type RecordedWrite = {
	file: string;
	bytes: number;
	boundedTailSample: string;
};

type PayloadIo = {
	operation: "read" | "write";
	file: string;
	bytes: number;
};

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function asciiPayload(marker: string, bytes: number): string {
	return `${marker}\n${marker[0]!.repeat(bytes - marker.length - 1)}`;
}

const commandOutput = asciiPayload("COMMAND_OUTPUT", 96 * 1024);
const reviewArtifact = asciiPayload("REVIEW_ARTIFACT", 96 * 1024);
const diagnosticArtifact = asciiPayload("DIAGNOSTIC_ARTIFACT", 64 * 1024);

function signalJson(goalId: string, gateId: string, ordinal: number): string {
	const signalId = `${goalId}-${gateId}-signal-${String(ordinal).padStart(4, "0")}`;
	return JSON.stringify({
		id: signalId,
		gateId,
		goalId,
		sessionId: "fixture-verifier",
		timestamp: 1_700_000_000_000 + ordinal,
		commitSha: "0123456789abcdef0123456789abcdef01234567",
		content: `Signal ${ordinal} content`,
		metadata: { fixture: "production-scale", ordinal: String(ordinal) },
		verification: {
			status: "failed",
			steps: [
				{
					name: "large command",
					type: "command",
					passed: false,
					status: "failed",
					output: commandOutput,
					duration_ms: 12_345,
					diagnostics: {
						type: "retained-command-diagnostics",
						baseDir: `/retained/${goalId}/${gateId}/${signalId}`,
						artifacts: [{
							path: `/retained/${goalId}/${gateId}/${signalId}/error-context.md`,
							relativePath: "test-results/error-context.md",
							sourcePath: `/worktree/test-results/${signalId}/error-context.md`,
							bytes: 64 * 1024,
							kind: "test-results",
							content: diagnosticArtifact,
							contentType: "text/markdown",
						}],
						createdAt: 1_700_000_000_000 + ordinal,
					},
				},
				{
					name: "large review",
					type: "llm-review",
					passed: false,
					status: "failed",
					output: "Review found a deterministic fixture issue.",
					duration_ms: 2_345,
					artifact: {
						content: reviewArtifact,
						contentType: "text/html",
						metadata: { title: "Production-scale review" },
					},
				},
			],
		},
	});
}

async function writeChunk(stream: fs.WriteStream, chunk: string): Promise<number> {
	if (!stream.write(chunk, "utf8")) {
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				stream.off("drain", onDrain);
				stream.off("error", onError);
			};
			const onDrain = () => { cleanup(); resolve(); };
			const onError = (error: Error) => { cleanup(); reject(error); };
			stream.once("drain", onDrain);
			stream.once("error", onError);
		});
	}
	return Buffer.byteLength(chunk);
}

/**
 * Streams small, independently serialized signal records. The test never builds
 * or stringifies the complete production-scale fixture in JavaScript memory.
 */
async function streamLegacyGateFixture(file: string): Promise<{ totalBytes: number; unrelatedBytes: number }> {
	const stream = fs.createWriteStream(file, { encoding: "utf8", highWaterMark: MIB });
	let totalBytes = 0;
	let unrelatedBytes = 0;
	const write = async (chunk: string, unrelated: boolean): Promise<void> => {
		const bytes = await writeChunk(stream, chunk);
		totalBytes += bytes;
		if (unrelated) unrelatedBytes += bytes;
	};

	try {
		await write("[", false);
		let firstGate = true;
		for (const goalId of [TARGET_GOAL_ID, UNRELATED_GOAL_ID]) {
			const unrelated = goalId === UNRELATED_GOAL_ID;
			for (let gateIndex = 0; gateIndex < GATES_PER_GOAL; gateIndex++) {
				const gateId = `gate-${gateIndex}`;
				await write(`${firstGate ? "" : ","}{"gateId":${JSON.stringify(gateId)},"goalId":${JSON.stringify(goalId)},"status":"failed","currentContent":"# Current gate truth","currentContentVersion":7,"currentMetadata":{"owner":"fixture"},"signals":[`, unrelated);
				firstGate = false;
				for (let signalIndex = 0; signalIndex < SIGNALS_PER_GATE; signalIndex++) {
					await write(`${signalIndex === 0 ? "" : ","}${signalJson(goalId, gateId, signalIndex)}`, unrelated);
				}
				await write(`],"updatedAt":1700000000000}`, unrelated);
			}
		}
		await write("]", false);
		stream.end();
		await finished(stream);
		return { totalBytes, unrelatedBytes };
	} catch (error) {
		stream.destroy();
		throw error;
	}
}

function dataBytes(data: string | NodeJS.ArrayBufferView): number {
	// Every generated fixture and mutation string is ASCII. Avoid adding another
	// full UTF-8 traversal to the event-loop measurement performed by the writer.
	return typeof data === "string" ? data.length : data.byteLength;
}

function boundedDataTailSample(data: string | NodeJS.ArrayBufferView): string {
	// One signal is about 256 KiB, so this bounded sample reaches the final
	// signal identity without scanning or retaining the complete write body.
	const sampleBytes = 384 * 1024;
	if (typeof data === "string") return data.slice(-sampleBytes);
	const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return buffer.subarray(Math.max(0, buffer.length - sampleBytes)).toString("utf8");
}

function recordingFs(writes: RecordedWrite[], payloadIo: PayloadIo[] = []): FsLike {
	return {
		...realFs,
		writeFileSync(file, data, options) {
			if (String(file).includes(`${path.sep}payloads${path.sep}`)) {
				payloadIo.push({ operation: "write", file: path.resolve(String(file)), bytes: dataBytes(data) });
			}
			return fs.writeFileSync(file, data, options as never);
		},
		promises: {
			...realFs.promises,
			writeFile: (async (file: fs.PathLike, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
				writes.push({
					file: path.resolve(String(file)),
					bytes: dataBytes(data),
					boundedTailSample: boundedDataTailSample(data),
				});
				await fs.promises.writeFile(file, data, options as never);
			}) as typeof fs.promises.writeFile,
		},
	};
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function startEventLoopHeartbeat(): {
	warm: () => void;
	stop: () => { maxLagMs: number; samples: number };
} {
	let lastTick = performance.now();
	let maxLagMs = 0;
	let samples = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxLagMs = Math.max(maxLagMs, Math.max(0, now - lastTick - HEARTBEAT_INTERVAL_MS));
		lastTick = now;
		samples++;
	}, HEARTBEAT_INTERVAL_MS);
	return {
		warm: () => {
			lastTick = performance.now();
			maxLagMs = 0;
			samples = 0;
		},
		stop: () => {
			clearInterval(timer);
			return { maxLagMs, samples };
		},
	};
}

describe("production-scale GateStore persistence", () => {
	it("migrates off-thread, then mutates only the target shard without stalling the gateway event loop", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-large-persistence-"));
		tempRoots.push(root);
		const stateDir = path.join(root, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const storeFile = path.join(stateDir, "gates.json");
		const fixture = await streamLegacyGateFixture(storeFile);
		assert.ok(
			fixture.totalBytes >= LEGACY_FIXTURE_MIN_BYTES,
			`fixture must be production-scale: ${fixture.totalBytes} < ${LEGACY_FIXTURE_MIN_BYTES}`,
		);

		const writes: RecordedWrite[] = [];
		const heartbeat = startEventLoopHeartbeat();
		await delay(HEARTBEAT_WARMUP_MS);
		heartbeat.warm();
		// The heartbeat deliberately spans first-open migration. Starting it after
		// GateStore construction would hide the production one-second migration stall.
		const store = new GateStore(stateDir, recordingFs(writes));
		await delay(HEARTBEAT_INTERVAL_MS * 3);
		const migrationLag = heartbeat.stop();
		assert.ok(
			migrationLag.maxLagMs <= MAX_EVENT_LOOP_LAG_MS,
			`GATE_V2_WORKER_MIGRATION_EVENT_LOOP_STALL: production-scale legacy migration exceeded ${MAX_EVENT_LOOP_LAG_MS}ms lag: max=${migrationLag.maxLagMs.toFixed(1)}ms over ${migrationLag.samples} post-warm sample(s)`,
		);
		assert.equal(store.getGatesForGoal(TARGET_GOAL_ID).length, GATES_PER_GOAL);
		assert.equal(store.getGatesForGoal(UNRELATED_GOAL_ID).length, GATES_PER_GOAL);
		writes.length = 0;

		const mutationHeartbeat = startEventLoopHeartbeat();
		await delay(HEARTBEAT_WARMUP_MS);
		mutationHeartbeat.warm();
		store.updateGateMetadata(TARGET_GOAL_ID, "gate-0", { owner: "mutated-target-only" });
		await store.flush();
		await delay(HEARTBEAT_INTERVAL_MS * 3);
		const lag = mutationHeartbeat.stop();

		const targetShard = goalRecordPath(gateStoreV2Root(stateDir), TARGET_GOAL_ID);
		const expectedWrite = path.resolve(`${targetShard}.tmp`);
		const mutationBytes = writes.reduce((sum, write) => sum + write.bytes, 0);
		const failures: string[] = [];
		if (writes.length !== 1 || writes[0]?.file !== expectedWrite) {
			failures.push(`expected one target-goal shard write at ${expectedWrite}; observed ${writes.map(write => write.file).join(", ") || "none"}`);
		}
		if (writes.some(write => write.file.endsWith("gates.json.tmp") || write.boundedTailSample.includes(UNRELATED_GOAL_ID))) {
			failures.push("mutation rewrote the legacy whole store or an unrelated goal shard");
		}
		if (mutationBytes >= fixture.unrelatedBytes || mutationBytes >= MIB) {
			failures.push(`target mutation write was not bounded: ${mutationBytes} bytes; unrelated legacy fixture bytes=${fixture.unrelatedBytes}`);
		}
		if (lag.maxLagMs > MAX_EVENT_LOOP_LAG_MS) {
			failures.push(
				`event loop lag exceeded ${MAX_EVENT_LOOP_LAG_MS}ms: max=${lag.maxLagMs.toFixed(1)}ms over ${lag.samples} post-warm sample(s)`,
			);
		}
		assert.deepEqual(failures, [], failures.join("\n"));
	}, 120_000);

	it("keeps 32 large retained artifacts metadata-only across reload and later same-goal mutation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-large-artifacts-"));
		tempRoots.push(root);
		const stateDir = path.join(root, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const writes: RecordedWrite[] = [];
		const payloadIo: PayloadIo[] = [];
		const measuredFs = recordingFs(writes, payloadIo);
		const store = new GateStore(stateDir, measuredFs);
		store.initGatesForGoal("artifact-goal", ["artifact-gate", "later-mutation"]);
		for (let ordinal = 0; ordinal < 32; ordinal++) {
			const marker = `LARGE_QA_ARTIFACT_${String(ordinal).padStart(2, "0")}`;
			store.recordSignal({
				id: `large-artifact-${ordinal}`,
				gateId: "artifact-gate",
				goalId: "artifact-goal",
				sessionId: `qa-${ordinal}`,
				timestamp: 1_700_000_000_000 + ordinal,
				commitSha: `commit-${ordinal}`,
				verification: {
					status: "passed",
					steps: [{
						name: `qa-${ordinal}`,
						type: "agent-qa",
						passed: true,
						status: "passed",
						output: "passed",
						duration_ms: 1,
						artifact: { content: `${marker}\n${String(ordinal % 10).repeat(MIB)}`, contentType: "text/html" },
					}],
				},
			});
		}
		await store.flush();
		const live = store.getGate("artifact-goal", "artifact-gate")!;
		const liveInlineBytes = live.signals.reduce((sum, row) => sum + Buffer.byteLength(row.verification.steps[0]?.artifact?.content ?? ""), 0);

		payloadIo.length = 0;
		writes.length = 0;
		const reloaded = new GateStore(stateDir, measuredFs);
		const restored = reloaded.getGate("artifact-goal", "artifact-gate")!;
		const restoredInlineBytes = restored.signals.reduce((sum, row) => sum + Buffer.byteLength(row.verification.steps[0]?.artifact?.content ?? ""), 0);
		const failures: string[] = [];
		if (liveInlineBytes !== 0 || restoredInlineBytes !== 0) {
			failures.push(`GATE_V2_CANONICAL_ARTIFACT_BODY_REHYDRATED: canonical GateState must remain metadata-only; live=${liveInlineBytes} restored=${restoredInlineBytes} inline bytes`);
		}

		payloadIo.length = 0;
		writes.length = 0;
		const heartbeat = startEventLoopHeartbeat();
		await delay(HEARTBEAT_WARMUP_MS);
		heartbeat.warm();
		reloaded.updateGateMetadata("artifact-goal", "later-mutation", { owner: "metadata-only" });
		await reloaded.flush();
		await delay(HEARTBEAT_INTERVAL_MS * 3);
		const lag = heartbeat.stop();
		if (payloadIo.length !== 0) {
			failures.push(`GATE_V2_LATER_MUTATION_TOUCHED_ARTIFACT_BODIES: later metadata mutation performed ${payloadIo.map(io => `${io.operation}:${io.bytes}`).join(",")}`);
		}
		if (lag.maxLagMs > MAX_EVENT_LOOP_LAG_MS) {
			failures.push(`GATE_V2_LATER_MUTATION_ARTIFACT_LAG: max=${lag.maxLagMs.toFixed(1)}ms exceeded ${MAX_EVENT_LOOP_LAG_MS}ms`);
		}
		const shardBytes = fs.statSync(goalRecordPath(gateStoreV2Root(stateDir), "artifact-goal")).size;
		if (shardBytes >= MIB) failures.push(`GATE_V2_METADATA_SHARD_UNBOUNDED: metadata-only shard was ${shardBytes} bytes`);
		assert.deepEqual(failures, [], failures.join("\n"));
	}, 60_000);
});
