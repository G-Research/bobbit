#!/usr/bin/env node

/**
 * Resolve cacache content destinations in a separately killable process.
 *
 * `cacache.index.insert()` is intentionally used only here: its filesystem
 * promises are not abortable, so the preparation coordinator owns this whole
 * helper process tree instead of racing an in-process promise against a timer.
 */
import { link, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import cacache from "cacache";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_INTEGRITIES = 10_000;
const MAX_INTEGRITY_LENGTH = 2_048;
const PROGRESS_INTERVAL = 1_000;

export function packedConsumerCachePathResultPath(requestPath) {
	return `${requestPath}.result.json`;
}

function isStrictChild(root, candidate) {
	const child = relative(resolve(root), resolve(candidate));
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function requireExactKeys(value, expected, label) {
	const actual = Object.keys(value).sort();
	const allowed = [...expected].sort();
	if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
		throw new Error(`${label} must contain only ${allowed.join(", ")}`);
	}
}

async function readRequest(requestPath) {
	if (!isAbsolute(requestPath)) throw new Error("cache-path request path must be absolute");
	const requestStat = await stat(requestPath);
	if (!requestStat.isFile() || requestStat.size <= 0 || requestStat.size > MAX_REQUEST_BYTES) {
		throw new Error(`cache-path request must be a non-empty file no larger than ${MAX_REQUEST_BYTES} bytes`);
	}
	let request;
	try {
		request = JSON.parse(await readFile(requestPath, "utf8"));
	} catch (error) {
		throw new Error(`cache-path request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	if (!request || typeof request !== "object" || Array.isArray(request)) {
		throw new Error("cache-path request must be an object");
	}
	requireExactKeys(request, ["fixtureRoot", "destination", "integrities"], "cache-path request");
	if (typeof request.fixtureRoot !== "string" || !isAbsolute(request.fixtureRoot)) {
		throw new Error("cache-path fixtureRoot must be absolute");
	}
	if (typeof request.destination !== "string" || !isAbsolute(request.destination)) {
		throw new Error("cache-path destination must be absolute");
	}
	const fixtureRoot = resolve(request.fixtureRoot);
	const destination = resolve(request.destination);
	if (!isStrictChild(fixtureRoot, requestPath)) {
		throw new Error("cache-path request must be a strict child of fixtureRoot");
	}
	if (!isStrictChild(fixtureRoot, destination)) {
		throw new Error("cache-path destination must be a strict child of fixtureRoot");
	}
	if (!destination.endsWith(`${sep}_cacache`)) {
		throw new Error("cache-path destination must identify a fresh _cacache directory");
	}
	if (!Array.isArray(request.integrities) || request.integrities.length > MAX_INTEGRITIES) {
		throw new Error(`cache-path integrities must be an array of at most ${MAX_INTEGRITIES} values`);
	}
	const seen = new Set();
	for (const integrity of request.integrities) {
		if (typeof integrity !== "string" || integrity.length === 0 || integrity.length > MAX_INTEGRITY_LENGTH) {
			throw new Error(`cache-path integrity must be a non-empty string no longer than ${MAX_INTEGRITY_LENGTH} characters`);
		}
		if (seen.has(integrity)) throw new Error(`cache-path integrities must be deduplicated: ${integrity}`);
		seen.add(integrity);
	}
	return { fixtureRoot, destination, integrities: request.integrities };
}

export async function resolvePackedConsumerCachePaths(requestPath) {
	if (typeof requestPath !== "string" || !isAbsolute(requestPath)) {
		throw new Error("cache-path request path must be absolute");
	}
	const absoluteRequestPath = resolve(requestPath);
	const resultPath = packedConsumerCachePathResultPath(absoluteRequestPath);
	const { fixtureRoot, destination, integrities } = await readRequest(absoluteRequestPath);
	if (!isStrictChild(fixtureRoot, resultPath)) throw new Error("cache-path result must be a strict child of fixtureRoot");
	const existingResult = await stat(resultPath).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
	if (existingResult) throw new Error(`cache-path result already exists: ${resultPath}`);

	console.error(`[packed-consumer-paths] resolving ${integrities.length} destinations`);
	const results = [];
	const paths = new Set();
	for (let index = 0; index < integrities.length; index++) {
		const integrity = integrities[index];
		const entry = await cacache.index.insert(destination, `bobbit-packed-consumer-path:${integrity}`, integrity);
		if (!entry || typeof entry.path !== "string" || !isAbsolute(entry.path)) {
			throw new Error(`cacache did not return an absolute content path for integrity ${integrity}`);
		}
		const path = resolve(entry.path);
		if (!isStrictChild(destination, path) || !isStrictChild(fixtureRoot, path)) {
			throw new Error(`cacache returned an out-of-root content path for integrity ${integrity}`);
		}
		if (paths.has(path)) throw new Error(`cacache returned a duplicate content path for integrity ${integrity}`);
		paths.add(path);
		results.push({ integrity, path });
		if ((index + 1) % PROGRESS_INTERVAL === 0) {
			console.error(`[packed-consumer-paths] resolved ${index + 1}/${integrities.length}`);
		}
	}

	const temporaryPath = `${resultPath}.tmp-${process.pid}-${randomUUID()}`;
	await writeFile(temporaryPath, `${JSON.stringify(results)}\n`, { flag: "wx" });
	try {
		// Publish a complete result without replacing stale state. Hard-linking is
		// the same cross-platform no-overwrite boundary used for CAS publication.
		await link(temporaryPath, resultPath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
	console.error(`[packed-consumer-paths] completed ${results.length} destinations`);
	return { resultPath, results };
}

async function main() {
	if (process.argv.length !== 3) throw new Error("usage: resolve-packed-consumer-cache-paths.mjs <absolute-request.json>");
	await resolvePackedConsumerCachePaths(process.argv[2]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		const diagnostic = error instanceof Error ? (error.stack ?? error.message) : String(error);
		console.error(`[packed-consumer-paths] failed: ${diagnostic.slice(0, 8_000)}`);
		process.exitCode = 1;
	});
}
