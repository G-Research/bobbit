import { lstat, readlink, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const TRANSIENT_REMOVAL_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const DEFAULT_MAX_ATTEMPTS = 32;
const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_INITIAL_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 500;
const DEFAULT_TRAVERSAL_CONCURRENCY = 8;

function isOwnedChild(ownerRoot, target) {
	const relative = path.relative(ownerRoot, target);
	return relative !== ""
		&& !path.isAbsolute(relative)
		&& relative !== ".."
		&& !relative.startsWith(`..${path.sep}`)
		&& !relative.startsWith("../")
		&& !relative.startsWith("..\\");
}

function nonNegativeNumber(value, fallback, name) {
	const resolved = value ?? fallback;
	if (!Number.isFinite(resolved) || resolved < 0) {
		throw new TypeError(`${name} must be a finite, non-negative number`);
	}
	return resolved;
}

function positiveInteger(value, fallback, name) {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1) {
		throw new TypeError(`${name} must be a positive integer`);
	}
	return resolved;
}

function errorAttempt(error, attempt, elapsedMs, traversal) {
	const record = { attempt, elapsedMs };
	if (error && typeof error === "object") {
		for (const key of ["code", "syscall", "path", "dest"]) {
			if (typeof error[key] === "string") record[key] = error[key];
		}
	}
	if (traversal.length > 0) record.traversal = traversal;
	record.message = error instanceof Error ? error.message : String(error);
	return record;
}

function errorFields(error) {
	const fields = {};
	if (error && typeof error === "object") {
		for (const key of ["code", "syscall", "path", "dest"]) {
			if (typeof error[key] === "string") fields[key] = error[key];
		}
	}
	return fields;
}

function stableIdentity(stats) {
	if (stats?.dev === undefined || stats?.ino === undefined || String(stats.ino) === "0") return undefined;
	return `${String(stats.dev)}:${String(stats.ino)}`;
}

function unsafePathError(candidate, reason, cause) {
	const error = new Error(`Refusing unsafe owned-path removal at "${candidate}": ${reason}`, cause ? { cause } : undefined);
	// A transient metadata failure may become provable on retry; every other
	// uncertain identity fails immediately without any destructive fallback.
	error.code = TRANSIENT_REMOVAL_CODES.has(cause?.code) ? cause.code : "EUNSAFEPATH";
	error.path = candidate;
	return error;
}

function recordDetectionFailure(traversal, candidate, operation, error) {
	traversal.push({
		type: "reparse-detection-failure",
		path: candidate,
		operation,
		...errorFields(error),
		message: error instanceof Error ? error.message : String(error),
	});
}

async function lstatIfPresent(candidate, fsImpl, traversal) {
	try {
		return await fsImpl.lstat(candidate);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		recordDetectionFailure(traversal, candidate, "lstat", error);
		throw error;
	}
}

async function classifyEntry(candidate, stats, fsImpl, platform, traversal) {
	const identity = stableIdentity(stats);
	if (identity === undefined) {
		recordDetectionFailure(traversal, candidate, "stable-identity", unsafePathError(candidate, "filesystem identity is unavailable"));
		throw unsafePathError(candidate, "filesystem identity is unavailable");
	}

	if (stats.isSymbolicLink()) {
		try {
			return { type: platform === "win32" ? "junction-or-symbolic-link" : "symbolic-link", identity, target: await fsImpl.readlink(candidate) };
		} catch (error) {
			recordDetectionFailure(traversal, candidate, "readlink", error);
			throw unsafePathError(candidate, "link target could not be identified", error);
		}
	}

	if (stats.isDirectory() && platform === "win32") {
		try {
			const target = await fsImpl.readlink(candidate);
			return { type: "directory-reparse-point", identity, target };
		} catch (error) {
			// Current Node releases identify junctions as symbolic links. The probe
			// also protects older/runtime-specific representations where lstat
			// reports a directory. EINVAL is the sole expected answer for a genuine
			// Windows directory; every other answer is an uncertain reparse state.
			if (error?.code !== "EINVAL") {
				recordDetectionFailure(traversal, candidate, "readlink-directory-probe", error);
				throw unsafePathError(candidate, "directory reparse status could not be established", error);
			}
		}
	}

	if (stats.isDirectory()) return { type: "directory", identity };
	return { type: "leaf", identity };
}

function entryMatchesClaim(entry, claim) {
	return entry.identity === claim.identity
		&& entry.type === claim.type
		&& (claim.target === undefined || entry.target === claim.target);
}

/**
 * Revalidate only the operation root, immediate producer, and current entry.
 * Rechecking every ancestor for every leaf is quadratic in deep package trees.
 * Reaching the same immediate producer inode through a changed intermediate
 * pathname still reaches the exact authorized directory; the root claim fences
 * replacement of the operation tree itself.
 */
async function assertClaimCurrent(claim, fsImpl, platform, traversal) {
	if (!claim) return;
	const claims = new Set([claim.rootClaim, claim.parent, claim]);
	claims.delete(undefined);
	for (const currentClaim of claims) {
		const current = await lstatIfPresent(currentClaim.path, fsImpl, traversal);
		if (!current) throw unsafePathError(currentClaim.path, "an entry disappeared during removal");
		const entry = await classifyEntry(currentClaim.path, current, fsImpl, platform, traversal);
		if (!entryMatchesClaim(entry, currentClaim)) {
			throw unsafePathError(currentClaim.path, "entry identity, type, or link target changed during removal");
		}
	}
}

async function withCurrentClaim(claim, fsImpl, platform, traversal, operation) {
	await assertClaimCurrent(claim, fsImpl, platform, traversal);
	let result;
	try {
		result = await operation();
	} catch (operationError) {
		// Prefer an identity error when namespace replacement caused the I/O
		// failure; otherwise preserve the original filesystem error for retry.
		await assertClaimCurrent(claim, fsImpl, platform, traversal);
		throw operationError;
	}
	await assertClaimCurrent(claim, fsImpl, platform, traversal);
	return result;
}

function makeClaim(candidate, entry, parent, operationRoot) {
	const claim = {
		path: candidate,
		identity: entry.identity,
		type: entry.type,
		...(entry.target === undefined ? {} : { target: entry.target }),
		parent,
		rootClaim: operationRoot,
	};
	if (!operationRoot) claim.rootClaim = claim;
	return claim;
}

async function removeClaimedLeaf(claim, fsImpl, platform, traversal, evidence) {
	await assertClaimCurrent(claim, fsImpl, platform, traversal);
	if (claim.type === "directory-reparse-point") await fsImpl.rmdir(claim.path);
	else await fsImpl.unlink(claim.path);
	const residual = await lstatIfPresent(claim.path, fsImpl, traversal);
	if (residual) throw unsafePathError(claim.path, "entry remained or was replaced after non-recursive removal");
	await assertClaimCurrent(claim.parent, fsImpl, platform, traversal);
	if (evidence) evidence.outcome = "removed";
}

async function removeClaimedDirectory(claim, fsImpl, platform, traversal) {
	await assertClaimCurrent(claim, fsImpl, platform, traversal);
	await fsImpl.rmdir(claim.path);
	const residual = await lstatIfPresent(claim.path, fsImpl, traversal);
	if (residual) throw unsafePathError(claim.path, "directory remained or was replaced after removal");
	await assertClaimCurrent(claim.parent, fsImpl, platform, traversal);
}

/** Run dynamically discovered entry work with one operation-level ceiling. */
async function processRemovalQueue(initialJob, concurrency) {
	await new Promise((resolve, reject) => {
		let queue = [];
		let cursor = 0;
		let active = 0;
		let outstanding = 0;
		let stopped = false;
		let firstError;

		const queuedCount = () => queue.length - cursor;
		const compactQueue = () => {
			if (cursor >= 256 && cursor * 2 >= queue.length) {
				queue = queue.slice(cursor);
				cursor = 0;
			}
		};
		const settle = () => {
			if (active !== 0 || outstanding !== 0) return;
			if (firstError !== undefined) reject(firstError);
			else resolve();
		};
		const finish = error => {
			active--;
			outstanding--;
			if (error !== undefined && !stopped) {
				stopped = true;
				firstError = error;
				outstanding -= queuedCount();
				queue = [];
				cursor = 0;
			}
			schedule();
			settle();
		};
		const schedule = () => {
			if (stopped) return;
			while (active < concurrency && cursor < queue.length) {
				const job = queue[cursor++];
				compactQueue();
				active++;
				void Promise.resolve().then(job).then(() => finish(), finish);
			}
		};
		const enqueue = job => {
			if (stopped) return false;
			queue.push(job);
			outstanding++;
			schedule();
			return true;
		};

		enqueue(() => initialJob(enqueue));
	});
}

async function captureParentClaim(ownerRoot, target, fsImpl, platform, traversal) {
	if (ownerRoot === target) return { missing: false, claim: undefined };
	const relative = path.relative(ownerRoot, path.dirname(target));
	const segments = relative === "" ? [] : relative.split(path.sep);
	let claim;
	let rootClaim;
	let current = ownerRoot;
	for (const segment of ["", ...segments]) {
		if (segment) current = path.join(current, segment);
		const stats = await lstatIfPresent(current, fsImpl, traversal);
		if (!stats) return { missing: true, claim: undefined };
		const entry = await classifyEntry(current, stats, fsImpl, platform, traversal);
		if (entry.type !== "directory") {
			traversal.push({ type: "unsafe-ancestor", path: current, entryType: entry.type, target: entry.target });
			throw unsafePathError(current, "target traversal would cross a link, reparse point, or non-directory");
		}
		claim = makeClaim(current, entry, claim, rootClaim);
		if (!rootClaim) {
			rootClaim = claim;
			claim.rootClaim = claim;
		}
	}
	return { missing: false, claim };
}

async function removePathNoFollow(target, ownerRoot, fsImpl, platform, traversal, concurrency) {
	const captured = await captureParentClaim(ownerRoot, target, fsImpl, platform, traversal);
	if (captured.missing) return;

	let operationRoot;
	const processEntry = async (candidate, parentClaim, complete, enqueue) => {
		await assertClaimCurrent(parentClaim, fsImpl, platform, traversal);
		const stats = await lstatIfPresent(candidate, fsImpl, traversal);
		if (!stats) {
			complete();
			return;
		}
		await assertClaimCurrent(parentClaim, fsImpl, platform, traversal);
		const entry = await classifyEntry(candidate, stats, fsImpl, platform, traversal);
		const claim = makeClaim(candidate, entry, parentClaim, operationRoot);
		if (!operationRoot) {
			operationRoot = claim;
			claim.rootClaim = claim;
		}

		if (entry.type !== "directory") {
			let evidence;
			if (entry.type !== "leaf") {
				evidence = {
					type: entry.type,
					path: candidate,
					target: entry.target,
					action: entry.type === "directory-reparse-point" ? "rmdir" : "unlink",
				};
				traversal.push(evidence);
			}
			await removeClaimedLeaf(claim, fsImpl, platform, traversal, evidence);
			complete();
			return;
		}

		const entries = await withCurrentClaim(
			claim,
			fsImpl,
			platform,
			traversal,
			() => fsImpl.readdir(candidate, { withFileTypes: true }),
		);
		if (entries.length === 0) {
			await removeClaimedDirectory(claim, fsImpl, platform, traversal);
			complete();
			return;
		}

		let remaining = entries.length;
		const childComplete = () => {
			remaining--;
			if (remaining !== 0) return;
			enqueue(async () => {
				await removeClaimedDirectory(claim, fsImpl, platform, traversal);
				complete();
			});
		};
		for (const child of entries) {
			enqueue(() => processEntry(
				path.join(candidate, child.name),
				claim,
				childComplete,
				enqueue,
			));
		}
	};

	await processRemovalQueue(
		enqueue => processEntry(target, captured.claim, () => {}, enqueue),
		concurrency,
	);
}

function diagnosticJson(value) {
	const seen = new WeakSet();
	try {
		return JSON.stringify(value, (_key, item) => {
			if (typeof item === "bigint") return `${item}n`;
			if (item && typeof item === "object") {
				if (seen.has(item)) return "[Circular]";
				seen.add(item);
			}
			return item;
		});
	} catch (error) {
		return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
	}
}

/** A terminal removal failure carrying the complete cleanup history. */
export class OwnedPathCleanupError extends Error {
	constructor({ target, ownerRoot, owner, lifecycle, history, elapsedMs, cause }) {
		const details = {
			target,
			ownerRoot,
			owner: owner ?? null,
			elapsedMs,
			attempts: history.length,
			history,
			lifecycle: lifecycle ?? null,
		};
		super(
			`Failed to remove owned path "${target}" within owner root "${ownerRoot}": ${diagnosticJson(details)}`,
			{ cause },
		);
		this.name = "OwnedPathCleanupError";
		this.target = target;
		this.ownerRoot = ownerRoot;
		this.owner = owner;
		this.attempts = history.length;
		this.elapsedMs = elapsedMs;
		this.history = history;
		this.lifecycle = lifecycle;
	}
}

/**
 * Remove a path owned by a test run without following links or reparse points.
 *
 * The operation root, immediate producer, and current entry are identity-
 * checked around pathname I/O. Links are removed non-recursively; uncertain
 * identities retain the root and fail loud.
 * Transient lock and directory-removal errors receive bounded exponential
 * backoff on every platform. Removing the owner root itself requires explicit
 * coordinator permission.
 */
export async function removeOwnedPath(target, options = {}) {
	if (typeof target !== "string" || target.length === 0) {
		throw new TypeError("target must be a non-empty path");
	}
	if (typeof options.ownerRoot !== "string" || options.ownerRoot.length === 0) {
		throw new TypeError("ownerRoot must be a non-empty path");
	}

	const ownerRoot = path.resolve(options.ownerRoot);
	const resolvedTarget = path.resolve(target);
	const targetsOwnerRoot = resolvedTarget === ownerRoot;
	if (targetsOwnerRoot) {
		if (!options.allowOwnerRoot || options.owner?.kind !== "coordinator") {
			throw new Error(`Refusing to remove owner root without explicit coordinator permission: ${resolvedTarget}`);
		}
	} else if (!isOwnedChild(ownerRoot, resolvedTarget)) {
		throw new Error(`Refusing to remove path outside the owned root: ${resolvedTarget} (owner root: ${ownerRoot})`);
	}

	const maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, "maxAttempts");
	const deadlineMs = nonNegativeNumber(options.deadlineMs, DEFAULT_DEADLINE_MS, "deadlineMs");
	const initialDelayMs = nonNegativeNumber(options.initialDelayMs, DEFAULT_INITIAL_DELAY_MS, "initialDelayMs");
	const maxDelayMs = nonNegativeNumber(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, "maxDelayMs");
	const traversalConcurrency = positiveInteger(
		options.traversalConcurrency,
		DEFAULT_TRAVERSAL_CONCURRENCY,
		"traversalConcurrency",
	);
	const platform = options.platform ?? process.platform;
	const fsImpl = {
		lstat,
		readlink,
		readdir,
		rmdir,
		unlink,
		...options.seams?.fs,
	};
	// The whole-attempt override exists only for deterministic retry-policy tests.
	// Production callers always use the no-follow traversal above.
	const remove = options.seams?.remove
		?? ((candidate, traversal) => removePathNoFollow(
			candidate,
			ownerRoot,
			fsImpl,
			platform,
			traversal,
			traversalConcurrency,
		));
	const sleep = options.seams?.sleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
	const now = options.seams?.now ?? (() => performance.now());
	const history = [];
	const startedAt = now();
	let lastError;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const elapsedMs = Math.max(0, now() - startedAt);
		if (attempt > 1 && elapsedMs >= deadlineMs) {
			throw new OwnedPathCleanupError({
				target: resolvedTarget,
				ownerRoot,
				owner: options.owner,
				lifecycle: options.lifecycle,
				history,
				elapsedMs,
				cause: lastError,
			});
		}
		const traversal = [];
		try {
			await remove(resolvedTarget, traversal);
			history.push({ attempt, elapsedMs, ...(traversal.length > 0 ? { traversal } : {}) });
			return { removed: true, attempts: attempt, history };
		} catch (error) {
			lastError = error;
			const record = errorAttempt(error, attempt, elapsedMs, traversal);
			history.push(record);
			if (record.code === "ENOENT") {
				return { removed: true, attempts: attempt, history };
			}

			const transient = TRANSIENT_REMOVAL_CODES.has(record.code);
			const exponentialDelayMs = initialDelayMs === 0
				? 0
				: initialDelayMs * (2 ** Math.min(attempt - 1, 52));
			const delayMs = Math.min(exponentialDelayMs, maxDelayMs);
			const currentElapsedMs = Math.max(0, now() - startedAt);
			if (!transient
				|| attempt >= maxAttempts
				|| currentElapsedMs >= deadlineMs
				|| delayMs > deadlineMs - currentElapsedMs) {
				throw new OwnedPathCleanupError({
					target: resolvedTarget,
					ownerRoot,
					owner: options.owner,
					lifecycle: options.lifecycle,
					history,
					elapsedMs: currentElapsedMs,
					cause: lastError,
				});
			}
			await sleep(delayMs);
		}
	}

	// The loop always returns or throws, but keep a defensive terminal path for
	// future changes to its bounds.
	throw new OwnedPathCleanupError({
		target: resolvedTarget,
		ownerRoot,
		owner: options.owner,
		lifecycle: options.lifecycle,
		history,
		elapsedMs: Math.max(0, now() - startedAt),
		cause: lastError,
	});
}

/**
 * Shut down resource owners in phase order, with peers in each phase settled
 * together. Deletion is allowed only after every owner has shut down cleanly.
 */
export async function shutdownResourcesThenRemove({ phases, remove }) {
	if (!Array.isArray(phases)) throw new TypeError("phases must be an array");
	if (typeof remove !== "function") throw new TypeError("remove must be a function");

	const failures = [];
	for (const phase of phases) {
		const phaseName = typeof phase?.name === "string" ? phase.name : "unnamed-phase";
		const owners = Array.isArray(phase?.owners) ? phase.owners : [];
		const results = await Promise.allSettled(owners.map(owner => Promise.resolve().then(() => owner())));
		for (let index = 0; index < results.length; index++) {
			const result = results[index];
			if (result.status === "rejected") {
				const reason = result.reason;
				const message = reason instanceof Error ? reason.message : String(reason);
				failures.push({ phase: phaseName, ownerIndex: index, reason, message });
			}
		}
	}

	if (failures.length > 0) {
		const errors = failures.map(failure => {
			const error = new Error(`${failure.phase} owner ${failure.ownerIndex}: ${failure.message}`, { cause: failure.reason });
			error.phase = failure.phase;
			error.ownerIndex = failure.ownerIndex;
			return error;
		});
		const aggregate = new AggregateError(
			errors,
			`Resource shutdown failed; removal skipped: ${errors.map(error => error.message).join("; ")}`,
		);
		aggregate.name = "ResourceShutdownError";
		aggregate.failures = failures;
		throw aggregate;
	}

	await remove();
}
