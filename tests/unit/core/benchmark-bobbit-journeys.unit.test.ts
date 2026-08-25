import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import {
	cp,
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
	aggregateErrors,
	parseArgs,
	resolveBenchmarkOutputPath,
	runBenchmark,
} from "../../../scripts/benchmark-bobbit-journeys.mjs";
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
} from "../../../scripts/benchmarks/contract.mjs";
import {
	cleanupTrackedGateways,
	buildGatewayStartupFixtureRecords,
	combineGatewayStartupSampleFailures,
	GATEWAY_STARTUP_CASES,
	GATEWAY_STARTUP_FIXTURE_VERSION,
	gatewayStartupGatewayArgs,
	generateGatewayStartupFixture,
	relocateSampleFixture,
	validateGatewayStartupSemanticProjection,
} from "../../../scripts/benchmarks/gateway-startup.mjs";
import { bfsEnrichArchivedIndexed } from "../../../src/server/agent/archived-session-bfs.js";
import {
	aggregateMeasuredReliability,
	cleanupBenchmarkRunRoot,
	closeBenchmarkBrowser,
	createBenchmarkGatewayToken,
	createBenchmarkRunRoot,
	createTailBuffer,
	readProcessMetrics,
	sanitizeBenchmarkError,
	waitForGatewayReady,
} from "../../../scripts/benchmarks/runtime.mjs";
import {
	createSessionOpenSampleWatchdog,
	generateSessionOpenFixture,
	measureBrowserSample,
	measureLongTasksInWindow,
	projectSessionOpenMessages,
	projectSessionOpenRenderedText,
	runSessionOpenSample,
	sessionOpenGatewayArgs,
	sessionOpenMetricFields,
	SESSION_OPEN_BALLAST_BLOCK_MAX_BYTES,
	SESSION_OPEN_BROWSER_ACQUISITION_TIMEOUT_MS,
	SESSION_OPEN_CASES,
	SESSION_OPEN_FIXTURE_VERSION,
	sessionOpenLongTaskMetricFields,
} from "../../../scripts/benchmarks/session-open.mjs";
import * as eventStreamBenchmark from "../../../scripts/benchmarks/event-stream.mjs";
import * as eventStreamFixture from "../../../scripts/benchmarks/event-stream/fixture.mjs";
import {
	EVENT_STREAM_DONE_MARKER,
	EVENT_STREAM_ERROR_OUTPUT,
	EVENT_STREAM_PROPOSAL_SPEC,
	EVENT_STREAM_PROPOSAL_TITLE,
	EVENT_STREAM_TOOL_OUTPUT,
	EVENT_STREAM_VIEWPORT,
	createEventStreamFixture,
} from "../../../scripts/benchmarks/event-stream/fixture.mjs";

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

function projectErrorGraph(error: any, depth = 0): any {
	if (!error || depth > 16) return null;
	return {
		name: error.name,
		message: error.message,
		phase: error.phase,
		phaseDurationsMs: error.phaseDurationsMs,
		benchmarkDiagnostic: error.benchmarkDiagnostic,
		errors: Array.isArray(error.errors) ? error.errors.map((child: any) => projectErrorGraph(child, depth + 1)) : [],
		cause: error.cause ? projectErrorGraph(error.cause, depth + 1) : null,
	};
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

	it("requires every declared raw metric while accepting explicit null and finite zero", async () => {
		const repoRoot = await temporaryRoot();
		const options = parseArgs(["--journey", "session-open", "--warmups", "2", "--repetitions", "1"]);
		const journey = (metricValue: number | null | undefined, includeMetric = true) => async (context: any) => {
			const schedule = context.scheduleFor(["only"]);
			return {
				samples: schedule.map((entry: any) => ({
					...entry,
					metrics: includeMetric ? { latencyMs: metricValue, supportedMs: 0 } : { supportedMs: 0 },
				})),
				metricDefinitions: {
					latencyMs: { unit: "ms", direction: "lower" },
					supportedMs: { unit: "ms", direction: "lower" },
				},
				correctness: { status: "passed" },
			};
		};

		const explicitNull = await runBenchmark(options, {
			repoRoot,
			importer: async () => ({ runJourney: journey(null) }),
		});
		assert.equal(explicitNull.exitCode, 0);
		assert.equal(explicitNull.report.samples[0].metrics.latencyMs, null);
		assert.equal(explicitNull.report.samples[0].metrics.supportedMs, 0);

		const missing = await runBenchmark(options, {
			repoRoot,
			importer: async () => ({ runJourney: journey(undefined, false) }),
		});
		assert.equal(missing.exitCode, 1);
		assert.match(missing.report.correctness.error, /must declare metric latencyMs/i);
	});

	it("retains the runner schedule and exact safe failing-sample diagnostic", async () => {
		const repoRoot = await temporaryRoot();
		const outputRoot = path.join(repoRoot, "reports");
		await mkdir(outputRoot);
		const baseline = path.join(outputRoot, "baseline.json");
		await writeFile(baseline, "known-good\n");
		const options = parseArgs([
			"--journey", "gateway-startup",
			"--warmups", "2",
			"--repetitions", "3",
			"--output", "baseline.json",
		]);
		const result = await runBenchmark(options, {
			repoRoot,
			outputRoot,
			importer: async () => ({ runJourney: async (context: any) => {
				const schedule = context.scheduleFor(["small", "medium", "large"]);
				const current = schedule.find((entry: any) => entry.order === 13);
				const failure: any = new Error("failed at /tmp/private/state token=unsafe-token");
				failure.benchmarkDiagnostic = {
					sample: current,
					childExit: {
						exitCode: 1,
						signal: "SIGTERM",
						spawnFailure: String.raw`spawn failed at C:\private\gateway.js password=unsafe-password
failed command: node evil.js`,
						pipesClosed: true,
						output: {
							tail: "command: node evil.js --token unsafe-token\nfatal /tmp/private/gateway.js\nOUTPUT-SENTINEL",
							truncated: false,
						},
						error: {
							tail: String.raw`Authorization: Bearer unsafe-authorization
\\server\share\private.log
ERROR-SENTINEL`,
							truncated: true,
						},
					},
				};
				throw failure;
			} }),
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.report.protocol.schedule.length, 15);
		assert.deepEqual(result.report.failure.sample, {
			phase: "measured", cycle: 2, case: "medium", caseOrder: 1, order: 13,
		});
		assert.equal(result.report.failure.childExit.exitCode, 1);
		assert.equal(result.report.failure.childExit.signal, "SIGTERM");
		assert.equal(result.report.failure.childExit.pipesClosed, true);
		assert.match(result.report.failure.childExit.output.tail, /OUTPUT-SENTINEL/);
		assert.match(result.report.failure.childExit.error.tail, /ERROR-SENTINEL/);
		assert.deepEqual(result.report.samples, []);
		assert.deepEqual(result.report.summaryByCase, {});
		assert.equal(await readFile(baseline, "utf8"), "known-good\n");
		const serialized = JSON.stringify(result.report);
		for (const forbidden of [
			"/tmp/private", "C:\\private", "unsafe-token", "unsafe-password",
			"unsafe-authorization", "node evil.js", String.raw`\\server\share`,
		]) {
			assert.equal(serialized.includes(forbidden), false, `failed report leaked ${forbidden}`);
		}
		assert.ok(Buffer.byteLength(serialized) < 100_000, "failed report must remain tightly bounded");
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

	it("preserves every unsupported session-open metric as null and supported zeroes", () => {
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
		const unsupported = sessionOpenMetricFields({
			timing: { now: 15, sent: 10, received: 12, snapshotChars: 0, heap: [], serverTiming: {} },
			snapshotFrameBytes: 0,
			heapBefore: null,
			heapAfterInteractive: null,
			longTaskMetrics: null,
		});
		assert.deepEqual(unsupported, {
			timeToInteractiveMs: 5,
			serverResponseLatencyMs: 2,
			transferredBytes: 0,
			longTaskCount: null,
			longTaskTotalMs: null,
			longTaskMaxMs: null,
			heapGrowthBytes: null,
			heapPeakBytes: null,
			rpcMs: null,
			pipelineMs: null,
			stampMs: null,
			stringifyMs: null,
		});
		const supportedZero = sessionOpenMetricFields({
			timing: {
				now: 0, sent: 0, received: 0, snapshotChars: 0, heap: [0],
				serverTiming: { rpcMs: 0, pipelineMs: 0, stampMs: 0, stringifyMs: 0 },
			},
			snapshotFrameBytes: 0,
			heapBefore: 0,
			heapAfterInteractive: 0,
			longTaskMetrics: { count: 0, totalMs: 0, maxMs: 0 },
		});
		assert.ok(Object.values(supportedZero).every(value => value === 0));
	});

	it("requires authentication in every benchmark gateway invocation", () => {
		const repoRoot = path.resolve("benchmark-repo");
		const workspace = path.resolve("benchmark-workspace");
		const invocations = [
			sessionOpenGatewayArgs(repoRoot, workspace, 1234),
			eventStreamBenchmark.eventStreamGatewayArgs(repoRoot, workspace, 1234),
			gatewayStartupGatewayArgs(repoRoot, workspace),
		];
		for (const args of invocations) {
			assert.equal(args.filter((arg: string) => arg === "--auth").length, 1);
			assert.deepEqual(args.slice(args.indexOf("--host"), args.indexOf("--host") + 2), ["--host", "127.0.0.1"]);
		}
	});

	it("creates distinct high-entropy sample credentials without putting them in report data", async () => {
		const root = await temporaryRoot();
		const first = await createBenchmarkGatewayToken(path.join(root, "sample-a", "secrets"));
		const second = await createBenchmarkGatewayToken(path.join(root, "sample-b", "secrets"));
		assert.match(first, /^[a-f0-9]{64}$/);
		assert.match(second, /^[a-f0-9]{64}$/);
		assert.notEqual(first, second);
		assert.equal(await readFile(path.join(root, "sample-a", "secrets", "token"), "utf8"), first);
		const reportMaterial = JSON.stringify(boundReport({
			fixtureDimensions: { fixtureVersion: GATEWAY_STARTUP_FIXTURE_VERSION },
			fixtureHashes: { semantic: "fixture-hash" },
			correctness: { status: "passed" },
		}));
		assert.equal(reportMaterial.includes(first), false);
		assert.equal(reportMaterial.includes(second), false);
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

	it("keeps full role/text parity independent from exact marker parity", () => {
		const fixture: any = createEventStreamFixture();
		const renderedMarkers = [
			...fixture.markers,
			EVENT_STREAM_PROPOSAL_TITLE,
			EVENT_STREAM_TOOL_OUTPUT,
			EVENT_STREAM_ERROR_OUTPUT,
			EVENT_STREAM_ERROR_OUTPUT,
			`${EVENT_STREAM_DONE_MARKER}:${fixture.updateCount}`,
			EVENT_STREAM_PROPOSAL_SPEC,
		].join(" | ");
		const liveMessages = [
			{ role: "user-message", text: "benchmark request" },
			{ role: "assistant-message", text: `proposal before ${EVENT_STREAM_PROPOSAL_SPEC} proposal after` },
			{ role: "tool-message", text: "tool details" },
		];
		const relocatedMessages = [
			{ role: "user-message", text: "benchmark request" },
			{ role: "assistant-message", text: "proposal before proposal after" },
			{ role: "tool-message", text: `${EVENT_STREAM_PROPOSAL_SPEC} tool details` },
		];
		const live = eventStreamBenchmark.fingerprintEventStreamDom(liveMessages, renderedMarkers, fixture);
		const relocated = eventStreamBenchmark.fingerprintEventStreamDom(relocatedMessages, renderedMarkers, fixture);
		eventStreamBenchmark.assertEventStreamLiveReloadParity(live, relocated);
		assert.equal(live.fullDomHash, relocated.fullDomHash, "exact proposal spec host relocation must canonicalize");
		assert.equal(live.markerHash, relocated.markerHash, "marker parity remains an independent exact surface");

		const mutations = [
			(messages: any[]) => messages.splice(2, 0, { role: "assistant-message", text: "non-marker insertion" }),
			(messages: any[]) => { messages[2].text = "changed non-marker details"; },
			(messages: any[]) => messages.splice(0, 2, messages[1], messages[0]),
		];
		for (const mutate of mutations) {
			const messages = structuredClone(relocatedMessages);
			mutate(messages);
			const changed = eventStreamBenchmark.fingerprintEventStreamDom(messages, renderedMarkers, fixture);
			assert.throws(
				() => eventStreamBenchmark.assertEventStreamLiveReloadParity(live, changed),
				/full DOM fingerprint/i,
			);
		}

		for (const changedText of [
			renderedMarkers.replace(EVENT_STREAM_PROPOSAL_TITLE, ""),
			`${renderedMarkers} ${EVENT_STREAM_PROPOSAL_SPEC}`,
			renderedMarkers.replace(
				`${EVENT_STREAM_PROPOSAL_TITLE} | ${EVENT_STREAM_TOOL_OUTPUT}`,
				`${EVENT_STREAM_TOOL_OUTPUT} | ${EVENT_STREAM_PROPOSAL_TITLE}`,
			),
		]) {
			const changed = eventStreamBenchmark.fingerprintEventStreamDom(relocatedMessages, changedText, fixture);
			assert.throws(
				() => eventStreamBenchmark.assertEventStreamLiveReloadParity(live, changed),
				/marker fingerprint/i,
			);
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

describe("bounded gateway child-exit diagnostics", () => {
	it("waits for close before formatting capped and redacted final pipe tails", async () => {
		const child: any = new EventEmitter();
		child.exitCode = 1;
		child.signalCode = "SIGTERM";
		const output = createTailBuffer(64);
		const error = createTailBuffer(64);
		output.push(`${"o".repeat(96)}OUTPUT-END`);
		error.push(`${"e".repeat(96)} token=secret-value C:\\private\\gateway.js`);
		const runtime: any = {
			child,
			stdout: output,
			stderr: error,
			exited: true,
			closed: false,
			spawnError: new Error(String.raw`synthetic spawn failure at /tmp/private/gateway.js token=secret-value
Authorization: Bearer authorization-secret
failed command: node evil.js
\\server\share\gateway.log`),
			diagnosticRedactions: ["secret-value"],
		};
		let finalPipeWrite = false;
		setTimeout(() => {
			error.push("\nFINAL-PIPE-SENTINEL");
			finalPipeWrite = true;
			runtime.closed = true;
			child.emit("close");
		}, 5);

		await assert.rejects(
			waitForGatewayReady({
				runtime,
				baseUrl: "http://127.0.0.1:1/",
				timeoutMs: 100,
				fetchImpl: async () => { throw new Error("health probe must not run after exit"); },
			}),
			(failure: any) => {
				assert.equal(finalPipeWrite, true, "diagnostic formatting must wait for child close");
				const diagnostic = failure.benchmarkDiagnostic.childExit;
				assert.equal(diagnostic.exitCode, 1);
				assert.equal(diagnostic.signal, "SIGTERM");
				assert.equal(diagnostic.pipesClosed, true);
				assert.equal(diagnostic.output.truncated, true);
				assert.equal(diagnostic.error.truncated, true);
				assert.match(diagnostic.output.tail, /OUTPUT-END/);
				assert.match(diagnostic.error.tail, /FINAL-PIPE-SENTINEL/);
				assert.match(diagnostic.spawnFailure, /synthetic spawn failure/);
				const serialized = JSON.stringify(diagnostic);
				assert.equal(serialized.includes("secret-value"), false);
				assert.equal(serialized.includes("/tmp/private"), false);
				assert.equal(serialized.includes("C:\\private"), false);
				assert.equal(serialized.includes("authorization-secret"), false);
				assert.equal(serialized.includes("node evil.js"), false);
				assert.equal(serialized.includes(String.raw`\\server\share`), false);
				return true;
			},
		);
	});
});

describe("bounded recursive benchmark error sanitization", () => {
	it("rebuilds nested AggregateError and cause graphs without tokenized URLs or raw causes", () => {
		const token = "a7".repeat(32);
		const navigation = new Error(`page.goto failed at http://127.0.0.1:4321/?token=${token}#/session/private`);
		(navigation as any).phase = "navigate";
		(navigation as any).phaseDurationsMs = { prepareMs: 12, navigateMs: 3, unsafe: token };
		(navigation as any).benchmarkDiagnostic = {
			sample: { phase: "measured", cycle: 1, case: "1mb", caseOrder: 0, order: 3, token },
			childExit: {
				exitCode: 1,
				signal: "SIGTERM",
				spawnFailure: `spawn token=${token}`,
				pipesClosed: true,
				output: { tail: `stdout ${token}`, truncated: false },
				error: { tail: `Authorization: Bearer ${token}`, truncated: false },
			},
		};
		const cleanup = new Error(`cleanup retained credential ${token}`, { cause: navigation });
		const root: any = new AggregateError([navigation, cleanup], `sample failed ${token}`, { cause: cleanup });
		navigation.cause = root;

		const sanitized: any = sanitizeBenchmarkError(root, {
			redactions: [token],
			runtime: { diagnosticRedactions: [token] },
		});
		const projection = projectErrorGraph(sanitized);
		const serialized = JSON.stringify(projection);
		assert.ok(sanitized instanceof AggregateError);
		assert.notEqual(sanitized, root);
		assert.notEqual(sanitized.errors[0], navigation);
		assert.equal(serialized.includes(token), false);
		assert.equal(serialized.includes("#/session/private"), false);
		assert.equal(sanitized.errors[0].phase, "navigate");
		assert.deepEqual(sanitized.errors[0].phaseDurationsMs, { prepareMs: 12, navigateMs: 3 });
		assert.deepEqual(sanitized.errors[0].benchmarkDiagnostic.sample, {
			order: 3, phase: "measured", cycle: 1, case: "1mb", caseOrder: 0,
		});
		assert.match(sanitized.errors[0].benchmarkDiagnostic.childExit.output.tail, /\[redacted\]/);
		assert.match(serialized, /graph cycle omitted/);
		assert.ok(Buffer.byteLength(serialized) < 20_000);
	});

	it("fails closed on hostile graph accessors and exact-redacts retained metadata strings", () => {
		const secret = "MetaSecret";
		const thrown = () => { throw new Error(`accessor escaped ${secret}`); };
		const hostile: any = new AggregateError([], "placeholder");
		Object.defineProperties(hostile, {
			message: { configurable: true, get: thrown },
			errors: { configurable: true, get: thrown },
			cause: { configurable: true, get: thrown },
			name: { configurable: true, value: `Error${secret}` },
			phase: { configurable: true, get: thrown },
			phaseDurationsMs: { configurable: true, get: thrown },
			benchmarkDiagnostic: {
				configurable: true,
				value: {
					sample: {
						order: 4,
						phase: `measured${secret}`,
						cycle: 1,
						case: `case-${secret}`,
						caseOrder: 0,
					},
					childExit: {
						exitCode: 1,
						signal: secret,
						spawnFailure: `spawn ${secret}`,
						pipesClosed: true,
						output: Object.defineProperty({}, "tail", { get: thrown }),
						error: { tail: `stderr ${secret}`, truncated: false },
					},
				},
			},
		});

		const sanitized: any = sanitizeBenchmarkError(hostile, { redactions: [secret] });
		const serialized = JSON.stringify(projectErrorGraph(sanitized));
		assert.ok(sanitized instanceof AggregateError);
		const safe: any = sanitized;
		assert.equal(safe.name, "AggregateError");
		assert.equal(safe.message, "Unknown benchmark error");
		assert.deepEqual(safe.errors, []);
		assert.equal(safe.cause, undefined);
		assert.equal(safe.phase, undefined);
		assert.equal(safe.benchmarkDiagnostic.sample.phase, "measured[redacted]");
		assert.equal(safe.benchmarkDiagnostic.sample.case, "case-[redacted]");
		assert.equal(safe.benchmarkDiagnostic.childExit.signal, null);
		assert.equal(safe.benchmarkDiagnostic.childExit.output.tail, "");
		assert.equal(serialized.includes(secret), false);
		assert.match(serialized, /\[redacted\]/);
	});

	it("keeps recursively sanitized journey failures credential-free in the failed report", async () => {
		const repoRoot = await temporaryRoot();
		const token = "ef".repeat(32);
		const options = parseArgs(["--journey", "event-stream", "--warmups", "2", "--repetitions", "1"]);
		const result = await runBenchmark(options, {
			repoRoot,
			importer: async () => ({
				runJourney: async (context: any) => {
					const [entry] = context.scheduleFor(["only"]);
					const leaf: any = new Error(`navigation http://127.0.0.1/?token=${token}#/private`);
					leaf.name = `Error${token}`;
					leaf.benchmarkDiagnostic = {
						sample: { ...entry, case: `only-${token}` },
						childExit: {
							exitCode: 1, signal: token, spawnFailure: null, pipesClosed: true,
							output: { tail: token, truncated: false },
							error: { tail: `Bearer ${token}`, truncated: false },
						},
					};
					throw sanitizeBenchmarkError(new AggregateError([leaf], `failed ${token}`, { cause: leaf }), {
						redactions: [token],
					});
				},
			}),
		});
		assert.equal(result.exitCode, 1);
		const serialized = JSON.stringify(result.report);
		assert.equal(serialized.includes(token), false);
		assert.match(serialized, /\[redacted\]/);
	});

	it("emits bounded failed JSON when the unsanitized failure graph has throwing accessors", async () => {
		const repoRoot = await temporaryRoot();
		const options = parseArgs(["--journey", "event-stream", "--warmups", "2", "--repetitions", "1"]);
		const result = await runBenchmark(options, {
			repoRoot,
			importer: async () => ({
				runJourney: async () => {
					const hostile: any = new Error("placeholder");
					for (const field of ["message", "errors", "cause", "benchmarkDiagnostic"]) {
						Object.defineProperty(hostile, field, {
							configurable: true,
							get() { throw new Error("hostile accessor must stay unread"); },
						});
					}
					throw hostile;
				},
			}),
		});
		assert.equal(result.exitCode, 1);
		assert.equal(result.report.correctness.status, "failed");
		assert.equal(result.report.correctness.error, "Unknown benchmark error");
		assert.doesNotThrow(() => JSON.stringify(result.report));
		assert.ok(Buffer.byteLength(JSON.stringify(result.report)) < 100_000);
	});

	it("keeps hostile run and deferred cleanup failures opaque until ordered sanitization", async () => {
		const repoRoot = await temporaryRoot();
		const token = "HostileMixedFailureToken";
		const hostile: any = new Error("placeholder");
		for (const field of ["message", "errors", "cause", "benchmarkDiagnostic"]) {
			Object.defineProperty(hostile, field, {
				configurable: true,
				get() { throw new Error(`accessor escaped ${token}`); },
			});
		}
		const cleanupFailure = new Error(`deferred cleanup token=${token}`);
		const combined: any = aggregateErrors("Benchmark run and cleanup failed", [hostile, cleanupFailure]);
		assert.deepEqual(combined.errors, [hostile, cleanupFailure]);
		const sanitized: any = sanitizeBenchmarkError(combined, { redactions: [token] });
		assert.deepEqual(sanitized.errors.map((error: Error) => error.message), [
			"Unknown benchmark error",
			"deferred cleanup token=[redacted]",
		]);

		let cleanupAttempts = 0;
		const result = await runBenchmark(
			parseArgs(["--journey", "event-stream", "--warmups", "2", "--repetitions", "1"]),
			{
				repoRoot,
				importer: async () => ({
					runJourney: async (context: any) => {
						context.scheduleFor(["only"]);
						context.deferCleanup(async () => {
							cleanupAttempts += 1;
							throw cleanupFailure;
						});
						throw hostile;
					},
				}),
			},
		);
		const serialized = JSON.stringify(result.report);
		assert.equal(cleanupAttempts, 1);
		assert.equal(result.exitCode, 1);
		assert.equal(result.report.cleanup.status, "failed");
		assert.equal(result.report.correctness.error, "Benchmark run and cleanup failed");
		assert.equal(serialized.includes(token), false);
		assert.equal(serialized.includes("accessor escaped"), false);
		assert.ok(Buffer.byteLength(serialized) < 100_000);
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
		watchdog.setPhase("browserAcquire");
		clock.advanceTo(35);
		watchdog.setPhase("browserSetup");
		clock.advanceTo(45);
		watchdog.setPhase("navigate");
		clock.advanceTo(50);
		watchdog.setPhase("interactiveWait");
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
			browserAcquireMs: 10,
			browserSetupMs: 10,
			navigateMs: 5,
			interactiveWaitMs: 10,
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

	it("names each asynchronous session-open browser boundary when it expires", async () => {
		for (const phase of ["browserAcquire", "browserSetup", "navigate", "interactiveWait"]) {
			const clock = injectedClock();
			const watchdog = createSessionOpenSampleWatchdog({
				timeoutMs: 10,
				graceMs: 1,
				now: clock.now,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
			});
			watchdog.setPhase(phase);
			clock.advanceTo(10);
			clock.timers.find(timer => timer.delay === 10)!.callback();
			assert.equal(watchdog.error.phase, phase);
			assert.match(watchdog.error.message, new RegExp(`during ${phase} phase`));
			await watchdog.finish();
		}
	});

	it("caps browser acquisition and reports launch rejection in its active phase", async () => {
		const watchdog = createSessionOpenSampleWatchdog({ timeoutMs: 180_000 });
		watchdog.setPhase("browserAcquire");
		let capturedOptions: any;
		await assert.rejects(measureBrowserSample(
			{ invocation: { baseUrl: "http://unused.invalid/" }, sessionId: "fixture-session" },
			{},
			watchdog,
			{
				launchBrowser: async (options: any) => {
					capturedOptions = options;
					throw new Error("injected Chromium launch rejection");
				},
			},
		), error => {
			assert.equal((error as any).phase, "browserAcquire");
			assert.match((error as Error).message, /browser acquisition failed during browserAcquire phase/i);
			assert.match(String((error as any).cause), /injected Chromium launch rejection/);
			return true;
		});
		assert.equal(capturedOptions.launchOptions.timeout, SESSION_OPEN_BROWSER_ACQUISITION_TIMEOUT_MS);
		assert.equal(watchdog.timedOut, false, "acquisition rejection must surface before the sample deadline");
		await watchdog.finish();
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

	it("interrupts a browser registered after pre-acquisition expiry and retains it through verified cleanup", async () => {
		const clock = injectedClock();
		const calls: string[] = [];
		const browserRuntime = { cdp: {}, browser: {} };
		const watchdog = eventStreamBenchmark.createEventStreamSampleWatchdog({
			timeoutMs: 40,
			graceMs: 5,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			terminateExecution: async (runtime: any) => { assert.equal(runtime, browserRuntime); calls.push("terminate"); },
			closeBrowser: async (runtime: any) => { assert.equal(runtime, browserRuntime); calls.push("fallback-close"); },
		});
		clock.advanceTo(40);
		clock.timers.find(timer => timer.delay === 40)!.callback();
		assert.equal(watchdog.signal.aborted, true);
		assert.deepEqual(watchdog.resources(), { browserRuntime: null, gatewayRuntime: null });

		watchdog.registerBrowser(browserRuntime);
		watchdog.registerBrowser(browserRuntime);
		assert.deepEqual(calls, ["terminate"], "late registration must interrupt exactly once");
		assert.equal(watchdog.resources().browserRuntime, browserRuntime, "watchdog retains ownership until verified cleanup");
		clock.advanceTo(45);
		clock.timers.find(timer => timer.delay === 5)!.callback();
		await Promise.resolve();
		assert.deepEqual(calls, ["terminate", "fallback-close"]);
		assert.equal(watchdog.resources().browserRuntime, browserRuntime, "fallback does not claim verified cleanup");

		calls.push("ordinary-close");
		watchdog.registerBrowser(null);
		await watchdog.finish();
		calls.push("next-sample");
		assert.deepEqual(calls, ["terminate", "fallback-close", "ordinary-close", "next-sample"]);
		assert.equal(watchdog.error.phase, "prepare");
	});

	it("starts grace close independently and bounds finish when interruption never settles", async () => {
		const clock = injectedClock();
		const calls: string[] = [];
		const browserRuntime = { cdp: {}, browser: {} };
		const never = new Promise<void>(() => {});
		const watchdog = eventStreamBenchmark.createEventStreamSampleWatchdog({
			timeoutMs: 40,
			graceMs: 5,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			terminateExecution: async () => { calls.push("terminate-start"); await never; },
			closeBrowser: async () => { calls.push("close-start"); await never; },
		});
		watchdog.registerBrowser(browserRuntime);
		clock.advanceTo(40);
		clock.timers.find(timer => timer.delay === 40)!.callback();
		assert.deepEqual(calls, ["terminate-start"]);
		clock.advanceTo(45);
		clock.timers.find(timer => timer.delay === 5)!.callback();
		assert.deepEqual(calls, ["terminate-start", "close-start"], "grace close must not await hung CDP termination");

		const finish = watchdog.finish();
		clock.advanceTo(55);
		clock.timers.find(timer => timer.delay === 10)!.callback();
		await assert.rejects(finish, /interruption did not settle within 10ms/);
		assert.equal(watchdog.resources().browserRuntime, browserRuntime, "unverified cleanup remains owned for deferred retry");
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

	it("does not describe an interrupted operation as incomplete cleanup when teardown succeeds", async () => {
		const clock = injectedClock();
		await assert.rejects(runSessionOpenSample(
			{ createSampleRoot: async () => "sample-root" },
			{ case: "tiny", phase: "measured", cycle: 0, order: 0, caseOrder: 0 },
			{ directory: "fixture", manifest: {} },
			{
				timeoutMs: 50,
				watchdogDependencies: {
					now: clock.now,
					setTimer: clock.setTimer,
					clearTimer: clock.clearTimer,
				},
				prepare: async () => ({ invocation: { baseUrl: "http://unused.invalid/" }, sessionId: "fixture-session" }),
				measure: async () => {
					clock.advanceTo(50);
					clock.timers.find(timer => timer.delay === 50)!.callback();
					throw new Error("browser operation rejected after interruption");
				},
			},
		), error => {
			assert.ok(error instanceof AggregateError);
			assert.equal((error as any).phase, "browserAcquire");
			assert.equal((error as AggregateError).errors[0].name, "SessionOpenSampleTimeoutError");
			assert.equal((error as AggregateError).errors[0].phase, "browserAcquire");
			assert.match((error as Error).message, /operation was interrupted during browserAcquire phase/i);
			assert.doesNotMatch((error as Error).message, /cleanup (?:was incomplete|failed)/i);
			return true;
		});
	});

	it("sanitizes tokenized post-navigation failures before cleanup completes", async () => {
		const token = "b8".repeat(32);
		const browserRuntime = { id: "browser" };
		const gatewayRuntime = { id: "gateway", diagnosticRedactions: [token] };
		let browserClosed = 0;
		let gatewayStopped = 0;
		const cleanupOrder: string[] = [];
		await assert.rejects(runSessionOpenSample(
			{ createSampleRoot: async () => "sample-root" },
			{ case: "tiny", phase: "measured", cycle: 0, order: 0, caseOrder: 0 },
			{ directory: "fixture", manifest: {} },
			{
				prepare: async (_context: any, _root: any, watchdog: any) => {
					watchdog.registerGateway(gatewayRuntime);
					return {
						invocation: { baseUrl: "http://127.0.0.1:4321/", token },
						sessionId: "fixture-session",
					};
				},
				measure: async (_restored: any, _manifest: any, watchdog: any) => {
					watchdog.registerBrowser(browserRuntime);
					throw new AggregateError([
						new Error(`page.goto: http://127.0.0.1:4321/?token=${token}#/session/fixture-session`),
					], `navigation failed ${token}`);
				},
				closeBrowser: async () => {
					cleanupOrder.push("browser");
					browserClosed += 1;
				},
				stopRuntime: async (_runtime: any, options: any) => {
					cleanupOrder.push("gateway");
					assert.equal(options.token, token, "cleanup must retain the exact live credential");
					gatewayStopped += 1;
				},
			},
		), error => {
			const serialized = JSON.stringify(projectErrorGraph(error));
			assert.equal(serialized.includes(token), false);
			assert.equal(serialized.includes("fixture-session"), false);
			return true;
		});
		assert.equal(browserClosed, 1);
		assert.equal(gatewayStopped, 1);
		assert.deepEqual(cleanupOrder, ["browser", "gateway"]);
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
				assert.equal(typeof options.launchBrowser, "function");
				clock.advanceTo(25);
				watchdog.setPhase("browserSetup");
				clock.advanceTo(30);
				watchdog.setPhase("navigate");
				clock.advanceTo(35);
				watchdog.setPhase("interactiveWait");
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
			browserAcquireMs: 5,
			browserSetupMs: 5,
			navigateMs: 5,
			interactiveWaitMs: 10,
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
			update(id: string, patch: any) { Object.assign(persistedSessions.find(session => session.id === id), patch); }
			get(id: string) { return persistedSessions.find(session => session.id === id); }
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
			assert.equal(existsSync(path.join(fixtureRoot, "secrets", "token")), false, "canonical fixture must not contain credentials");
			assert.doesNotMatch(JSON.stringify(generated.manifest), /"(?:token|auth)[^"]*"/i);
			const sampleRoots = [path.join(paths.samples, "sample-a"), path.join(paths.samples, "sample-b")];
			await Promise.all(sampleRoots.map(sampleRoot => cp(fixtureRoot, sampleRoot, { recursive: true })));
			const relocated = [];
			for (const sampleRoot of sampleRoots) {
				relocated.push(await relocateSampleFixture(sampleRoot, { SessionStore }));
			}
			assert.match(relocated[0].token, /^[a-f0-9]{64}$/);
			assert.match(relocated[1].token, /^[a-f0-9]{64}$/);
			assert.notEqual(relocated[0].token, relocated[1].token);
			for (const sample of relocated) {
				assert.equal(JSON.stringify(sample.manifest).includes(sample.token), false);
				assert.equal(await readFile(path.join(sample.secretsRoot, "token"), "utf8"), sample.token);
			}

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

	it("preserves the operation failure when gateway cleanup also fails", () => {
		const operation = new Error("OPERATION-SENTINEL");
		const cleanup = new Error("CLEANUP-SENTINEL");
		const combined = combineGatewayStartupSampleFailures(operation, cleanup);
		assert.ok(combined instanceof AggregateError);
		assert.deepEqual(combined.errors, [operation, cleanup]);
		assert.match(combined.message, /OPERATION-SENTINEL.*CLEANUP-SENTINEL/);
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
		const cleanupAttempts: string[] = [];
		const firstCleanup = new Error("first cleanup failure");
		const secondCleanup = new Error("second cleanup failure");
		const options = parseArgs(["--journey", "event-stream", "--warmups", "2", "--repetitions", "1", "--output", "baseline.json"]);
		const result = await runBenchmark(options, {
			repoRoot,
			outputRoot,
			importer: async () => ({ runJourney: async (context: any) => {
				context.deferCleanup(async () => { cleanupAttempts.push("first"); throw firstCleanup; });
				context.deferCleanup(async () => { cleanupAttempts.push("second"); throw secondCleanup; });
				return passingJourney(["only"])(context);
			} }),
		});
		assert.equal(result.exitCode, 1);
		assert.equal(result.report.correctness.error, "Benchmark cleanup failed");
		assert.deepEqual(cleanupAttempts, ["second", "first"]);
		assert.equal(await readFile(baseline, "utf8"), "known-good\n");
		const failed = JSON.parse(await readFile(path.join(outputRoot, "baseline.failed.json"), "utf8"));
		assert.equal(failed.correctness.status, "failed");
		assert.equal(failed.cleanup.status, "failed");
		assert.equal(JSON.stringify(failed).includes("threshold"), false);
	});
});
