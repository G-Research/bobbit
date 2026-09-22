#!/usr/bin/env node

/**
 * Copy exact ambient cacache digests into a run-owned staging directory.
 *
 * The fixture argv and dedicated ambient-cache environment value are independent
 * process authority. Stdin contains only a bounded, versioned list of exact
 * URL/integrity identities; callers cannot choose source or destination paths.
 * The ambient cache is read-only and omitted from command diagnostics.
 */
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import cacache from "cacache";

const REQUEST_VERSION = 2;
const RESULT_VERSION = 2;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACTS = 1_000;
const MAX_INTEGRITY_LENGTH = 2_048;
const MAX_RESOLVED_LENGTH = 16_384;
const PHYSICAL_COPY_LINK_ERRORS = new Set(["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
const MAX_WORKERS = 3;
const MAX_DIAGNOSTIC_BYTES = 8_000;
const AMBIENT_CACHE_ENV = "BOBBIT_PACKED_CONSUMER_AMBIENT_CACACHE";

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

function artifactIdentity(artifact) {
	return `${artifact.resolved}\u0000${artifact.integrity}`;
}

function npmRequestCacheKey(resolved) {
	return `make-fetch-happen:request-cache:${resolved}`;
}

function validateRequest(request) {
	requireExactKeys(request, ["version", "artifacts"], "cache-copy request");
	if (request.version !== REQUEST_VERSION) throw new Error(`cache-copy request version must be ${REQUEST_VERSION}`);
	if (!Array.isArray(request.artifacts) || request.artifacts.length > MAX_ARTIFACTS) {
		throw new Error(`cache-copy artifacts must be an array of at most ${MAX_ARTIFACTS} values`);
	}
	let previous;
	for (const artifact of request.artifacts) {
		requireExactKeys(artifact, ["resolved", "integrity"], "cache-copy artifact");
		if (typeof artifact.resolved !== "string" || artifact.resolved.length === 0 || artifact.resolved.length > MAX_RESOLVED_LENGTH || !/^https:\/\//.test(artifact.resolved)) {
			throw new Error(`cache-copy resolved URL must be an https URL no longer than ${MAX_RESOLVED_LENGTH} characters`);
		}
		if (typeof artifact.integrity !== "string" || artifact.integrity.length === 0 || artifact.integrity.length > MAX_INTEGRITY_LENGTH) {
			throw new Error(`cache-copy integrity must be a non-empty string no longer than ${MAX_INTEGRITY_LENGTH} characters`);
		}
		const identity = artifactIdentity(artifact);
		if (previous !== undefined && identity.localeCompare(previous) <= 0) {
			throw new Error("cache-copy artifacts must be sorted and unique by resolved URL and integrity");
		}
		previous = identity;
	}
	return request.artifacts;
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

/** Seed a validated exact artifact batch, stopping admission on the first fatal error. */
export async function copyPackedConsumerCacheBatch(authoritativeFixtureRoot, authoritativeAmbientContentCache, request, {
	lookup = (cache, resolved) => cacache.get.info(cache, npmRequestCacheKey(resolved), { memoize: false }),
	copyByDigest = cacache.get.copy.byDigest,
	linkFile = link,
	inspectPath = lstat,
	canonicalPath = realpath,
	removePartial = path => rm(path, { force: true }),
	createDirectory = (path, options) => mkdir(path, options),
	nonce = () => `${process.pid}-${randomUUID()}`,
	workerCount = MAX_WORKERS,
} = {}) {
	const { fixtureRoot, ambientContentCache } = validateAuthority(authoritativeFixtureRoot, authoritativeAmbientContentCache);
	const artifacts = validateRequest(request);
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
	const staging = await inspectPath(stagingRoot);
	if (!staging?.isDirectory?.() || staging.isSymbolicLink?.()) throw new Error("cache-copy staging root must be a non-reparse directory");
	const ambientCanonical = resolve(await canonicalPath(ambientContentCache));

	const results = new Array(artifacts.length);
	const partialPaths = artifacts.map((_, index) => join(stagingRoot, `${String(index).padStart(5, "0")}.partial`));
	let nextIndex = 0;
	let stopAdmission = false;
	let admitted = 0;
	let completed = 0;
	let active = 0;
	let maxActive = 0;
	const failures = new Array(artifacts.length);
	const worker = async () => {
		while (!stopAdmission) {
			const index = nextIndex++;
			if (index >= artifacts.length) return;
			const artifact = artifacts[index];
			const partialPath = partialPaths[index];
			admitted++;
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				let info;
				try {
					info = await lookup(ambientContentCache, artifact.resolved);
				} catch (error) {
					if (error?.code !== "ENOENT") throw error;
				}
				if (!info || String(info.integrity ?? "") !== artifact.integrity) {
					results[index] = { ...artifact, status: "missing" };
					continue;
				}
				if (typeof info.path !== "string" || !isAbsolute(info.path)) throw new Error("exact ambient cache lookup returned a non-absolute content path");
				const sourcePath = resolve(info.path);
				if (!isStrictChild(ambientContentCache, sourcePath)) throw new Error("exact ambient cache lookup returned an out-of-cache content path");
				const source = await inspectPath(sourcePath);
				if (!source?.isFile?.() || source.isSymbolicLink?.()) throw new Error("exact ambient cache lookup source must be a non-reparse regular file");
				const sourceCanonical = resolve(await canonicalPath(sourcePath));
				if (relative(sourcePath, sourceCanonical) !== "" || !isStrictChild(ambientCanonical, sourceCanonical)) {
					throw new Error("exact ambient cache lookup source must not traverse a reparse point or escape cache authority");
				}
				let status = "linked";
				if (source.dev !== staging.dev) {
					await copyByDigest(ambientContentCache, artifact.integrity, partialPath);
					status = "copied";
				} else {
					try {
						await linkFile(sourcePath, partialPath);
					} catch (error) {
						if (!PHYSICAL_COPY_LINK_ERRORS.has(error?.code)) throw error;
						await copyByDigest(ambientContentCache, artifact.integrity, partialPath);
						status = "copied";
					}
				}
				results[index] = { ...artifact, status, partialPath };
			} catch (error) {
				failures[index] = error;
				stopAdmission = true;
			} finally {
				completed++;
				active--;
			}
		}
	};
	await Promise.allSettled(Array.from({ length: Math.min(workerCount, artifacts.length) }, () => worker()));
	const progress = { total: artifacts.length, admitted, completed, maxActive };
	const operationFailures = failures.filter(error => error !== undefined).map(error => withProgress(error, progress));
	if (operationFailures.length > 0) {
		const cleanupSettlements = await Promise.allSettled(partialPaths.slice(0, admitted).map(path => removePartial(path)));
		const cleanupFailures = cleanupSettlements
			.map((settlement, index) => settlement.status === "rejected"
				? new Error(`cache-copy partial cleanup failed for admitted partial ${index}: ${settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason)}`, { cause: settlement.reason })
				: undefined)
			.filter(Boolean);
		throw new AggregateError(
			[...operationFailures, ...cleanupFailures],
			`Packed-consumer cache seed failed; total=${progress.total}, admitted=${admitted}, completed=${completed}, maxActive=${maxActive}`,
		);
	}
	const metrics = Object.freeze({
		linked: results.filter(result => result.status === "linked").length,
		copied: results.filter(result => result.status === "copied").length,
		missing: results.filter(result => result.status === "missing").length,
	});
	return {
		version: RESULT_VERSION,
		stagingRoot,
		results,
		metrics,
		admitted,
		completed,
		maxActive,
	};
}

async function main() {
	if (process.argv.length !== 3) {
		throw new Error("usage: copy-packed-consumer-cache-batch.mjs <authoritative-fixture-root>");
	}
	const ambientContentCache = process.env[AMBIENT_CACHE_ENV];
	if (!ambientContentCache) throw new Error(`missing ${AMBIENT_CACHE_ENV} authority`);
	const request = await readBoundedJson(process.stdin);
	const result = await copyPackedConsumerCacheBatch(process.argv[2], ambientContentCache, request);
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
		const ambientContentCache = process.env[AMBIENT_CACHE_ENV];
		const diagnostic = JSON.stringify(diagnosticError(error));
		const redacted = ambientContentCache ? diagnostic.split(ambientContentCache).join("<ambient npm cache>") : diagnostic;
		console.error(`[packed-consumer-copy] failed: ${redacted.slice(0, MAX_DIAGNOSTIC_BYTES)}`);
		process.exitCode = 1;
	});
}
