import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BENCHMARK_SCHEMA_VERSION = 1;
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
export const MAX_REPORT_STRING_LENGTH = 8_000;
export const MAX_REPORT_ARRAY_LENGTH = 4_096;
export const MAX_REPORT_OBJECT_KEYS = 256;
export const MAX_REPORT_DEPTH = 12;

const FORBIDDEN_REPORT_KEYS = new Set([
	"command",
	"domdump",
	"domdumps",
	"fulllogs",
	"fullprocesslogs",
	"processlogs",
	"shell",
	"shelltext",
	"stderr",
	"stdout",
	"threshold",
	"thresholds",
	"transcript",
	"transcriptbodies",
	"transcriptbody",
]);

function numericValues(values) {
	if (!Array.isArray(values)) throw new TypeError("Expected an array of numbers");
	return values.map(value => {
		if (!Number.isFinite(value)) throw new TypeError("Statistics require finite numbers");
		return Number(value);
	});
}

export function median(values) {
	const sorted = numericValues(values).sort((a, b) => a - b);
	if (sorted.length === 0) return null;
	const midpoint = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[midpoint - 1] + sorted[midpoint]) / 2
		: sorted[midpoint];
}

export function nearestRankPercentile(values, percentile) {
	const sorted = numericValues(values).sort((a, b) => a - b);
	if (sorted.length === 0) return null;
	if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
		throw new RangeError("Percentile must be greater than 0 and at most 1");
	}
	return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

export function p95(values) {
	return nearestRankPercentile(values, 0.95);
}

export function medianAbsoluteDeviation(values) {
	const numbers = numericValues(values);
	if (numbers.length === 0) return null;
	const center = median(numbers);
	return median(numbers.map(value => Math.abs(value - center)));
}

export function coefficientOfVariation(values) {
	const numbers = numericValues(values);
	if (numbers.length === 0) return null;
	const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
	if (mean === 0) return null;
	const variance = numbers.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / numbers.length;
	return Math.sqrt(variance) / Math.abs(mean);
}

export function summarizeMetric(values, definition = {}) {
	const numbers = numericValues(values);
	if (numbers.length === 0) return {
		unit: definition.unit ?? null,
		direction: definition.direction ?? null,
		reliability: definition.reliability ?? null,
		count: 0,
		median: null,
		p95: null,
		min: null,
		max: null,
		range: null,
		mad: null,
		coefficientOfVariation: null,
	};
	const min = Math.min(...numbers);
	const max = Math.max(...numbers);
	return {
		unit: definition.unit ?? null,
		direction: definition.direction ?? null,
		reliability: definition.reliability ?? null,
		count: numbers.length,
		median: median(numbers),
		p95: p95(numbers),
		min,
		max,
		range: max - min,
		mad: medianAbsoluteDeviation(numbers),
		coefficientOfVariation: coefficientOfVariation(numbers),
	};
}

/**
 * Summarize measured samples by case. A metric definition is
 * `{ unit, direction, reliability? }`; null and unsupported samples are omitted.
 */
export function summarizeSamplesByCase(samples, metricDefinitions) {
	if (!Array.isArray(samples)) throw new TypeError("samples must be an array");
	if (!metricDefinitions || typeof metricDefinitions !== "object" || Array.isArray(metricDefinitions)) {
		throw new TypeError("metricDefinitions must be an object");
	}
	const measured = samples.filter(sample => sample?.phase !== "warmup");
	const caseNames = [...new Set(measured.map(sample => String(sample.case)))].sort();
	return Object.fromEntries(caseNames.map(caseName => [caseName, Object.fromEntries(
		Object.entries(metricDefinitions).map(([metric, definition]) => {
			const values = measured
				.filter(sample => String(sample?.case) === caseName)
				.map(sample => sample?.metrics?.[metric] ?? sample?.[metric])
				.filter(Number.isFinite);
			return [metric, summarizeMetric(values, definition)];
		}),
	)]));
}

/** Build warm-up and measured cycles, reversing case order on every cycle. */
export function buildAlternatingSchedule(cases, warmups, repetitions) {
	if (!Array.isArray(cases) || cases.length === 0 || cases.some(value => typeof value !== "string" || !value)) {
		throw new TypeError("cases must be a non-empty array of names");
	}
	if (new Set(cases).size !== cases.length) throw new Error("case names must be unique");
	if (!Number.isInteger(warmups) || warmups < 0) throw new RangeError("warmups must be a non-negative integer");
	if (!Number.isInteger(repetitions) || repetitions < 1) throw new RangeError("repetitions must be a positive integer");
	const schedule = [];
	let order = 0;
	let alternationCycle = 0;
	const append = (phase, count) => {
		for (let cycle = 0; cycle < count; cycle += 1, alternationCycle += 1) {
			const orderedCases = alternationCycle % 2 === 0 ? cases : [...cases].reverse();
			for (let caseOrder = 0; caseOrder < orderedCases.length; caseOrder += 1) {
				schedule.push({ phase, cycle, case: orderedCases[caseOrder], caseOrder, order: order++ });
			}
		}
	};
	append("warmup", warmups);
	append("measured", repetitions);
	return schedule;
}

export function collectCommitMetadata(repoRoot) {
	try {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const status = execFileSync("git", ["status", "--porcelain"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return { sha: sha || null, dirty: status.trim().length > 0 };
	} catch {
		return { sha: null, dirty: null };
	}
}

export function collectEnvironmentMetadata(overrides = {}) {
	const cpuList = os.cpus();
	return {
		os: process.platform,
		release: os.release(),
		arch: process.arch,
		node: process.version,
		v8: process.versions.v8,
		cpuModel: cpuList[0]?.model?.trim() || null,
		logicalCpus: cpuList.length || null,
		totalMemoryBytes: os.totalmem(),
		browser: overrides.browser ?? null,
		viewport: overrides.viewport ?? null,
		metricSupport: overrides.metricSupport ?? {},
	};
}

function normalizedKey(key) {
	return key.replace(/[-_\s]/g, "").toLowerCase();
}

function sanitizeValue(value, depth, seen) {
	if (depth > MAX_REPORT_DEPTH) throw new Error(`Benchmark report exceeds maximum depth ${MAX_REPORT_DEPTH}`);
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return typeof value === "string" && value.length > MAX_REPORT_STRING_LENGTH
			? `${value.slice(0, MAX_REPORT_STRING_LENGTH - 24)}…[truncated ${value.length}]`
			: value;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") throw new TypeError(`Unsupported report value: ${typeof value}`);
	if (seen.has(value)) throw new TypeError("Benchmark report must not contain cycles");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_REPORT_ARRAY_LENGTH) {
				throw new Error(`Benchmark report array exceeds ${MAX_REPORT_ARRAY_LENGTH} entries`);
			}
			return value.map(item => sanitizeValue(item, depth + 1, seen));
		}
		const entries = Object.entries(value);
		if (entries.length > MAX_REPORT_OBJECT_KEYS) {
			throw new Error(`Benchmark report object exceeds ${MAX_REPORT_OBJECT_KEYS} keys`);
		}
		const output = {};
		for (const [key, item] of entries) {
			if (FORBIDDEN_REPORT_KEYS.has(normalizedKey(key))) {
				throw new Error(`Benchmark reports may not contain ${key} fields`);
			}
			output[key] = sanitizeValue(item, depth + 1, seen);
		}
		return output;
	} finally {
		seen.delete(value);
	}
}

export function boundReport(report) {
	const bounded = sanitizeValue(report, 0, new Set());
	const bytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
	if (bytes > MAX_REPORT_BYTES) throw new Error(`Benchmark report exceeds ${MAX_REPORT_BYTES} bytes`);
	return bounded;
}

export function serializeBoundedReport(report) {
	return `${JSON.stringify(boundReport(report), null, 2)}\n`;
}

function isWithin(parent, candidate) {
	const relative = path.relative(path.resolve(parent), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function existingPathInfo(candidate) {
	const missing = [];
	let existing = path.resolve(candidate);
	while (true) {
		try {
			await lstat(existing);
			return { existing, missing, canonical: path.join(await realpath(existing), ...missing) };
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			const parent = path.dirname(existing);
			if (parent === existing) throw new Error(`No existing ancestor for ${candidate}`);
			missing.unshift(path.basename(existing));
			existing = parent;
		}
	}
}

async function rejectLinksWithin(root, candidate) {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidate);
	let current = path.parse(resolvedCandidate).root;
	if ((await lstat(current)).isSymbolicLink()) {
		throw new Error("Benchmark report output must not traverse a symbolic link or junction");
	}
	for (const segment of path.relative(current, resolvedCandidate).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			if ((await lstat(current)).isSymbolicLink()) {
				if (path.resolve(current) === resolvedRoot) {
					throw new Error("Benchmark report output root must not be a symbolic link or junction");
				}
				throw new Error("Benchmark report output must not traverse a symbolic link or junction");
			}
		} catch (error) {
			if (error?.code === "ENOENT") break;
			throw error;
		}
	}
}

async function assertSafeReportMutation(destination, allowedRoot) {
	const root = path.resolve(allowedRoot);
	if (!isWithin(root, destination) || path.resolve(destination) === root) {
		throw new Error("Benchmark report output escaped its allowed root");
	}
	await rejectLinksWithin(root, destination);
	const [rootInfo, parentInfo] = await Promise.all([
		existingPathInfo(root),
		existingPathInfo(path.dirname(destination)),
	]);
	if (!isWithin(rootInfo.canonical, parentInfo.canonical)) {
		throw new Error("Benchmark report output resolved outside its allowed root");
	}
}

/** Write through a same-directory temporary file so rename is atomic. */
export async function atomicWriteReport(outputPath, report, { allowedRoot = path.dirname(path.resolve(outputPath)) } = {}) {
	const destination = path.resolve(outputPath);
	await assertSafeReportMutation(destination, allowedRoot);
	await mkdir(path.dirname(destination), { recursive: true });
	// Re-check after directory creation and immediately before both mutations.
	await assertSafeReportMutation(destination, allowedRoot);
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, serializeBoundedReport(report), { encoding: "utf8", flag: "wx" });
		await assertSafeReportMutation(destination, allowedRoot);
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
	return destination;
}

/** Failed runs use a sibling artifact and never replace a known-good baseline. */
export function failedReportPath(outputPath) {
	const parsed = path.parse(outputPath);
	return path.join(parsed.dir, `${parsed.name}.failed${parsed.ext || ".json"}`);
}
