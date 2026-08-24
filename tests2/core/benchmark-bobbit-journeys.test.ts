import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	DEFAULT_REPETITIONS,
	DEFAULT_WARMUPS,
	parseArgs,
	resolveBenchmarkOutputPath,
	runBenchmark,
} from "../../scripts/benchmark-bobbit-journeys.mjs";
import {
	atomicWriteReport,
	boundReport,
	buildAlternatingSchedule,
	coefficientOfVariation,
	failedReportPath,
	median,
	medianAbsoluteDeviation,
	p95,
	summarizeSamplesByCase,
} from "../../scripts/benchmarks/contract.mjs";
import {
	cleanupTrackedGateways,
	buildGatewayStartupFixtureRecords,
	GATEWAY_STARTUP_CASES,
	GATEWAY_STARTUP_FIXTURE_VERSION,
	generateGatewayStartupFixture,
	validateGatewayStartupSemanticProjection,
} from "../../scripts/benchmarks/gateway-startup.mjs";
import { bfsEnrichArchivedIndexed } from "../../src/server/agent/archived-session-bfs.js";
import {
	aggregateMeasuredReliability,
	cleanupBenchmarkRunRoot,
	closeBenchmarkBrowser,
	createBenchmarkRunRoot,
	readProcessMetrics,
} from "../../scripts/benchmarks/runtime.mjs";
import {
	createSessionOpenSampleWatchdog,
	generateSessionOpenFixture,
	measureLongTasksInWindow,
	projectSessionOpenMessages,
	projectSessionOpenRenderedText,
	runSessionOpenSample,
	SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES,
	SESSION_OPEN_CASES,
	SESSION_OPEN_FIXTURE_VERSION,
	sessionOpenLongTaskMetricFields,
} from "../../scripts/benchmarks/session-open.mjs";
import * as eventStreamBenchmark from "../../scripts/benchmarks/event-stream.mjs";
import * as eventStreamFixture from "../../scripts/benchmarks/event-stream/fixture.mjs";
import {
	EVENT_STREAM_DONE_MARKER,
	EVENT_STREAM_ERROR_OUTPUT,
	EVENT_STREAM_PROPOSAL_SPEC,
	EVENT_STREAM_PROPOSAL_TITLE,
	EVENT_STREAM_TOOL_OUTPUT,
	EVENT_STREAM_VIEWPORT,
	createEventStreamFixture,
} from "../../scripts/benchmarks/event-stream/fixture.mjs";

const temporaryRoots = new Set<string>();

async function temporaryRoot(prefix = "bobbit-benchmark-core-"): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryRoots.add(root);
	return root;
}

afterEach(async () => {
	await Promise.all([...temporaryRoots].map(root => rm(root, { recursive: true, force: true })));
	temporaryRoots.clear();
});

function sha256(value: unknown): string {
	return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function passingJourney(cases = ["alpha", "beta"]) {
	return async (context: any) => {
		const schedule = context.scheduleFor(cases);
		return {
			samples: schedule.map((entry: any) => ({ ...entry, metrics: { latencyMs: entry.order + 1 } })),
			metricDefinitions: { latencyMs: { unit: "ms", direction: "lower" } },
			correctness: { status: "passed" },
		};
	};
}

describe("benchmark journey CLI and scheduling contract", () => {
	it("accepts only fixed journeys and bounded benchmark controls", () => {
		const defaults = parseArgs(["--journey", "session-open"]);
		assert.equal(defaults.warmups, DEFAULT_WARMUPS);
		assert.equal(defaults.repetitions, DEFAULT_REPETITIONS);
		assert.deepEqual(parseArgs([
			"--journey=event-stream", "--warmups=20", "--repetitions", "50", "--output", "candidate.json", "--keep-temp",
		]), {
			journey: "event-stream", warmups: 20, repetitions: 50, output: "candidate.json", keepTemp: true, help: false,
		});
		for (const argv of [
			["--journey", "node -e process.exit()"],
			["--journey", "session-open", "--command", "rm -rf fixture"],
			["--journey", "session-open", "--warmups", "1"],
			["--journey", "session-open", "--warmups", "21"],
			["--journey", "session-open", "--repetitions", "0"],
			["--journey", "session-open", "--repetitions", "51"],
			["--journey", "session-open", "--repetitions", "1.5"],
			["--journey", "session-open", "--journey", "event-stream"],
		]) assert.throws(() => parseArgs(argv), /journey|Unknown argument|integer|specified once/i);
	});

	it("alternates all cases across warm-up and measured cycles without omissions", () => {
		const schedule = buildAlternatingSchedule(["small", "medium", "large"], 2, 3);
		assert.equal(schedule.length, 15);
		assert.deepEqual(schedule.map((entry: any) => entry.case), [
			"small", "medium", "large", "large", "medium", "small",
			"small", "medium", "large", "large", "medium", "small", "small", "medium", "large",
		]);
		assert.deepEqual(schedule.map((entry: any) => entry.order), [...schedule.keys()]);
		assert.deepEqual(schedule.filter((entry: any) => entry.phase === "measured").map((entry: any) => entry.cycle), [0, 0, 0, 1, 1, 1, 2, 2, 2]);
	});

	it("requires exactly one schedule call and exactly one matching sample per entry", async () => {
		const repoRoot = await temporaryRoot();
		const options = parseArgs(["--journey", "session-open", "--warmups", "2", "--repetitions", "1"]);
		let calls = 0;
		const success = await runBenchmark(options, {
			repoRoot,
			importer: async () => ({ runJourney: async (context: any) => { calls += 1; return passingJourney()(context); } }),
		});
		assert.equal(success.exitCode, 0);
		assert.equal(calls, 1);
		assert.equal(success.report.samples.length, 6);
		assert.deepEqual(success.report.protocol.schedule, success.report.samples.map((sample: any) => ({
			phase: sample.phase, cycle: sample.cycle, case: sample.case, caseOrder: sample.caseOrder, order: sample.order,
		})));

		const missing = await runBenchmark(options, {
			repoRoot,
			importer: async () => ({ runJourney: async (context: any) => {
				const result = await passingJourney()(context);
				result.samples.pop();
				return result;
			} }),
		});
		assert.equal(missing.exitCode, 1);
		assert.match(missing.report.correctness.error, /5 samples for 6 scheduled entries/);

		const twice = await runBenchmark(options, {
			repoRoot,
			importer: async () => ({ runJourney: async (context: any) => {
				context.scheduleFor(["alpha"]);
				context.scheduleFor(["alpha"]);
			} }),
		});
		assert.equal(twice.exitCode, 1);
		assert.match(twice.report.correctness.error, /exactly once/);
	});
});

describe("benchmark statistics and bounded report contract", () => {
	it("uses deterministic median, nearest-rank p95, MAD, and population CV", () => {
		assert.equal(median([9, 1, 5, 3]), 4);
		assert.equal(p95(Array.from({ length: 20 }, (_, index) => index + 1)), 19);
		assert.equal(medianAbsoluteDeviation([1, 1, 2, 2, 4, 6, 9]), 1);
		assert.ok(Math.abs((coefficientOfVariation([1, 2, 3]) ?? 0) - (Math.sqrt(2 / 3) / 2)) < 1e-12);
		assert.equal(coefficientOfVariation([-1, 0, 1]), null);
		assert.throws(() => p95([1, Number.NaN]), /finite/);
	});

	it("summarizes measured numeric values while preserving unsupported metrics as null", () => {
		const summary = summarizeSamplesByCase([
			{ phase: "warmup", case: "a", metrics: { latencyMs: 999, longTaskCount: 1 } },
			{ phase: "measured", case: "a", metrics: { latencyMs: 4, longTaskCount: null } },
			{ phase: "measured", case: "a", metrics: { latencyMs: 8, longTaskCount: null } },
		], {
			latencyMs: { unit: "ms", direction: "lower", reliability: "reliable" },
			longTaskCount: { unit: "count", direction: "lower", reliability: "unsupported" },
		});
		assert.equal(summary.a.latencyMs.median, 6);
		assert.equal(summary.a.latencyMs.p95, 8);
		assert.deepEqual(summary.a.longTaskCount, {
			unit: "count", direction: "lower", reliability: "unsupported", count: 0,
			median: null, p95: null, min: null, max: null, range: null, mad: null, coefficientOfVariation: null,
		});
	});

	it("rejects shell, transcript, log, and threshold payloads and bounds all values", () => {
		for (const key of ["command", "shell_text", "transcriptBodies", "full-process-logs", "thresholds"]) {
			assert.throws(() => boundReport({ [key]: "secret" }), /may not contain/);
		}
		const bounded = boundReport({ message: "x".repeat(9_000), unsupported: Number.POSITIVE_INFINITY });
		assert.match(bounded.message, /truncated/);
		assert.equal(bounded.unsupported, null);
		const cycle: any = {};
		cycle.self = cycle;
		assert.throws(() => boundReport(cycle), /cycles/);
	});

	it("writes atomically beneath a missing allowed-root ancestor and never replaces a baseline on failure", async () => {
		const root = await temporaryRoot();
		const outputRoot = path.join(root, "missing", "nested");
		const destination = path.join(outputRoot, "baseline.json");
		await atomicWriteReport(destination, { correctness: { status: "passed" } }, { allowedRoot: outputRoot });
		const original = await readFile(destination, "utf8");
		assert.equal(JSON.parse(original).correctness.status, "passed");
		await assert.rejects(
			atomicWriteReport(destination, { command: "not allowed" }, { allowedRoot: outputRoot }),
			/may not contain/,
		);
		assert.equal(await readFile(destination, "utf8"), original);
		assert.equal(failedReportPath(destination), path.join(outputRoot, "baseline.failed.json"));
	});
});

describe("deterministic benchmark fixtures and independent oracles", () => {
	it("pins the exact session fixture-v2 dimensions, hashes, and bounded ballast", async () => {
		const root = await temporaryRoot();
		const expected: Record<string, any> = {
			"1mb": {
				bytes: 1_000_000,
				transcriptHash: "6bcdb8fdb70a4269f766e4b25438ba7d4208f259727a9ce25654c6c5c4f1b07f",
				semanticHash: "ea6a90805b65257871f16adf7747e632f4ce594ed9706f824e6db4ec8f129aae",
				renderIdsHash: "e04cc8840c5f3039790854b651756a2ceda56301b097188da5677d12da0e39f2",
				renderedTextHash: "014847f3af651b9bf4ae0490a075bd12d364adf674279bf87958655a3bc50b42",
				ballastLengthsHash: "ebe99a403beb356c27ce2c1dc4832e5bb803f90c7182015bf4a7b87ab00e2d43",
				rawCount: 26, visibleCount: 30, renderCount: 20, renderedTextCount: 49, ballastCount: 33,
			},
			"10mb": {
				bytes: 10_000_000,
				transcriptHash: "23502ed46911c654d2cc392debc33c8c8ddc75b3764092baf78a33ecd212df82",
				semanticHash: "5bfb8972a2b1ee088f9aab7e8dbb297c82e1219a766b9a01c46debda798bdac9",
				renderIdsHash: "326ae2b3ef411e9a056074b59c9a0185cbab637a99b9378c4a98290c4c5d324f",
				renderedTextHash: "e1ab5931d427189e91a8a34daa4aaaae252904f46fe08c1d81acd938cece2dcf",
				ballastLengthsHash: "d125cbca055e06a2cc6203eff5280bec9bf0f8f088cfe7b648c57a88a29acc19",
				rawCount: 35, visibleCount: 39, renderCount: 29, renderedTextCount: 341, ballastCount: 325,
			},
			"25mb": {
				bytes: 25_000_000,
				transcriptHash: "f44bb5a748fd1979601b95830400f3ed1d64e94040a3009d208d22a359fba68a",
				semanticHash: "5dc288a94ccd48663be21326fbe66a48c48519716b4039b525be36690347ab66",
				renderIdsHash: "29b18700f566e63ece1d5c7c1e5519a76558a70835ec73bec6779c3082f99cfd",
				renderedTextHash: "7a935b420aac57637b9d47d28dcd716e54fb9a2b47cfcfc05e0a117ea6e9f9af",
				ballastLengthsHash: "0593292d7be1f0da84ccb5eb17ac30386d42543e352797c7da190fdad74d86d3",
				rawCount: 50, visibleCount: 54, renderCount: 44, renderedTextCount: 829, ballastCount: 813,
			},
		};
		for (const fixtureCase of SESSION_OPEN_CASES) {
			const fixture = await generateSessionOpenFixture(root, fixtureCase);
			const pin = expected[fixtureCase.name];
			const transcriptPath = path.join(fixture.directory, "transcript.jsonl");
			const transcript = await readFile(transcriptPath, "utf8");
			const entries = transcript.trimEnd().split("\n").slice(1).map(line => JSON.parse(line));
			const rawMessages = entries.map(entry => entry.message);
			const ballastBlocks = rawMessages.flatMap(message => message.content ?? [])
				.filter((block: any) => block?.type === "text" && block.text.startsWith("Bobbit session open ballast block "));

			assert.equal(SESSION_OPEN_FIXTURE_VERSION, 2);
			assert.equal(fixture.manifest.schemaVersion, 2);
			assert.equal((await stat(transcriptPath)).size, pin.bytes);
			assert.equal(fixture.manifest.targetBytes, pin.bytes);
			assert.equal(fixture.manifest.transcriptBytes, pin.bytes);
			assert.equal(fixture.manifest.transcriptSha256, pin.transcriptHash);
			assert.equal(fixture.manifest.expectedSemanticSha256, pin.semanticHash);
			assert.equal(fixture.manifest.expectedRenderIdsSha256, pin.renderIdsHash);
			assert.equal(fixture.manifest.expectedRenderedTextSha256, pin.renderedTextHash);
			assert.equal(fixture.manifest.ballastBlockLengthsSha256, pin.ballastLengthsHash);
			assert.equal(fixture.manifest.rawMessageCount, pin.rawCount);
			assert.equal(fixture.manifest.expectedVisibleMessageCount, pin.visibleCount);
			assert.equal(fixture.manifest.expectedRenderIds.length, pin.renderCount);
			assert.equal(fixture.manifest.expectedRenderedTextCount, pin.renderedTextCount);
			assert.equal(fixture.manifest.realisticCycleCount, 8);
			assert.equal(fixture.manifest.expectedToolCallIds.length, 8);
			assert.deepEqual([
				fixture.manifest.expectedModernErrorIds.length,
				fixture.manifest.expectedLegacyErrorIds.length,
				fixture.manifest.expectedSerializedErrorIds.length,
			], [2, 2, 2]);
			assert.equal(fixture.manifest.expectedErrorIds.length, 6);
			assert.equal(fixture.manifest.expectedCompactionIds.length, 2);
			assert.equal(ballastBlocks.length, pin.ballastCount);
			assert.equal(fixture.manifest.ballastBlockCount, pin.ballastCount);
			assert.equal(fixture.manifest.ballastBlockMaxBytes, SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES);
			assert.ok(ballastBlocks.every((block: any) => Buffer.byteLength(block.text) <= SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES));
			assert.deepEqual(fixture.manifest.rawEntryIds, entries.map(entry => entry.id));
			assert.deepEqual(fixture.manifest.rawMessageIds, rawMessages.map(message => message.id));
			assert.equal(new Set(fixture.manifest.rawEntryIds).size, entries.length);
			assert.ok(entries.every((entry, index) => entry.parentId === (index === 0 ? null : entries[index - 1].id)));
			assert.equal(transcript.split(fixture.manifest.firstMarker).length - 1, 1);
			assert.equal(transcript.split(fixture.manifest.lastMarker).length - 1, 1);
		}
	}, 30_000);

	it("makes session semantic and rendered-text oracles reject omission, duplication, reordering, and mutation", async () => {
		const root = await temporaryRoot();
		const fixture = await generateSessionOpenFixture(root, { name: "oracle", transcriptBytes: 1_000_000 });
		const transcript = await readFile(path.join(fixture.directory, "transcript.jsonl"), "utf8");
		const messages = transcript.trimEnd().split("\n").slice(1).map(line => JSON.parse(line).message);
		const semanticHash = sha256(projectSessionOpenMessages(messages));
		const renderedHash = sha256(projectSessionOpenRenderedText(messages));
		const mutations = [
			(value: any[]) => value.splice(1, 1),
			(value: any[]) => value.splice(1, 0, structuredClone(value[1])),
			(value: any[]) => value.splice(0, 2, value[1], value[0]),
			(value: any[]) => { value[0].content[0].text += " mutated"; },
			(value: any[]) => { value.find(message => message.role === "toolResult").toolCallId = "wrong-tool"; },
		];
		for (const mutate of mutations) {
			const mutated = structuredClone(messages);
			mutate(mutated);
			assert.notEqual(sha256(projectSessionOpenMessages(mutated)), semanticHash);
		}
		for (const mutate of mutations.slice(0, 4)) {
			const mutated = structuredClone(messages);
			mutate(mutated);
			assert.notEqual(sha256(projectSessionOpenRenderedText(mutated)), renderedHash);
		}
	});

	it("normalizes all supported tool-error shapes in the independent session projection", () => {
		const messages = [
			{ id: "modern", role: "toolResult", isError: true, content: [{ type: "text", text: "modern" }] },
			{ id: "legacy", role: "toolResult", is_error: true, content: [{ type: "text", text: "legacy" }] },
			{ id: "serialized", role: "toolResult", content: [{ type: "text", text: JSON.stringify({ is_error: true }) }] },
			{ id: "success", role: "toolResult", isError: false, content: [{ type: "text", text: "ok" }] },
		];
		assert.deepEqual(projectSessionOpenMessages(messages).map((message: any) => message.isError), [true, true, true, false]);
		assert.notEqual(sha256(projectSessionOpenMessages(messages)), sha256(projectSessionOpenMessages([...messages].reverse())));
	});

	it("preserves unsupported session-open Long Task keys as null and supported zeroes", () => {
		assert.deepEqual(sessionOpenLongTaskMetricFields(null), {
			longTaskCount: null,
			longTaskTotalMs: null,
			longTaskMaxMs: null,
		});
		assert.deepEqual(sessionOpenLongTaskMetricFields({ count: 0, totalMs: 0, maxMs: 0 }), {
			longTaskCount: 0,
			longTaskTotalMs: 0,
			longTaskMaxMs: 0,
		});
	});

	it("pins store counts and detects observed relationship mutations independently", () => {
		assert.deepEqual(GATEWAY_STARTUP_CASES.map((value: any) => [value.name, value.sessionCount, value.liveCount]), [
			["0-sessions", 0, 0], ["100-sessions", 100, 3], ["1000-sessions", 1_000, 3],
		]);
		for (const definition of GATEWAY_STARTUP_CASES) {
			const records = buildGatewayStartupFixtureRecords(definition.name, { projectRoot: "project", transcriptRoot: "agent" });
			assert.equal(records.sessions.length, definition.sessionCount);
			assert.equal(records.manifest.archivedCount, definition.sessionCount - definition.liveCount);
			assert.equal(new Set(records.sessions.map((session: any) => session.id)).size, definition.sessionCount);
			assert.equal(records.manifest.semanticSha256, buildGatewayStartupFixtureRecords(definition.name, { projectRoot: "project", transcriptRoot: "agent" }).manifest.semanticSha256);
			validateGatewayStartupSemanticProjection(records.manifest, structuredClone(records.sessions));
			if (records.sessions.length) {
				const mutated = structuredClone(records.sessions);
				mutated[0].title = "silently omitted content";
				assert.throws(() => validateGatewayStartupSemanticProjection(records.manifest, mutated), /relationship semantics changed/);
			}
		}
	});

	it("pins the complete event manifest and semantic hash without trusting runtime output", () => {
		const fixture: any = createEventStreamFixture();
		const fixtureVersion = (eventStreamFixture as any).EVENT_STREAM_FIXTURE_VERSION;
		assert.equal(fixture.events.length, 68);
		assert.equal(fixture.expectedFrames.length, 68);
		assert.equal(fixture.semanticHash, ({
			1: "03f6927086603dbbb2189c7e736d76b833483eb28915a2a7a07316f07bb8c2d9",
			2: "d2c12ea2a3ef1fe46833dab1f66f90706c6d60c32a4cfb999db6b3a1fb0f1add",
		} as Record<number, string>)[fixtureVersion]);
		assert.deepEqual(fixture.expectedFrames, fixture.events.map((event: any) => ({
			id: event.data.benchmarkEventId, type: event.data.type, ordinal: event.data.benchmarkOrdinal ?? null,
		})));
		const independentProjection: any = {
			fixtureVersion,
			updateCount: fixture.updateCount,
			intervalMs: fixture.intervalMs,
			viewport: EVENT_STREAM_VIEWPORT,
			expectedFrames: fixture.expectedFrames,
			markers: fixture.markers,
			finalMarkers: [EVENT_STREAM_PROPOSAL_TITLE, EVENT_STREAM_TOOL_OUTPUT, EVENT_STREAM_ERROR_OUTPUT, `${EVENT_STREAM_DONE_MARKER}:${fixture.updateCount}`],
			settlementMarkers: [EVENT_STREAM_PROPOSAL_SPEC],
			...(fixtureVersion >= 2 ? {
				expectedFinalSemanticProjection: fixture.expectedFinalSemanticProjection,
				expectedFinalSemanticCounts: fixture.expectedFinalSemanticCounts,
				expectedToolPairs: fixture.expectedToolPairs,
			} : {}),
		};
		assert.equal(sha256(independentProjection), fixture.semanticHash);
		const mutated = structuredClone(independentProjection);
		mutated.expectedFrames[1].type = "message_end";
		assert.notEqual(sha256(mutated), fixture.semanticHash);
		if (fixtureVersion >= 2) {
			assert.equal(fixture.expectedFinalSemanticHash, "0ab29717a26acc8cf1a826bc48df3a70c26467fca7cd12dc83c08e0d1e5f6b50");
			assert.deepEqual(fixture.expectedFinalSemanticCounts, {
				messageCount: 9,
				roles: { user: 1, assistant: 5, toolResult: 3 },
				toolCallCount: 3,
				toolResultCount: 3,
				successfulToolResultCount: 2,
				errorToolResultCount: 1,
			});
		}
	});

	it("rejects missing, changed, duplicated, or reordered rendered event markers", () => {
		const fixture: any = createEventStreamFixture();
		const renderedMarkers = [
			...fixture.markers,
			EVENT_STREAM_PROPOSAL_TITLE,
			EVENT_STREAM_TOOL_OUTPUT,
			EVENT_STREAM_ERROR_OUTPUT,
			EVENT_STREAM_ERROR_OUTPUT,
			`${EVENT_STREAM_DONE_MARKER}:${fixture.updateCount}`,
			EVENT_STREAM_PROPOSAL_SPEC,
		];
		const base: any = {
			status: "idle",
			pendingToolCount: 0,
			streamingMessageVisible: false,
			streamingActive: false,
			streamingTimerVisible: false,
			editorEnabled: true,
			renderedText: renderedMarkers.join(" | "),
			semanticProjection: structuredClone(fixture.expectedFinalSemanticProjection),
		};
		eventStreamBenchmark.assertFinalState(base, fixture);
		const mutations = [
			(text: string) => text.replace(EVENT_STREAM_PROPOSAL_TITLE, ""),
			(text: string) => text.replace(EVENT_STREAM_ERROR_OUTPUT, "CHANGED_ERROR_OUTPUT"),
			(text: string) => `${text} ${EVENT_STREAM_TOOL_OUTPUT}`,
			(text: string) => text.replace(
				`${EVENT_STREAM_ERROR_OUTPUT} | ${EVENT_STREAM_DONE_MARKER}:${fixture.updateCount}`,
				`${EVENT_STREAM_DONE_MARKER}:${fixture.updateCount} | ${EVENT_STREAM_ERROR_OUTPUT}`,
			),
		];
		for (const mutate of mutations) {
			assert.throws(() => eventStreamBenchmark.assertFinalState({ ...base, renderedText: mutate(base.renderedText) }, fixture), /rendered marker|omitted|reordered/i);
		}
	});

	it("rejects event semantic omission, duplication, reordering, and tool mutation", () => {
		const assertSemantic = (eventStreamBenchmark as any).assertExpectedFinalSemanticState;
		if (typeof assertSemantic !== "function") return; // Repair branch supplies this pure seam before integration.
		const fixture: any = createEventStreamFixture();
		assertSemantic({ semanticProjection: structuredClone(fixture.expectedFinalSemanticProjection) }, fixture);
		const mutations = [
			(projection: any[]) => projection.splice(1, 1),
			(projection: any[]) => projection.splice(1, 0, structuredClone(projection[1])),
			(projection: any[]) => projection.splice(1, 2, projection[2], projection[1]),
			(projection: any[]) => { projection.find(message => message.id === "benchmark-error-result").isError = false; },
			(projection: any[]) => { projection.find(message => message.id === "benchmark-success-result").toolCallId = "wrong-tool"; },
		];
		for (const mutate of mutations) {
			const projection = structuredClone(fixture.expectedFinalSemanticProjection);
			mutate(projection);
			assert.throws(() => assertSemantic({ semanticProjection: projection }, fixture), /semantic|tool pairs/i);
		}
	});

	it("accounts for a complete animation-frame stall and reports unsupported long tasks as null", () => {
		const cadence = (eventStreamBenchmark as any).frameCadenceMetrics;
		const longTasks = (eventStreamBenchmark as any).longTaskMetrics;
		if (typeof cadence !== "function" || typeof longTasks !== "function") return; // Repair branch supplies pure seams before integration.
		assert.deepEqual(cadence([16, 16, 200]), {
			estimatedRefreshMs: 16,
			slowFrames: 1,
			droppedFrames: 12,
		});
		assert.deepEqual(longTasks([{ durationMs: 80 }], false), {
			count: null,
			totalMs: null,
			maxMs: null,
			reliability: "unsupported",
		});
		assert.deepEqual(longTasks([{ durationMs: 80 }, { durationMs: 55 }], true), {
			count: 2,
			totalMs: 135,
			maxMs: 80,
			reliability: "browser-api",
		});
	});
});

describe("process metrics and reliability aggregation", () => {
	it("does not fabricate Linux CPU time and preserves independently valid RSS", async () => {
		const stat = `123 (benchmark) S ${Array.from({ length: 10 }, () => 0).join(" ")} 10 20`;
		const status = "Name:\tbenchmark\nVmHWM:\t42 kB\nVmRSS:\t21 kB\n";
		const valid = await readProcessMetrics(123, {
			platform: "linux",
			readFileImpl: async (file: string) => file.endsWith("/stat") ? stat : status,
			spawnSyncImpl: () => ({ status: 0, stdout: "100\n" }),
		});
		assert.equal(valid.cpuTimeMs, 300);
		assert.equal(valid.peakRssBytes, 42 * 1024);
		assert.equal(valid.cpuReliability, "reliable");
		assert.equal(valid.peakRssReliability, "reliable");

		for (const result of [
			{ status: 0, stdout: "" },
			{ status: 1, stdout: "100" },
			{ status: 0, stdout: "not-a-number" },
		]) {
			const partial = await readProcessMetrics(123, {
				platform: "linux",
				readFileImpl: async (file: string) => file.endsWith("/stat") ? stat : status,
				spawnSyncImpl: () => result,
			});
			assert.equal(partial.cpuTimeMs, null);
			assert.equal(partial.cpuReliability, "unsupported");
			assert.equal(partial.peakRssBytes, 42 * 1024);
			assert.equal(partial.peakRssReliability, "reliable");
		}
	});

	it("summarizes measured reliability conservatively and ignores warm-ups", () => {
		const samples = [
			{ phase: "warmup", metricReliability: { heap: "unsupported" } },
			{ phase: "measured", metricReliability: { heap: "reliable" } },
			{ phase: "measured", metricReliability: { heap: "lower-confidence" } },
		];
		assert.equal(aggregateMeasuredReliability(samples, "heap"), "mixed (lower-confidence, reliable)");
		assert.equal(aggregateMeasuredReliability([{ phase: "measured", metricReliability: { heap: "partial" } }], "heap"), "partial");
		assert.equal(aggregateMeasuredReliability([{ phase: "warmup", metricReliability: { heap: "reliable" } }], "heap"), "unsupported");
		assert.equal(aggregateMeasuredReliability([{ phase: "measured", metricReliability: {} }], "heap"), "unsupported");
	});
});

describe("session-open bounded sample lifecycle", () => {
	type ScheduledTimer = {
		callback: () => void;
		delay: number;
		cleared: boolean;
	};

	function injectedClock() {
		let clock = 0;
		const timers: ScheduledTimer[] = [];
		return {
			timers,
			now: () => clock,
			advanceTo: (next: number) => { clock = next; },
			setTimer: (callback: () => void, delay: number) => {
				const timer = { callback, delay, cleared: false };
				timers.push(timer);
				return timer;
			},
			clearTimer: (timer: ScheduledTimer) => { timer.cleared = true; },
		};
	}

	it("clips Long Tasks to the measured session-open interval", () => {
		assert.deepEqual(measureLongTasksInWindow([
			{ startTime: 5, duration: 10 },
			{ startTime: 15, duration: 20 },
			{ startTime: 35, duration: 20 },
			{ startTime: 50, duration: 0 },
			{ startTime: Number.NaN, duration: 10 },
		], 10, 40), {
			count: 3,
			totalMs: 30,
			maxMs: 20,
		});
		assert.throws(() => measureLongTasksInWindow([], 20, 10), /finite and ordered/);
	});

	it("aborts the active phase, interrupts execution, and escalates after grace", async () => {
		const clock = injectedClock();
		const calls: string[] = [];
		const browserRuntime = { browser: { close: async () => {} }, cdp: {} };
		const gatewayRuntime = { process: "owned" };
		const watchdog = createSessionOpenSampleWatchdog({
			timeoutMs: 100,
			graceMs: 10,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			terminateExecution: async (runtime: any) => { assert.equal(runtime, browserRuntime); calls.push("terminate"); },
			closeBrowser: async (runtime: any) => { assert.equal(runtime, browserRuntime); calls.push("close"); },
		});
		watchdog.registerBrowser(browserRuntime);
		watchdog.registerGateway(gatewayRuntime);
		clock.advanceTo(25);
		watchdog.setPhase("tti");
		clock.advanceTo(60);
		watchdog.setPhase("paritySettle");
		clock.advanceTo(100);
		clock.timers.find(timer => timer.delay === 100)!.callback();
		await Promise.resolve();

		assert.equal(watchdog.timedOut, true);
		assert.equal(watchdog.signal.aborted, true);
		assert.equal(watchdog.error.name, "SessionOpenSampleTimeoutError");
		assert.equal((watchdog.error as any).phase, "paritySettle");
		assert.deepEqual((watchdog.error as any).phaseDurationsMs, {
			prepareMs: 25,
			ttiMs: 35,
			paritySettleMs: 40,
			oracleMs: 0,
			teardownMs: 0,
		});
		assert.deepEqual(watchdog.resources(), { browserRuntime, gatewayRuntime });
		assert.deepEqual(calls, ["terminate"]);
		clock.advanceTo(110);
		clock.timers.find(timer => timer.delay === 10)!.callback();
		await watchdog.finish();
		assert.deepEqual(calls, ["terminate", "close"]);
		assert.throws(() => watchdog.throwIfExpired(), /watchdog expired.*paritySettle/i);
	});

	it("uses the shared watchdog to interrupt a never-settling event renderer operation", async () => {
		const clock = injectedClock();
		let rejectRenderer!: (error: Error) => void;
		const renderer = new Promise((_resolve, reject) => { rejectRenderer = reject; });
		const browserRuntime = { cdp: {} };
		const watchdog = eventStreamBenchmark.createEventStreamSampleWatchdog({
			timeoutMs: 40,
			graceMs: 5,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			terminateExecution: async (runtime: any) => {
				assert.equal(runtime, browserRuntime);
				rejectRenderer(new Error("renderer execution terminated"));
			},
		});
		watchdog.registerBrowser(browserRuntime);
		watchdog.setPhase("stream");
		clock.advanceTo(40);
		clock.timers.find(timer => timer.delay === 40)!.callback();
		await assert.rejects(renderer, /execution terminated/);
		await watchdog.finish();
		assert.equal(watchdog.error.name, "EventStreamSampleTimeoutError");
		assert.equal(watchdog.error.phase, "stream");
	});

	it("propagates an injected watchdog expiry through the sample orchestrator", async () => {
		const clock = injectedClock();
		let interruptCount = 0;
		let measureCalled = false;
		const context = { createSampleRoot: async () => "sample-root" };
		const fixture = { directory: "fixture", manifest: {} };
		const entry = { case: "tiny", phase: "measured", cycle: 0, order: 0, caseOrder: 0 };
		await assert.rejects(runSessionOpenSample(context, entry, fixture, {
			timeoutMs: 50,
			watchdogDependencies: {
				now: clock.now,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
				terminateExecution: async () => { interruptCount += 1; },
			},
			prepare: async (_context: any, _sampleRoot: any, watchdog: any) => {
				watchdog.registerBrowser({ cdp: {} });
				clock.advanceTo(50);
				clock.timers.find(timer => timer.delay === 50)!.callback();
				await Promise.resolve();
				watchdog.throwIfExpired();
			},
			measure: async () => {
				measureCalled = true;
				throw new Error("measure must not run after prepare expires");
			},
			closeBrowser: async () => {},
		}), error => {
			assert.equal((error as any).name, "SessionOpenSampleTimeoutError");
			assert.equal((error as any).phase, "prepare");
			assert.match((error as Error).message, /expired after 50ms during prepare phase/);
			return true;
		});
		assert.equal(interruptCount, 1);
		assert.equal(measureCalled, false);
		assert.equal(clock.timers[0].cleared, true);
	});

	it("retains cleanup ownership, aggregates failures, and lets the backstop retry browser before gateway", async () => {
		const deferred: Array<() => Promise<void>> = [];
		const cleanupOrder: string[] = [];
		let browserAttempts = 0;
		let gatewayAttempts = 0;
		const context = {
			createSampleRoot: async () => "sample-root",
			deferCleanup: (cleanup: () => Promise<void>) => deferred.push(cleanup),
		};
		await assert.rejects(runSessionOpenSample(
			context,
			{ case: "tiny", phase: "measured", cycle: 0, order: 0, caseOrder: 0 },
			{ directory: "fixture", manifest: {} },
			{
				prepare: async (_context: any, _root: any, watchdog: any) => {
					watchdog.registerBrowser({ id: "browser" });
					watchdog.registerGateway({ id: "gateway" });
					throw new Error("prepare operation failed");
				},
				closeBrowser: async () => {
					cleanupOrder.push("browser");
					browserAttempts += 1;
					if (browserAttempts === 1) throw new Error("first browser close failed");
				},
				stopRuntime: async () => {
					cleanupOrder.push("gateway");
					gatewayAttempts += 1;
					if (gatewayAttempts === 1) throw new Error("first gateway stop failed");
				},
			},
		), error => {
			assert.ok(error instanceof AggregateError);
			assert.match(String(error), /prepare operation failed/);
			return true;
		});
		assert.deepEqual(cleanupOrder, ["browser", "gateway"]);
		assert.equal(deferred.length, 1);
		await deferred[0]();
		assert.deepEqual(cleanupOrder, ["browser", "gateway", "browser", "gateway"]);
	});

	it("runs injected prepare/measure phases and disarms the deadline after success", async () => {
		const clock = injectedClock();
		const context = {
			createSampleRoot: async () => {
				clock.advanceTo(5);
				return "sample-root";
			},
		};
		const fixture = { directory: "fixture", manifest: { expectedVisibleMessageCount: 1 } };
		const entry = { case: "tiny", phase: "measured", cycle: 0, order: 0, caseOrder: 0 };
		const sample = await runSessionOpenSample(context, entry, fixture, {
			timeoutMs: 100,
			watchdogDependencies: {
				now: clock.now,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
			},
			prepare: async (_context: any, sampleRoot: any, watchdog: any) => {
				assert.equal(sampleRoot, "sample-root");
				assert.equal(watchdog.signal.aborted, false);
				clock.advanceTo(20);
				return { invocation: { baseUrl: "http://unused.invalid/" }, sessionId: "fixture-session" };
			},
			measure: async (_restored: any, _manifest: any, watchdog: any, options: any) => {
				assert.equal(options.parityBatchSize, 4);
				clock.advanceTo(45);
				watchdog.setPhase("paritySettle");
				clock.advanceTo(70);
				watchdog.setPhase("oracle");
				clock.advanceTo(85);
				return {
					metrics: { timeToInteractiveMs: 40 },
					correctness: {
						messageCount: 1,
						renderCount: 1,
						toolPairCount: 0,
						canonicalErrorIds: [],
						compactionCount: 0,
						semanticSha256: "semantic",
						renderIdsSha256: "render-ids",
						renderedTextSha256: "rendered-text",
					},
					metricSupport: { longTasks: "unsupported" },
					browserVersion: "injected-browser",
				};
			},
		});
		assert.equal(sample.correctness.status, "passed");
		assert.equal(sample.browserVersion, "injected-browser");
		assert.deepEqual(sample.phaseDurationsMs, {
			prepareMs: 20,
			ttiMs: 25,
			paritySettleMs: 25,
			oracleMs: 15,
			teardownMs: 0,
		});
		assert.equal(clock.timers[0].cleared, true);
		clock.timers[0].callback();
		assert.equal(sample.correctness.status, "passed", "a disarmed watchdog cannot mutate a completed sample");
	});
});

describe("gateway-startup fixture v4 relationship regression", () => {
	function permutations<T>(values: T[]): T[][] {
		if (values.length <= 1) return [values];
		return values.flatMap((value, index) => permutations([
			...values.slice(0, index),
			...values.slice(index + 1),
		]).map(rest => [value, ...rest]));
	}

	it("keeps the production archived BFS exact for every live-seed permutation", () => {
		for (const caseName of ["100-sessions", "1000-sessions"]) {
			const records = buildGatewayStartupFixtureRecords(caseName, {
				projectRoot: "project",
				transcriptRoot: "agent",
			});
			const archived = records.sessions.filter((session: any) => session.archived === true);
			const seedPermutations = permutations(records.manifest.liveIds);
			assert.equal(seedPermutations.length, 6);
			assert.ok(records.manifest.goalId);

			for (const liveSeeds of seedPermutations) {
				const actualIds = bfsEnrichArchivedIndexed(
					[...liveSeeds, records.manifest.goalId],
					archived,
					(session: any) => ({ ...session }),
				).map((session: any) => session.id);
				assert.deepEqual(
					actualIds,
					records.manifest.reachableArchivedIds,
					`${caseName} changed BFS order for live seeds ${liveSeeds.join(",")}`,
				);
				const reachable = new Set(actualIds);
				assert.ok(
					records.manifest.controls.every((id: string) => !reachable.has(id)),
					`${caseName} admitted an unrelated archived control`,
				);
			}
		}
	});
});

describe("gateway-startup generated preferences and containment regression", () => {
	it("generates the exact v4 restore preferences entirely beneath an owned run root", async () => {
		const tempParent = await temporaryRoot();
		const paths = await createBenchmarkRunRoot({ repoRoot: tempParent, tempDirectory: tempParent, env: {} });
		const fixtureRoot = path.join(paths.fixtures, "100-sessions");
		const dependencyPaths: string[] = [];
		const persistedSessions: any[] = [];
		const expectedArchivedSearchId = "benchmark-100-sessions-archived-0000";

		class SessionStore {
			constructor(directory: string) { dependencyPaths.push(directory); }
			put(session: any) { persistedSessions.push(structuredClone(session)); }
			async flushAsync() {}
		}
		class ProjectRegistry {
			constructor(directory: string) { dependencyPaths.push(directory); }
			ensureHeadquartersProject(gatewayRoot: string, options: { stateDir: string; configDir: string }) {
				dependencyPaths.push(gatewayRoot, options.stateDir, options.configDir);
			}
		}
		class GoalStore {
			constructor(directory: string) { dependencyPaths.push(directory); }
			put(_goal: any) {}
			async flush() {}
			async close() {}
		}
		class SearchService {
			constructor(options: { stateDir: string }) { dependencyPaths.push(options.stateDir); }
			open(_stores: any) {}
			async whenReady() {}
			async rebuildFromStores(_goalStore: any, _sessionStore: any) {}
			async search() { return { results: [{ sessionId: expectedArchivedSearchId }] }; }
			async close() {}
		}

		try {
			const generated = await generateGatewayStartupFixture({
				caseName: "100-sessions",
				fixtureRoot,
				productionModules: { SessionStore, ProjectRegistry, GoalStore, SearchService },
			});
			const preferencesPath = path.join(fixtureRoot, "gateway", "state", "preferences.json");
			const preferencesText = await readFile(preferencesPath, "utf8");
			assert.deepEqual(JSON.parse(preferencesText), {
				customProviders: [{
					id: "mock",
					name: "mock",
					type: "manual",
					baseUrl: "http://127.0.0.1",
					models: [{ id: "mock-model", name: "mock-model" }],
				}],
				"default.sessionModel": "mock/mock-model",
				"default.sessionThinkingLevel": "off",
			});
			assert.equal(generated.manifest.fixtureVersion, 4);
			assert.equal(GATEWAY_STARTUP_FIXTURE_VERSION, 4);
			assert.equal(persistedSessions.length, 100);

			const generatedPaths = [
				fixtureRoot,
				preferencesPath,
				...dependencyPaths,
				...persistedSessions.flatMap(session => [session.cwd, session.agentSessionFile].filter(Boolean)),
			];
			for (const candidate of generatedPaths) {
				const relative = path.relative(paths.root, path.resolve(candidate));
				assert.ok(
					relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)),
					`generated fixture path escaped its owned run root: ${candidate}`,
				);
				assert.equal(path.resolve(candidate).split(path.sep).includes(".bobbit"), false);
			}
		} finally {
			await cleanupBenchmarkRunRoot(paths);
		}
		assert.equal(existsSync(paths.root), false, "owned fixture run root must be cleaned after generation");
	});
});

describe("filesystem containment and aggregated cleanup", () => {
	async function createDirectoryLink(target: string, linkPath: string): Promise<boolean> {
		try {
			await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
			return true;
		} catch (error: any) {
			if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return false;
			throw error;
		}
	}

	it("rejects output traversal through a symlink or junction", async context => {
		const root = await temporaryRoot();
		const outputRoot = path.join(root, "output");
		const outside = path.join(root, "outside");
		await Promise.all([mkdir(outputRoot), mkdir(outside)]);
		if (!await createDirectoryLink(outside, path.join(outputRoot, "linked"))) context.skip();
		assert.throws(() => resolveBenchmarkOutputPath("linked/result.json", outputRoot), /symbolic link|junction|outside/i);
		await assert.rejects(
			atomicWriteReport(path.join(outputRoot, "linked", "result.json"), { ok: true }, { allowedRoot: outputRoot }),
			/symbolic link|junction|outside/i,
		);
		assert.equal(existsSync(path.join(outside, "result.json")), false);
	});

	it("rejects a missing allowed root projected through a linked ancestor", async context => {
		const root = await temporaryRoot();
		const outside = path.join(root, "outside");
		const link = path.join(root, "linked");
		await mkdir(outside);
		if (!await createDirectoryLink(outside, link)) context.skip();
		const missingRoot = path.join(link, "missing-output-root");
		assert.throws(() => resolveBenchmarkOutputPath("result.json", missingRoot), /symbolic link|junction|outside/i);
		await assert.rejects(
			atomicWriteReport(path.join(missingRoot, "result.json"), { ok: true }, { allowedRoot: missingRoot }),
			/symbolic link|junction|outside/i,
		);
	});

	it("refuses cleanup after an owned run root is replaced by a link", async context => {
		const parent = await temporaryRoot();
		const paths = await createBenchmarkRunRoot({ repoRoot: parent, tempDirectory: parent, env: {} });
		const moved = `${paths.root}-moved`;
		const outside = path.join(parent, "outside");
		await rename(paths.root, moved);
		await mkdir(outside);
		if (!await createDirectoryLink(outside, paths.root)) {
			await rename(moved, paths.root);
			await cleanupBenchmarkRunRoot(paths);
			context.skip();
		}
		await assert.rejects(cleanupBenchmarkRunRoot(paths), /linked|identity changed/);
		assert.equal((await lstat(paths.root)).isSymbolicLink(), true);
		assert.equal(existsSync(moved), true);
	});

	it("attempts every browser and gateway cleanup and aggregates all failures", async () => {
		const browserCalls: string[] = [];
		const browserRuntime = {
			cdp: { detach: async () => { browserCalls.push("cdp"); throw new Error("cdp boom"); } },
			page: { close: async () => { browserCalls.push("page"); throw new Error("page boom"); } },
			context: { close: async () => { browserCalls.push("context"); throw new Error("context boom"); } },
			browser: {
				close: async () => { browserCalls.push("browser"); throw new Error("browser boom"); },
				isConnected: () => true,
			},
		};
		await assert.rejects(closeBenchmarkBrowser(browserRuntime), error => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /cdp boom.*page boom.*context boom.*browser boom/i);
			return true;
		});
		assert.deepEqual(browserCalls, ["cdp", "page", "context", "browser"]);

		const gateways = new Set<any>([
			{ runtime: {}, baseUrl: "http://one.invalid/" },
			{ runtime: {}, baseUrl: "http://two.invalid/" },
		]);
		const attempts: string[] = [];
		await assert.rejects(cleanupTrackedGateways(gateways, async (_runtime: any, options: any) => {
			attempts.push(options.baseUrl);
			throw new Error(`cannot stop ${options.baseUrl}`);
		}), error => {
			assert.ok(error instanceof AggregateError);
			assert.equal(error.errors.length, 2);
			return true;
		});
		assert.deepEqual(attempts, ["http://one.invalid/", "http://two.invalid/"]);
	});

	it("aggregates deferred cleanup failures into a bounded failed artifact", async () => {
		const repoRoot = await temporaryRoot();
		const outputRoot = path.join(repoRoot, "reports");
		await mkdir(outputRoot);
		const baseline = path.join(outputRoot, "baseline.json");
		await writeFile(baseline, "known-good\n");
		const options = parseArgs(["--journey", "event-stream", "--warmups", "2", "--repetitions", "1", "--output", "baseline.json"]);
		const result = await runBenchmark(options, {
			repoRoot,
			outputRoot,
			importer: async () => ({ runJourney: async (context: any) => {
				context.deferCleanup(async () => { throw new Error("first cleanup failure"); });
				context.deferCleanup(async () => { throw new Error("second cleanup failure"); });
				return passingJourney(["only"])(context);
			} }),
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.report.correctness.error, /second cleanup failure.*first cleanup failure/);
		assert.equal(await readFile(baseline, "utf8"), "known-good\n");
		const failed = JSON.parse(await readFile(path.join(outputRoot, "baseline.failed.json"), "utf8"));
		assert.equal(failed.correctness.status, "failed");
		assert.equal(failed.cleanup.status, "failed");
		assert.equal(JSON.stringify(failed).includes("threshold"), false);
	});
});
