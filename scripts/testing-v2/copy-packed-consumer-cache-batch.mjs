#!/usr/bin/env node

/**
 * Publish exact ambient cacache hits directly into the run-owned cache.
 *
 * The fixture argv and dedicated ambient-cache environment value are independent
 * process authority. Stdin may select only exact URL/integrity identities and
 * unique destinations below the fixed fixture npm-cache/_cacache root. The
 * ambient cache is read-only and omitted from command diagnostics.
 */
import { COPYFILE_EXCL } from "node:constants";
import { copyFile, link, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import cacache from "cacache";

const REQUEST_VERSION = 3;
const RESULT_VERSION = 3;
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
	const destinationContentCache = resolve(fixtureRoot, "npm-cache", "_cacache");
	if (basename(ambientContentCache) !== "_cacache") {
		throw new Error("authoritative ambient content cache must identify npm's _cacache directory");
	}
	if (!isStrictChild(fixtureRoot, destinationContentCache)) {
		throw new Error("derived destination content cache escaped the authoritative fixture root");
	}
	if (fixtureRoot === ambientContentCache || isStrictChild(fixtureRoot, ambientContentCache) || isStrictChild(ambientContentCache, fixtureRoot)) {
		throw new Error("authoritative ambient content cache and fixture root must not overlap");
	}
	return { fixtureRoot, ambientContentCache, destinationContentCache };
}

function artifactIdentity(artifact) {
	return `${artifact.resolved}\u0000${artifact.integrity}`;
}

function npmRequestCacheKey(resolved) {
	return `make-fetch-happen:request-cache:${resolved}`;
}

function validateRequest(request, destinationContentCache) {
	requireExactKeys(request, ["version", "artifacts"], "cache-copy request");
	if (request.version !== REQUEST_VERSION) throw new Error(`cache-copy request version must be ${REQUEST_VERSION}`);
	if (!Array.isArray(request.artifacts) || request.artifacts.length > MAX_ARTIFACTS) {
		throw new Error(`cache-copy artifacts must be an array of at most ${MAX_ARTIFACTS} values`);
	}
	let previous;
	const destinations = new Set();
	for (const artifact of request.artifacts) {
		requireExactKeys(artifact, ["resolved", "integrity", "destinationPath"], "cache-copy artifact");
		if (typeof artifact.resolved !== "string" || artifact.resolved.length === 0 || artifact.resolved.length > MAX_RESOLVED_LENGTH || !/^https:\/\//.test(artifact.resolved)) {
			throw new Error(`cache-copy resolved URL must be an https URL no longer than ${MAX_RESOLVED_LENGTH} characters`);
		}
		if (typeof artifact.integrity !== "string" || artifact.integrity.length === 0 || artifact.integrity.length > MAX_INTEGRITY_LENGTH) {
			throw new Error(`cache-copy integrity must be a non-empty string no longer than ${MAX_INTEGRITY_LENGTH} characters`);
		}
		if (typeof artifact.destinationPath !== "string" || !isAbsolute(artifact.destinationPath)) {
			throw new Error("cache-copy destinationPath must be absolute");
		}
		const destinationPath = resolve(artifact.destinationPath);
		if (!isStrictChild(destinationContentCache, destinationPath)) {
			throw new Error("cache-copy destinationPath must be a strict child of the authoritative fixture npm-cache/_cacache root");
		}
		if (destinations.has(destinationPath)) throw new Error("cache-copy destination paths must be unique");
		destinations.add(destinationPath);
		artifact.destinationPath = destinationPath;
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

function resultEnvelope(results, progress) {
	const metrics = Object.freeze({
		linked: results.filter(result => result.status === "linked").length,
		copied: results.filter(result => result.status === "copied").length,
		missing: results.filter(result => result.status === "missing").length,
	});
	return {
		version: RESULT_VERSION,
		results,
		metrics,
		...progress,
	};
}

/** Publish a validated exact artifact batch, stopping admission on the first fatal error. */
export async function copyPackedConsumerCacheBatch(authoritativeFixtureRoot, authoritativeAmbientContentCache, request, {
	lookup = (cache, key) => cacache.get.info(cache, key, { memoize: false }),
	linkFile = link,
	copyPhysical = (source, destination) => copyFile(source, destination, COPYFILE_EXCL),
	inspectPath = lstat,
	canonicalPath = realpath,
	createDirectory = (path, options) => mkdir(path, options),
	workerCount = MAX_WORKERS,
} = {}) {
	const { fixtureRoot, ambientContentCache, destinationContentCache } = validateAuthority(authoritativeFixtureRoot, authoritativeAmbientContentCache);
	const artifacts = validateRequest(request, destinationContentCache);
	if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > MAX_WORKERS) {
		throw new Error(`cache-copy workerCount must be an integer from 1 to ${MAX_WORKERS}`);
	}

	let ambientMissing = false;
	let ambientCanonical;
	try {
		await requireCanonicalDirectory(ambientContentCache, inspectPath, canonicalPath, "authoritative ambient content cache");
		ambientCanonical = resolve(await canonicalPath(ambientContentCache));
	} catch (error) {
		if (error?.code === "ENOENT") ambientMissing = true;
		else throw error;
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
				const destinationParent = await ensureDestinationParent(fixtureRoot, destinationContentCache, artifact.destinationPath, {
					inspectPath, canonicalPath, createDirectory,
				});
				if (await inspectOptional(artifact.destinationPath, inspectPath)) {
					throw Object.assign(new Error("cache-copy destination already exists"), { code: "EEXIST" });
				}
				if (ambientMissing) {
					results[index] = { resolved: artifact.resolved, integrity: artifact.integrity, status: "missing" };
					continue;
				}
				const expectedKey = npmRequestCacheKey(artifact.resolved);
				let info;
				try {
					info = await lookup(ambientContentCache, expectedKey);
				} catch (error) {
					if (error?.code !== "ENOENT") throw error;
				}
				if (!isExactLookup(info, expectedKey, artifact.integrity)) {
					results[index] = { resolved: artifact.resolved, integrity: artifact.integrity, status: "missing" };
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
				if (!published?.isFile?.() || published.isSymbolicLink?.()) {
					throw new Error("cache-copy publication must be a non-reparse regular file");
				}
				if (status === "linked" && source.ino !== undefined && published.ino !== undefined &&
					(source.dev !== published.dev || source.ino !== published.ino)) {
					throw new Error("cache-copy hardlink publication did not retain the validated source inode");
				}
				results[index] = { resolved: artifact.resolved, integrity: artifact.integrity, status };
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
		throw new AggregateError(
			operationFailures,
			`Packed-consumer cache seed failed; total=${progress.total}, admitted=${admitted}, completed=${completed}, maxActive=${maxActive}`,
		);
	}
	return resultEnvelope(results, { admitted, completed, maxActive });
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

function redactDiagnostic(value, secret) {
	if (!secret) return value;
	if (typeof value === "string") return value.split(secret).join("<ambient npm cache>");
	if (Array.isArray(value)) return value.map(entry => redactDiagnostic(entry, secret));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDiagnostic(entry, secret)]));
	}
	return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		const diagnostic = redactDiagnostic(diagnosticError(error), process.env[AMBIENT_CACHE_ENV]);
		console.error(`[packed-consumer-copy] failed: ${JSON.stringify(diagnostic).slice(0, MAX_DIAGNOSTIC_BYTES)}`);
		process.exitCode = 1;
	});
}
