import { afterEach, assert, describe, it } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

import { GateStore } from "../../src/server/agent/gate-store.js";
import { gateStoreV2Root, goalRecordPath } from "../../src/server/agent/gate-store-v2-persistence.js";
import { realFs, type FsLike } from "../../src/server/gateway-deps.js";
import { getGateway, type GatewayFixture } from "../harness/gateway.js";

const MIB = 1024 * 1024;
const DEFAULT_FIXTURE_MIB = 1;
const configuredFixtureMib = (() => {
	const configured = process.env.BOBBIT_GATE_STORE_STRESS_MIB;
	if (configured === undefined || configured === "") return DEFAULT_FIXTURE_MIB;
	const value = Number(configured);
	if (!Number.isSafeInteger(value) || value < DEFAULT_FIXTURE_MIB) {
		throw new Error(`BOBBIT_GATE_STORE_STRESS_MIB must be an integer >= ${DEFAULT_FIXTURE_MIB}; received ${configured}`);
	}
	return value;
})();
const LEGACY_FIXTURE_MIN_BYTES = configuredFixtureMib * MIB;
const HEARTBEAT_INTERVAL_MS = 5;
const HEARTBEAT_WARMUP_MS = 100;
const MAX_EVENT_LOOP_LAG_MS = 75;
const TARGET_GOAL_ID = "large-store-target-goal";
const UNRELATED_GOAL_ID = "large-store-unrelated-goal";
const GATES_PER_GOAL = 2;
const SIGNALS_PER_GATE = 32;
const FIXTURE_SIGNAL_COUNT = 2 * GATES_PER_GOAL * SIGNALS_PER_GATE;
const BYTES_PER_SIGNAL = Math.ceil(LEGACY_FIXTURE_MIN_BYTES / FIXTURE_SIGNAL_COUNT);
const DIAGNOSTIC_BYTES = Math.max(256, Math.floor(BYTES_PER_SIGNAL / 8));
const COMMAND_BYTES = Math.floor((BYTES_PER_SIGNAL - DIAGNOSTIC_BYTES) / 2);
const REVIEW_BYTES = BYTES_PER_SIGNAL - DIAGNOSTIC_BYTES - COMMAND_BYTES;
const fixtureMode = configuredFixtureMib === DEFAULT_FIXTURE_MIB ? "default" : "stress";
const tempRoots: string[] = [];

console.info(`[gate-store-large-persistence] mode=${fixtureMode} configured=${configuredFixtureMib}MiB signals=${FIXTURE_SIGNAL_COUNT} heartbeat=${HEARTBEAT_INTERVAL_MS}ms/${MAX_EVENT_LOOP_LAG_MS}ms`);

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

// Routine runs use a ~1 MiB behavioral fixture; BOBBIT_GATE_STORE_STRESS_MIB=280
// selects the observed-corpus benchmark/stress mode (not a production cap).
// The authoritative regression checks below are deterministic: preload performs no synchronous canonical read
// and mutation writes only the bounded target shard. Every gate retains the full
// 32-signal hot-history boundary with all three heavy-body shapes represented.
const commandOutput = asciiPayload("COMMAND_OUTPUT", COMMAND_BYTES);
const reviewArtifact = asciiPayload("REVIEW_ARTIFACT", REVIEW_BYTES);
const diagnosticArtifact = asciiPayload("DIAGNOSTIC_ARTIFACT", DIAGNOSTIC_BYTES);

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
async function streamLegacyGateFixture(
	file: string,
	options: { goalIds?: string[]; gatesPerGoal?: number; signalsPerGate?: number } = {},
): Promise<{ totalBytes: number; unrelatedBytes: number }> {
	const goalIds = options.goalIds ?? [TARGET_GOAL_ID, UNRELATED_GOAL_ID];
	const gatesPerGoal = options.gatesPerGoal ?? GATES_PER_GOAL;
	const signalsPerGate = options.signalsPerGate ?? SIGNALS_PER_GATE;
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
		for (const goalId of goalIds) {
			const unrelated = goalId === UNRELATED_GOAL_ID;
			for (let gateIndex = 0; gateIndex < gatesPerGoal; gateIndex++) {
				const gateId = `gate-${gateIndex}`;
				await write(`${firstGate ? "" : ","}{"gateId":${JSON.stringify(gateId)},"goalId":${JSON.stringify(goalId)},"status":"failed","currentContent":"# Current gate truth","currentContentVersion":7,"currentMetadata":{"owner":"fixture"},"signals":[`, unrelated);
				firstGate = false;
				for (let signalIndex = 0; signalIndex < signalsPerGate; signalIndex++) {
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

async function hashFile(file: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = fs.createReadStream(file);
	for await (const chunk of stream) hash.update(chunk);
	return hash.digest("hex");
}

async function streamMalformedLegacyFixture(file: string, bytes: number): Promise<void> {
	const stream = fs.createWriteStream(file, { encoding: "utf8", highWaterMark: MIB });
	const chunk = " ".repeat(4 * MIB);
	try {
		await writeChunk(stream, "[");
		let written = 1;
		while (written + chunk.length + 1 <= bytes) {
			written += await writeChunk(stream, chunk);
		}
		if (written < bytes - 1) await writeChunk(stream, " ".repeat(bytes - written - 1));
		await writeChunk(stream, "!");
		stream.end();
		await finished(stream);
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

function recordingFs(writes: RecordedWrite[], payloadIo: PayloadIo[] = [], synchronousReads: string[] = []): FsLike {
	return {
		...realFs,
		readFileSync: ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
			synchronousReads.push(path.resolve(String(file)));
			return (fs.readFileSync as (...readArgs: unknown[]) => unknown)(file, ...args);
		}) as typeof fs.readFileSync,
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

async function cleanupGatewayProject(gateway: GatewayFixture, rootPath: string, sessionIds: string[] = []): Promise<void> {
	for (const sessionId of sessionIds) {
		await gateway.api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined);
	}
	const manager = gateway.projectContextManager as any;
	const registry = manager.getRegistry();
	const project = registry.getByPath(rootPath);
	if (!project) return;
	await manager.remove(project.id).catch(() => undefined);
	try { registry.remove(project.id); } catch { /* already rolled back or removed */ }
}

async function observeRegisteredProjectBeforeResponse(
	gateway: GatewayFixture,
	rootPath: string,
	request: Promise<Response>,
	timeoutMs: number,
): Promise<any | undefined> {
	const manager = gateway.projectContextManager as any;
	const deadline = Date.now() + timeoutMs;
	let responseSettled = false;
	void request.then(
		() => { responseSettled = true; },
		() => { responseSettled = true; },
	);
	while (Date.now() < deadline && !responseSettled) {
		const project = manager.getRegistry().getByPath(rootPath);
		if (project) return project;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	return undefined;
}

type HeartbeatResult = {
	/** Timer lag backed by CPU consumed on this JavaScript thread. */
	maxLagMs: number;
	/** Unadjusted timer lag, retained to make host contention auditable. */
	maxWallLagMs: number;
	contentionSamples: number;
	samples: number;
};

function startEventLoopHeartbeat(): {
	warm: () => void;
	stop: () => HeartbeatResult;
} {
	let lastTick = performance.now();
	let lastThreadCpu = process.threadCpuUsage();
	let maxLagMs = 0;
	let maxWallLagMs = 0;
	let contentionSamples = 0;
	let samples = 0;
	let stoppedResult: HeartbeatResult | undefined;
	const sample = () => {
		const now = performance.now();
		const currentThreadCpu = process.threadCpuUsage();
		const wallLagMs = Math.max(0, now - lastTick - HEARTBEAT_INTERVAL_MS);
		const threadCpuMs = Math.max(0,
			currentThreadCpu.user - lastThreadCpu.user + currentThreadCpu.system - lastThreadCpu.system,
		) / 1_000;
		// A stringify/parse regression consumes the gateway JavaScript thread, so
		// its timer delay is backed by the same thread's CPU time. Wall time alone
		// cannot distinguish that stall from Vitest's other worker processes
		// descheduling this process under the full-unit load. Attribute at most the
		// consumed current-thread CPU to this interval, while retaining raw wall lag
		// in the result so contention remains visible rather than silently discarded.
		const attributableLagMs = Math.min(wallLagMs, threadCpuMs);
		maxLagMs = Math.max(maxLagMs, attributableLagMs);
		maxWallLagMs = Math.max(maxWallLagMs, wallLagMs);
		if (wallLagMs > MAX_EVENT_LOOP_LAG_MS && attributableLagMs <= MAX_EVENT_LOOP_LAG_MS) contentionSamples++;
		lastTick = now;
		lastThreadCpu = currentThreadCpu;
		samples++;
	};
	const timer = setInterval(sample, HEARTBEAT_INTERVAL_MS);
	return {
		warm: () => {
			lastTick = performance.now();
			lastThreadCpu = process.threadCpuUsage();
			maxLagMs = 0;
			maxWallLagMs = 0;
			contentionSamples = 0;
			samples = 0;
		},
		stop: () => {
			if (stoppedResult) return stoppedResult;
			sample();
			clearInterval(timer);
			stoppedResult = { maxLagMs, maxWallLagMs, contentionSamples, samples };
			if (contentionSamples > 0) {
				console.info(`[gate-store-large-persistence] scheduler contention classified separately: ${heartbeatDetails(stoppedResult)}`);
			}
			return stoppedResult;
		},
	};
}

function heartbeatDetails(result: HeartbeatResult): string {
	return `max=${result.maxLagMs.toFixed(1)}ms raw-wall=${result.maxWallLagMs.toFixed(1)}ms contention-samples=${result.contentionSamples} samples=${result.samples}`;
}

describe("configurable artifact-heavy GateStore persistence", () => {
	it("preloads off-thread, then mutates only the target shard without synchronous hydration", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-large-persistence-"));
		tempRoots.push(root);
		const stateDir = path.join(root, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const storeFile = path.join(stateDir, "gates.json");
		assert.ok(SIGNALS_PER_GATE >= 32, "fixture must retain at least 32 artifact-heavy signals per gate");
		const fixture = await streamLegacyGateFixture(storeFile);
		assert.ok(
			fixture.totalBytes >= LEGACY_FIXTURE_MIN_BYTES,
			`fixture must be production-scale: ${fixture.totalBytes} < ${LEGACY_FIXTURE_MIN_BYTES}`,
		);

		const writes: RecordedWrite[] = [];
		const synchronousReads: string[] = [];
		const measuredFs = recordingFs(writes, [], synchronousReads);
		const heartbeat = startEventLoopHeartbeat();
		await delay(HEARTBEAT_WARMUP_MS);
		heartbeat.warm();
		// This strict heartbeat is a smoke check in the default 1 MiB mode and an
		// observed-corpus benchmark when BOBBIT_GATE_STORE_STRESS_MIB=280.
		// Deterministic no-read and target-only-write assertions remain authoritative.
		const migration = await GateStore.prepare(stateDir);
		assert.equal(migration.migrated, true);
		// Recording FsLike wrappers must not force a second synchronous hydration:
		// the validated worker snapshot remains the one-shot first-open handoff.
		const store = new GateStore(stateDir, measuredFs, migration.preload);
		const canonicalRoot = path.resolve(gateStoreV2Root(stateDir));
		assert.deepEqual(
			synchronousReads.filter(file => file === canonicalRoot || file.startsWith(`${canonicalRoot}${path.sep}`)),
			[],
			"GATE_V2_PRELOAD_SYNC_CANONICAL_READ: validated worker preload must not synchronously re-read or parse canonical shards",
		);
		assert.throws(
			() => new GateStore(stateDir, measuredFs, migration.preload),
			/already consumed/,
			"worker preload handoff must remain one-shot with an injected recording FsLike",
		);
		await delay(HEARTBEAT_INTERVAL_MS * 3);
		const migrationLag = heartbeat.stop();
		assert.ok(
			migrationLag.maxLagMs <= MAX_EVENT_LOOP_LAG_MS,
			`GATE_V2_WORKER_MIGRATION_EVENT_LOOP_STALL: ${configuredFixtureMib}MiB legacy migration exceeded ${MAX_EVENT_LOOP_LAG_MS}ms lag: ${heartbeatDetails(migrationLag)}`,
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
		const unrelatedShard = path.resolve(goalRecordPath(gateStoreV2Root(stateDir), UNRELATED_GOAL_ID));
		const expectedWrite = path.resolve(`${targetShard}.tmp`);
		const mutationBytes = writes.reduce((sum, write) => sum + write.bytes, 0);
		const failures: string[] = [];
		if (writes.length !== 1 || writes[0]?.file !== expectedWrite) {
			failures.push(`expected one target-goal shard write at ${expectedWrite}; observed ${writes.map(write => write.file).join(", ") || "none"}`);
		}
		if (writes.some(write => write.file.endsWith("gates.json.tmp")
			|| write.file === unrelatedShard
			|| write.file === `${unrelatedShard}.tmp`
			|| write.boundedTailSample.includes(UNRELATED_GOAL_ID))) {
			failures.push("mutation rewrote the legacy whole store or unrelated goal bytes");
		}
		if (mutationBytes >= fixture.unrelatedBytes || mutationBytes >= MIB) {
			failures.push(`target mutation write was not bounded: ${mutationBytes} bytes; unrelated legacy fixture bytes=${fixture.unrelatedBytes}`);
		}
		if (lag.maxLagMs > MAX_EVENT_LOOP_LAG_MS) {
			failures.push(`event loop lag exceeded ${MAX_EVENT_LOOP_LAG_MS}ms: ${heartbeatDetails(lag)}`);
		}
		assert.deepEqual(failures, [], failures.join("\n"));
	}, 120_000);

	it("registers and concurrently upserts a configured existing project behind one post-boot worker barrier", { retry: 0, timeout: 120_000 }, async () => {
		const gateway = await getGateway();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-postboot-api-"));
		tempRoots.push(root);
		const stateDir = path.join(root, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const legacyFile = path.join(stateDir, "gates.json");
		const fixture = await streamLegacyGateFixture(legacyFile);
		assert.ok(fixture.totalBytes >= LEGACY_FIXTURE_MIN_BYTES);
		const heartbeat = startEventLoopHeartbeat();
		const requests: Promise<Response>[] = [];
		const failures: string[] = [];

		try {
			await delay(HEARTBEAT_WARMUP_MS);
			heartbeat.warm();
			const body = JSON.stringify({ name: "Postboot Large Existing", rootPath: root, upsert: true, acceptCanonical: true });
			requests.push(gateway.api("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
			const project = await observeRegisteredProjectBeforeResponse(gateway, root, requests[0]!, 15_000);
			const manager = gateway.projectContextManager as any;
			if (!project) {
				failures.push("POSTBOOT_PROJECT_API_BYPASSED_ASYNC_PREPARATION: request completed before its registered descriptor was observably fenced");
			} else if ((manager.contexts as Map<string, unknown>).has(project.id)) {
				failures.push("POSTBOOT_CONTEXT_PUBLISHED_BEFORE_MIGRATION: registered project became visible before its request completed");
			} else {
				requests.push(gateway.api("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
			}

			const responses = await Promise.all(requests);
			if (responses.length !== 2 || responses[0]?.status !== 201 || responses[1]?.status !== 200) {
				failures.push(`POSTBOOT_PROJECT_API_STATUS_MISMATCH: observed ${responses.map(response => response.status).join(",") || "none"}`);
			}
			const responseProjects = await Promise.all(responses.map(response => response.json() as Promise<{ id?: string }>));
			const projectId = responseProjects[0]?.id;
			if (!projectId || responseProjects.some(row => row.id !== projectId)) failures.push("POSTBOOT_PROJECT_API_DID_NOT_COALESCE_IDENTITY: registration/upsert returned different projects");
			const context = projectId ? (manager.contexts as Map<string, any>).get(projectId) : undefined;
			if (!context) {
				failures.push("POSTBOOT_CONTEXT_NOT_PUBLISHED_AFTER_MIGRATION: successful requests returned without one live context");
			} else {
				for (const [goalId, label] of [[TARGET_GOAL_ID, "live"], [UNRELATED_GOAL_ID, "archived"]] as const) {
					const gates = context.gateStore.getGatesForGoal(goalId);
					if (gates.length !== GATES_PER_GOAL) failures.push(`POSTBOOT_GATE_FIDELITY_${label.toUpperCase()}: expected ${GATES_PER_GOAL} gates, got ${gates.length}`);
					for (let gateIndex = 0; gateIndex < gates.length; gateIndex++) {
						const gate = gates[gateIndex]!;
						const expectedIds = Array.from({ length: SIGNALS_PER_GATE }, (_, ordinal) => `${goalId}-gate-${gateIndex}-signal-${String(ordinal).padStart(4, "0")}`);
						if (gate.gateId !== `gate-${gateIndex}` || gate.status !== "failed" || gate.currentContent !== "# Current gate truth" || gate.currentContentVersion !== 7 || gate.currentMetadata?.owner !== "fixture") failures.push(`POSTBOOT_GATE_TRUTH_CHANGED: ${goalId}/${gate.gateId}`);
						if (JSON.stringify(gate.signals.map((signal: any) => signal.id)) !== JSON.stringify(expectedIds)) failures.push(`POSTBOOT_SIGNAL_ORDER_CHANGED: ${goalId}/${gate.gateId}`);
						if (gate.signals.some((signal: any) => signal.verification?.status !== "failed")) failures.push(`POSTBOOT_VERDICT_CHANGED: ${goalId}/${gate.gateId}`);
					}
				}
			}
			await delay(HEARTBEAT_INTERVAL_MS * 3);
			const lag = heartbeat.stop();
			if (lag.maxLagMs > MAX_EVENT_LOOP_LAG_MS) failures.push(`POSTBOOT_PROJECT_API_EVENT_LOOP_STALL: ${heartbeatDetails(lag)} exceeded ${MAX_EVENT_LOOP_LAG_MS}ms`);
			const stateEntries = fs.readdirSync(stateDir);
			if (fs.existsSync(legacyFile) || !fs.existsSync(`${legacyFile}.v1-retired`)) failures.push("POSTBOOT_LEGACY_PUBLICATION_MISMATCH: validated v2 state must retire gates.json exactly once");
			if (stateEntries.some(name => name.startsWith(".gate-v2-migration-"))) failures.push(`POSTBOOT_GATE_PREPARATION_NOT_COALESCED: migration staging remained: ${stateEntries.join(",")}`);
			assert.deepEqual(failures, [], failures.join("\n"));
		} finally {
			await Promise.allSettled(requests);
			heartbeat.stop();
			await cleanupGatewayProject(gateway, root);
		}
	});

	it("joins config access to an empty project's worker-preload publication fence", { retry: 0, timeout: 30_000 }, async () => {
		const gateway = await getGateway();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-empty-project-publication-"));
		tempRoots.push(root);
		const stateDir = path.join(root, ".bobbit", "state");
		const manager = gateway.projectContextManager as any;
		const originalPrepare = GateStore.prepare;
		const originalPrepareAndGetOrCreate = manager.prepareAndGetOrCreate;
		let releasePreload!: () => void;
		const holdPreload = new Promise<void>(resolve => { releasePreload = resolve; });
		let workerPreloaded!: () => void;
		const workerPreloadReady = new Promise<void>(resolve => { workerPreloaded = resolve; });
		let joinedPublication!: () => void;
		const publicationJoined = new Promise<void>(resolve => { joinedPublication = resolve; });
		const preparationCalls = new Map<string, number>();
		const requests: Promise<Response>[] = [];

		GateStore.prepare = function (preparedStateDir: string) {
			const prepared = originalPrepare.call(this, preparedStateDir);
			if (path.resolve(preparedStateDir) !== path.resolve(stateDir)) return prepared;
			return prepared.then(async result => {
				workerPreloaded();
				await holdPreload;
				return result;
			});
		};
		manager.prepareAndGetOrCreate = function (projectId: string) {
			const calls = (preparationCalls.get(projectId) ?? 0) + 1;
			preparationCalls.set(projectId, calls);
			if (calls === 2) joinedPublication();
			return originalPrepareAndGetOrCreate.call(this, projectId);
		};

		try {
			requests.push(gateway.api("/api/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Empty Publication Fence", rootPath: root }),
			}));
			const project = await observeRegisteredProjectBeforeResponse(gateway, root, requests[0]!, 10_000);
			assert.ok(project, "EMPTY_PROJECT_DESCRIPTOR_NOT_OBSERVED_BEFORE_PUBLICATION");
			await workerPreloadReady;
			assert.equal((manager.contexts as Map<string, unknown>).has(project.id), false, "empty project context published before its preload was released");

			requests.push(gateway.api(`/api/projects/${project.id}/config`));
			const joinOutcome = await Promise.race([
				publicationJoined.then(() => "joined" as const),
				requests[1]!.then(() => "settled" as const),
			]);
			assert.equal(joinOutcome, "joined", "EMPTY_PROJECT_CONFIG_BYPASSED_PUBLICATION_FENCE: config request settled without joining preparation");
			assert.equal(preparationCalls.get(project.id), 2, "registration and config access must share the project publication operation");

			releasePreload();
			const [registration, config] = await Promise.all(requests);
			assert.equal(registration.status, 201, await registration.clone().text());
			assert.equal(config.status, 200, await config.clone().text());
			assert.equal(manager.getRegistry().get(project.id)?.rootPath, root, "joined publication must retain the registered project identity");
			assert.ok((manager.contexts as Map<string, unknown>).has(project.id), "joined publication must expose exactly the registered project context");
		} finally {
			releasePreload();
			GateStore.prepare = originalPrepare;
			manager.prepareAndGetOrCreate = originalPrepareAndGetOrCreate;
			await Promise.allSettled(requests);
			await cleanupGatewayProject(gateway, root);
		}
	});

	it("keeps a large failed post-boot migration legacy-authoritative with no API-published context", { retry: 0, timeout: 60_000 }, async () => {
		const gateway = await getGateway();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-postboot-failure-"));
		tempRoots.push(root);
		const stateDir = path.join(root, ".bobbit", "state");
		const legacyFile = path.join(stateDir, "gates.json");
		fs.mkdirSync(stateDir, { recursive: true });
		await streamMalformedLegacyFixture(legacyFile, 64 * MIB);
		const originalBytes = fs.statSync(legacyFile).size;
		const originalSha256 = await hashFile(legacyFile);
		const heartbeat = startEventLoopHeartbeat();

		try {
			await delay(HEARTBEAT_WARMUP_MS);
			heartbeat.warm();
			const response = await gateway.api("/api/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Postboot Worker Failure", rootPath: root, upsert: true, acceptCanonical: true }),
			});
			await delay(HEARTBEAT_INTERVAL_MS * 3);
			const lag = heartbeat.stop();
			const manager = gateway.projectContextManager as any;
			const project = manager.getRegistry().getByPath(root);
			const failures: string[] = [];
			if (response.ok) failures.push(`POSTBOOT_WORKER_FAILURE_NOT_PROPAGATED: API returned ${response.status}`);
			if (lag.maxLagMs > MAX_EVENT_LOOP_LAG_MS) failures.push(`POSTBOOT_WORKER_FAILURE_EVENT_LOOP_STALL: ${heartbeatDetails(lag)} exceeded ${MAX_EVENT_LOOP_LAG_MS}ms`);
			if (project && (manager.contexts as Map<string, unknown>).has(project.id)) failures.push("POSTBOOT_WORKER_FAILURE_PUBLISHED_CONTEXT: failed migration exposed a ProjectContext");
			if (!fs.existsSync(legacyFile) || fs.statSync(legacyFile).size !== originalBytes || await hashFile(legacyFile) !== originalSha256) failures.push("POSTBOOT_WORKER_FAILURE_LOST_LEGACY_AUTHORITY: gates.json bytes changed or disappeared");
			if (fs.existsSync(path.join(gateStoreV2Root(stateDir), "manifest.json"))) failures.push("POSTBOOT_WORKER_FAILURE_PUBLISHED_V2: failed migration published a manifest");
			if (fs.existsSync(`${legacyFile}.v1-retired`)) failures.push("POSTBOOT_WORKER_FAILURE_RETIRED_LEGACY: failed migration retired its only authoritative source");
			assert.deepEqual(failures, [], failures.join("\n"));
		} finally {
			heartbeat.stop();
			await cleanupGatewayProject(gateway, root);
		}
	});

	it("fences and coalesces provisional project publication until post-boot preparation completes", { retry: 0, timeout: 30_000 }, async () => {
		const gateway = await getGateway();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-postboot-provisional-"));
		tempRoots.push(root);
		const stateDir = path.join(root, ".bobbit", "state");
		const legacyFile = path.join(stateDir, "gates.json");
		fs.mkdirSync(stateDir, { recursive: true });
		const signalCount = 32;
		await streamLegacyGateFixture(legacyFile, { goalIds: ["postboot-provisional-goal"], gatesPerGoal: 1, signalsPerGate: signalCount });
		const manager = gateway.projectContextManager as any;
		const registry = manager.getRegistry() as any;
		const syncTimings: Array<{ phase: string; durationMs: number }> = [];
		const restoreMethods: Array<() => void> = [];
		const instrumentSync = (owner: any, method: string, phase: string): void => {
			const original = owner[method];
			owner[method] = function (this: unknown, ...args: unknown[]) {
				const startedAt = performance.now();
				try { return original.apply(this, args); }
				finally { syncTimings.push({ phase, durationMs: performance.now() - startedAt }); }
			};
			restoreMethods.push(() => { owner[method] = original; });
		};
		instrumentSync(registry, "registerProvisional", "registerProvisional");
		instrumentSync(manager, "createAndPublishContext", "context-hydration");

		// This regression owns the live provisional registration + migration
		// publication boundary. SessionManager setup starts only after that boundary
		// and is independently covered by lifecycle tests; two concurrent mock-agent
		// setups can synchronously consume hundreds of milliseconds in the shared
		// gateway fixture. Stop the migration heartbeat at the exact createSession
		// entry seam, while still counting both calls to protect exactly-once setup.
		const heartbeat = startEventLoopHeartbeat();
		let migrationLag: ReturnType<ReturnType<typeof startEventLoopHeartbeat>["stop"]> | undefined;
		let createSessionCalls = 0;
		const originalCreateSession = gateway.sessionManager.createSession;
		gateway.sessionManager.createSession = function (this: unknown, ...args: unknown[]) {
			createSessionCalls++;
			migrationLag ??= heartbeat.stop();
			return originalCreateSession.apply(this, args);
		};
		restoreMethods.push(() => { gateway.sessionManager.createSession = originalCreateSession; });
		const requests: Promise<Response>[] = [];
		const sessionIds: string[] = [];

		try {
			await delay(HEARTBEAT_WARMUP_MS);
			heartbeat.warm();
			const body = JSON.stringify({ assistantType: "project", cwd: root, worktree: false });
			requests.push(gateway.api("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
			const provisional = await observeRegisteredProjectBeforeResponse(gateway, root, requests[0]!, 10_000);
			assert.ok(provisional, "POSTBOOT_PROVISIONAL_BYPASSED_ASYNC_PREPARATION: session response won before its descriptor was observably fenced");
			assert.equal((manager.contexts as Map<string, unknown>).has(provisional.id), false, "POSTBOOT_PROVISIONAL_CONTEXT_PUBLISHED_EARLY");
			requests.push(gateway.api("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body }));

			const responses = await Promise.all(requests);
			for (const response of responses) {
				assert.equal(response.status, 201, await response.clone().text());
				const session = await response.json() as { id: string; projectId?: string; provisionalProjectId?: string };
				sessionIds.push(session.id);
				assert.equal(session.projectId, provisional.id);
				assert.equal(session.provisionalProjectId, provisional.id);
			}
			const context = (manager.contexts as Map<string, any>).get(provisional.id);
			assert.ok(context, "provisional context must publish after migration");
			const gate = context.gateStore.getGate("postboot-provisional-goal", "gate-0");
			assert.equal(gate?.status, "failed");
			assert.equal(gate?.currentContent, "# Current gate truth");
			assert.equal(gate?.currentContentVersion, 7);
			assert.deepEqual(gate?.currentMetadata, { owner: "fixture" });
			assert.deepEqual(gate?.signals.map((signal: any) => signal.id), Array.from({ length: signalCount }, (_, ordinal) => `postboot-provisional-goal-gate-0-signal-${String(ordinal).padStart(4, "0")}`));
			assert.equal(createSessionCalls, 2, "each accepted provisional request must enter session setup exactly once");
			const lag = migrationLag ?? heartbeat.stop();
			assert.ok(
				lag.maxLagMs <= MAX_EVENT_LOOP_LAG_MS,
				`POSTBOOT_PROVISIONAL_EVENT_LOOP_STALL: ${heartbeatDetails(lag)} exceeded ${MAX_EVENT_LOOP_LAG_MS}ms before session setup; sync=${syncTimings.map(row => `${row.phase}:${row.durationMs.toFixed(1)}ms`).join(",") || "none"}`,
			);
		} finally {
			for (const restore of restoreMethods.reverse()) restore();
			const settled = await Promise.allSettled(requests);
			for (const result of settled) {
				if (result.status !== "fulfilled" || !result.value.ok) continue;
				try {
					const session = await result.value.clone().json() as { id?: string };
					if (session.id && !sessionIds.includes(session.id)) sessionIds.push(session.id);
				} catch { /* response may already be consumed */ }
			}
			heartbeat.stop();
			await cleanupGatewayProject(gateway, root, sessionIds);
		}
	});

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
			failures.push(`GATE_V2_LATER_MUTATION_ARTIFACT_LAG: ${heartbeatDetails(lag)} exceeded ${MAX_EVENT_LOOP_LAG_MS}ms`);
		}
		const shardBytes = fs.statSync(goalRecordPath(gateStoreV2Root(stateDir), "artifact-goal")).size;
		if (shardBytes >= MIB) failures.push(`GATE_V2_METADATA_SHARD_UNBOUNDED: metadata-only shard was ${shardBytes} bytes`);
		assert.deepEqual(failures, [], failures.join("\n"));
	}, 60_000);
});
