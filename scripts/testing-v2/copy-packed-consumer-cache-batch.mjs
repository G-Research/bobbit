#!/usr/bin/env node

/**
 * Copy exact ambient cacache digests into a run-owned staging directory.
 *
 * The two argv paths are independent process authority. Stdin contains only a
 * bounded, versioned list of exact integrity identities; callers cannot choose
 * source or destination paths. The ambient cache is read-only.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import cacache from "cacache";

const REQUEST_VERSION = 1;
const RESULT_VERSION = 1;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_INTEGRITIES = 1_000;
const MAX_INTEGRITY_LENGTH = 2_048;
const MAX_WORKERS = 3;
const MAX_DIAGNOSTIC_BYTES = 8_000;

function isStrictChild(root, candidate) {
	const child = relative(resolve(root), resolve(candidate));
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function requireExactKeys(value, expected, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	const actual = Object.keys(value).sort();
	const allowed = [...expected].sort();
	if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
		throw new Error(`${label} must contain only ${allowed.join(", ")}`);
	}
}

function validateAuthority(authoritativeFixtureRoot, authoritativeAmbientContentCache) {
	if (typeof authoritativeFixtureRoot !== "string" || !isAbsolute(authoritativeFixtureRoot)) {
		throw new Error("authoritative fixture root must be absolute");
	}
	if (typeof authoritativeAmbientContentCache !== "string" || !isAbsolute(authoritativeAmbientContentCache)) {
		throw new Error("authoritative ambient content cache must be absolute");
	}
	const fixtureRoot = resolve(authoritativeFixtureRoot);
	const ambientContentCache = resolve(authoritativeAmbientContentCache);
	if (basename(ambientContentCache) !== "_cacache") {
		throw new Error("authoritative ambient content cache must identify npm's _cacache directory");
	}
	if (fixtureRoot === ambientContentCache || isStrictChild(fixtureRoot, ambientContentCache) || isStrictChild(ambientContentCache, fixtureRoot)) {
		throw new Error("authoritative ambient content cache and fixture root must not overlap");
	}
	return { fixtureRoot, ambientContentCache };
}

function validateRequest(request) {
	requireExactKeys(request, ["version", "integrities"], "cache-copy request");
	if (request.version !== REQUEST_VERSION) throw new Error(`cache-copy request version must be ${REQUEST_VERSION}`);
	if (!Array.isArray(request.integrities) || request.integrities.length > MAX_INTEGRITIES) {
		throw new Error(`cache-copy integrities must be an array of at most ${MAX_INTEGRITIES} values`);
	}
	let previous;
	for (const integrity of request.integrities) {
		if (typeof integrity !== "string" || integrity.length === 0 || integrity.length > MAX_INTEGRITY_LENGTH) {
			throw new Error(`cache-copy integrity must be a non-empty string no longer than ${MAX_INTEGRITY_LENGTH} characters`);
		}
		if (previous !== undefined && integrity <= previous) {
			throw new Error("cache-copy integrities must be sorted and unique");
		}
		previous = integrity;
	}
	return request.integrities;
}

async function readBoundedJson(input) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of input) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > MAX_REQUEST_BYTES) throw new Error(`cache-copy request exceeds the ${MAX_REQUEST_BYTES}-byte input limit`);
		chunks.push(buffer);
	}
	if (bytes === 0) throw new Error("cache-copy request must be non-empty");
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		throw new Error(`cache-copy request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

function withProgress(error, progress) {
	if (error && typeof error === "object") error.cacheCopyProgress = Object.freeze({ ...progress });
	return error;
}

/** Copy a validated batch, stopping admission on the first non-ENOENT error. */
export async function copyPackedConsumerCacheBatch(authoritativeFixtureRoot, authoritativeAmbientContentCache, request, {
	copyByDigest = cacache.get.copy.byDigest,
	removePartial = path => rm(path, { force: true }),
	createDirectory = (path, options) => mkdir(path, options),
	nonce = () => `${process.pid}-${randomUUID()}`,
	workerCount = MAX_WORKERS,
} = {}) {
	const { fixtureRoot, ambientContentCache } = validateAuthority(authoritativeFixtureRoot, authoritativeAmbientContentCache);
	const integrities = validateRequest(request);
	if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > MAX_WORKERS) {
		throw new Error(`cache-copy workerCount must be an integer from 1 to ${MAX_WORKERS}`);
	}
	const stagingParent = join(fixtureRoot, "cache-copy-staging");
	const stagingRoot = join(stagingParent, `batch-${nonce()}`);
	if (!isStrictChild(fixtureRoot, stagingParent) || !isStrictChild(stagingParent, stagingRoot)) {
		throw new Error("derived cache-copy staging path escaped the authoritative fixture root");
	}
	await createDirectory(stagingParent, { recursive: true });
	await createDirectory(stagingRoot, { recursive: false });

	const results = new Array(integrities.length);
	const partialPaths = integrities.map((_, index) => join(stagingRoot, `${String(index).padStart(5, "0")}.partial`));
	let nextIndex = 0;
	let stopAdmission = false;
	let admitted = 0;
	let completed = 0;
	let active = 0;
	let maxActive = 0;
	const failures = new Array(integrities.length);
	const worker = async () => {
		while (!stopAdmission) {
			const index = nextIndex++;
			if (index >= integrities.length) return;
			const integrity = integrities[index];
			const partialPath = partialPaths[index];
			admitted++;
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				await copyByDigest(ambientContentCache, integrity, partialPath);
				results[index] = { integrity, status: "copied", partialPath };
			} catch (error) {
				if (error?.code === "ENOENT") results[index] = { integrity, status: "missing" };
				else {
					failures[index] = error;
					stopAdmission = true;
				}
			} finally {
				completed++;
				active--;
			}
		}
	};
	await Promise.allSettled(Array.from({ length: Math.min(workerCount, integrities.length) }, () => worker()));
	const progress = { total: integrities.length, admitted, completed, maxActive };
	const operationFailures = failures.filter(error => error !== undefined).map(error => withProgress(error, progress));
	if (operationFailures.length > 0) {
		const cleanupSettlements = await Promise.allSettled(partialPaths.slice(0, admitted).map(path => removePartial(path)));
		const cleanupFailures = cleanupSettlements
			.map((settlement, index) => settlement.status === "rejected"
				? new Error(`cache-copy partial cleanup failed for ${partialPaths[index]}: ${settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason)}`, { cause: settlement.reason })
				: undefined)
			.filter(Boolean);
		throw new AggregateError(
			[...operationFailures, ...cleanupFailures],
			`Packed-consumer cache copy failed; total=${progress.total}, admitted=${admitted}, completed=${completed}, maxActive=${maxActive}`,
		);
	}
	return {
		version: RESULT_VERSION,
		stagingRoot,
		results,
		admitted,
		completed,
		maxActive,
	};
}

async function main() {
	if (process.argv.length !== 4) {
		throw new Error("usage: copy-packed-consumer-cache-batch.mjs <authoritative-fixture-root> <authoritative-ambient-_cacache>");
	}
	const request = await readBoundedJson(process.stdin);
	const result = await copyPackedConsumerCacheBatch(process.argv[2], process.argv[3], request);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

function diagnosticError(error) {
	if (!(error instanceof Error)) return { message: String(error) };
	return {
		name: error.name,
		message: error.message,
		...(error.code ? { code: error.code } : {}),
		...(error.cacheCopyProgress ? { progress: error.cacheCopyProgress } : {}),
		...(error instanceof AggregateError ? { errors: error.errors.map(diagnosticError) } : {}),
		...(error.cause === undefined ? {} : { cause: diagnosticError(error.cause) }),
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		const diagnostic = JSON.stringify(diagnosticError(error));
		console.error(`[packed-consumer-copy] failed: ${diagnostic.slice(0, MAX_DIAGNOSTIC_BYTES)}`);
		process.exitCode = 1;
	});
}
