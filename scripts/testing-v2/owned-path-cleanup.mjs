import { fork } from "node:child_process";
import { lstat, readlink, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const TRANSIENT_REMOVAL_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const DEFAULT_MAX_ATTEMPTS = 32;
const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_INITIAL_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 500;
const DEFAULT_TRAVERSAL_CONCURRENCY = 8;
const DEFAULT_SUBPROCESS_THREAD_POOL_SIZE = 32;
// Give the remover its complete monotonic deadline, then one short window to
// publish its result and close the IPC channel before the parent intervenes.
const SUBPROCESS_CLOSE_GRACE_MS = 1_000;
const CLEANUP_DEADLINE_CODE = "ECLEANUPDEADLINE";
const CLEANUP_CHILD_ARGUMENT = "--owned-path-cleanup-child";

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
		for (const key of ["code", "syscall", "path", "dest", "stage"]) {
			if (typeof error[key] === "string") record[key] = error[key];
		}
		if (Number.isFinite(error.deadlineMs)) record.deadlineMs = error.deadlineMs;
	}
	if (traversal.length > 0) record.traversal = traversal;
	record.message = error instanceof Error ? error.message : String(error);
	return record;
}

function errorFields(error) {
	const fields = {};
	if (error && typeof error === "object") {
		for (const key of ["code", "syscall", "path", "dest", "stage"]) {
			if (typeof error[key] === "string") fields[key] = error[key];
		}
	}
	return fields;
}

function createDeadlineGuard({ deadlineMs, startedAt, now }) {
	const expiresAt = startedAt + deadlineMs;
	let failure;
	const checkpoint = (stage, currentPath) => {
		if (failure) throw failure;
		const elapsedMs = Math.max(0, now() - startedAt);
		if (elapsedMs < deadlineMs) return;
		failure = Object.assign(
			new Error(`Owned-path cleanup deadline expired during ${stage} at "${currentPath}" after ${elapsedMs}ms (deadline ${deadlineMs}ms)`),
			{
				code: CLEANUP_DEADLINE_CODE,
				stage,
				path: currentPath,
				deadlineMs,
				elapsedMs,
				expiresAt,
			},
		);
		throw failure;
	};
	return { checkpoint, get failure() { return failure; }, expiresAt };
}

async function runGuardedBoundary(guard, stage, currentPath, operation) {
	guard.checkpoint(stage, currentPath);
	try {
		const result = await operation();
		guard.checkpoint(stage, currentPath);
		return result;
	} catch (error) {
		// If the I/O itself crossed the immutable expiry, the deadline is the
		// authoritative failure. The operation is already settled before this
		// checkpoint can reject, so no work is abandoned.
		guard.checkpoint(stage, currentPath);
		throw error;
	}
}

function lifecycleWithDeadline(lifecycle, error) {
	if (error?.code !== CLEANUP_DEADLINE_CODE) return lifecycle;
	const base = lifecycle && typeof lifecycle === "object"
		? { ...lifecycle }
		: { suppliedLifecycle: lifecycle ?? null };
	base.cleanupDeadline = {
		code: error.code,
		stage: error.stage,
		path: error.path,
		deadlineMs: error.deadlineMs,
		elapsedMs: error.elapsedMs,
	};
	return base;
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

async function lstatIfPresent(candidate, fsImpl, traversal, guard) {
	try {
		return await runGuardedBoundary(guard, "lstat", candidate, () => fsImpl.lstat(candidate));
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		recordDetectionFailure(traversal, candidate, "lstat", error);
		throw error;
	}
}

async function classifyEntry(candidate, stats, fsImpl, platform, traversal, guard) {
	const identity = stableIdentity(stats);
	if (identity === undefined) {
		recordDetectionFailure(traversal, candidate, "stable-identity", unsafePathError(candidate, "filesystem identity is unavailable"));
		throw unsafePathError(candidate, "filesystem identity is unavailable");
	}

	if (stats.isSymbolicLink()) {
		try {
			const target = await runGuardedBoundary(guard, "readlink", candidate, () => fsImpl.readlink(candidate));
			return { type: platform === "win32" ? "junction-or-symbolic-link" : "symbolic-link", identity, target };
		} catch (error) {
			if (error?.code === CLEANUP_DEADLINE_CODE) throw error;
			recordDetectionFailure(traversal, candidate, "readlink", error);
			throw unsafePathError(candidate, "link target could not be identified", error);
		}
	}

	if (stats.isDirectory() && platform === "win32") {
		try {
			const target = await runGuardedBoundary(guard, "readlink-directory-probe", candidate, () => fsImpl.readlink(candidate));
			return { type: "directory-reparse-point", identity, target };
		} catch (error) {
			if (error?.code === CLEANUP_DEADLINE_CODE) throw error;
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
async function assertClaimCurrent(claim, fsImpl, platform, traversal, guard, probeDirectories = false) {
	if (!claim) return;
	const claims = new Set([claim.rootClaim, claim.parent, claim]);
	claims.delete(undefined);
	for (const currentClaim of claims) {
		const current = await lstatIfPresent(currentClaim.path, fsImpl, traversal, guard);
		if (!current) throw unsafePathError(currentClaim.path, "an entry disappeared during removal");
		// Initial capture proves an ordinary directory with the Windows readlink
		// probe. Revalidation can compare its stable identity plus lstat type;
		// repeat the expensive throwing probe only at a directory-delete boundary.
		// Links always re-read their target, and any junction reported as a link
		// therefore still fails the type/target comparison before pathname I/O.
		const entry = !probeDirectories
			&& currentClaim.type === "directory"
			&& current.isDirectory()
			&& !current.isSymbolicLink()
			? { type: "directory", identity: stableIdentity(current) }
			: await classifyEntry(currentClaim.path, current, fsImpl, platform, traversal, guard);
		if (!entryMatchesClaim(entry, currentClaim)) {
			throw unsafePathError(currentClaim.path, "entry identity, type, or link target changed during removal");
		}
	}
}

async function withCurrentClaim(claim, fsImpl, platform, traversal, guard, stage, operation) {
	await assertClaimCurrent(claim, fsImpl, platform, traversal, guard);
	let result;
	try {
		result = await runGuardedBoundary(guard, stage, claim.path, operation);
	} catch (operationError) {
		// Prefer an identity error when namespace replacement caused the I/O
		// failure; otherwise preserve the original filesystem error for retry.
		await assertClaimCurrent(claim, fsImpl, platform, traversal, guard);
		throw operationError;
	}
	await assertClaimCurrent(claim, fsImpl, platform, traversal, guard);
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

async function removeClaimedLeaf(claim, fsImpl, platform, traversal, evidence, guard) {
	await assertClaimCurrent(claim, fsImpl, platform, traversal, guard);
	if (claim.type === "directory-reparse-point") {
		await runGuardedBoundary(guard, "rmdir-reparse-point", claim.path, () => fsImpl.rmdir(claim.path));
	} else {
		await runGuardedBoundary(guard, "unlink", claim.path, () => fsImpl.unlink(claim.path));
	}
	const residual = await lstatIfPresent(claim.path, fsImpl, traversal, guard);
	if (residual) throw unsafePathError(claim.path, "entry remained or was replaced after non-recursive removal");
	// No parent recheck is needed after absence is established: every later
	// destructive boundary independently validates its root/producer claim.
	if (evidence) evidence.outcome = "removed";
}

async function removeClaimedDirectory(claim, fsImpl, platform, traversal, guard) {
	await assertClaimCurrent(claim, fsImpl, platform, traversal, guard, true);
	await runGuardedBoundary(guard, "rmdir", claim.path, () => fsImpl.rmdir(claim.path));
	const residual = await lstatIfPresent(claim.path, fsImpl, traversal, guard);
	if (residual) throw unsafePathError(claim.path, "directory remained or was replaced after removal");
}

/** Run dynamically discovered entry work with one operation-level ceiling. */
async function processRemovalQueue(initialJob, concurrency, guard, target) {
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
			if (error !== undefined) {
				if (!stopped) {
					stopped = true;
					firstError = error;
					outstanding -= queuedCount();
					queue = [];
					cursor = 0;
				} else if (error?.code === CLEANUP_DEADLINE_CODE) {
					// A deadline observed while already-started peers drain is more
					// actionable than the transient failure that first stopped admission.
					firstError = error;
				}
			}
			schedule();
			settle();
		};
		const schedule = () => {
			if (stopped) return;
			while (active < concurrency && cursor < queue.length) {
				const queued = queue[cursor++];
				compactQueue();
				active++;
				void Promise.resolve().then(queued.job).then(() => finish(), finish);
			}
		};
		const enqueue = (job, context = {}) => {
			if (stopped) return false;
			guard.checkpoint(context.stage ?? "queue-admission", context.path ?? target);
			queue.push({ job });
			outstanding++;
			schedule();
			return true;
		};

		enqueue(() => initialJob(enqueue), { stage: "queue-admission-root", path: target });
	});
}

async function captureParentClaim(ownerRoot, target, fsImpl, platform, traversal, guard) {
	if (ownerRoot === target) return { missing: false, claim: undefined };
	const relative = path.relative(ownerRoot, path.dirname(target));
	const segments = relative === "" ? [] : relative.split(path.sep);
	let claim;
	let rootClaim;
	let current = ownerRoot;
	for (const segment of ["", ...segments]) {
		if (segment) current = path.join(current, segment);
		const stats = await lstatIfPresent(current, fsImpl, traversal, guard);
		if (!stats) return { missing: true, claim: undefined };
		const entry = await classifyEntry(current, stats, fsImpl, platform, traversal, guard);
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

async function removePathNoFollow(target, ownerRoot, fsImpl, platform, traversal, concurrency, guard) {
	const captured = await captureParentClaim(ownerRoot, target, fsImpl, platform, traversal, guard);
	if (captured.missing) return;

	// Child cleanup remains anchored to the identity captured for the
	// authoritative owner root. Using the target itself as the operation root
	// would let an owner-root rename/reparse substitution preserve the target
	// and immediate-parent identities while redirecting later pathname I/O.
	// Coordinator-owned root deletion has no parent claim, so its target still
	// becomes the operation root when processEntry captures it below.
	let operationRoot = captured.claim?.rootClaim;
	const processEntry = async (candidate, parentClaim, complete, enqueue) => {
		guard.checkpoint("entry-start", candidate);
		// Capturing metadata is non-destructive. The leaf delete or directory read
		// below validates the resulting claim together with its producer and root
		// immediately around the first pathname I/O that can mutate or enumerate.
		const stats = await lstatIfPresent(candidate, fsImpl, traversal, guard);
		if (!stats) {
			complete();
			return;
		}
		const entry = await classifyEntry(candidate, stats, fsImpl, platform, traversal, guard);
		// The leaf deletion or directory read that follows revalidates this entry,
		// its producer, and the operation root immediately around pathname I/O.
		// Avoid a duplicate parent/root probe here for every high-cardinality leaf.
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
			await removeClaimedLeaf(claim, fsImpl, platform, traversal, evidence, guard);
			complete();
			return;
		}

		const entries = await withCurrentClaim(
			claim,
			fsImpl,
			platform,
			traversal,
			guard,
			"readdir",
			() => fsImpl.readdir(candidate, { withFileTypes: true }),
		);
		if (entries.length === 0) {
			await removeClaimedDirectory(claim, fsImpl, platform, traversal, guard);
			complete();
			return;
		}

		let remaining = entries.length;
		const childComplete = () => {
			remaining--;
			if (remaining !== 0) return;
			enqueue(async () => {
				await removeClaimedDirectory(claim, fsImpl, platform, traversal, guard);
				complete();
			}, { stage: "queue-admission-directory", path: claim.path });
		};
		for (const child of entries) {
			const childPath = path.join(candidate, child.name);
			enqueue(() => processEntry(
				childPath,
				claim,
				childComplete,
				enqueue,
			), { stage: "queue-admission-entry", path: childPath });
		}
	};

	await processRemovalQueue(
		enqueue => processEntry(target, captured.claim, () => {}, enqueue),
		concurrency,
		guard,
		target,
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
		const attempts = history.reduce((maximum, record) => Math.max(maximum, record.attempt ?? 0), 0);
		const details = {
			target,
			ownerRoot,
			owner: owner ?? null,
			elapsedMs,
			attempts,
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
		this.attempts = attempts;
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
	const sleep = options.seams?.sleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
	const now = options.seams?.now ?? (() => performance.now());
	const history = [];
	const startedAt = now();
	const deadlineGuard = createDeadlineGuard({ deadlineMs, startedAt, now });
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
			deadlineGuard,
		));
	let lastError;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const elapsedMs = Math.max(0, now() - startedAt);
		const traversal = [];
		try {
			deadlineGuard.checkpoint("attempt-start", resolvedTarget);
			await remove(resolvedTarget, traversal);
			// Whole-attempt test seams do not receive the production traversal
			// guard, so recheck before reporting their completion as successful.
			deadlineGuard.checkpoint("attempt-complete", resolvedTarget);
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
					lifecycle: lifecycleWithDeadline(options.lifecycle, lastError),
					history,
					elapsedMs: currentElapsedMs,
					cause: lastError,
				});
			}
			await sleep(delayMs);
			try {
				deadlineGuard.checkpoint("retry-delay", resolvedTarget);
			} catch (deadlineError) {
				lastError = deadlineError;
				const afterDelayElapsedMs = Math.max(0, now() - startedAt);
				history.push(errorAttempt(deadlineError, attempt, afterDelayElapsedMs, []));
				throw new OwnedPathCleanupError({
					target: resolvedTarget,
					ownerRoot,
					owner: options.owner,
					lifecycle: lifecycleWithDeadline(options.lifecycle, deadlineError),
					history,
					elapsedMs: afterDelayElapsedMs,
					cause: deadlineError,
				});
			}
		}
	}

	// The loop always returns or throws, but keep a defensive terminal path for
	// future changes to its bounds.
	throw new OwnedPathCleanupError({
		target: resolvedTarget,
		ownerRoot,
		owner: options.owner,
		lifecycle: lifecycleWithDeadline(options.lifecycle, lastError),
		history,
		elapsedMs: Math.max(0, now() - startedAt),
		cause: lastError,
	});
}

const SUBPROCESS_REMOVE_OPTION_KEYS = [
	"ownerRoot",
	"allowOwnerRoot",
	"owner",
	"lifecycle",
	"platform",
	"maxAttempts",
	"deadlineMs",
	"initialDelayMs",
	"maxDelayMs",
	"traversalConcurrency",
];
const MAX_IPC_TEXT_LENGTH = 16_384;
const MAX_IPC_TRAVERSAL_RECORDS = 32;

function boundedText(value) {
	if (typeof value !== "string" || value.length <= MAX_IPC_TEXT_LENGTH) return value;
	return `${value.slice(0, MAX_IPC_TEXT_LENGTH)}… [truncated ${value.length - MAX_IPC_TEXT_LENGTH} chars]`;
}

function boundedPlainValue(value) {
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) return undefined;
		if (encoded.length <= MAX_IPC_TEXT_LENGTH) return JSON.parse(encoded);
		return { truncated: true, preview: boundedText(encoded) };
	} catch (error) {
		return { unavailable: boundedText(error instanceof Error ? error.message : String(error)) };
	}
}

function boundedCleanupHistory(history) {
	if (!Array.isArray(history)) return undefined;
	return history.slice(-DEFAULT_MAX_ATTEMPTS).map(record => {
		if (!record || typeof record !== "object") return boundedPlainValue(record);
		const bounded = {};
		for (const key of ["attempt", "elapsedMs", "code", "syscall", "path", "dest", "stage", "deadlineMs", "message"]) {
			if (record[key] !== undefined) bounded[key] = boundedText(record[key]);
		}
		if (Array.isArray(record.traversal)) {
			bounded.traversal = record.traversal.slice(-MAX_IPC_TRAVERSAL_RECORDS).map(boundedPlainValue);
			if (record.traversal.length > MAX_IPC_TRAVERSAL_RECORDS) {
				bounded.traversalOmitted = record.traversal.length - MAX_IPC_TRAVERSAL_RECORDS;
			}
		}
		return bounded;
	});
}

function serializedCleanupError(error) {
	if (!(error instanceof Error)) return { name: "Error", message: boundedText(String(error)) };
	const serialized = {
		name: boundedText(error.name),
		message: boundedText(error.message),
		stack: boundedText(error.stack),
	};
	for (const key of ["code", "stage", "target", "ownerRoot"]) {
		if (error[key] !== undefined) serialized[key] = boundedText(error[key]);
	}
	for (const key of ["owner", "lifecycle"]) {
		if (error[key] !== undefined) serialized[key] = boundedPlainValue(error[key]);
	}
	if (error.history !== undefined) serialized.history = boundedCleanupHistory(error.history);
	for (const key of ["attempts", "elapsedMs", "deadlineMs"]) {
		if (error[key] !== undefined) serialized[key] = error[key];
	}
	return serialized;
}

function cleanupErrorFromPayload(payload) {
	const error = new Error(payload?.message ?? "Owned cleanup subprocess failed");
	for (const key of [
		"code",
		"stage",
		"target",
		"ownerRoot",
		"owner",
		"lifecycle",
		"history",
		"attempts",
		"elapsedMs",
		"deadlineMs",
	]) {
		if (payload?.[key] !== undefined) error[key] = payload[key];
	}
	if (payload?.name) error.name = payload.name;
	if (payload?.stack) error.stack = payload.stack;
	return error;
}

function jsonTransportClone(request, target, options) {
	try {
		const encoded = JSON.stringify(request);
		if (encoded === undefined) throw new TypeError("request encoded to undefined");
		return JSON.parse(encoded);
	} catch (cause) {
		const error = new TypeError(
			`Owned-path cleanup subprocess request is not JSON-compatible for "${target}"`,
			{ cause },
		);
		error.code = "ECLEANUPIPCJSON";
		error.stage = "serialize-request";
		error.target = target;
		error.ownerRoot = options.ownerRoot;
		error.lifecycle = boundedPlainValue(options.lifecycle);
		throw error;
	}
}

function subprocessLifecycleError({
	code,
	summary,
	cause,
	target,
	options,
	stage,
	elapsedMs,
	lifecycleDeadlineMs,
	childLifecycle,
}) {
	const owner = boundedPlainValue(options.owner) ?? null;
	const lifecycle = {
		cleanup: boundedPlainValue(options.lifecycle) ?? null,
		subprocess: childLifecycle,
	};
	const details = {
		target,
		ownerRoot: options.ownerRoot,
		owner,
		stage,
		elapsedMs,
		lifecycleDeadlineMs,
		lifecycle,
	};
	const error = new Error(`${summary}: ${diagnosticJson(details)}`, cause === undefined ? undefined : { cause });
	error.name = "OwnedPathCleanupSubprocessError";
	error.code = code;
	error.stage = stage;
	error.target = target;
	error.ownerRoot = options.ownerRoot;
	error.owner = owner;
	error.elapsedMs = elapsedMs;
	error.deadlineMs = lifecycleDeadlineMs;
	error.lifecycle = lifecycle;
	return error;
}

/**
 * Run a large owned removal in a short-lived process with an isolated libuv
 * filesystem pool. The parent settles only after that process exits, so the
 * direct remover's deadline/drain/no-background-work contract is unchanged.
 */
export function removeOwnedPathInSubprocess(target, options = {}, seams = {}) {
	if (options.seams !== undefined) {
		throw new TypeError("removeOwnedPathInSubprocess does not accept in-process seams");
	}
	const threadPoolSize = positiveInteger(
		options.subprocessThreadPoolSize,
		DEFAULT_SUBPROCESS_THREAD_POOL_SIZE,
		"subprocessThreadPoolSize",
	);
	const unknownOptions = Object.keys(options).filter(key => key !== "subprocessThreadPoolSize" && !SUBPROCESS_REMOVE_OPTION_KEYS.includes(key));
	if (unknownOptions.length > 0) {
		throw new TypeError(`removeOwnedPathInSubprocess received unsupported options: ${unknownOptions.join(", ")}`);
	}
	const removeOptions = Object.fromEntries(
		SUBPROCESS_REMOVE_OPTION_KEYS
			.filter(key => options[key] !== undefined)
			.map(key => [key, options[key]]),
	);
	const cleanupDeadlineMs = nonNegativeNumber(options.deadlineMs, DEFAULT_DEADLINE_MS, "deadlineMs");
	const lifecycleDeadlineMs = cleanupDeadlineMs + SUBPROCESS_CLOSE_GRACE_MS;
	// Validate against the transport's real contract before creating a process.
	// structuredClone accepts values such as BigInt that JSON fork IPC rejects.
	const request = jsonTransportClone({ target, options: removeOptions }, target, options);
	const forkProcess = seams.forkProcess ?? fork;
	const setTimer = seams.setTimer ?? setTimeout;
	const clearTimer = seams.clearTimer ?? clearTimeout;
	const now = seams.now ?? (() => performance.now());
	const modulePath = fileURLToPath(import.meta.url);
	const startedAt = now();

	return new Promise((resolve, reject) => {
		let child;
		try {
			child = forkProcess(modulePath, [CLEANUP_CHILD_ARGUMENT], {
				env: { ...process.env, UV_THREADPOOL_SIZE: String(threadPoolSize) },
				execArgv: [],
				serialization: "json",
				stdio: ["ignore", "inherit", "inherit", "ipc"],
				windowsHide: true,
			});
		} catch (cause) {
			reject(subprocessLifecycleError({
				code: "ECLEANUPSUBPROCESSSPAWN",
				summary: "Failed to spawn owned-path cleanup subprocess",
				cause,
				target,
				options,
				stage: "spawn",
				elapsedMs: Math.max(0, now() - startedAt),
				lifecycleDeadlineMs,
				childLifecycle: { spawned: false },
			}));
			return;
		}

		let stage = "send-request";
		let response;
		let receivedMessage = false;
		let sendAcknowledged = false;
		let terminationRequested = false;
		let terminationReason;
		let killResult;
		let killError;
		let closed = false;
		let settled = false;
		let terminalFailure;
		let closeCode;
		let closeSignal;

		const elapsed = () => Math.max(0, now() - startedAt);
		const childLifecycle = () => ({
			spawned: true,
			stage,
			sendAcknowledged,
			receivedMessage,
			terminationRequested,
			...(terminationReason === undefined ? {} : { terminationReason }),
			...(killResult === undefined ? {} : { killResult }),
			...(killError === undefined ? {} : { killError: boundedText(killError.message ?? String(killError)) }),
			closed,
			...(closeCode === undefined ? {} : { closeCode }),
			...(closeSignal === undefined ? {} : { closeSignal }),
		});
		const recordFailure = (code, summary, failureStage, cause) => {
			if (terminalFailure === undefined) {
				terminalFailure = { code, summary, stage: failureStage, cause };
			}
		};
		const terminateOnce = reason => {
			if (terminationRequested || closed || settled) return;
			terminationRequested = true;
			terminationReason = reason;
			stage = `await-close-after-${reason}`;
			try {
				killResult = child.kill("SIGKILL");
			} catch (error) {
				killError = error;
			}
		};
		const failAndTerminate = (code, summary, failureStage, cause) => {
			if (settled || closed) return;
			recordFailure(code, summary, failureStage, cause);
			terminateOnce(failureStage);
		};
		const remainingLifecycleMs = Math.max(0, lifecycleDeadlineMs - elapsed());
		const timer = setTimer(() => {
			if (settled || closed) return;
			failAndTerminate(
				"ECLEANUPSUBPROCESSTIMEOUT",
				"Owned-path cleanup subprocess exceeded its parent lifecycle deadline",
				stage,
			);
		}, remainingLifecycleMs);

		child.once("message", message => {
			if (settled || closed || terminalFailure !== undefined) return;
			receivedMessage = true;
			response = message;
			if ((message?.ok === true && message?.result?.removed === true)
				|| (message?.ok === false && typeof message?.error?.message === "string")) {
				stage = "await-close-after-result";
				return;
			}
			failAndTerminate(
				"ECLEANUPSUBPROCESSPROTOCOL",
				"Owned-path cleanup subprocess sent a malformed result",
				"receive-result",
			);
		});
		child.once("error", cause => {
			failAndTerminate(
				"ECLEANUPSUBPROCESSCHILD",
				"Owned-path cleanup subprocess emitted an error",
				stage,
				cause,
			);
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			closed = true;
			closeCode = code;
			closeSignal = signal;
			clearTimer(timer);
			settled = true;
			if (terminalFailure !== undefined) {
				reject(subprocessLifecycleError({
					...terminalFailure,
					target,
					options,
					elapsedMs: elapsed(),
					lifecycleDeadlineMs,
					childLifecycle: childLifecycle(),
				}));
				return;
			}
			if (response?.ok === true && response?.result?.removed === true && code === 0) {
				resolve(response.result);
				return;
			}
			if (response?.ok === false && typeof response?.error?.message === "string") {
				reject(cleanupErrorFromPayload(response.error));
				return;
			}
			const hasResponse = response !== undefined;
			reject(subprocessLifecycleError({
				code: hasResponse ? "ECLEANUPSUBPROCESSPROTOCOL" : "ECLEANUPSUBPROCESSNORESULT",
				summary: hasResponse
					? "Owned-path cleanup subprocess closed with an invalid result or exit status"
					: "Owned-path cleanup subprocess exited without a result",
				target,
				options,
				stage: hasResponse ? "close-with-invalid-result" : "close-without-result",
				elapsedMs: elapsed(),
				lifecycleDeadlineMs,
				childLifecycle: childLifecycle(),
			}));
		});

		try {
			child.send(request, error => {
				if (settled || closed) return;
				if (error) {
					failAndTerminate(
						"ECLEANUPSUBPROCESSSEND",
						"Failed to send request to owned-path cleanup subprocess",
						"send-request-callback",
						error,
					);
					return;
				}
				sendAcknowledged = true;
				if (!receivedMessage) stage = "await-result";
			});
		} catch (cause) {
			failAndTerminate(
				"ECLEANUPSUBPROCESSSEND",
				"Failed to send request to owned-path cleanup subprocess",
				"send-request",
				cause,
			);
		}
	});
}

async function runCleanupChild() {
	const request = await new Promise((resolve, reject) => {
		process.once("message", resolve);
		process.once("disconnect", () => reject(new Error("Cleanup parent disconnected before sending work")));
	});
	let response;
	let exitCode = 0;
	try {
		response = { ok: true, result: await removeOwnedPath(request.target, request.options) };
	} catch (error) {
		response = { ok: false, error: serializedCleanupError(error) };
		exitCode = 1;
	}
	await new Promise((resolve, reject) => {
		if (typeof process.send !== "function") {
			reject(new Error("Cleanup child IPC channel is unavailable"));
			return;
		}
		process.send(response, error => error ? reject(error) : resolve());
	});
	process.disconnect();
	process.exitCode = exitCode;
}

const isCleanupChild = process.argv[1]
	&& import.meta.url === pathToFileURL(process.argv[1]).href
	&& process.argv[2] === CLEANUP_CHILD_ARGUMENT;
if (isCleanupChild) {
	runCleanupChild().catch(error => {
		console.error("[owned-path-cleanup] child failed:", error);
		process.exit(1);
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
