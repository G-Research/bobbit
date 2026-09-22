#!/usr/bin/env node

/**
 * Publish exact ambient cacache hits and verify run-owned cache digests.
 *
 * Both operations run in a tracked helper so no cacache I/O can outlive command
 * settlement in the coordinator. Ambient cache authority is required only for
 * publication and is omitted from argv and diagnostics.
 */
import { COPYFILE_EXCL } from "node:constants";
import { copyFile, link, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import cacache from "cacache";

const REQUEST_VERSION = 4;
const RESULT_VERSION = 4;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACTS = 1_000;
const MAX_INTEGRITY_LENGTH = 2_048;
const MAX_RESOLVED_LENGTH = 16_384;
const PHYSICAL_COPY_LINK_ERRORS = new Set(["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
const MAX_WORKERS = 3;
const MAX_DIAGNOSTIC_BYTES = 8_000;
const AMBIENT_CACHE_ENV = "BOBBIT_PACKED_CONSUMER_AMBIENT_CACACHE";

function compareCodeUnits(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

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

function validateAuthority(authoritativeFixtureRoot, authoritativeAmbientContentCache, operation) {
	if (typeof authoritativeFixtureRoot !== "string" || !isAbsolute(authoritativeFixtureRoot)) {
		throw new Error("authoritative fixture root must be absolute");
	}
	const fixtureRoot = resolve(authoritativeFixtureRoot);
	const destinationContentCache = resolve(fixtureRoot, "npm-cache", "_cacache");
	if (!isStrictChild(fixtureRoot, destinationContentCache)) {
		throw new Error("derived destination content cache escaped the authoritative fixture root");
	}
	if (operation !== "publish") return { fixtureRoot, destinationContentCache };
	if (typeof authoritativeAmbientContentCache !== "string" || !isAbsolute(authoritativeAmbientContentCache)) {
		throw new Error("publish requires an absolute authoritative ambient content cache");
	}
	const ambientContentCache = resolve(authoritativeAmbientContentCache);
	if (basename(ambientContentCache) !== "_cacache") {
		throw new Error("authoritative ambient content cache must identify npm's _cacache directory");
	}
	if (fixtureRoot === ambientContentCache || isStrictChild(fixtureRoot, ambientContentCache) || isStrictChild(ambientContentCache, fixtureRoot)) {
		throw new Error("authoritative ambient content cache and fixture root must not overlap");
	}
	return { fixtureRoot, ambientContentCache, destinationContentCache };
}

function pathIdentity(path) {
	const absolute = resolve(path);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function npmRequestCacheKey(resolved) {
	return `make-fetch-happen:request-cache:${resolved}`;
}

function validateCandidates(value) {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARTIFACTS) {
		throw new Error(`cache-copy candidates must be a non-empty array of at most ${MAX_ARTIFACTS} values`);
	}
	let previous;
	for (const candidate of value) {
		if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_RESOLVED_LENGTH || !/^https:\/\//.test(candidate)) {
			throw new Error(`cache-copy candidate URL must be an https URL no longer than ${MAX_RESOLVED_LENGTH} characters`);
		}
		if (previous !== undefined && compareCodeUnits(candidate, previous) <= 0) {
			throw new Error("cache-copy candidate URLs must be sorted and unique");
		}
		previous = candidate;
	}
	return value;
}

function validateRequest(request, destinationContentCache) {
	requireExactKeys(request, ["version", "operation", "artifacts"], "cache-copy request");
	if (request.version !== REQUEST_VERSION) throw new Error(`cache-copy request version must be ${REQUEST_VERSION}`);
	if (request.operation !== "publish" && request.operation !== "verify") {
		throw new Error("cache-copy operation must be publish or verify");
	}
	if (!Array.isArray(request.artifacts) || request.artifacts.length > MAX_ARTIFACTS) {
		throw new Error(`cache-copy artifacts must be an array of at most ${MAX_ARTIFACTS} values`);
	}
	let previousIntegrity;
	const destinations = new Set();
	for (const artifact of request.artifacts) {
		requireExactKeys(artifact,
			request.operation === "publish" ? ["candidates", "integrity", "destinationPath"] : ["integrity", "destinationPath"],
			"cache-copy artifact");
		if (request.operation === "publish") validateCandidates(artifact.candidates);
		if (typeof artifact.integrity !== "string" || artifact.integrity.length === 0 || artifact.integrity.length > MAX_INTEGRITY_LENGTH) {
			throw new Error(`cache-copy integrity must be a non-empty string no longer than ${MAX_INTEGRITY_LENGTH} characters`);
		}
		if (previousIntegrity !== undefined && compareCodeUnits(artifact.integrity, previousIntegrity) <= 0) {
			throw new Error("cache-copy artifacts must be sorted and unique by integrity");
		}
		previousIntegrity = artifact.integrity;
		if (typeof artifact.destinationPath !== "string" || !isAbsolute(artifact.destinationPath)) {
			throw new Error("cache-copy destinationPath must be absolute");
		}
		const destinationPath = resolve(artifact.destinationPath);
		if (!isStrictChild(destinationContentCache, destinationPath)) {
			throw new Error("cache-copy destinationPath must be a strict child of the authoritative fixture npm-cache/_cacache root");
		}
		const destinationIdentity = pathIdentity(destinationPath);
		if (destinations.has(destinationIdentity)) throw new Error("cache-copy destination paths must be unique");
		destinations.add(destinationIdentity);
		artifact.destinationPath = destinationPath;
	}
	return { operation: request.operation, artifacts: request.artifacts };
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

async function inspectOptional(path, inspectPath) {
	try {
		return await inspectPath(path);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function requireCanonicalDirectory(path, inspectPath, canonicalPath, label) {
	const entry = await inspectPath(path);
	if (!entry?.isDirectory?.() || entry.isSymbolicLink?.()) throw new Error(`${label} must be a non-reparse directory`);
	const canonical = resolve(await canonicalPath(path));
	if (relative(resolve(path), canonical) !== "") throw new Error(`${label} must not traverse a reparse point`);
	return entry;
}

async function ensureDestinationParent(fixtureRoot, destinationContentCache, destinationPath, {
	inspectPath,
	canonicalPath,
	createDirectory,
}) {
	await requireCanonicalDirectory(fixtureRoot, inspectPath, canonicalPath, "authoritative fixture root");
	const targetParent = dirname(destinationPath);
	if (!isStrictChild(destinationContentCache, destinationPath) ||
		(targetParent !== destinationContentCache && !isStrictChild(destinationContentCache, targetParent))) {
		throw new Error("cache-copy destination escaped the authoritative destination cache");
	}
	const relativeParent = relative(fixtureRoot, targetParent);
	let current = fixtureRoot;
	for (const component of relativeParent.split(sep).filter(Boolean)) {
		current = join(current, component);
		let entry = await inspectOptional(current, inspectPath);
		if (!entry) {
			try {
				await createDirectory(current, { recursive: false });
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
			}
			entry = await inspectPath(current);
		}
		if (!entry?.isDirectory?.() || entry.isSymbolicLink?.()) {
			throw new Error("cache-copy destination ancestry must contain only non-reparse directories");
		}
		const canonical = resolve(await canonicalPath(current));
		if (relative(resolve(current), canonical) !== "") {
			throw new Error("cache-copy destination ancestry must not traverse a reparse point");
		}
	}
	return inspectPath(targetParent);
}

function isExactLookup(info, expectedKey, integrity) {
	return info && info.key === expectedKey && String(info.integrity ?? "") === integrity;
}

function isDigestMiss(error) {
	return error?.code === "ENOENT" || error?.code === "EINTEGRITY";
}

async function verifyDigest(destinationContentCache, artifact, { readDigest, removeDestination, removeCorrupt = false }) {
	try {
		await readDigest(destinationContentCache, artifact.integrity);
		return "verified";
	} catch (error) {
		if (!isDigestMiss(error)) throw error;
		if (removeCorrupt) await removeDestination(artifact.destinationPath);
		return error?.code === "EINTEGRITY" ? "corrupt" : "missing";
	}
}

function resultEnvelope(operation, results, progress) {
	const metrics = operation === "publish"
		? { linked: 0, copied: 0, missing: 0, corrupt: 0 }
		: { verified: 0, missing: 0, corrupt: 0 };
	for (const result of results) metrics[result.status]++;
	return { version: RESULT_VERSION, operation, results, metrics, ...progress };
}

/** Publish or verify a validated artifact batch, stopping admission on the first fatal error. */
export async function copyPackedConsumerCacheBatch(authoritativeFixtureRoot, authoritativeAmbientContentCache, request, {
	lookup = (cache, key) => cacache.get.info(cache, key, { memoize: false }),
	readDigest = (cache, integrity) => cacache.get.byDigest(cache, integrity),
	linkFile = link,
	copyPhysical = (source, destination) => copyFile(source, destination, COPYFILE_EXCL),
	removeDestination = path => rm(path, { force: true }),
	inspectPath = lstat,
	canonicalPath = realpath,
	createDirectory = (path, options) => mkdir(path, options),
	workerCount = MAX_WORKERS,
} = {}) {
	const provisionalOperation = request?.operation;
	const authority = validateAuthority(authoritativeFixtureRoot, authoritativeAmbientContentCache, provisionalOperation);
	const { fixtureRoot, ambientContentCache, destinationContentCache } = authority;
	const { operation, artifacts } = validateRequest(request, destinationContentCache);
	if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > MAX_WORKERS) {
		throw new Error(`cache-copy workerCount must be an integer from 1 to ${MAX_WORKERS}`);
	}
	await requireCanonicalDirectory(fixtureRoot, inspectPath, canonicalPath, "authoritative fixture root");

	let ambientMissing = false;
	let ambientCanonical;
	if (operation === "publish") {
		try {
			await requireCanonicalDirectory(ambientContentCache, inspectPath, canonicalPath, "authoritative ambient content cache");
			ambientCanonical = resolve(await canonicalPath(ambientContentCache));
		} catch (error) {
			if (error?.code === "ENOENT") ambientMissing = true;
			else throw error;
		}
	}

	const results = new Array(artifacts.length);
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
			admitted++;
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				if (operation === "verify") {
					const status = await verifyDigest(destinationContentCache, artifact, { readDigest, removeDestination });
					results[index] = { integrity: artifact.integrity, status };
					continue;
				}
				const destinationParent = await ensureDestinationParent(fixtureRoot, destinationContentCache, artifact.destinationPath, {
					inspectPath, canonicalPath, createDirectory,
				});
				if (await inspectOptional(artifact.destinationPath, inspectPath)) {
					throw Object.assign(new Error("cache-copy destination already exists"), { code: "EEXIST" });
				}
				if (ambientMissing) {
					results[index] = { integrity: artifact.integrity, status: "missing", candidate: null };
					continue;
				}
				let selected;
				for (const candidate of artifact.candidates) {
					const expectedKey = npmRequestCacheKey(candidate);
					let info;
					try {
						info = await lookup(ambientContentCache, expectedKey);
					} catch (error) {
						if (error?.code !== "ENOENT") throw error;
					}
					if (isExactLookup(info, expectedKey, artifact.integrity)) {
						selected = { candidate, info };
						break;
					}
				}
				if (!selected) {
					results[index] = { integrity: artifact.integrity, status: "missing", candidate: null };
					continue;
				}
				const { candidate, info } = selected;
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
				if (source.dev !== destinationParent.dev) {
					await copyPhysical(sourcePath, artifact.destinationPath);
					status = "copied";
				} else {
					try {
						await linkFile(sourcePath, artifact.destinationPath);
					} catch (error) {
						const safeUnsupported = PHYSICAL_COPY_LINK_ERRORS.has(error?.code) || error?.code === "EISDIR";
						if (!safeUnsupported) throw error;
						await copyPhysical(sourcePath, artifact.destinationPath);
						status = "copied";
					}
				}
				const published = await inspectPath(artifact.destinationPath);
				if (!published?.isFile?.() || published.isSymbolicLink?.()) throw new Error("cache-copy publication must be a non-reparse regular file");
				if (status === "linked" && source.ino !== undefined && published.ino !== undefined &&
					(source.dev !== published.dev || source.ino !== published.ino)) {
					throw new Error("cache-copy hardlink publication did not retain the validated source inode");
				}
				const verification = await verifyDigest(destinationContentCache, artifact, {
					readDigest, removeDestination, removeCorrupt: true,
				});
				results[index] = verification === "verified"
					? { integrity: artifact.integrity, status, candidate }
					: { integrity: artifact.integrity, status: verification, candidate };
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
		throw new AggregateError(operationFailures,
			`Packed-consumer cache ${operation} failed; total=${progress.total}, admitted=${admitted}, completed=${completed}, maxActive=${maxActive}`);
	}
	return resultEnvelope(operation, results, { admitted, completed, maxActive });
}

async function main() {
	if (process.argv.length !== 3) throw new Error("usage: copy-packed-consumer-cache-batch.mjs <authoritative-fixture-root>");
	const request = await readBoundedJson(process.stdin);
	const result = await copyPackedConsumerCacheBatch(
		process.argv[2],
		process.env[AMBIENT_CACHE_ENV],
		request,
	);
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

function redactDiagnostic(value, secret) {
	if (!secret) return value;
	if (typeof value === "string") return value.split(secret).join("<ambient npm cache>");
	if (Array.isArray(value)) return value.map(entry => redactDiagnostic(entry, secret));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDiagnostic(entry, secret)]));
	return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		const diagnostic = redactDiagnostic(diagnosticError(error), process.env[AMBIENT_CACHE_ENV]);
		console.error(`[packed-consumer-copy] failed: ${JSON.stringify(diagnostic).slice(0, MAX_DIAGNOSTIC_BYTES)}`);
		process.exitCode = 1;
	});
}
