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
	validateGatewayStartupSemanticProjection,
} from "../../scripts/benchmarks/gateway-startup.mjs";
import {
	cleanupBenchmarkRunRoot,
	closeBenchmarkBrowser,
	createBenchmarkRunRoot,
} from "../../scripts/benchmarks/runtime.mjs";
import {
	generateSessionOpenFixture,
	projectSessionOpenMessages,
	SESSION_OPEN_CASES,
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
	it("pins exact session transcript dimensions, hashes, and semantic counts", async () => {
		const root = await temporaryRoot();
		const expected: Record<string, any> = {
			"1mb": [1_000_000, "af879373eb70bbe53d64f9bf33b16fda84af7aa17d31aa317c15835ddda36370", "f72abc837e0a43c243010c60c435e89cf7a7c4d2f7c660a678adcecbc2aebcb2", 115, 119, 38, 28],
			"10mb": [10_000_000, "bbdd6ca819ccb9cf118fbb1d61e4f181493b8d75a1b8f92b5a45c0b1fa92a462", "60fc873aa5b1518e0858fbe923643ef74039c895f2ac5b29c08c1fa02403a4d6", 1168, 1172, 389, 291],
			"25mb": [25_000_000, "42700048481b9485cac9a83ddb0295253e54afe0741d016534955b26e01d7fd6", "857e9bcc0881322e8badb79f0ea0531170e8a730be07b9031179b7992a1d7dc1", 2920, 2924, 973, 729],
		};
		for (const fixtureCase of SESSION_OPEN_CASES) {
			const fixture = await generateSessionOpenFixture(root, fixtureCase);
			const [bytes, transcriptHash, semanticHash, rawCount, visibleCount, tools, errors] = expected[fixtureCase.name];
			assert.equal((await stat(path.join(fixture.directory, "transcript.jsonl"))).size, bytes);
			assert.equal(fixture.manifest.transcriptSha256, transcriptHash);
			assert.equal(fixture.manifest.expectedSemanticSha256, semanticHash);
			assert.equal(fixture.manifest.rawMessageCount, rawCount);
			assert.equal(fixture.manifest.expectedVisibleMessageCount, visibleCount);
			assert.equal(fixture.manifest.expectedToolCallIds.length, tools);
			assert.equal(fixture.manifest.expectedErrorIds.length, errors);
			assert.equal(fixture.manifest.expectedCompactionIds.length, 2);
		}
	}, 20_000);

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
