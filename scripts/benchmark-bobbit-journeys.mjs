#!/usr/bin/env node

import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	BENCHMARK_SCHEMA_VERSION,
	atomicWriteReport,
	boundReport,
	buildAlternatingSchedule,
	collectCommitMetadata,
	collectEnvironmentMetadata,
	failedReportPath,
	serializeBoundedReport,
	summarizeSamplesByCase,
} from "./benchmarks/contract.mjs";
import {
	cleanupBenchmarkRunRoot,
	createBenchmarkRunRoot,
	createSampleRoot,
} from "./benchmarks/runtime.mjs";

export const BENCHMARKS = Object.freeze({
	"session-open": "./benchmarks/session-open.mjs",
	"gateway-startup": "./benchmarks/gateway-startup.mjs",
	"event-stream": "./benchmarks/event-stream.mjs",
});
export const DEFAULT_WARMUPS = 2;
export const DEFAULT_REPETITIONS = 7;
export const MIN_WARMUPS = 2;
export const MAX_WARMUPS = 20;
export const MIN_REPETITIONS = 1;
export const MAX_REPETITIONS = 50;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const DEFAULT_OUTPUT_ROOT = path.join(REPO_ROOT, ".bobbit-qa", "benchmarks");

function takeValue(argv, index, flag) {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function parseBoundedInteger(value, flag, minimum, maximum) {
	if (!/^\d+$/.test(value)) throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`);
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
		throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`);
	}
	return number;
}

function isWithin(parent, candidate) {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function projectedCanonicalPath(candidate) {
	const missing = [];
	let existing = path.resolve(candidate);
	while (!existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) throw new Error(`No existing ancestor for ${candidate}`);
		missing.unshift(path.basename(existing));
		existing = parent;
	}
	return path.join(realpathSync(existing), ...missing);
}

function rejectExistingOutputLinks(root, destination) {
	let current = path.resolve(root);
	if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
		throw new Error("Benchmark output root must not be a symbolic link or junction");
	}
	const relative = path.relative(current, path.dirname(destination));
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if (!existsSync(current)) break;
		if (lstatSync(current).isSymbolicLink()) {
			throw new Error("--output must not traverse a symbolic link or junction");
		}
	}
	if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
		throw new Error("--output must not replace a symbolic link or junction");
	}
}

export function resolveBenchmarkOutputPath(value, outputRoot = DEFAULT_OUTPUT_ROOT) {
	if (typeof value !== "string" || !value.trim()) throw new Error("--output requires a relative JSON filename");
	if (path.isAbsolute(value)) throw new Error("--output must stay beneath the benchmark output root");
	const root = path.resolve(outputRoot);
	const destination = path.resolve(root, value);
	const relative = path.relative(root, destination);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("--output must stay beneath the benchmark output root");
	}
	if (path.extname(destination).toLowerCase() !== ".json") throw new Error("--output must name a .json file");
	rejectExistingOutputLinks(root, destination);
	if (!isWithin(projectedCanonicalPath(root), projectedCanonicalPath(path.dirname(destination)))) {
		throw new Error("--output resolved outside the benchmark output root");
	}
	return destination;
}

export function parseArgs(argv) {
	const options = {
		journey: null,
		warmups: DEFAULT_WARMUPS,
		repetitions: DEFAULT_REPETITIONS,
		output: null,
		keepTemp: false,
		help: false,
	};
	const seen = new Set();
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") {
			if (seen.has("help")) throw new Error("--help may only be specified once");
			seen.add("help");
			options.help = true;
			continue;
		}
		if (argument === "--keep-temp") {
			if (seen.has("keep-temp")) throw new Error("--keep-temp may only be specified once");
			seen.add("keep-temp");
			options.keepTemp = true;
			continue;
		}
		let flag;
		let value;
		if (argument.startsWith("--") && argument.includes("=")) {
			[flag, value] = argument.split(/=(.*)/s, 2);
			if (!value) throw new Error(`${flag} requires a value`);
		} else if (["--journey", "--warmups", "--repetitions", "--output"].includes(argument)) {
			flag = argument;
			value = takeValue(argv, index, flag);
			index += 1;
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
		const key = flag.slice(2);
		if (!Object.hasOwn(options, key)) throw new Error(`Unknown argument: ${flag}`);
		if (seen.has(key)) throw new Error(`${flag} may only be specified once`);
		seen.add(key);
		if (flag === "--journey") options.journey = value;
		else if (flag === "--warmups") options.warmups = parseBoundedInteger(value, flag, MIN_WARMUPS, MAX_WARMUPS);
		else if (flag === "--repetitions") options.repetitions = parseBoundedInteger(value, flag, MIN_REPETITIONS, MAX_REPETITIONS);
		else if (flag === "--output") options.output = value;
	}
	if (!options.help && !Object.hasOwn(BENCHMARKS, options.journey)) {
		throw new Error(`--journey must be one of: ${Object.keys(BENCHMARKS).join(", ")}`);
	}
	return options;
}

export function usage() {
	return [
		"Usage: node scripts/benchmark-bobbit-journeys.mjs --journey <name> [options]",
		"",
		`Journeys: ${Object.keys(BENCHMARKS).join(", ")}`,
		`  --warmups N       Warm-up cycles (${MIN_WARMUPS}-${MAX_WARMUPS}, default ${DEFAULT_WARMUPS})`,
		`  --repetitions N    Measured cycles (${MIN_REPETITIONS}-${MAX_REPETITIONS}, default ${DEFAULT_REPETITIONS})`,
		"  --output FILE      Write JSON beneath .bobbit-qa/benchmarks/",
		"  --keep-temp        Retain the owned temporary run root for diagnostics",
		"  -h, --help         Show this help",
	].join("\n");
}

async function importJourney(journey, importer = specifier => import(specifier)) {
	const relativeModule = BENCHMARKS[journey];
	if (!relativeModule) throw new Error(`Unknown benchmark journey: ${journey}`);
	const moduleUrl = new URL(relativeModule, import.meta.url);
	const module = await importer(moduleUrl.href);
	if (typeof module.runJourney !== "function") {
		throw new Error(`${journey} must export an async runJourney(context) function`);
	}
	return module.runJourney;
}

function normalizeCorrectness(correctness) {
	const passed = correctness === true
		|| correctness?.passed === true
		|| correctness?.status === "passed";
	const details = correctness && typeof correctness === "object" && !Array.isArray(correctness)
		? correctness
		: {};
	return { ...details, status: passed ? "passed" : "failed" };
}

function makeBaseReport({ benchmark, options, journeyResult, schedule, cleanup, repoRoot }) {
	const environmentOverrides = journeyResult?.environment ?? {};
	const correctness = normalizeCorrectness(journeyResult?.correctness);
	const samples = journeyResult.samples;
	const summaryByCase = summarizeSamplesByCase(samples, journeyResult.metricDefinitions);
	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		benchmark,
		generatedAt: new Date().toISOString(),
		commit: collectCommitMetadata(repoRoot),
		environment: collectEnvironmentMetadata(environmentOverrides),
		fixtureDimensions: journeyResult?.fixtureDimensions ?? {},
		fixtureHashes: journeyResult?.fixtureHashes ?? {},
		protocol: {
			warmups: options.warmups,
			repetitions: options.repetitions,
			schedule,
		},
		samples,
		summaryByCase,
		interpretation: journeyResult?.interpretation ?? "Inspect parity first, then compare raw samples, median, p95, MAD, and coefficient of variation on the same host.",
		limitations: journeyResult?.limitations ?? [],
		noiseSources: journeyResult?.noiseSources ?? [],
		comparisonMethod: journeyResult?.comparisonMethod ?? "Use the same fixture and schema versions and alternate baseline/candidate runs on the same host before comparing lower-is-better latency metrics.",
		cleanup,
		correctness,
	};
}

function validateMetricDefinitions(metricDefinitions) {
	if (!metricDefinitions || typeof metricDefinitions !== "object" || Array.isArray(metricDefinitions)) {
		throw new TypeError("runJourney() must return a non-empty metricDefinitions object");
	}
	const entries = Object.entries(metricDefinitions);
	if (entries.length === 0) throw new Error("runJourney() must define at least one numeric metric");
	for (const [metric, definition] of entries) {
		if (!metric || !definition || typeof definition !== "object" || Array.isArray(definition)) {
			throw new TypeError(`Metric ${metric || "<empty>"} must have a definition object`);
		}
		if (typeof definition.unit !== "string" || !definition.unit) {
			throw new TypeError(`Metric ${metric} must define a non-empty unit`);
		}
		if (definition.direction !== "lower" && definition.direction !== "higher") {
			throw new TypeError(`Metric ${metric} direction must be lower or higher`);
		}
	}
	return entries.map(([metric]) => metric);
}

function validateScheduledSamples(journeyResult, schedule) {
	if (!Array.isArray(journeyResult.samples)) throw new TypeError("runJourney() must return a samples array");
	if (journeyResult.samples.length !== schedule.length) {
		throw new Error(`runJourney() returned ${journeyResult.samples.length} samples for ${schedule.length} scheduled entries`);
	}
	const metrics = validateMetricDefinitions(journeyResult.metricDefinitions);
	const identityFields = ["phase", "cycle", "case", "caseOrder", "order"];
	let measuredSamples = 0;
	for (let index = 0; index < schedule.length; index += 1) {
		const expected = schedule[index];
		const sample = journeyResult.samples[index];
		if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
			throw new TypeError(`Sample ${index} must be an object`);
		}
		for (const field of identityFields) {
			if (sample[field] !== expected[field]) {
				throw new Error(`Sample ${index} ${field} must be ${JSON.stringify(expected[field])}, got ${JSON.stringify(sample[field])}`);
			}
		}
		if (!sample.metrics || typeof sample.metrics !== "object" || Array.isArray(sample.metrics)) {
			throw new TypeError(`Sample ${index} must contain a metrics object`);
		}
		let numericMetrics = 0;
		for (const metric of metrics) {
			const value = sample.metrics[metric];
			if (value !== null && value !== undefined && !Number.isFinite(value)) {
				throw new TypeError(`Sample ${index} metric ${metric} must be a finite number or null`);
			}
			if (Number.isFinite(value)) numericMetrics += 1;
		}
		if (sample.phase === "measured") {
			measuredSamples += 1;
			if (numericMetrics === 0) throw new Error(`Measured sample ${index} contains no numeric metrics`);
		}
	}
	if (measuredSamples === 0) throw new Error("runJourney() returned no measured samples");
}

function aggregateErrors(label, errors) {
	if (errors.length === 0) return undefined;
	if (errors.length === 1) return errors[0];
	return new AggregateError(errors, `${label}: ${errors.map(error => error?.message ?? String(error)).join("; ")}`);
}

function makeFailureReport({ benchmark, options, error, cleanup, repoRoot }) {
	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		benchmark,
		generatedAt: new Date().toISOString(),
		commit: collectCommitMetadata(repoRoot),
		environment: collectEnvironmentMetadata(),
		fixtureDimensions: {},
		fixtureHashes: {},
		protocol: { warmups: options.warmups, repetitions: options.repetitions, schedule: [] },
		samples: [],
		summaryByCase: {},
		interpretation: "This run failed correctness or lifecycle validation and must not be used as a baseline.",
		limitations: [],
		noiseSources: [],
		comparisonMethod: "Resolve the failure and rerun; failed reports are not comparable benchmark results.",
		cleanup,
		correctness: {
			status: "failed",
			error: String(error?.message ?? error ?? "Unknown benchmark failure"),
		},
	};
}

/**
 * Execute one allow-listed journey. Journey modules own fixture/oracle semantics
 * and expose only `runJourney(context)`; the shared runner owns the contract.
 */
export async function runBenchmark(options, {
	importer,
	repoRoot = REPO_ROOT,
	outputRoot = path.join(repoRoot, ".bobbit-qa", "benchmarks"),
	runRootFactory = createBenchmarkRunRoot,
} = {}) {
	const requestedOutputPath = options.output
		? resolveBenchmarkOutputPath(options.output, outputRoot)
		: null;
	let paths;
	let journeyResult;
	let runError;
	let cleanupError;
	let usedSchedule = null;
	let scheduleCalls = 0;
	const deferredCleanup = [];
	try {
		paths = await runRootFactory({ repoRoot });
		const runJourney = await importJourney(options.journey, importer);
		const context = Object.freeze({
			benchmark: options.journey,
			repoRoot,
			runRoot: paths.root,
			paths: Object.freeze({
				gateway: paths.gateway,
				project: paths.project,
				agent: paths.agent,
				artifacts: paths.artifacts,
				fixtures: paths.fixtures,
				samples: paths.samples,
			}),
			options: Object.freeze({
				warmups: options.warmups,
				repetitions: options.repetitions,
				keepTemp: options.keepTemp,
			}),
			scheduleFor(cases) {
				scheduleCalls += 1;
				if (scheduleCalls !== 1) throw new Error("scheduleFor(cases) must be called exactly once per journey");
				usedSchedule = buildAlternatingSchedule(cases, options.warmups, options.repetitions);
				return usedSchedule.map(entry => ({ ...entry }));
			},
			createSampleRoot(entry, sampleOptions) {
				return createSampleRoot(paths, entry, sampleOptions);
			},
			deferCleanup(callback) {
				if (typeof callback !== "function") throw new TypeError("Cleanup callback must be a function");
				deferredCleanup.push(callback);
			},
		});
		journeyResult = await runJourney(context);
		if (!journeyResult || typeof journeyResult !== "object" || Array.isArray(journeyResult)) {
			throw new TypeError(`${options.journey} runJourney() must return a result object`);
		}
		if (normalizeCorrectness(journeyResult.correctness).status !== "passed") {
			throw new Error(`${options.journey} correctness validation failed`);
		}
		if (scheduleCalls !== 1 || !usedSchedule) {
			throw new Error(`${options.journey} must call scheduleFor(cases) exactly once`);
		}
		validateScheduledSamples(journeyResult, usedSchedule);
	} catch (error) {
		runError = error;
	} finally {
		const cleanupErrors = [];
		for (const callback of deferredCleanup.reverse()) {
			try { await callback(); } catch (error) { cleanupErrors.push(error); }
		}
		if (paths && !options.keepTemp) {
			try { await cleanupBenchmarkRunRoot(paths); } catch (error) { cleanupErrors.push(error); }
		}
		cleanupError = aggregateErrors("Benchmark cleanup failed", cleanupErrors);
	}

	let finalError = aggregateErrors("Benchmark run and cleanup failed", [runError, cleanupError].filter(Boolean));
	const retainedRoot = options.keepTemp ? paths?.root ?? null : null;
	const cleanup = {
		status: cleanupError ? "failed" : retainedRoot ? "retained" : "completed",
		kept: retainedRoot !== null,
		root: retainedRoot,
	};
	const failureReport = error => boundReport(makeFailureReport({
		benchmark: options.journey,
		options,
		error,
		cleanup,
		repoRoot,
	}));
	let boundedReport;
	try {
		boundedReport = finalError
			? failureReport(finalError)
			: boundReport(makeBaseReport({
				benchmark: options.journey,
				options,
				journeyResult,
				schedule: usedSchedule,
				cleanup,
				repoRoot,
			}));
	} catch (error) {
		finalError = error;
		boundedReport = failureReport(error);
	}
	let writtenPath = null;
	if (requestedOutputPath) {
		try {
			writtenPath = await atomicWriteReport(finalError ? failedReportPath(requestedOutputPath) : requestedOutputPath, boundedReport, { allowedRoot: outputRoot });
		} catch (error) {
			finalError ??= error;
			boundedReport = failureReport(finalError);
			// A result-write failure still produces bounded JSON on stdout. Make one
			// best-effort failed artifact without ever replacing the requested baseline.
			try {
				writtenPath = await atomicWriteReport(failedReportPath(requestedOutputPath), boundedReport, { allowedRoot: outputRoot });
			} catch { writtenPath = null; }
		}
	}
	return { report: boundedReport, exitCode: finalError ? 1 : 0, outputPath: writtenPath };
}

export async function runCli(argv, dependencies) {
	const options = parseArgs(argv);
	if (options.help) return { help: usage(), exitCode: 0 };
	return runBenchmark(options, dependencies);
}

function isMainModule() {
	if (!process.argv[1]) return false;
	return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
	try {
		const result = await runCli(process.argv.slice(2));
		if (result.help) process.stdout.write(`${result.help}\n`);
		else process.stdout.write(serializeBoundedReport(result.report));
		process.exitCode = result.exitCode;
	} catch (error) {
		process.stderr.write(`benchmark: ${error?.message ?? error}\n`);
		process.exitCode = 1;
	}
}
