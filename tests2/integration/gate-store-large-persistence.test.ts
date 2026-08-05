import { afterEach, assert, describe, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

import { GateStore } from "../../src/server/agent/gate-store.js";
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

function recordingFs(writes: RecordedWrite[]): FsLike {
	return {
		...realFs,
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
	it("mutating one gate neither rewrites an unrelated goal nor stalls the gateway event loop", async () => {
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
		const store = new GateStore(stateDir, recordingFs(writes));
		assert.equal(store.getGatesForGoal(TARGET_GOAL_ID).length, GATES_PER_GOAL);
		assert.equal(store.getGatesForGoal(UNRELATED_GOAL_ID).length, GATES_PER_GOAL);
		writes.length = 0; // Constructor/migration work is outside the hot mutation window.

		const heartbeat = startEventLoopHeartbeat();
		await delay(HEARTBEAT_WARMUP_MS);
		heartbeat.warm();
		store.updateGateMetadata(TARGET_GOAL_ID, "gate-0", { owner: "mutated-target-only" });
		await store.flush();
		await delay(HEARTBEAT_INTERVAL_MS * 3);
		const lag = heartbeat.stop();

		const unrelatedWrites = writes.filter(write => write.boundedTailSample.includes(UNRELATED_GOAL_ID));
		const unrelatedRewriteBytes = unrelatedWrites.reduce((sum, write) => sum + write.bytes, 0);
		const failures: string[] = [];
		if (unrelatedWrites.length > 0 || unrelatedRewriteBytes >= fixture.unrelatedBytes) {
			failures.push(
				`rewrote unrelated gate bytes: ${unrelatedRewriteBytes} bytes across ${unrelatedWrites.length} write(s); unrelated fixture bytes=${fixture.unrelatedBytes}`,
			);
		}
		if (lag.maxLagMs > MAX_EVENT_LOOP_LAG_MS) {
			failures.push(
				`event loop lag exceeded ${MAX_EVENT_LOOP_LAG_MS}ms: max=${lag.maxLagMs.toFixed(1)}ms over ${lag.samples} post-warm sample(s)`,
			);
		}
		assert.deepEqual(failures, [], failures.join("\n"));
	}, 120_000);
});
