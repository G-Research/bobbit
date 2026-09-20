#!/usr/bin/env node

/**
 * Resolve cacache content destinations in a separately killable process.
 *
 * The fixture root is process authority supplied independently on argv. The
 * bounded stdin document is untrusted data and cannot redirect index writes.
 */
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import cacache from "cacache";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_INTEGRITIES = 10_000;
const MAX_INTEGRITY_LENGTH = 2_048;
const PROGRESS_INTERVAL = 1_000;

function isStrictChild(root, candidate) {
	const child = relative(resolve(root), resolve(candidate));
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function requireExactKeys(value, expected, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const actual = Object.keys(value).sort();
	const allowed = [...expected].sort();
	if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
		throw new Error(`${label} must contain only ${allowed.join(", ")}`);
	}
}

function validateRequest(authoritativeFixtureRoot, request) {
	if (typeof authoritativeFixtureRoot !== "string" || !isAbsolute(authoritativeFixtureRoot)) {
		throw new Error("authoritative fixture root must be absolute");
	}
	const fixtureRoot = resolve(authoritativeFixtureRoot);
	requireExactKeys(request, ["fixtureRoot", "destination", "integrities"], "cache-path request");
	if (typeof request.fixtureRoot !== "string" || !isAbsolute(request.fixtureRoot)) {
		throw new Error("cache-path fixtureRoot must be absolute");
	}
	if (resolve(request.fixtureRoot) !== fixtureRoot) {
		throw new Error("cache-path fixtureRoot does not match authoritative fixture root");
	}
	if (typeof request.destination !== "string" || !isAbsolute(request.destination)) {
		throw new Error("cache-path destination must be absolute");
	}
	const destination = resolve(request.destination);
	const expectedDestination = resolve(fixtureRoot, "npm-cache", "_cacache");
	if (destination !== expectedDestination) {
		throw new Error("cache-path destination must equal the authoritative fixture npm-cache/_cacache path");
	}
	if (!isStrictChild(fixtureRoot, destination)) {
		throw new Error("cache-path destination must be a strict child of fixtureRoot");
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

async function readBoundedJson(input) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of input) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > MAX_REQUEST_BYTES) {
			throw new Error(`cache-path request exceeds the ${MAX_REQUEST_BYTES}-byte input limit`);
		}
		chunks.push(buffer);
	}
	if (bytes === 0) throw new Error("cache-path request must be non-empty");
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		throw new Error(`cache-path request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

export async function resolvePackedConsumerCachePaths(authoritativeFixtureRoot, request, {
	indexInsert = cacache.index.insert,
} = {}) {
	const { fixtureRoot, destination, integrities } = validateRequest(authoritativeFixtureRoot, request);
	console.error(`[packed-consumer-paths] resolving ${integrities.length} destinations`);
	const results = [];
	const paths = new Set();
	const keys = new Set();
	for (let index = 0; index < integrities.length; index++) {
		const integrity = integrities[index];
		const key = `bobbit-packed-consumer-path:${integrity}`;
		const entry = await indexInsert(destination, key, integrity);
		if (!entry || typeof entry !== "object") {
			throw new Error(`cacache did not return an index entry for integrity ${integrity}`);
		}
		if (entry.key !== key) {
			throw new Error(`cacache returned a mismatched key for integrity ${integrity}`);
		}
		if (typeof entry.integrity !== "string" || entry.integrity !== integrity) {
			throw new Error(`cacache returned a mismatched canonical integrity for ${integrity}`);
		}
		if (typeof entry.path !== "string" || !isAbsolute(entry.path)) {
			throw new Error(`cacache did not return an absolute content path for integrity ${integrity}`);
		}
		const path = resolve(entry.path);
		if (!isStrictChild(destination, path) || !isStrictChild(fixtureRoot, path)) {
			throw new Error(`cacache returned an out-of-root content path for integrity ${integrity}`);
		}
		if (keys.has(entry.key)) throw new Error(`cacache returned a duplicate key for integrity ${integrity}`);
		if (paths.has(path)) throw new Error(`cacache returned a duplicate content path for integrity ${integrity}`);
		keys.add(entry.key);
		paths.add(path);
		results.push({ integrity: entry.integrity, path });
		if ((index + 1) % PROGRESS_INTERVAL === 0) {
			console.error(`[packed-consumer-paths] resolved ${index + 1}/${integrities.length}`);
		}
	}
	console.error(`[packed-consumer-paths] completed ${results.length} destinations`);
	return results;
}

async function main() {
	if (process.argv.length !== 3) throw new Error("usage: resolve-packed-consumer-cache-paths.mjs <authoritative-fixture-root>");
	const request = await readBoundedJson(process.stdin);
	const results = await resolvePackedConsumerCachePaths(process.argv[2], request);
	process.stdout.write(`${JSON.stringify(results)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		const diagnostic = error instanceof Error ? (error.stack ?? error.message) : String(error);
		console.error(`[packed-consumer-paths] failed: ${diagnostic.slice(0, 8_000)}`);
		process.exitCode = 1;
	});
}
