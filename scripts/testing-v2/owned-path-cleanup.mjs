import { rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const WINDOWS_TRANSIENT_REMOVAL_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_INITIAL_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 500;

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

function errorAttempt(error, attempt, elapsedMs) {
	const record = { attempt, elapsedMs };
	if (error && typeof error === "object") {
		for (const key of ["code", "syscall", "path", "dest"]) {
			if (typeof error[key] === "string") record[key] = error[key];
		}
	}
	record.message = error instanceof Error ? error.message : String(error);
	return record;
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
 * Recursively remove a path owned by a test run.
 *
 * Windows lock errors receive bounded exponential backoff. Other errors fail
 * immediately, and removing the owner root itself requires explicit
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
	const remove = options.seams?.remove ?? ((candidate, removeOptions) => rm(candidate, removeOptions));
	const sleep = options.seams?.sleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
	const now = options.seams?.now ?? (() => performance.now());
	const platform = options.platform ?? process.platform;
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
		try {
			await remove(resolvedTarget, { recursive: true, force: true });
			history.push({ attempt, elapsedMs });
			return { removed: true, attempts: attempt, history };
		} catch (error) {
			lastError = error;
			const record = errorAttempt(error, attempt, elapsedMs);
			history.push(record);
			if (record.code === "ENOENT") {
				return { removed: true, attempts: attempt, history };
			}

			const transient = platform === "win32" && WINDOWS_TRANSIENT_REMOVAL_CODES.has(record.code);
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
