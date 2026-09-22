#!/usr/bin/env node

/**
 * Prepare the authoritative packed-consumer fixture once inside an E2E run.
 *
 * The coordinator first seeds a run-owned cache from the committed production
 * lock, then packs Bobbit and finalizes a clean consumer strictly offline. The
 * seed and finalization share one immutable deadline. Browser workers only
 * materialize the published template; they never run npm pack/install.
 */
import { existsSync, readFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { ensureDistBuild } from "./ensure-dist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CACHE_PATH_HELPER_NAME = "resolve-packed-consumer-cache-paths.mjs";
const CACHE_COPY_HELPER_NAME = "copy-packed-consumer-cache-batch.mjs";
const CACHE_COPY_AMBIENT_ENV = "BOBBIT_PACKED_CONSUMER_AMBIENT_CACACHE";
const MAX_CACHE_HELPER_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_HELPER_RESULT_BYTES = 8 * 1024 * 1024;
const DIST_BUILD_TIMEOUT_MS = 5 * 60_000;
const PACK_TIMEOUT_MS = 3 * 60_000;
const CACHE_BATCH_TIMEOUT_MS = 3 * 60_000;
const OFFLINE_INSTALL_TIMEOUT_MS = 10 * 60_000;
// This bounds dist readiness plus the whole package-command sequence. Each
// owned command receives the absolute remaining preparation budget as its total
// lifetime, including ownership readiness. Tree shutdown proof remains bounded
// separately after that deadline fires.
export const PACKED_CONSUMER_PREPARATION_TIMEOUT_MS = 5 * 60_000;
const CACHE_BATCH_SIZE = 32;
const CACHE_WORKER_COUNT = 3;
const CACHE_DISCOVERY_TIMEOUT_MS = 30_000;
const DESCRIPTOR_VERSION = 1;
const FIXTURE_DIRECTORY = "prepared-packed-consumer";
export const PACKED_CONSUMER_DESCRIPTOR_ENV = "BOBBIT_PACKED_CONSUMER_DESCRIPTOR";
// Hosted Windows can spend well over 30 seconds establishing the Job-backed
// ownership handshake during a cold PowerShell start. Readiness may use this
// larger internal cap, but runOwnedCommand also clamps it to the unchanged
// command-wide absolute preparation deadline.
export const OWNERSHIP_ESTABLISHMENT_TIMEOUT_MS = 90_000;
const TREE_EXIT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

function displayCommand(command, args) {
	return [command, ...args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
}

function npmInvocation(env = process.env) {
	const candidates = [
		env.npm_execpath,
		join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
		resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
	].filter(candidate => typeof candidate === "string" && candidate.length > 0);
	const cli = candidates.find(candidate => existsSync(candidate));
	if (!cli) throw new Error(`Unable to locate npm's JavaScript CLI beside ${process.execPath}`);
	return { command: process.execPath, argsPrefix: [cli] };
}

/** Remove npm-script/project state that an external consumer must not inherit. */
export function packedConsumerNpmEnv(cwd, baseEnv = process.env) {
	const env = { ...baseEnv };
	const projectScopedKeys = new Set([
		"npm_config_local_prefix",
		"npm_config_package_lock",
		"npm_config_shrinkwrap",
		"npm_config_workspace",
		"npm_config_workspaces",
		"npm_config_include_workspace_root",
		"npm_config_ignore_scripts",
		"npm_config_omit",
		"npm_config_include",
		"npm_config_optional",
		"npm_config_audit_level",
		"npm_config_dry_run",
	]);
	for (const key of Object.keys(env)) {
		const lower = key.toLowerCase();
		if (projectScopedKeys.has(lower) || lower.startsWith("npm_package_") || lower.startsWith("npm_lifecycle_")) {
			delete env[key];
		}
	}
	delete env.INIT_CWD;
	delete env.init_cwd;
	env.INIT_CWD = cwd;
	return env;
}

function isolatedNpmEnv(cwd, cacheDir, baseEnv) {
	const env = packedConsumerNpmEnv(cwd, baseEnv);
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === "npm_config_cache") delete env[key];
	}
	env.npm_config_cache = cacheDir;
	return env;
}

async function defaultSpawnOwned(command, args, options) {
	options.signal?.throwIfAborted();
	let spawnTreePath = join(options.repoRoot, "dist", "server", "agent", "spawn-tree.js");
	if (!existsSync(spawnTreePath)) {
		// A clean checkout has no dist primitive yet. Bootstrap the exact source
		// implementation into the retained fixture root using Node's built-in
		// erasable-TypeScript support; do not launch an unowned compiler first.
		if (!options.ownershipBootstrapRoot) {
			throw new Error("Owned command startup requires an ownershipBootstrapRoot when dist is absent");
		}
		const bootstrapDir = join(options.ownershipBootstrapRoot, "ownership-bootstrap");
		await mkdir(bootstrapDir, { recursive: true });
		spawnTreePath = join(bootstrapDir, "spawn-tree.ts");
		if (!existsSync(spawnTreePath)) {
			const sourcePath = join(options.repoRoot, "src", "server", "agent", "spawn-tree.ts");
			const clockUrl = pathToFileURL(join(options.repoRoot, "src", "server", "clock.ts")).href;
			const source = await readFile(sourcePath, "utf8");
			const rewritten = source.replace('from "../clock.js"', `from ${JSON.stringify(clockUrl)}`);
			if (rewritten === source) throw new Error(`Unable to bind the source process-tree clock import in ${sourcePath}`);
			await writeFile(spawnTreePath, rewritten, { flag: "wx" });
		}
	}
	const { spawnTracked } = await import(pathToFileURL(spawnTreePath).href);
	// The command-wide deadline is armed before bootstrap/import. This final
	// synchronous check is the no-late-spawn boundary: once aborted, no child may
	// be created after async setup eventually returns.
	options.signal?.throwIfAborted();
	const tracked = spawnTracked(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	// Expose ownership in the same turn as child creation. A caller can then
	// terminate and join the tree even when this async factory is wrapped or its
	// returned promise is delayed after spawn.
	options.onSpawned?.(tracked);
	return tracked;
}

export function isCompleteOwnedCommandShutdown(shutdown) {
	return shutdown?.ownershipState === "established"
		&& shutdown.rootCloseObserved === true
		&& shutdown.treeExitAttempted === true
		&& shutdown.treeExitSettled === true
		&& shutdown.treeExitVerified === true
		&& shutdown.completionTimedOut === false;
}

export class OwnedCommandError extends Error {
	constructor(message, { cause, command, args, cwd, shutdown } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "OwnedCommandError";
		this.command = command;
		this.args = args ? [...args] : [];
		this.cwd = cwd;
		this.shutdown = Object.freeze({ ...shutdown });
	}
}

function commandDiagnostic({ rendered, cwd, child, ownershipState, killRequested, killError, closed, treeExit, treeExitTimeoutMs, stdout, stderr }) {
	const rootClose = closed.observed
		? `code=${closed.code ?? "null"}, signal=${closed.signal ?? "none"}`
		: `not observed within ${treeExitTimeoutMs}ms after termination request`;
	let treeExitDiagnostic = "verification not started";
	if (treeExit.attempted) {
		if (!treeExit.settled) treeExitDiagnostic = `verification did not complete within ${treeExitTimeoutMs}ms`;
		else if (treeExit.error) treeExitDiagnostic = `verification failed: ${treeExit.error.message}`;
		else treeExitDiagnostic = treeExit.verified ? "verified complete" : "not verified";
	}
	return [
		`command: ${rendered}`,
		`cwd: ${cwd}`,
		`pid: ${child.pid ?? "unavailable"}`,
		`ownership: ${ownershipState}`,
		`tree termination requested: ${killRequested ? "yes (SIGKILL)" : "no"}${killError ? `; request failed: ${killError.message}` : ""}`,
		`root close: ${rootClose}`,
		`tree exit: ${treeExitDiagnostic}`,
		`stdout:\n${stdout}`,
		`stderr:\n${stderr}`,
	].join("\n");
}

/**
 * Run a shell-free command whose whole process tree is owned. Timeout/overflow
 * requests one owned-tree kill, then joins both root close and the tracked
 * tree-completion barrier before returning diagnostics.
 */
export async function runOwnedCommand(command, args, {
	cwd,
	env = process.env,
	timeoutMs,
	totalTimeoutMs,
	maxOutputBytes = MAX_OUTPUT_BYTES,
	input,
	maxInputBytes = MAX_CACHE_HELPER_REQUEST_BYTES,
	ownershipEstablishmentTimeoutMs = OWNERSHIP_ESTABLISHMENT_TIMEOUT_MS,
	treeExitTimeoutMs = TREE_EXIT_TIMEOUT_MS,
	repoRoot = REPO_ROOT,
	ownershipBootstrapRoot,
	spawnOwned = defaultSpawnOwned,
	now = () => performance.now(),
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	setCompletionTimer = setTimeout,
	clearCompletionTimer = clearTimeout,
} = {}) {
	if (!cwd) throw new Error("cwd is required");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
	if (totalTimeoutMs !== undefined && (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0)) {
		throw new Error("totalTimeoutMs must be a positive number when provided");
	}
	if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) throw new Error("maxOutputBytes must be a positive number");
	if (!Number.isFinite(maxInputBytes) || maxInputBytes <= 0) throw new Error("maxInputBytes must be a positive number");
	if (input !== undefined && typeof input !== "string" && !Buffer.isBuffer(input)) {
		throw new Error("input must be a string or Buffer when provided");
	}
	const inputBuffer = input === undefined ? undefined : Buffer.isBuffer(input) ? input : Buffer.from(input);
	if (inputBuffer && inputBuffer.byteLength > maxInputBytes) {
		throw new Error(`${displayCommand(command, args)} input exceeds the ${maxInputBytes}-byte input limit`);
	}
	if (!Number.isFinite(ownershipEstablishmentTimeoutMs) || ownershipEstablishmentTimeoutMs <= 0) {
		throw new Error("ownershipEstablishmentTimeoutMs must be a positive number");
	}
	if (!Number.isFinite(treeExitTimeoutMs) || treeExitTimeoutMs <= 0) throw new Error("treeExitTimeoutMs must be a positive number");

	const rendered = displayCommand(command, args);
	const totalStartedAt = now();
	const spawnAbort = new AbortController();
	const stdout = [];
	const stderr = [];
	let outputBytes = 0;
	let terminalError;
	let tracked;
	let child;
	let killRequested = false;
	let killError;
	let ownershipState = "pending";
	let ownershipTimer;
	let executionTimer;
	let totalTimer;
	let completionTimer;
	let resolveKillRequested;
	let resolveSpawnDeadline;
	let resolveCompletionTimeout;
	const killRequestedResult = new Promise(resolveKill => { resolveKillRequested = resolveKill; });
	const spawnDeadlineResult = new Promise(resolveDeadline => { resolveSpawnDeadline = resolveDeadline; });
	const completionTimeoutResult = new Promise(resolveTimeout => { resolveCompletionTimeout = resolveTimeout; });
	const treeExit = { attempted: false, settled: false, verified: false, error: undefined };
	let treeExitResult;
	let closeSettled = false;
	let resolveCloseResult;
	const closeResult = new Promise(resolveClose => { resolveCloseResult = resolveClose; });
	let outputDetached = false;
	let completionTimedOut = false;
	let transportAdmissionClosed = false;
	let transportResult = Promise.resolve();
	const transportStreams = [];
	const destroyedTransports = new Set();

	const startTreeExitVerification = () => {
		if (treeExitResult) return treeExitResult;
		if (!tracked) throw new Error("Cannot verify a process tree before its owned handle is exposed");
		treeExit.attempted = true;
		treeExitResult = (async () => {
			try {
				const verified = await tracked.waitForTreeExit(treeExitTimeoutMs);
				treeExit.settled = true;
				treeExit.verified = verified === true;
			} catch (error) {
				treeExit.settled = true;
				treeExit.error = error instanceof Error ? error : new Error(String(error));
			}
		})();
		return treeExitResult;
	};
	const armCompletionTimeout = () => {
		if (completionTimer !== undefined) return;
		completionTimer = setCompletionTimer(() => {
			completionTimedOut = true;
			const error = new Error(`${rendered} did not complete its process-tree shutdown within ${treeExitTimeoutMs}ms`);
			requestOwnedKill(error);
			resolveCompletionTimeout();
		}, treeExitTimeoutMs);
	};
	const closeTransportAdmission = () => {
		if (!transportAdmissionClosed) {
			transportAdmissionClosed = true;
			detachOutputListeners();
		}
		for (const { stream, direction } of transportStreams) {
			if (destroyedTransports.has(stream)) continue;
			const settled = stream.destroyed || stream.closed
				|| (direction === "input" ? stream.writableFinished : stream.readableEnded);
			if (settled) continue;
			destroyedTransports.add(stream);
			stream.destroy();
		}
	};
	const requestOwnedKill = (error) => {
		if (!terminalError) terminalError = error;
		closeTransportAdmission();
		if (!tracked || killRequested) return;
		killRequested = true;
		armCompletionTimeout();
		resolveKillRequested();
		try {
			tracked.killTree("SIGKILL");
		} catch (killFailure) {
			killError = killFailure instanceof Error ? killFailure : new Error(String(killFailure));
		} finally {
			startTreeExitVerification();
		}
	};
	const collect = (target, chunk) => {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (outputBytes + buffer.byteLength > maxOutputBytes) {
			requestOwnedKill(new Error(`${rendered} exceeded the ${maxOutputBytes}-byte output limit`));
			return;
		}
		outputBytes += buffer.byteLength;
		target.push(buffer);
	};
	const collectStdout = chunk => collect(stdout, chunk);
	const collectStderr = chunk => collect(stderr, chunk);
	const detachOutputListeners = () => {
		if (outputDetached || !child) return;
		outputDetached = true;
		child.stdout?.off("data", collectStdout);
		child.stderr?.off("data", collectStderr);
	};
	const finishClose = result => {
		if (closeSettled) return;
		closeSettled = true;
		resolveCloseResult(result);
	};
	const onError = error => requestOwnedKill(error instanceof Error ? error : new Error(String(error)));
	const onClose = (code, signal) => finishClose({ code, signal });
	const exposeSpawned = candidate => {
		if (tracked && tracked !== candidate) {
			throw new Error(`${rendered} spawn factory exposed more than one owned process tree`);
		}
		if (tracked) return tracked;
		if (!candidate?.child || typeof candidate.killTree !== "function" || typeof candidate.waitForTreeExit !== "function") {
			throw new Error(`${rendered} spawn factory exposed an invalid owned process-tree handle`);
		}
		tracked = candidate;
		child = candidate.child;
		child.stdout?.on("data", collectStdout);
		child.stderr?.on("data", collectStderr);
		child.on("error", onError);
		child.once("close", onClose);
		const settleStream = (stream, label, direction) => {
			if (!stream) {
				requestOwnedKill(new Error(`${rendered} has no ${label} transport`));
				return Promise.resolve();
			}
			transportStreams.push({ stream, direction });
			return finished(stream, { cleanup: true }).catch(error => {
				requestOwnedKill(new Error(`${rendered} ${label} transport failed`, { cause: error }));
			});
		};
		const transports = [
			settleStream(child.stdout, "stdout", "output"),
			settleStream(child.stderr, "stderr", "output"),
		];
		if (inputBuffer) transports.push(settleStream(child.stdin, "stdin", "input"));
		transportResult = Promise.all(transports);
		if (inputBuffer && !terminalError) {
			try {
				child.stdin.end(inputBuffer);
			} catch (error) {
				requestOwnedKill(new Error(`${rendered} stdin transport failed`, { cause: error }));
			}
		}
		if (terminalError) requestOwnedKill(terminalError);
		return tracked;
	};
	const closed = { observed: false, code: null, signal: null };
	const observedCloseResult = closeResult.then(result => {
		closed.observed = true;
		closed.code = result.code;
		closed.signal = result.signal;
		if (executionTimer !== undefined) {
			clearTimer(executionTimer);
			executionTimer = undefined;
		}
	});
	const deadlineError = totalTimeoutMs === undefined
		? undefined
		: new Error(`${rendered} exceeded its ${totalTimeoutMs}ms total deadline (including ownership readiness)`);
	if (deadlineError) {
		const remainingMs = totalTimeoutMs - Math.max(0, now() - totalStartedAt);
		const expire = () => {
			if (!terminalError) terminalError = deadlineError;
			spawnAbort.abort(deadlineError);
			requestOwnedKill(deadlineError);
			resolveSpawnDeadline();
		};
		if (remainingMs <= 0) expire();
		else totalTimer = setTimer(expire, remainingMs);
	}

	let spawnFailure;
	if (!spawnAbort.signal.aborted) {
		// Convert both branches to values before racing. If the absolute deadline
		// wins, a bootstrap/import/custom factory may remain pending indefinitely;
		// its eventual rejection is still observed and cannot become unhandled.
		let spawnInvocation;
		try {
			spawnInvocation = Promise.resolve(spawnOwned(command, args, {
				cwd,
				env,
				repoRoot,
				ownershipBootstrapRoot,
				input: inputBuffer,
				signal: spawnAbort.signal,
				onSpawned: exposeSpawned,
			}));
		} catch (error) {
			spawnInvocation = Promise.reject(error);
		}
		const spawnSettlement = spawnInvocation.then(
			returned => {
				try {
					// Keep observing a late return even after the deadline race has
					// settled. Factories should expose at creation, but a returned
					// handle is still captured and terminated rather than abandoned.
					exposeSpawned(returned);
					return { status: "fulfilled", returned };
				} catch (error) {
					return { status: "rejected", error };
				}
			},
			error => ({ status: "rejected", error }),
		);
		const spawnBoundary = deadlineError
			? await Promise.race([
				spawnSettlement,
				spawnDeadlineResult.then(() => ({ status: "deadline" })),
			])
			: await spawnSettlement;
		if (spawnBoundary.status === "rejected") {
			spawnFailure = spawnBoundary.error instanceof Error
				? spawnBoundary.error
				: new Error(String(spawnBoundary.error));
		}
	}
	if (!tracked) {
		if (totalTimer !== undefined) clearTimer(totalTimer);
		ownershipState = terminalError ? "not spawned before deadline" : "spawn failed";
		const cause = terminalError ?? spawnFailure ?? new Error(`Failed to spawn ${rendered}`);
		const shutdown = Object.freeze({
			ownershipState,
			killRequested: false,
			rootCloseObserved: false,
			rootExitCode: null,
			rootSignal: null,
			treeExitAttempted: false,
			treeExitSettled: false,
			treeExitVerified: false,
			completionTimedOut: false,
		});
		throw new OwnedCommandError(
			`${cause.message}\ncommand: ${rendered}\ncwd: ${cwd}\npid: unavailable\nownership: ${ownershipState}\ntree termination requested: no\ntree exit: not applicable (no child created)`,
			{ cause, command, args, cwd, shutdown },
		);
	}
	if (spawnFailure) {
		requestOwnedKill(new Error(`${rendered} spawn factory failed after exposing its owned process tree`, { cause: spawnFailure }));
	}

	const remainingOwnershipBudgetMs = totalTimeoutMs === undefined
		? Number.POSITIVE_INFINITY
		: Math.max(1, Math.ceil(totalTimeoutMs - Math.max(0, now() - totalStartedAt)));
	// The readiness cap is independent only when it can expire first. Otherwise
	// the already-armed absolute timer remains the sole authority for the same or
	// shorter remaining budget, preserving its deadline error and kill request.
	const ownershipReadinessTimeoutMs = ownershipEstablishmentTimeoutMs < remainingOwnershipBudgetMs
		? ownershipEstablishmentTimeoutMs
		: undefined;
	const ownershipTimeoutError = ownershipReadinessTimeoutMs === undefined
		? undefined
		: new Error(`${rendered} ownership readiness timed out after ${ownershipReadinessTimeoutMs}ms`);
	const terminationDuringOwnership = Symbol("termination-during-ownership");
	try {
		await Promise.race([
			tracked.ownershipReady,
			...(ownershipReadinessTimeoutMs === undefined ? [] : [new Promise((_, reject) => {
				ownershipTimer = setTimer(() => reject(ownershipTimeoutError), ownershipReadinessTimeoutMs);
			})]),
			killRequestedResult.then(() => { throw terminationDuringOwnership; }),
		]);
		ownershipState = "established";
	} catch (error) {
		if (error === terminationDuringOwnership) {
			ownershipState = "termination requested before readiness";
		} else {
			ownershipState = error === ownershipTimeoutError ? "timed out" : "failed";
			requestOwnedKill(error === ownershipTimeoutError
				? ownershipTimeoutError
				: new Error(`${rendered} did not establish process-tree ownership`, { cause: error }));
		}
	} finally {
		if (ownershipTimer !== undefined) clearTimer(ownershipTimer);
	}
	if (!terminalError) {
		const totalRemainingMs = totalTimeoutMs === undefined
			? Number.POSITIVE_INFINITY
			: totalTimeoutMs - Math.max(0, now() - totalStartedAt);
		if (totalRemainingMs <= 0) {
			requestOwnedKill(new Error(`${rendered} exceeded its ${totalTimeoutMs}ms total deadline (including ownership readiness)`));
		} else if (timeoutMs < totalRemainingMs) {
			executionTimer = setTimer(() => requestOwnedKill(new Error(`${rendered} timed out after ${timeoutMs}ms`)), timeoutMs);
		}
	}

	const firstBoundary = await Promise.race([
		observedCloseResult.then(() => "close"),
		killRequestedResult.then(() => "kill"),
	]);
	if (firstBoundary === "close") {
		startTreeExitVerification();
		armCompletionTimeout();
	}
	const completionResult = Promise.all([observedCloseResult, startTreeExitVerification(), transportResult]);
	const completionBoundary = await Promise.race([
		completionResult.then(() => "complete"),
		completionTimeoutResult.then(() => "timeout"),
	]);
	if (completionBoundary === "timeout") {
		// A bounded shutdown proof may fail closed without an observed root close,
		// but transport ownership is never abandoned. Failure admission destroys
		// every still-open pipe and joins those finished settlements before return.
		await transportResult;
	}

	child.off("error", onError);
	child.off("close", onClose);
	detachOutputListeners();
	if (executionTimer !== undefined) clearTimer(executionTimer);
	if (totalTimer !== undefined) clearTimer(totalTimer);
	if (completionTimer !== undefined) clearCompletionTimer(completionTimer);
	const stdoutText = Buffer.concat(stdout).toString("utf8");
	const stderrText = Buffer.concat(stderr).toString("utf8");
	const diagnostic = commandDiagnostic({
		rendered,
		cwd,
		child,
		ownershipState,
		killRequested,
		killError,
		closed,
		treeExit,
		treeExitTimeoutMs,
		stdout: stdoutText,
		stderr: stderrText,
	});

	const shutdown = {
		ownershipState,
		killRequested,
		rootCloseObserved: closed.observed,
		rootExitCode: closed.code,
		rootSignal: closed.signal,
		treeExitAttempted: treeExit.attempted,
		treeExitSettled: treeExit.settled,
		treeExitVerified: treeExit.verified === true,
		completionTimedOut,
	};
	const ownedCommandError = (message, cause) => new OwnedCommandError(message, {
		cause,
		command,
		args,
		cwd,
		shutdown,
	});
	if (completionTimedOut || !closed.observed) {
		const terminalContext = terminalError ? `${terminalError.message}\n` : "";
		throw ownedCommandError(
			`${terminalContext}${rendered} did not complete its process-tree shutdown within ${treeExitTimeoutMs}ms\n${diagnostic}`,
			terminalError,
		);
	}
	if (!treeExit.verified) {
		throw ownedCommandError(
			`${rendered} closed without verified process-tree completion\n${diagnostic}`,
			treeExit.error ?? terminalError,
		);
	}
	if (terminalError) throw ownedCommandError(`${terminalError.message}\n${diagnostic}`, terminalError);
	if (closed.signal || closed.code === null) throw ownedCommandError(`${rendered} terminated without an exit code\n${diagnostic}`);
	return {
		command,
		args: [...args],
		code: closed.code,
		stdout: stdoutText,
		stderr: stderrText,
		shutdown: Object.freeze(shutdown),
	};
}

function requireSuccess(result) {
	if (result.code === 0) return;
	throw new Error(`${displayCommand(result.command, result.args)} exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function parsePackResult(stdout, expectedPackageName) {
	let parsed;
	try { parsed = JSON.parse(stdout); } catch (error) {
		throw new Error(`npm pack emitted malformed JSON: ${error.message}`, { cause: error });
	}
	if (!Array.isArray(parsed) || parsed.length !== 1) {
		throw new Error(`npm pack must report exactly one result, received ${JSON.stringify(parsed)}`);
	}
	const entry = parsed[0];
	if (!entry || typeof entry !== "object" || entry.name !== expectedPackageName ||
		typeof entry.filename !== "string" || entry.filename.length === 0 || basename(entry.filename) !== entry.filename) {
		throw new Error(`npm pack reported an invalid result: ${JSON.stringify(entry)}`);
	}
	return { entry, report: parsed };
}

function readPackageLock(path, label) {
	let parsed;
	try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
		throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || parsed.lockfileVersion !== 3 ||
		!parsed.packages || typeof parsed.packages !== "object" || Array.isArray(parsed.packages)) {
		throw new Error(`${label} must be a package-lock v3 document with a packages object`);
	}
	return parsed;
}

function assertPackedArtifactLock(lock, packageName, resolverDir, tarballPath) {
	const rootSpec = lock.packages?.[""]?.dependencies?.[packageName];
	const installedSpec = lock.packages?.[`node_modules/${packageName}`]?.resolved;
	for (const [label, spec] of [["root dependency", rootSpec], ["installed package", installedSpec]]) {
		if (typeof spec !== "string" || !spec.startsWith("file:")) {
			throw new Error(`Generated consumer lock ${label} for ${packageName} must be a file: reference`);
		}
		let lockedPath;
		try { lockedPath = resolve(resolverDir, decodeURIComponent(spec.slice("file:".length))); } catch (error) {
			throw new Error(`Generated consumer lock ${label} for ${packageName} has an invalid file: reference`, { cause: error });
		}
		if (lockedPath !== resolve(tarballPath)) {
			throw new Error(`Generated consumer lock ${label} for ${packageName} does not resolve to the emitted tarball`);
		}
	}
}

function allowsRuntime(values, actual, field, location) {
	if (values === undefined) return true;
	const list = typeof values === "string" ? [values] : values;
	if (!Array.isArray(list) || list.some(value => typeof value !== "string" || value.length === 0)) {
		throw new Error(`${location} has an invalid ${field} constraint`);
	}
	if (!actual) return false;
	if (list.length === 1 && list[0] === "any") return true;
	let negated = 0;
	let matched = false;
	for (const value of list) {
		const denied = value.startsWith("!");
		const expected = denied ? value.slice(1) : value;
		if (denied) {
			negated++;
			if (actual === expected) return false;
		} else if (actual === expected) matched = true;
	}
	return matched || negated === list.length;
}

function runtimeLibc(platform = process.platform) {
	if (platform !== "linux") return undefined;
	const report = process.report?.getReport?.();
	return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function compareCodeUnits(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function artifactIdentity(artifact) {
	return `${artifact.resolved}\u0000${artifact.integrity ?? ""}`;
}

function runtimeTuple({
	platform = process.platform,
	arch = process.arch,
	libc = runtimeLibc(platform),
} = {}) {
	return Object.freeze({ platform, arch, ...(libc ? { libc } : {}) });
}

function compatibleRegistryArtifacts(lock, runtime = {}, { excludeDev = false } = {}) {
	const { platform, arch, libc } = runtimeTuple(runtime);
	const artifacts = new Map();
	for (const [location, entry] of Object.entries(lock.packages)) {
		if (!location || !entry || typeof entry !== "object") continue;
		if (excludeDev && entry.dev === true) continue;
		const resolved = entry.resolved;
		if (typeof resolved !== "string" || !/^https:\/\//.test(resolved)) continue;
		if (typeof entry.version !== "string" || entry.version.length === 0) {
			throw new Error(`${location} has a registry tarball without an exact version`);
		}
		if (!allowsRuntime(entry.os, platform, "os", location) ||
			!allowsRuntime(entry.cpu, arch, "cpu", location) ||
			!allowsRuntime(entry.libc, libc, "libc", location)) continue;
		const integrity = typeof entry.integrity === "string" && entry.integrity.length > 0
			? entry.integrity
			: undefined;
		const artifact = { resolved, integrity };
		const identity = artifactIdentity(artifact);
		if (!artifacts.has(identity)) artifacts.set(identity, artifact);
	}
	return [...artifacts.values()].sort((left, right) =>
		compareCodeUnits(left.resolved, right.resolved) ||
		compareCodeUnits(left.integrity ?? "", right.integrity ?? ""));
}

/** Select the deterministic runtime-compatible production seed superset. */
export function selectRepositorySeedArtifacts(lock, runtime = {}) {
	return compatibleRegistryArtifacts(lock, runtime, { excludeDev: true });
}

function compatibleRegistryTarballs(lock, runtime = {}) {
	return new Set(compatibleRegistryArtifacts(lock, runtime).map(artifact => artifact.resolved));
}

export function lockedTarballsMissingFromRepository(consumerLock, repositoryLock, runtime = {}) {
	const required = compatibleRegistryTarballs(consumerLock, runtime);
	const alreadyCached = compatibleRegistryTarballs(repositoryLock, runtime);
	return [...required].filter(url => !alreadyCached.has(url)).sort(compareCodeUnits);
}


function ambientCacheFromOutput(stdout) {
	const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	if (lines.length !== 1 || !isAbsolute(lines[0])) {
		throw new Error(`npm config get cache must return one absolute path, received ${JSON.stringify(stdout)}`);
	}
	return resolve(lines[0]);
}

function isStrictChild(root, candidate) {
	const child = relative(resolve(root), resolve(candidate));
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertOwnedPath(runRoot, candidate, label) {
	if (!isStrictChild(runRoot, candidate)) throw new Error(`${label} must be a strict child of the E2E run root`);
}

function cachePathHelperEnv(baseEnv, fixtureRoot) {
	const allowed = new Set(["systemroot", "windir", "comspec", "pathext", "path"]);
	const env = Object.fromEntries(Object.entries(baseEnv).filter(([key, value]) =>
		allowed.has(key.toLowerCase()) && typeof value === "string"));
	// PowerShell's Windows Job supervisor and Add-Type need temporary storage.
	// Keep it run-owned without inheriting ambient npm or credential state.
	env.TEMP = join(fixtureRoot, "helper-temp");
	env.TMP = env.TEMP;
	return env;
}

function exactObjectKeys(value, expected) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	const allowed = [...expected].sort();
	return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

async function resolveDestinationContentPaths({
	artifacts,
	destinationContentCache,
	fixtureRoot,
	runRoot,
	repoRoot,
	baseEnv,
	runCommand,
	commands,
	remainingPreparationMs,
}) {
	const integrities = [...new Set(artifacts
		.map(artifact => artifact.integrity)
		.filter(integrity => typeof integrity === "string" && integrity.length > 0))].sort(compareCodeUnits);
	if (integrities.length === 0) return new Map();

	const request = {
		fixtureRoot,
		destination: destinationContentCache,
		integrities,
	};
	const input = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(input) > MAX_CACHE_HELPER_REQUEST_BYTES) {
		throw new Error(`Packed-consumer cache path request exceeds ${MAX_CACHE_HELPER_REQUEST_BYTES} bytes`);
	}
	const helperPath = join(repoRoot, "scripts", "testing-v2", CACHE_PATH_HELPER_NAME);
	const helperEnv = cachePathHelperEnv(baseEnv, fixtureRoot);
	const totalTimeoutMs = remainingPreparationMs("destination cache path resolution");
	const result = await runCommand(process.execPath, [helperPath, fixtureRoot], {
		cwd: repoRoot,
		env: helperEnv,
		timeoutMs: totalTimeoutMs,
		totalTimeoutMs,
		maxOutputBytes: MAX_CACHE_HELPER_RESULT_BYTES,
		maxInputBytes: MAX_CACHE_HELPER_REQUEST_BYTES,
		input,
		repoRoot,
		ownershipBootstrapRoot: fixtureRoot,
	});
	commands.push(result);
	requireSuccess(result);
	if (Buffer.byteLength(result.stdout) <= 0 || Buffer.byteLength(result.stdout) > MAX_CACHE_HELPER_RESULT_BYTES) {
		throw new Error(`Packed-consumer cache path helper must emit non-empty JSON no larger than ${MAX_CACHE_HELPER_RESULT_BYTES} bytes`);
	}
	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`Packed-consumer cache path helper emitted malformed JSON: ${error.message}`, { cause: error });
	}
	if (!Array.isArray(parsed) || parsed.length !== integrities.length) {
		throw new Error(`Packed-consumer cache path helper must return exactly ${integrities.length} results`);
	}
	const expected = new Set(integrities);
	const paths = new Set();
	const destinationPaths = new Map();
	for (const entry of parsed) {
		if (!exactObjectKeys(entry, ["integrity", "path"]) || typeof entry.integrity !== "string" || typeof entry.path !== "string") {
			throw new Error("Packed-consumer cache path helper returned a malformed result entry");
		}
		if (!expected.has(entry.integrity)) {
			throw new Error(`Packed-consumer cache path helper returned an unexpected integrity: ${entry.integrity}`);
		}
		if (destinationPaths.has(entry.integrity)) {
			throw new Error(`Packed-consumer cache path helper returned a duplicate integrity: ${entry.integrity}`);
		}
		if (!isAbsolute(entry.path) || !isStrictChild(destinationContentCache, entry.path) || !isStrictChild(runRoot, entry.path)) {
			throw new Error(`Packed-consumer cache path helper returned an out-of-root path for ${entry.integrity}`);
		}
		const normalizedPath = resolve(entry.path);
		if (paths.has(normalizedPath)) {
			throw new Error(`Packed-consumer cache path helper returned a duplicate path: ${normalizedPath}`);
		}
		paths.add(normalizedPath);
		destinationPaths.set(entry.integrity, normalizedPath);
	}
	for (const integrity of integrities) {
		if (!destinationPaths.has(integrity)) throw new Error(`Packed-consumer cache path helper omitted ${integrity}`);
	}
	return destinationPaths;
}

function validateCacheHelperResult(parsed, operation, artifacts) {
	if (!exactObjectKeys(parsed, ["version", "operation", "results", "metrics", "admitted", "completed", "maxActive"]) ||
		parsed.version !== 4 || parsed.operation !== operation) {
		throw new Error("Packed-consumer cache helper returned a malformed result envelope");
	}
	if (!Array.isArray(parsed.results) || parsed.results.length !== artifacts.length) {
		throw new Error(`Packed-consumer cache helper must return exactly ${artifacts.length} results`);
	}
	if (parsed.admitted !== artifacts.length || parsed.completed !== artifacts.length ||
		!Number.isInteger(parsed.maxActive) || parsed.maxActive < 1 || parsed.maxActive > 3) {
		throw new Error("Packed-consumer cache helper returned invalid admission/completion accounting");
	}
	const allowedStatuses = operation === "publish"
		? ["linked", "copied", "missing", "corrupt"]
		: ["verified", "missing", "corrupt"];
	if (!exactObjectKeys(parsed.metrics, allowedStatuses) ||
		Object.keys(parsed.metrics).some(status => !allowedStatuses.includes(status)) ||
		Object.values(parsed.metrics).some(value => !Number.isInteger(value) || value < 0) ||
		Object.values(parsed.metrics).reduce((sum, value) => sum + value, 0) !== artifacts.length) {
		throw new Error("Packed-consumer cache helper returned invalid deterministic metrics");
	}
	const expected = new Map(artifacts.map(artifact => [artifact.integrity, artifact]));
	const results = new Map();
	const observedMetrics = Object.fromEntries(allowedStatuses.map(status => [status, 0]));
	for (const entry of parsed.results) {
		const validKeys = operation === "publish" ? ["integrity", "status", "candidate"] : ["integrity", "status"];
		if (!exactObjectKeys(entry, validKeys) || typeof entry.integrity !== "string" || !allowedStatuses.includes(entry.status)) {
			throw new Error("Packed-consumer cache helper returned a malformed result entry");
		}
		const requested = expected.get(entry.integrity);
		if (!requested) throw new Error("Packed-consumer cache helper returned an unexpected integrity");
		if (results.has(entry.integrity)) throw new Error("Packed-consumer cache helper returned a duplicate integrity");
		if (operation === "publish") {
			const validCandidate = entry.candidate === null ||
				(typeof entry.candidate === "string" && requested.candidates.includes(entry.candidate));
			if (!validCandidate || (entry.candidate === null && entry.status !== "missing")) {
				throw new Error("Packed-consumer cache helper returned an invalid alias selection");
			}
		}
		results.set(entry.integrity, entry);
		observedMetrics[entry.status] = (observedMetrics[entry.status] ?? 0) + 1;
	}
	for (const artifact of artifacts) if (!results.has(artifact.integrity)) throw new Error("Packed-consumer cache helper omitted an integrity");
	if (JSON.stringify(observedMetrics) !== JSON.stringify(parsed.metrics)) throw new Error("Packed-consumer cache helper metrics do not match its results");
	return { results, metrics: Object.freeze({ ...observedMetrics }) };
}

async function runCacheHelper({
	operation,
	artifacts,
	sourceContentCache,
	fixtureRoot,
	repoRoot,
	baseEnv,
	runCommand,
	commands,
	remainingPreparationMs,
	label,
}) {
	if (artifacts.length === 0) return { results: new Map(), metrics: Object.freeze({}) };
	const request = { version: 4, operation, artifacts };
	const input = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(input) > MAX_CACHE_HELPER_REQUEST_BYTES) {
		throw new Error(`Packed-consumer cache ${operation} request exceeds ${MAX_CACHE_HELPER_REQUEST_BYTES} bytes`);
	}
	const helperPath = join(repoRoot, "scripts", "testing-v2", CACHE_COPY_HELPER_NAME);
	const helperEnv = cachePathHelperEnv(baseEnv, fixtureRoot);
	if (operation === "publish") helperEnv[CACHE_COPY_AMBIENT_ENV] = sourceContentCache;
	const totalTimeoutMs = remainingPreparationMs(label);
	const result = await runCommand(process.execPath, [helperPath, fixtureRoot], {
		cwd: repoRoot,
		env: helperEnv,
		timeoutMs: totalTimeoutMs,
		totalTimeoutMs,
		maxOutputBytes: MAX_CACHE_HELPER_RESULT_BYTES,
		maxInputBytes: MAX_CACHE_HELPER_REQUEST_BYTES,
		input,
		repoRoot,
		ownershipBootstrapRoot: fixtureRoot,
	});
	commands.push(result);
	requireSuccess(result);
	if (Buffer.byteLength(result.stdout) <= 0 || Buffer.byteLength(result.stdout) > MAX_CACHE_HELPER_RESULT_BYTES) {
		throw new Error(`Packed-consumer cache helper must emit non-empty JSON no larger than ${MAX_CACHE_HELPER_RESULT_BYTES} bytes`);
	}
	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`Packed-consumer cache helper emitted malformed JSON: ${error.message}`, { cause: error });
	}
	return validateCacheHelperResult(parsed, operation, artifacts);
}

function destinationArtifact(integrity, destinationPaths) {
	const destinationPath = destinationPaths.get(integrity);
	if (typeof destinationPath !== "string" || !isAbsolute(destinationPath)) {
		throw new Error(`Packed-consumer cache operation has no absolute destination for ${integrity}`);
	}
	return { integrity, destinationPath };
}

async function copyAvailableArtifacts(options) {
	const { artifacts, destinationPaths } = options;
	const transferable = artifacts.filter(artifact => artifact.integrity)
		.sort((left, right) => compareCodeUnits(artifactIdentity(left), artifactIdentity(right)));
	const noIntegrity = artifacts.filter(artifact => !artifact.integrity);
	if (transferable.length === 0) {
		return { fallbackArtifacts: noIntegrity, linkedCount: 0, copiedCount: 0, missingDigestCount: 0, corruptDigestCount: 0 };
	}
	const byIntegrity = new Map();
	for (const artifact of transferable) {
		const group = byIntegrity.get(artifact.integrity) ?? [];
		group.push(artifact);
		byIntegrity.set(artifact.integrity, group);
	}
	const helperArtifacts = [...byIntegrity.entries()].map(([integrity, group]) => ({
		...destinationArtifact(integrity, destinationPaths),
		candidates: [...new Set(group.map(artifact => artifact.resolved))]
			.sort(compareCodeUnits),
	})).sort((left, right) => compareCodeUnits(left.integrity, right.integrity));
	const validated = await runCacheHelper({
		...options,
		operation: "publish",
		artifacts: helperArtifacts,
		label: "ambient cache direct publication",
	});
	const fallbackArtifacts = [...noIntegrity];
	for (const helperArtifact of helperArtifacts) {
		const result = validated.results.get(helperArtifact.integrity);
		if (result.status === "missing" || result.status === "corrupt") fallbackArtifacts.push(...byIntegrity.get(helperArtifact.integrity));
	}
	return {
		fallbackArtifacts: fallbackArtifacts.sort((left, right) => compareCodeUnits(artifactIdentity(left), artifactIdentity(right))),
		linkedCount: validated.metrics.linked ?? 0,
		copiedCount: validated.metrics.copied ?? 0,
		missingDigestCount: validated.metrics.missing ?? 0,
		corruptDigestCount: validated.metrics.corrupt ?? 0,
	};
}

async function verifyDestinationArtifacts({ artifacts, destinationPaths, ...options }) {
	const byIntegrity = new Map();
	for (const artifact of artifacts) if (artifact.integrity) {
		const group = byIntegrity.get(artifact.integrity) ?? [];
		group.push(artifact);
		byIntegrity.set(artifact.integrity, group);
	}
	const helperArtifacts = [...byIntegrity.keys()]
		.sort(compareCodeUnits)
		.map(integrity => destinationArtifact(integrity, destinationPaths));
	const verified = await runCacheHelper({
		...options,
		operation: "verify",
		artifacts: helperArtifacts,
		label: options.label ?? "destination cache verification",
	});
	const invalid = helperArtifacts.filter(artifact => verified.results.get(artifact.integrity).status !== "verified");
	if (invalid.length > 0) {
		throw new Error(`Packed-consumer isolated cache is missing or corrupt after transfer/fetch:\n${invalid.flatMap(artifact =>
			byIntegrity.get(artifact.integrity).map(candidate => `${candidate.resolved} (${artifact.integrity}; ${verified.results.get(artifact.integrity).status})`)).join("\n")}`);
	}
	return verified;
}

async function measured(label, operation) {
	const start = Date.now();
	console.log(`[packed-consumer] ${label}: started`);
	try {
		const result = await operation();
		console.log(`[packed-consumer] ${label}: completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
		return result;
	} catch (error) {
		console.error(`[packed-consumer] ${label}: failed after ${((Date.now() - start) / 1000).toFixed(1)}s`);
		throw error;
	}
}

function cleanConsumerManifest(nodeTypesVersion) {
	return {
		name: "bobbit-inline-theme-clean-consumer",
		version: "1.0.0",
		private: true,
		...(nodeTypesVersion ? { overrides: { "@types/node": nodeTypesVersion } } : {}),
	};
}

async function writeManifest(directory, manifest) {
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function errorEvidence(error) {
	if (!(error instanceof Error)) return { message: String(error) };
	const cause = error.cause;
	const owned = error instanceof OwnedCommandError ? {
		command: error.command,
		args: error.args,
		cwd: error.cwd,
		shutdown: error.shutdown,
	} : {};
	const aggregate = error instanceof AggregateError ? {
		errors: [...error.errors].map(errorEvidence),
	} : {};
	const cacheOperation = error.cacheOperation ? { cacheOperation: error.cacheOperation } : {};
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
		...owned,
		...aggregate,
		...cacheOperation,
		...(cause === undefined ? {} : { cause: errorEvidence(cause) }),
	};
}

async function retainPreparationFailure({ fixtureRoot, commands, error }) {
	const evidencePath = join(fixtureRoot, "preparation-failure.json");
	const evidence = {
		status: "failed",
		fixtureRoot,
		failedAt: new Date().toISOString(),
		error: errorEvidence(error),
		commands,
	};
	try {
		await mkdir(fixtureRoot, { recursive: true });
		await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
	} catch (evidenceError) {
		throw new AggregateError(
			[error, evidenceError],
			`Packed-consumer preparation failed and failure evidence could not be written at ${evidencePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const retained = new Error(
		`Packed-consumer preparation failed; retained partial fixture and command evidence at ${evidencePath}: ${error instanceof Error ? error.message : String(error)}`,
		{ cause: error },
	);
	retained.fixtureRoot = fixtureRoot;
	retained.evidencePath = evidencePath;
	retained.commands = commands;
	throw retained;
}

/** Ensure dist under the same preparation deadline and owned-tree boundary. */
export async function ensurePackedConsumerDist({
	repoRoot,
	baseEnv,
	npm,
	fixtureRoot,
	commands,
	runCommand,
	remainingPreparationMs,
	ensureDistBuildFn = ensureDistBuild,
}) {
	return ensureDistBuildFn({
		repoRoot,
		lockWaitMs: remainingPreparationMs("dist build lock"),
		runBuild: async () => {
			const args = [...npm.argsPrefix, "run", "build"];
			const totalTimeoutMs = remainingPreparationMs("npm run build");
			const result = await runCommand(npm.command, args, {
				cwd: repoRoot,
				env: baseEnv,
				timeoutMs: Math.min(DIST_BUILD_TIMEOUT_MS, totalTimeoutMs),
				totalTimeoutMs,
				repoRoot,
				ownershipBootstrapRoot: fixtureRoot,
			});
			commands.push(result);
			requireSuccess(result);
		},
	});
}

const seedAuthorities = new WeakMap();
const SEED_DESCRIPTOR_VERSION = 1;
const MAX_SEED_ARTIFACTS = 5_000;

function packedConsumerLayout(runRoot) {
	const absoluteRunRoot = resolve(runRoot);
	const fixtureRoot = join(absoluteRunRoot, FIXTURE_DIRECTORY);
	const packDir = join(fixtureRoot, "pack");
	const preparationDir = join(fixtureRoot, "preparation");
	const layout = Object.freeze({
		absoluteRunRoot,
		fixtureRoot,
		packDir,
		preparationDir,
		resolverDir: join(preparationDir, "resolver"),
		templateDir: join(preparationDir, "template"),
		cacheDir: join(fixtureRoot, "npm-cache"),
		consumersDir: join(fixtureRoot, "materialized"),
		descriptorPath: join(fixtureRoot, "descriptor.json"),
		seedDescriptorPath: join(fixtureRoot, "seed-descriptor.json"),
	});
	for (const [label, candidate] of Object.entries(layout)) {
		if (label !== "absoluteRunRoot") assertOwnedPath(absoluteRunRoot, candidate, label);
	}
	return layout;
}

function createPreparationDeadline(preparationTimeoutMs, now) {
	if (!Number.isFinite(preparationTimeoutMs) || preparationTimeoutMs <= 0) {
		throw new Error("preparationTimeoutMs must be a positive number");
	}
	const startedAt = now();
	const deadline = Object.freeze({
		identity: randomUUID(),
		startedAt,
		expiresAt: startedAt + preparationTimeoutMs,
		timeoutMs: preparationTimeoutMs,
	});
	let latestNow = startedAt;
	const remainingPreparationMs = label => {
		latestNow = Math.max(latestNow, now());
		const elapsedMs = latestNow - startedAt;
		const remainingMs = deadline.expiresAt - latestNow;
		if (remainingMs <= 0) {
			throw new Error(`Packed-consumer preparation deadline exhausted before ${label} after ${Math.round(elapsedMs)}ms (limit ${preparationTimeoutMs}ms)`);
		}
		return Math.ceil(remainingMs);
	};
	return { deadline, remainingPreparationMs };
}

function seedLockInput(repoRoot, injectedLock) {
	if (injectedLock !== undefined) {
		if (!injectedLock || typeof injectedLock !== "object" || injectedLock.lockfileVersion !== 3 ||
			!injectedLock.packages || typeof injectedLock.packages !== "object") {
			throw new Error("repositoryLock must be a package-lock v3 document");
		}
		return { lock: injectedLock, bytes: Buffer.from(JSON.stringify(injectedLock)) };
	}
	const path = join(repoRoot, "package-lock.json");
	return { lock: readPackageLock(path, "repository package-lock.json"), bytes: readFileSync(path) };
}

function repositoryLockHash(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function assertConsumerSeedSubset(consumerArtifacts, seedArtifacts) {
	const seeded = new Set(seedArtifacts.map(artifactIdentity));
	const missing = consumerArtifacts.filter(artifact => !seeded.has(artifactIdentity(artifact)));
	if (missing.length > 0) {
		throw new Error(`Generated consumer lock contains registry artifacts outside the verified seed:\n${missing
			.map(artifact => `${artifact.resolved} (${artifact.integrity ?? "no integrity"})`).join("\n")}`);
	}
}

/** Seed the run-owned cache from the committed production lock before Group B. */
export async function seedPackedConsumerCache({
	repoRoot = REPO_ROOT,
	runRoot,
	baseEnv = process.env,
	ensureDist,
	runCommand = runOwnedCommand,
	resolveNpm = npmInvocation,
	runtime,
	preparationTimeoutMs = PACKED_CONSUMER_PREPARATION_TIMEOUT_MS,
	now = () => performance.now(),
	repositoryLock,
} = {}) {
	if (!runRoot) throw new Error("seedPackedConsumerCache requires runRoot");
	const wallStartedAt = Date.now();
	const { deadline, remainingPreparationMs } = createPreparationDeadline(preparationTimeoutMs, now);
	const layout = packedConsumerLayout(runRoot);
	if (existsSync(layout.fixtureRoot)) throw new Error(`Packed-consumer fixture was already prepared at ${layout.fixtureRoot}`);
	const commands = [];
	try {
		await Promise.all([
			mkdir(layout.packDir, { recursive: true }),
			mkdir(layout.resolverDir, { recursive: true }),
			mkdir(layout.templateDir, { recursive: true }),
			mkdir(layout.cacheDir, { recursive: true }),
			mkdir(layout.consumersDir, { recursive: true }),
		]);
		const npm = resolveNpm(baseEnv);
		const lockInput = seedLockInput(repoRoot, repositoryLock);
		const selectedRuntime = runtimeTuple(runtime);
		const selectedArtifacts = selectRepositorySeedArtifacts(lockInput.lock, selectedRuntime);
		if (selectedArtifacts.length > MAX_SEED_ARTIFACTS) throw new Error(`Repository lock seed exceeds ${MAX_SEED_ARTIFACTS} artifacts`);
		const totalTimeoutMs = remainingPreparationMs("ambient npm cache discovery");
		const discovery = await measured("seed ambient cache discovery", async () => {
			const result = await runCommand(npm.command, [...npm.argsPrefix, "config", "get", "cache"], {
				cwd: repoRoot,
				env: packedConsumerNpmEnv(repoRoot, baseEnv),
				timeoutMs: Math.min(CACHE_DISCOVERY_TIMEOUT_MS, totalTimeoutMs),
				totalTimeoutMs,
				repoRoot,
				ownershipBootstrapRoot: layout.fixtureRoot,
			});
			commands.push(result);
			requireSuccess(result);
			return result;
		});
		const ambientCacheDir = ambientCacheFromOutput(discovery.stdout);
		if (ambientCacheDir === resolve(layout.cacheDir) || ambientCacheDir === resolve(layout.fixtureRoot) ||
			isStrictChild(layout.fixtureRoot, ambientCacheDir) || isStrictChild(ambientCacheDir, layout.fixtureRoot)) {
			throw new Error(`Ambient npm cache must lie outside and not contain the packed-consumer fixture: ${ambientCacheDir}`);
		}
		const destinationContentCache = join(layout.cacheDir, "_cacache");
		const destinationPaths = await measured("seed destination cache path resolution", () => resolveDestinationContentPaths({
			artifacts: selectedArtifacts,
			destinationContentCache,
			fixtureRoot: layout.fixtureRoot,
			runRoot: layout.absoluteRunRoot,
			repoRoot,
			baseEnv,
			runCommand,
			commands,
			remainingPreparationMs,
		}));
		const transfer = await measured("seed cache direct publication", () => copyAvailableArtifacts({
			artifacts: selectedArtifacts,
			sourceContentCache: join(ambientCacheDir, "_cacache"),
			destinationPaths,
			fixtureRoot: layout.fixtureRoot,
			repoRoot,
			baseEnv,
			runCommand,
			commands,
			remainingPreparationMs,
		}));
		console.log(`[packed-consumer] exact cache seed metrics: linked=${transfer.linkedCount}, copied=${transfer.copiedCount}, missing=${transfer.missingDigestCount}, corrupt=${transfer.corruptDigestCount}`);
		const fallbackArtifacts = transfer.fallbackArtifacts;
		const fallbackUrls = [...new Set(fallbackArtifacts.map(artifact => artifact.resolved))].sort(compareCodeUnits);
		const batches = [];
		for (let offset = 0; offset < fallbackUrls.length; offset += CACHE_BATCH_SIZE) batches.push(fallbackUrls.slice(offset, offset + CACHE_BATCH_SIZE));
		const results = new Array(batches.length);
		const failures = new Array(batches.length);
		const resolverEnv = isolatedNpmEnv(layout.resolverDir, layout.cacheDir, baseEnv);
		let next = 0;
		let stopped = false;
		const worker = async () => {
			while (!stopped) {
				const index = next++;
				if (index >= batches.length) return;
				try {
					const remaining = remainingPreparationMs(`npm cache batch ${index + 1}`);
					const result = await measured(`seed cache batch ${index + 1}/${batches.length}`, () => runCommand(
						npm.command,
						[...npm.argsPrefix, "cache", "add", "--cache", layout.cacheDir, ...batches[index]],
						{ cwd: layout.resolverDir, env: resolverEnv, timeoutMs: Math.min(CACHE_BATCH_TIMEOUT_MS, remaining), totalTimeoutMs: remaining, repoRoot, ownershipBootstrapRoot: layout.fixtureRoot },
					));
					results[index] = result;
					requireSuccess(result);
				} catch (error) {
					failures[index] = error;
					stopped = true;
				}
			}
		};
		await Promise.allSettled(Array.from({ length: Math.min(CACHE_WORKER_COUNT, batches.length) }, worker));
		for (const result of results) if (result) commands.push(result);
		const failed = failures.map((error, index) => error ? { error, index } : undefined).filter(Boolean);
		if (failed.length) throw new AggregateError(failed.map(entry => entry.error), `npm cache population failed for ${failed.map(entry => `batch ${entry.index + 1}`).join(", ")}`);
		// Direct publication verifies each selected digest while copying it. Only
		// fallback artifacts written by npm cache add still need a digest proof.
		// Avoid traversing every direct hit again on the preparation deadline.
		const integrityFallbackArtifacts = fallbackArtifacts.filter(artifact => artifact.integrity);
		await measured("fallback cache verification", () => verifyDestinationArtifacts({
			artifacts: integrityFallbackArtifacts,
			destinationPaths,
			fixtureRoot: layout.fixtureRoot,
			repoRoot,
			baseEnv,
			runCommand,
			commands,
			remainingPreparationMs,
			label: "fallback cache verification",
		}));
		remainingPreparationMs("seed descriptor publication");
		const identities = selectedArtifacts.map(artifact => Object.freeze({
			resolved: artifact.resolved,
			integrity: artifact.integrity ?? null,
			status: artifact.integrity ? "verified-digest" : "fetched-exact-url",
		}));
		const seedDescriptor = Object.freeze({
			version: SEED_DESCRIPTOR_VERSION,
			runRoot: layout.absoluteRunRoot,
			fixtureRoot: layout.fixtureRoot,
			cacheDir: layout.cacheDir,
			seedDescriptorPath: layout.seedDescriptorPath,
			repositoryLockHash: repositoryLockHash(lockInput.bytes),
			runtime: selectedRuntime,
			identities,
			deadline,
			transferMetrics: Object.freeze({
				linked: transfer.linkedCount,
				copied: transfer.copiedCount,
				missing: transfer.missingDigestCount,
				corrupt: transfer.corruptDigestCount,
			}),
			lifecycle: Object.freeze({ cacheOwnersSettled: true, helperTransportJoined: true, verifiedArtifacts: identities.length }),
		});
		const temporary = `${layout.seedDescriptorPath}.tmp-${process.pid}-${randomUUID()}`;
		await writeFile(temporary, `${JSON.stringify(seedDescriptor, null, 2)}\n`, { flag: "wx" });
		remainingPreparationMs("seed descriptor rename");
		await rename(temporary, layout.seedDescriptorPath);
		const seedHandle = Object.freeze({ version: SEED_DESCRIPTOR_VERSION, seedDescriptorPath: layout.seedDescriptorPath, deadline, seedWallMs: Date.now() - wallStartedAt });
		seedAuthorities.set(seedHandle, Object.freeze({
			layout, wallStartedAt, repoRoot: resolve(repoRoot), baseEnv, ensureDist, runCommand, npm, runtime: selectedRuntime,
			remainingPreparationMs, lock: lockInput.lock,
			lockInjected: repositoryLock !== undefined,
			lockHash: seedDescriptor.repositoryLockHash, selectedArtifacts, destinationPaths, identities, commands, seedDescriptor,
		}));
		console.log(`[packed-consumer] seed completed in ${(seedHandle.seedWallMs / 1000).toFixed(1)}s; deadline=${deadline.identity}`);
		return seedHandle;
	} catch (error) {
		await retainPreparationFailure({ fixtureRoot: layout.fixtureRoot, commands, error });
	}
}

/**
 * Complete one seeded packed-consumer template and publish its descriptor only
 * after the actual tarball, generated lockfile, and installed tree exist.
 */
export async function finalizePackedConsumerFixture(seedHandle) {
	const authority = seedAuthorities.get(seedHandle);
	if (!authority) throw new Error("Packed-consumer finalization requires an authoritative seed handle from this process");
	const {
		layout, wallStartedAt, repoRoot, baseEnv, ensureDist, runCommand, npm, runtime,
		remainingPreparationMs, lock: repositoryLock, lockInjected,
		lockHash, identities, commands, seedDescriptor,
	} = authority;
	const finalizationStartedAt = Date.now();
	const { absoluteRunRoot, fixtureRoot, packDir, templateDir, cacheDir, consumersDir, descriptorPath } = layout;
	const commandDeadline = (label, commandTimeoutMs) => {
		const totalTimeoutMs = remainingPreparationMs(label);
		return { timeoutMs: Math.min(commandTimeoutMs, totalTimeoutMs), totalTimeoutMs };
	};
	try {
		const persistedSeed = JSON.parse(await readFile(layout.seedDescriptorPath, "utf8"));
		if (JSON.stringify(persistedSeed) !== JSON.stringify(seedDescriptor)) {
			throw new Error("Packed-consumer persisted seed descriptor does not match its authoritative in-memory seed");
		}
		const currentLock = seedLockInput(repoRoot, lockInjected ? repositoryLock : undefined);
		if (repositoryLockHash(currentLock.bytes) !== lockHash) {
			throw new Error("Repository package-lock.json changed after packed-consumer cache seeding");
		}
		const canonical = packedConsumerLayout(absoluteRunRoot);
		for (const key of Object.keys(canonical)) {
			if (resolve(canonical[key]) !== resolve(layout[key])) throw new Error(`Packed-consumer seed ${key} does not match its canonical run-owned path`);
		}
		if (seedHandle.deadline.identity !== seedDescriptor.deadline.identity || seedHandle.deadline.expiresAt !== seedDescriptor.deadline.expiresAt) {
			throw new Error("Packed-consumer seed deadline identity was forged");
		}
		remainingPreparationMs("finalization start");
		await measured("build", async () => {
			if (ensureDist) {
				const totalTimeoutMs = remainingPreparationMs("dist build");
				await ensureDist({
					timeoutMs: totalTimeoutMs,
					totalTimeoutMs,
					fixtureRoot,
					commands,
					runCommand,
				});
			} else {
				await ensurePackedConsumerDist({
					repoRoot,
					baseEnv,
					npm,
					fixtureRoot,
					commands,
					runCommand,
					remainingPreparationMs,
				});
			}
			remainingPreparationMs("post-build preparation");
		});
		const packageManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
		const packageName = packageManifest.name;
		if (typeof packageName !== "string" || packageName.length === 0) throw new Error("package.json must declare a package name");
		const nodeTypesVersion = repositoryLock.packages?.["node_modules/@types/node"]?.version;
		const consumerManifest = cleanConsumerManifest(nodeTypesVersion);
		// Seed Arborist with the checkout's exact graph. npm remains authoritative:
		// one strict-offline install prunes this lock to the external manifest,
		// binds the emitted tarball, and materializes node_modules in one transaction.
		await Promise.all([
			writeManifest(templateDir, consumerManifest),
			copyFile(join(repoRoot, "package-lock.json"), join(templateDir, "package-lock.json")),
		]);

		const packArgs = [...npm.argsPrefix, "pack", "--ignore-scripts", "--json", "--pack-destination", packDir];
		const packCommand = await measured("pack", async () => {
			const result = await runCommand(npm.command, packArgs, {
				cwd: repoRoot,
				env: baseEnv,
				...commandDeadline("npm pack", PACK_TIMEOUT_MS),
				repoRoot,
			});
			commands.push(result);
			requireSuccess(result);
			return result;
		});
		const { entry: packEntry, report: packReport } = parsePackResult(packCommand.stdout, packageName);
		const tarballPath = resolve(packDir, packEntry.filename);
		assertOwnedPath(absoluteRunRoot, tarballPath, "tarballPath");
		const tarball = await stat(tarballPath).catch(() => undefined);
		if (!tarball?.isFile()) throw new Error(`npm pack did not create ${tarballPath}`);

		const templateEnv = isolatedNpmEnv(templateDir, cacheDir, baseEnv);
		const installArgs = [
			...npm.argsPrefix,
			"install",
			"--offline",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--cache", cacheDir,
			tarballPath,
		];
		const installCommand = await measured("offline template install", async () => {
			const result = await runCommand(npm.command, installArgs, {
				cwd: templateDir,
				env: templateEnv,
				...commandDeadline("offline npm install", OFFLINE_INSTALL_TIMEOUT_MS),
				repoRoot,
			});
			commands.push(result);
			requireSuccess(result);
			return result;
		});

		const [templateLock, templateModules] = await Promise.all([
			stat(join(templateDir, "package-lock.json")).catch(() => undefined),
			stat(join(templateDir, "node_modules")).catch(() => undefined),
		]);
		if (!templateLock?.isFile() || !templateModules?.isDirectory()) {
			throw new Error("Offline packed-consumer template validation failed: package-lock.json or node_modules is missing");
		}
		const consumerLock = readPackageLock(join(templateDir, "package-lock.json"), "generated consumer package-lock.json");
		assertPackedArtifactLock(consumerLock, packageName, templateDir, tarballPath);
		// The npm-authored lock is final authority. Every selected registry identity
		// must belong to the direct-publication or verified-fallback seed.
		const selectedArtifacts = compatibleRegistryArtifacts(consumerLock, runtime);
		assertConsumerSeedSubset(selectedArtifacts, identities);

		const finalizationWallMs = Date.now() - finalizationStartedAt;
		const descriptor = {
			version: DESCRIPTOR_VERSION,
			runRoot: absoluteRunRoot,
			fixtureRoot,
			templateDir,
			consumersDir,
			tarballPath,
			cacheDir,
			descriptorPath,
			packageName,
			packEntry,
			packReport,
			commands,
			seed: { descriptorPath: layout.seedDescriptorPath, repositoryLockHash: lockHash, identities, deadline: seedDescriptor.deadline },
			timing: { seedWallMs: seedHandle.seedWallMs, finalizationWallMs, totalWallMs: Date.now() - wallStartedAt },
			preparedAt: new Date().toISOString(),
		};
		const temporaryDescriptor = `${descriptorPath}.tmp-${process.pid}-${randomUUID()}`;
		await writeFile(temporaryDescriptor, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx" });
		remainingPreparationMs("descriptor publication");
		await rename(temporaryDescriptor, descriptorPath);
		console.log(`[packed-consumer] finalization completed in ${(finalizationWallMs / 1000).toFixed(1)}s; total ${(descriptor.timing.totalWallMs / 1000).toFixed(1)}s; deadline=${seedDescriptor.deadline.identity}`);
		console.log(`[packed-consumer] descriptor: ${descriptorPath}`);
		return descriptor;
	} catch (error) {
		// The coordinator retains failed run roots. Keep this partial fixture too:
		// deleting it here used a second retry algorithm, could hide cleanup errors,
		// and discarded the exact npm command evidence needed to diagnose failures.
		await retainPreparationFailure({ fixtureRoot, commands, error });
	}
}

/** Sequential compatibility wrapper for direct and focused callers. */
export async function preparePackedConsumerFixture(options = {}) {
	const seedHandle = await seedPackedConsumerCache(options);
	return finalizePackedConsumerFixture(seedHandle);
}

function assertMatchingPath(actual, expected, label) {
	if (resolve(actual) !== resolve(expected)) {
		throw new Error(`Prepared packed-consumer ${label} does not match the authoritative E2E run layout`);
	}
}

function validateDescriptor(descriptor, coordinatorRunRoot) {
	if (!coordinatorRunRoot) throw new Error("Prepared packed-consumer validation requires the authoritative coordinator run root");
	if (!descriptor || typeof descriptor !== "object" || descriptor.version !== DESCRIPTOR_VERSION) {
		throw new Error("Prepared packed-consumer descriptor has an unsupported format");
	}
	for (const key of ["runRoot", "fixtureRoot", "templateDir", "consumersDir", "tarballPath", "cacheDir", "descriptorPath", "packageName"]) {
		if (typeof descriptor[key] !== "string" || descriptor[key].length === 0) throw new Error(`Prepared packed-consumer descriptor is missing ${key}`);
	}
	if (!descriptor.packEntry || typeof descriptor.packEntry !== "object" || typeof descriptor.packEntry.filename !== "string" || descriptor.packEntry.filename.length === 0) {
		throw new Error("Prepared packed-consumer descriptor is missing packEntry.filename");
	}

	const runRoot = resolve(coordinatorRunRoot);
	assertMatchingPath(descriptor.runRoot, runRoot, "declared run root");
	for (const key of ["fixtureRoot", "templateDir", "consumersDir", "tarballPath", "cacheDir", "descriptorPath"]) {
		assertOwnedPath(runRoot, descriptor[key], key);
	}

	const fixtureRoot = join(runRoot, FIXTURE_DIRECTORY);
	assertMatchingPath(descriptor.fixtureRoot, fixtureRoot, "fixture root");
	assertMatchingPath(descriptor.templateDir, join(fixtureRoot, "preparation", "template"), "template path");
	assertMatchingPath(descriptor.consumersDir, join(fixtureRoot, "materialized"), "consumer root");
	assertMatchingPath(descriptor.cacheDir, join(fixtureRoot, "npm-cache"), "cache path");
	assertMatchingPath(descriptor.descriptorPath, join(fixtureRoot, "descriptor.json"), "descriptor path");
	const packRoot = join(fixtureRoot, "pack");
	assertOwnedPath(packRoot, descriptor.tarballPath, "tarballPath");
	assertMatchingPath(descriptor.tarballPath, join(packRoot, descriptor.packEntry.filename), "tarball path");
	return descriptor;
}

export async function readPreparedPackedConsumerDescriptor(descriptorPath, coordinatorRunRoot) {
	if (!coordinatorRunRoot) throw new Error("readPreparedPackedConsumerDescriptor requires the authoritative coordinator run root");
	const runRoot = resolve(coordinatorRunRoot);
	assertOwnedPath(runRoot, descriptorPath, "descriptorPath");
	assertMatchingPath(descriptorPath, join(runRoot, FIXTURE_DIRECTORY, "descriptor.json"), "input descriptor path");
	const parsed = JSON.parse(await readFile(descriptorPath, "utf8"));
	const descriptor = validateDescriptor(parsed, runRoot);
	assertMatchingPath(descriptor.descriptorPath, descriptorPath, "descriptor path");
	return descriptor;
}

/** Materialize the installed template into a unique, mutable, run-owned consumer. */
export async function materializePackedConsumerFixture(descriptor, {
	coordinatorRunRoot,
	name = "consumer",
	mode = "copy",
	copy = cp,
	move = rename,
} = {}) {
	const validated = validateDescriptor(descriptor, coordinatorRunRoot);
	if (mode !== "copy" && mode !== "consume") {
		throw new Error(`Unsupported packed-consumer materialization mode: ${mode}`);
	}
	const safeName = String(name).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "consumer";
	const consumerDir = join(validated.consumersDir, `${safeName}-${process.pid}-${randomUUID()}`);
	assertOwnedPath(resolve(coordinatorRunRoot), consumerDir, "consumerDir");
	await mkdir(validated.consumersDir, { recursive: true });
	if (mode === "consume") {
		// The template and destination have equal depth below the same run-owned
		// fixture root. Rename is therefore atomic and preserves ../../pack lock refs.
		await move(validated.templateDir, consumerDir);
	} else {
		await copy(validated.templateDir, consumerDir, { recursive: true, force: false, errorOnExist: true });
	}
	return { consumerDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	console.error("This module is prepared by scripts/testing-v2/run-e2e-v2.mjs; standalone cache prewarming was removed.");
	process.exitCode = 1;
}
